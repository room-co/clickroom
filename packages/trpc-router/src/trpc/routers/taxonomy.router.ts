import { newId, type ScopedPrismaClient } from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { cacheBust, cacheGetJson, cacheSetJson, redis } from '../../lib/redis.js'
import { requirePermission, router, scopedForProject } from '../trpc.js'

// tRPC has no superjson transformer here, so BigInt/Date are not JSON-safe.
// The serializers below coerce every taxonomy row into a JSON-safe shape
// (volume30d BigInt → number, Date → ISO string) BEFORE it is cached or
// returned, so the cache-hit and cache-miss paths are byte-identical.
const CACHE_TTL_SECONDS = 60
const cacheKey = (projectId: string) => `tax:def:${projectId}`

const propertyScopeSchema = z.enum(['event', 'person'])
const propertyTypeSchema = z.enum(['String', 'Numeric', 'Boolean', 'DateTime'])
const enforcementModeSchema = z.enum(['none', 'warn', 'strict'])

type SerializedEvent = {
  id: string
  projectId: string
  name: string
  isSystem: boolean
  verified: boolean
  hidden: boolean
  description: string | null
  lastSeenAt: string | null
  volume30d: number
  enforcementMode: 'none' | 'warn' | 'strict'
  createdAt: string
  updatedAt: string
}

type SerializedProperty = {
  id: string
  projectId: string
  name: string
  scope: 'event' | 'person'
  propertyType: 'String' | 'Numeric' | 'Boolean' | 'DateTime'
  typeLocked: boolean
  isNumerical: boolean
  verified: boolean
  hidden: boolean
  description: string | null
  lastSeenAt: string | null
  createdAt: string
  updatedAt: string
}

type TaxonomySnapshot = {
  events: SerializedEvent[]
  properties: SerializedProperty[]
  // Flat event→property links used for contextual property autocomplete, plus
  // `required` so the schema editor can pre-fill each property's current
  // required/optional state for a given event.
  eventProperties: { eventName: string; propertyName: string; required: boolean }[]
}

// Prisma row types derived from the scoped client — avoids importing
// @prisma/client directly (not a declared dependency of @clickroom/api).
type EventDefinitionRow = Awaited<
  ReturnType<ScopedPrismaClient['eventDefinition']['findFirstOrThrow']>
>
type PropertyDefinitionRow = Awaited<
  ReturnType<ScopedPrismaClient['propertyDefinition']['findFirstOrThrow']>
>

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null)

function serializeEvent(e: EventDefinitionRow): SerializedEvent {
  return {
    id: e.id,
    projectId: e.projectId,
    name: e.name,
    isSystem: e.isSystem,
    verified: e.verified,
    hidden: e.hidden,
    description: e.description,
    lastSeenAt: iso(e.lastSeenAt),
    volume30d: Number(e.volume30d),
    enforcementMode: e.enforcementMode,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  }
}

function serializeProperty(p: PropertyDefinitionRow): SerializedProperty {
  return {
    id: p.id,
    projectId: p.projectId,
    name: p.name,
    scope: p.scope,
    propertyType: p.propertyType,
    typeLocked: p.typeLocked,
    isNumerical: p.isNumerical,
    verified: p.verified,
    hidden: p.hidden,
    description: p.description,
    lastSeenAt: iso(p.lastSeenAt),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }
}

/**
 * Load the full JSON-safe taxonomy snapshot for a project, Redis-cached under
 * `tax:def:<project_id>` with a short TTL. On any cache miss or Redis outage the
 * scoped Prisma client is queried and the result re-populates the cache.
 */
async function loadSnapshot(pdb: ScopedPrismaClient, projectId: string): Promise<TaxonomySnapshot> {
  const cached = await cacheGetJson<TaxonomySnapshot>(cacheKey(projectId))
  if (cached) return cached

  const [events, properties, links] = await Promise.all([
    pdb.eventDefinition.findMany({ orderBy: { name: 'asc' } }),
    pdb.propertyDefinition.findMany({ orderBy: { name: 'asc' } }),
    pdb.eventProperty.findMany(),
  ])

  const snapshot: TaxonomySnapshot = {
    events: events.map(serializeEvent),
    properties: properties.map(serializeProperty),
    eventProperties: links.map((l) => ({
      eventName: l.eventName,
      propertyName: l.propertyName,
      required: l.required,
    })),
  }
  await cacheSetJson(cacheKey(projectId), snapshot, CACHE_TTL_SECONDS)
  return snapshot
}

const matchesSearch = (name: string, search: string) =>
  name.toLowerCase().includes(search.toLowerCase())

/** Redis key holding the capture-side enforcement schema for a project. */
const schemaCacheKey = (projectId: string) => `capture:schema:${projectId}`

type SchemaCacheEntry = {
  mode: 'warn' | 'strict'
  required: string[]
  types: Record<string, 'String' | 'Numeric' | 'Boolean' | 'DateTime'>
}

type EnforcedEventRow = Pick<EventDefinitionRow, 'name' | 'enforcementMode'>
type EventPropertyLinkRow = { eventName: string; propertyName: string; required: boolean }
type EventPropertyLink = { propertyName: string; required: boolean }

/** Enforced events + their property links/types, fetched in parallel. */
async function fetchSchemaCacheInputs(pdb: ScopedPrismaClient) {
  const [events, links, properties] = await Promise.all([
    pdb.eventDefinition.findMany({ where: { enforcementMode: { not: 'none' } } }),
    pdb.eventProperty.findMany(),
    pdb.propertyDefinition.findMany({ where: { scope: 'event' } }),
  ])
  return { events, links, properties }
}

/** Group event→property links by event name for O(1) lookup while building entries. */
function indexLinksByEvent(links: EventPropertyLinkRow[]): Map<string, EventPropertyLink[]> {
  const linksByEvent = new Map<string, EventPropertyLink[]>()
  for (const link of links) {
    const entry = { propertyName: link.propertyName, required: link.required }
    const existing = linksByEvent.get(link.eventName)
    if (existing) existing.push(entry)
    else linksByEvent.set(link.eventName, [entry])
  }
  return linksByEvent
}

/** Build one event's cache entry from its links + the project's declared property types. */
function buildSchemaCacheEntry(
  event: EnforcedEventRow,
  eventLinks: EventPropertyLink[],
  propertyTypeByName: Map<string, PropertyDefinitionRow['propertyType']>,
): SchemaCacheEntry {
  const types: SchemaCacheEntry['types'] = {}
  for (const link of eventLinks) {
    const propertyType = propertyTypeByName.get(link.propertyName)
    if (propertyType) types[link.propertyName] = propertyType
  }
  return {
    mode: event.enforcementMode as 'warn' | 'strict',
    required: eventLinks.filter((l) => l.required).map((l) => l.propertyName),
    types,
  }
}

/** Best-effort write: ingest-rs falls back to permissive behavior on a missing/stale key. */
async function writeSchemaCache(projectId: string, schema: Record<string, SchemaCacheEntry>) {
  try {
    await redis.set(schemaCacheKey(projectId), JSON.stringify(schema))
  } catch {
    // Transient Redis failure must not block the mutation that triggered this sync.
  }
}

/**
 * Rebuild and persist the `capture:schema:<project_id>` Redis blob consumed by
 * services/ingest to validate/warn on incoming events. Only events with
 * enforcementMode != 'none' are included — unenforced events need no
 * validation info at the hot path, keeping the payload small. Called after
 * every mutation below that can change enforcement config (events.create,
 * events.update, events.setSchema) so ingest-rs never reads stale rules.
 */
async function syncSchemaCache(pdb: ScopedPrismaClient, projectId: string): Promise<void> {
  const { events, links, properties } = await fetchSchemaCacheInputs(pdb)
  const propertyTypeByName = new Map(properties.map((p) => [p.name, p.propertyType]))
  const linksByEvent = indexLinksByEvent(links)

  const schema: Record<string, SchemaCacheEntry> = {}
  for (const event of events) {
    schema[event.name] = buildSchemaCacheEntry(
      event,
      linksByEvent.get(event.name) ?? [],
      propertyTypeByName,
    )
  }

  await writeSchemaCache(projectId, schema)
}

const eventsRouter = router({
  list: requirePermission('projects:read')
    .input(
      z.object({
        projectId: z.string(),
        search: z.string().optional(),
        includeHidden: z.boolean().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const { events } = await loadSnapshot(pdb, input.projectId)
      return events.filter((e) => {
        if (!input.includeHidden && e.hidden) return false
        if (input.search && !matchesSearch(e.name, input.search)) return false
        return true
      })
    }),

  update: requirePermission('projects:manage')
    .input(
      z.object({
        projectId: z.string(),
        id: z.string(),
        description: z.string().nullable().optional(),
        verified: z.boolean().optional(),
        hidden: z.boolean().optional(),
        enforcementMode: enforcementModeSchema.optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const { count } = await pdb.eventDefinition.updateMany({
        where: { id: input.id },
        data: {
          ...(input.description !== undefined && { description: input.description }),
          ...(input.verified !== undefined && { verified: input.verified }),
          ...(input.hidden !== undefined && { hidden: input.hidden }),
          ...(input.enforcementMode !== undefined && { enforcementMode: input.enforcementMode }),
        },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Event definition not found.' })
      }
      await cacheBust(cacheKey(input.projectId))
      await syncSchemaCache(pdb, input.projectId)
      const updated = await pdb.eventDefinition.findFirstOrThrow({ where: { id: input.id } })
      return serializeEvent(updated)
    }),

  // Registers a new EventDefinition. Auto-discovery (ingest-rs) may already
  // have created this row from observed traffic, so this behaves as
  // "ensure this event exists with this config" (upsert) rather than a
  // strict insert-or-fail — callers shouldn't have to know whether discovery
  // beat them to it.
  create: requirePermission('projects:manage')
    .input(
      z.object({
        projectId: z.string(),
        name: z.string().min(1),
        enforcementMode: enforcementModeSchema.optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const event = await pdb.eventDefinition.upsert({
        where: { projectId_name: { projectId: input.projectId, name: input.name } },
        create: {
          id: newId(),
          projectId: input.projectId,
          name: input.name,
          enforcementMode: input.enforcementMode ?? 'none',
        },
        update: {
          ...(input.enforcementMode !== undefined && { enforcementMode: input.enforcementMode }),
        },
      })
      await cacheBust(cacheKey(input.projectId))
      await syncSchemaCache(pdb, input.projectId)
      return serializeEvent(event)
    }),

  // Bulk-defines/updates the property schema for an event: locks each
  // property's type and marks which properties are required, then rewrites
  // the enforcement cache ingest-rs reads on the hot path. Wrapped in a
  // transaction since it can touch several rows across two tables.
  setSchema: requirePermission('projects:manage')
    .input(
      z.object({
        projectId: z.string(),
        event: z.string().min(1),
        properties: z.array(
          z.object({
            name: z.string().min(1),
            type: propertyTypeSchema,
            required: z.boolean(),
          }),
        ),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      await pdb.$transaction(async (tx) => {
        for (const prop of input.properties) {
          await tx.propertyDefinition.upsert({
            where: {
              projectId_name_scope: {
                projectId: input.projectId,
                name: prop.name,
                scope: 'event',
              },
            },
            create: {
              id: newId(),
              projectId: input.projectId,
              name: prop.name,
              scope: 'event',
              propertyType: prop.type,
              typeLocked: true,
            },
            update: { propertyType: prop.type, typeLocked: true },
          })
          await tx.eventProperty.upsert({
            where: {
              projectId_eventName_propertyName: {
                projectId: input.projectId,
                eventName: input.event,
                propertyName: prop.name,
              },
            },
            create: {
              id: newId(),
              projectId: input.projectId,
              eventName: input.event,
              propertyName: prop.name,
              required: prop.required,
            },
            update: { required: prop.required },
          })
        }
      })
      await cacheBust(cacheKey(input.projectId))
      await syncSchemaCache(pdb, input.projectId)
      return { ok: true }
    }),
})

const propertiesRouter = router({
  list: requirePermission('projects:read')
    .input(
      z.object({
        projectId: z.string(),
        scope: propertyScopeSchema,
        search: z.string().optional(),
        eventName: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const { properties, eventProperties } = await loadSnapshot(pdb, input.projectId)

      // When an eventName is supplied, restrict to properties observed on that
      // event (contextual autocomplete) via the EventProperty link table, and
      // carry along each property's `required` flag for that event so callers
      // like the schema editor can pre-fill current state without a second
      // round-trip.
      let requiredByName: Map<string, boolean> | null = null
      if (input.eventName) {
        requiredByName = new Map(
          eventProperties
            .filter((l) => l.eventName === input.eventName)
            .map((l) => [l.propertyName, l.required]),
        )
      }

      return properties
        .filter((p) => {
          if (p.scope !== input.scope) return false
          if (p.hidden) return false
          if (requiredByName && !requiredByName.has(p.name)) return false
          if (input.search && !matchesSearch(p.name, input.search)) return false
          return true
        })
        .map((p) => ({ ...p, required: requiredByName?.get(p.name) }))
    }),

  update: requirePermission('projects:manage')
    .input(
      z.object({
        projectId: z.string(),
        id: z.string(),
        description: z.string().nullable().optional(),
        verified: z.boolean().optional(),
        hidden: z.boolean().optional(),
        propertyType: propertyTypeSchema.optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const { count } = await pdb.propertyDefinition.updateMany({
        where: { id: input.id },
        data: {
          ...(input.description !== undefined && { description: input.description }),
          ...(input.verified !== undefined && { verified: input.verified }),
          ...(input.hidden !== undefined && { hidden: input.hidden }),
          // Setting the type is an explicit override — lock it so discovery
          // (ingest-rs) never silently re-infers it later.
          ...(input.propertyType !== undefined && {
            propertyType: input.propertyType,
            typeLocked: true,
          }),
        },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Property definition not found.' })
      }
      await cacheBust(cacheKey(input.projectId))
      const updated = await pdb.propertyDefinition.findFirstOrThrow({ where: { id: input.id } })
      return serializeProperty(updated)
    }),
})

export const taxonomyRouter = router({
  events: eventsRouter,
  properties: propertiesRouter,
})
