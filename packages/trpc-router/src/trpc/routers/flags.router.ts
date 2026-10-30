import {
  type Environment,
  effectiveLimits,
  type FlagAuditAction,
  newId,
  Prisma,
  prisma,
  type ScopedPrismaClient,
} from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { assertUnderQuota } from '../../lib/quota.guard.js'
import { requirePermission, router, scopedForProject } from '../trpc.js'
import { rebuildFlagCache, recordFlagAudit } from './flags.cache.js'

// Plain (non-Prisma-inferred) shape for `flags.history` output — keeps the
// client-side router type from chasing Prisma's generic client types through
// the ScopedPrismaClient extension (hits TS's type-instantiation depth limit
// otherwise, TS2589).
type FlagAuditHistoryItem = {
  id: string
  flagId: string
  projectId: string
  action: FlagAuditAction
  actorUserId: string
  diff: unknown
  version: number
  createdAt: Date
  actor: { id: string; name: string | null; email: string }
}

// ── /: strict `filters` JSON schema ────────────────────────────
// MVP operators. Any other operator is rejected by Zod.
const operatorSchema = z.enum(['exact', 'is_not', 'icontains', 'gt', 'lt', 'is_set'])

const propertySchema = z
  .object({
    key: z.string(),
    operator: operatorSchema,
    // value is operator-dependent (string/number/bool) and nullable (is_set
    // ignores it). Kept permissive on type; server does not evaluate.
    value: z.any().nullable(),
  })
  .strict()

const groupSchema = z
  .object({
    properties: z.array(propertySchema),
    rollout_percentage: z.number().int().min(0).max(100),
    // Pin the group to a variant, or null for boolean/first-variant behaviour.
    variant: z.string().nullable(),
    // Boolean value a matched, in-rollout user is served. Absent means `true`
    // (every group written before this field existed). `false` lets a boolean
    // flag serve OFF to a targeted cohort and fall through to a trailing
    // catch-all group serving ON — the boolean "default".
    serve: z.boolean().optional(),
  })
  .strict()

const multivariateSchema = z
  .object({
    variants: z.array(
      z
        .object({
          key: z.string(),
          rollout_percentage: z.number().int().min(0).max(100),
        })
        .strict(),
    ),
  })
  .strict()

const filtersSchema = z
  .object({
    groups: z.array(groupSchema),
    // OMITTED for boolean flags.
    multivariate: multivariateSchema.optional(),
    // variant key -> arbitrary payload JSON.
    payloads: z.record(z.string(), z.any()).optional(),
    // Pure UI hint distinguishing string vs number multivariate flags from
    // boolean ones — never read by the evaluator (SDK + Rust ingest/capture).
    kind: z.enum(['boolean', 'string', 'number']).optional(),
  })
  .strict()

export type FlagFilters = z.infer<typeof filtersSchema>

// Env now travels as a per-project Environment slug (`Environment.key`), not a
// fixed enum — custom environments). The slug is still the wire/cache
// contract (Redis, capture-rs); this schema just validates shape, not
// membership — every procedure below resolves the slug against the project's
// actual `Environment` rows and throws NOT_FOUND on an unknown one.
export const envSlugSchema = z.string().min(1)
export type EnvSlug = z.infer<typeof envSlugSchema>

const patchSchema = z
  .object({
    name: z.string().nullable().optional(),
    env: envSlugSchema.optional(),
    tags: z.array(z.string()).optional(),
    filters: filtersSchema.optional(),
    // exposure-tracking toggle. Gated by the running-experiment pin —
    // a `false` write while a running experiment references the flag is rejected
    // (see `assertTrackNotPinned`).
    track: z.boolean().optional(),
  })
  .strict()

// Message surfaced by the flag-update pin guard; the web UI matches on it to
// explain why the toggle can't be turned off.
export const TRACK_PIN_ERROR_MESSAGE =
  'Cannot disable exposure tracking while a running experiment uses this flag.'

/**
 * A flag referenced by a **running** experiment must keep `track = true` — the
 * experiment's exposure denominator ($feature_flag_called) depends on it.
 * Rejects a `track: false` write while such an experiment exists; a
 * stopped/archived/deleted experiment releases the pin. A no-op for any write
 * that isn't setting `track` to false.
 */
export async function assertTrackNotPinned(
  pdb: ScopedPrismaClient,
  flagId: string,
  nextTrack: boolean | undefined,
): Promise<void> {
  if (nextTrack !== false) return
  const running = await pdb.experiment.findFirst({
    where: { featureFlagId: flagId, status: 'running', deletedAt: null },
    select: { id: true },
  })
  if (running) {
    throw new TRPCError({ code: 'CONFLICT', message: TRACK_PIN_ERROR_MESSAGE })
  }
}

/** Resolve a project's env slug to its `Environment` row; NOT_FOUND on a miss. */
export async function resolveEnvironment(
  pdb: ScopedPrismaClient,
  projectId: string,
  slug: string,
): Promise<Environment> {
  const environment = await pdb.environment.findFirst({ where: { projectId, key: slug } })
  if (!environment) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `Unknown environment "${slug}".` })
  }
  return environment
}

/** The project's `isDefault` environment (fallback: its earliest-created one). */
export async function defaultEnvironment(
  pdb: ScopedPrismaClient,
  projectId: string,
): Promise<Environment> {
  const isDefault = await pdb.environment.findFirst({ where: { projectId, isDefault: true } })
  if (isDefault) return isDefault
  const first = await pdb.environment.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
  })
  if (first) return first
  // Legacy project created before `projects.create` bootstrapped environments:
  // heal it lazily rather than 500ing.
  try {
    return await pdb.environment.create({
      data: {
        id: newId(),
        projectId,
        key: 'production',
        name: 'Production',
        isDefault: true,
      },
    })
  } catch (err) {
    // Concurrent healer won the (projectId, key) unique race.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return pdb.environment.findFirstOrThrow({ where: { projectId, isDefault: true } })
    }
    throw err
  }
}

// Raw Prisma row shape (with the `environment` relation joined) mapped back to
// the wire shape the API has always returned: an `env` slug string alongside
// `environmentId`, keeping existing consumers (web, tests) working unchanged.
function withEnvSlug<T extends { environment: { key: string } }>(
  flag: T,
): Omit<T, 'environment'> & { env: string } {
  const { environment, ...rest } = flag
  return { ...rest, env: environment.key }
}

const FLAG_WITH_ENV_INCLUDE = { environment: { select: { key: true } } } as const

export const flagsRouter = router({
  list: requirePermission('flags:read')
    .input(z.object({ projectId: z.string(), env: envSlugSchema }))
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const environment = await resolveEnvironment(pdb, input.projectId, input.env)
      const rows = await pdb.featureFlag.findMany({
        where: { deletedAt: null, environmentId: environment.id },
        orderBy: { key: 'asc' },
        include: FLAG_WITH_ENV_INCLUDE,
      })
      return rows.map(withEnvSlug)
    }),

  history: requirePermission('flags:read')
    .input(
      z.object({
        projectId: z.string(),
        flagId: z.string(),
        cursor: z.string().nullish(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(
      async ({
        input,
        ctx,
      }): Promise<{ items: FlagAuditHistoryItem[]; nextCursor: string | null }> => {
        const pdb = await scopedForProject(ctx, input.projectId)
        const rows = await pdb.flagAudit.findMany({
          where: { flagId: input.flagId },
          orderBy: { createdAt: 'desc' },
          take: input.limit + 1,
          ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
        })
        const hasMore = rows.length > input.limit
        const page = hasMore ? rows.slice(0, input.limit) : rows

        // Actors are looked up separately (not via `include`) — User carries no
        // tenant column, so it passes through the scoped client untouched.
        const actorIds = [...new Set(page.map((r) => r.actorUserId))]
        const actors = await pdb.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true, email: true },
        })
        const actorById = new Map(actors.map((a) => [a.id, a]))
        const items: FlagAuditHistoryItem[] = page.map((r) => ({
          ...r,
          actor: actorById.get(r.actorUserId) ?? {
            id: r.actorUserId,
            name: null,
            email: 'unknown',
          },
        }))

        return { items, nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null }
      },
    ),

  counts: requirePermission('flags:read')
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      // Aggregate over the project's actual Environment rows rather
      // than a fixed enum's `.options` — a project may have any number of
      // custom environments now.
      const environments = await pdb.environment.findMany({ where: { projectId: input.projectId } })
      const rows = await pdb.featureFlag.groupBy({
        by: ['environmentId', 'active'],
        where: { deletedAt: null },
        _count: { _all: true },
      })
      const byEnvironmentId = new Map<string, { total: number; active: number }>()
      for (const env of environments) byEnvironmentId.set(env.id, { total: 0, active: 0 })
      for (const row of rows) {
        const entry = byEnvironmentId.get(row.environmentId) ?? { total: 0, active: 0 }
        entry.total += row._count._all
        if (row.active) entry.active += row._count._all
        byEnvironmentId.set(row.environmentId, entry)
      }
      return environments.map((env) => ({
        env: env.key,
        ...(byEnvironmentId.get(env.id) ?? { total: 0, active: 0 }),
      }))
    }),

  get: requirePermission('flags:read')
    .input(z.object({ projectId: z.string(), key: z.string(), env: envSlugSchema }))
    .query(async ({ input, ctx }) => {
      // `pdb` is already project-scoped (scopedForProject binds it to projectId
      // via createScopedClient), so an explicit projectId filter here would be
      // redundant — the scoped client fails closed on any other project.
      const pdb = await scopedForProject(ctx, input.projectId)
      const environment = await resolveEnvironment(pdb, input.projectId, input.env)
      const flag = await pdb.featureFlag.findFirst({
        where: { key: input.key, environmentId: environment.id, deletedAt: null },
        include: FLAG_WITH_ENV_INCLUDE,
      })
      if (!flag) throw new TRPCError({ code: 'NOT_FOUND', message: 'Feature flag not found.' })
      return withEnvSlug(flag)
    }),

  create: requirePermission('flags:write')
    .input(
      z.object({
        projectId: z.string(),
        key: z.string().min(1),
        name: z.string().optional(),
        active: z.boolean(),
        env: envSlugSchema.optional(),
        tags: z.array(z.string()).optional(),
        filters: filtersSchema,
        // defaults false — a manual/operational gate stays silent.
        // Experiment-created flags set this true via the experiments router.
        track: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const environment =
        input.env !== undefined
          ? await resolveEnvironment(pdb, input.projectId, input.env)
          : await defaultEnvironment(pdb, input.projectId)

      // Lifetime flags-created quota is counted across the WHOLE ORG (all
      // projects), not just this project — `pdb` is project-scoped and would
      // fail closed on an org-wide query, so this goes through the raw
      // (unscoped) client with an explicit `project.orgId` filter instead.
      const org = await ctx.db.org.findFirst({ include: { plan: true } })
      const flagCount = await prisma.featureFlag.count({
        where: { deletedAt: null, project: { orgId: ctx.orgId } },
      })
      assertUnderQuota('flags', flagCount, effectiveLimits(org ?? {}, org?.plan ?? null).maxFlags)

      let flag: Awaited<ReturnType<typeof pdb.featureFlag.create>>
      try {
        flag = await pdb.featureFlag.create({
          data: {
            id: newId(),
            projectId: input.projectId,
            key: input.key,
            name: input.name,
            active: input.active,
            track: input.track ?? false,
            environmentId: environment.id,
            ...(input.tags !== undefined && { tags: input.tags }),
            filters: input.filters,
          },
        })
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `A feature flag with key "${input.key}" already exists.`,
          })
        }
        throw err
      }
      await rebuildFlagCache(pdb, input.projectId, environment)
      await recordFlagAudit(pdb, {
        flagId: flag.id,
        projectId: input.projectId,
        action: 'created',
        actorUserId: ctx.tokenPayload.sub,
        diff: { before: null, after: { active: flag.active, filters: flag.filters } },
        version: flag.version,
      })
      return { ...flag, env: environment.key }
    }),

  update: requirePermission('flags:write')
    .input(z.object({ projectId: z.string(), id: z.string(), patch: patchSchema }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const existing = await pdb.featureFlag.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { active: true, filters: true, environment: { select: { id: true, key: true } } },
      })
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Feature flag not found.' })
      }
      // Reject a `track: false` write while a running experiment pins it true.
      await assertTrackNotPinned(pdb, input.id, input.patch.track)
      const newEnvironment =
        input.patch.env !== undefined
          ? await resolveEnvironment(pdb, input.projectId, input.patch.env)
          : undefined
      const { count } = await pdb.featureFlag.updateMany({
        where: { id: input.id, deletedAt: null },
        // `version` is unconditionally incremented, so a lone `track` flip still
        // bumps the blob's top-level version and reaches capture-rs.
        data: {
          version: { increment: 1 },
          ...(input.patch.name !== undefined && { name: input.patch.name }),
          ...(newEnvironment !== undefined && { environmentId: newEnvironment.id }),
          ...(input.patch.tags !== undefined && { tags: input.patch.tags }),
          ...(input.patch.filters !== undefined && { filters: input.patch.filters }),
          ...(input.patch.track !== undefined && { track: input.patch.track }),
        },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Feature flag not found.' })
      }
      // env is part of the unique key: changing it moves the row into another
      // cache partition, so both the old and new env caches need a rebuild.
      if (newEnvironment !== undefined && newEnvironment.id !== existing.environment.id) {
        await rebuildFlagCache(pdb, input.projectId, existing.environment)
        await rebuildFlagCache(pdb, input.projectId, newEnvironment)
      } else {
        await rebuildFlagCache(pdb, input.projectId, existing.environment)
      }
      const updated = await pdb.featureFlag.findFirstOrThrow({
        where: { id: input.id },
        include: FLAG_WITH_ENV_INCLUDE,
      })
      await recordFlagAudit(pdb, {
        flagId: updated.id,
        projectId: input.projectId,
        action: 'updated',
        actorUserId: ctx.tokenPayload.sub,
        diff: {
          before: { active: existing.active, filters: existing.filters },
          after: { active: updated.active, filters: updated.filters },
        },
        version: updated.version,
      })
      return withEnvSlug(updated)
    }),

  toggle: requirePermission('flags:write')
    .input(z.object({ projectId: z.string(), id: z.string(), active: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const existing = await pdb.featureFlag.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { active: true, environment: { select: { id: true, key: true } } },
      })
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Feature flag not found.' })
      }
      const { count } = await pdb.featureFlag.updateMany({
        where: { id: input.id, deletedAt: null },
        data: { active: input.active, version: { increment: 1 } },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Feature flag not found.' })
      }
      await rebuildFlagCache(pdb, input.projectId, existing.environment)
      const updated = await pdb.featureFlag.findFirstOrThrow({
        where: { id: input.id },
        include: FLAG_WITH_ENV_INCLUDE,
      })
      await recordFlagAudit(pdb, {
        flagId: updated.id,
        projectId: input.projectId,
        action: 'toggled',
        actorUserId: ctx.tokenPayload.sub,
        diff: { before: { active: existing.active }, after: { active: updated.active } },
        version: updated.version,
      })
      return withEnvSlug(updated)
    }),

  delete: requirePermission('flags:write')
    .input(z.object({ projectId: z.string(), id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const existing = await pdb.featureFlag.findFirst({
        where: { id: input.id, deletedAt: null },
        select: {
          active: true,
          filters: true,
          version: true,
          environment: { select: { id: true, key: true } },
        },
      })
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Feature flag not found.' })
      }
      const { count } = await pdb.featureFlag.updateMany({
        where: { id: input.id, deletedAt: null },
        data: { deletedAt: new Date() },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Feature flag not found.' })
      }
      await rebuildFlagCache(pdb, input.projectId, existing.environment)
      await recordFlagAudit(pdb, {
        flagId: input.id,
        projectId: input.projectId,
        action: 'deleted',
        actorUserId: ctx.tokenPayload.sub,
        diff: { before: { active: existing.active, filters: existing.filters }, after: null },
        version: existing.version,
      })
      return { id: input.id, deleted: true }
    }),
})
