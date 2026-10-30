// Shared org-bootstrap helper.
//
// Both apps/api AuthService.signup and packages/db seed must create the exact
// same starter shape for a new org, so the logic lives here in ONE place:
//   - Org (id, name, slug)
//   - admin OrgMembership for the creating user
//   - a "Default" Project
//   - system EventDefinitions   ($autocapture, $pageview, $identify — isSystem)
//   - system PropertyDefinitions ($current_url, $event_type — scope=event)
//
// All primary keys are app-supplied ULIDs (newId()). The caller resolves a
// unique slug (see uniqueOrgSlug) and passes it in; this helper never mutates
// the slug it is given.

import { Prisma, type PrismaClient } from '@prisma/client'
import { newId } from './client.js'
import { defaultPlanKey, type EffectiveLimits, effectiveLimits } from './limits.js'

/** Lowercase, hyphenate, strip non-url-safe chars. Empty input → "org". */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'org'
}

/** A Prisma client (tx or base) that can look up an org by slug. */
interface OrgSlugLookup {
  org: { findUnique(args: { where: { slug: string } }): Promise<{ id: string } | null> }
}

/**
 * Resolve a unique org slug from a display name. Appends a short random suffix
 * on collision until an unused slug is found.
 */
export async function uniqueOrgSlug(client: OrgSlugLookup, orgName: string): Promise<string> {
  const base = slugify(orgName)
  let slug = base
  while (await client.org.findUnique({ where: { slug } })) {
    slug = `${base}-${newId().slice(-4).toLowerCase()}`
  }
  return slug
}

const SYSTEM_EVENTS = ['$autocapture', '$pageview', '$identify'] as const
const SYSTEM_PROPERTIES = ['$current_url', '$event_type'] as const

/** Minimal client surface for environment bootstrapping (tx, base or scoped client). */
interface EnvironmentWriter {
  environment: {
    create(args: {
      data: { id: string; projectId: string; key: string; name: string; isDefault: boolean }
    }): Promise<{ id: string; key: string }>
  }
}

/**
 * Create the starter environments (`production` default + `development`) for a
 * project. Shared by org bootstrap (signup/seed) and `projects.create` so every
 * project is born with an environment — key/flag creation resolves the default
 * env and hard-fails on a project that has none.
 */
export async function createDefaultEnvironments(
  tx: EnvironmentWriter,
  projectId: string,
): Promise<{
  production: { id: string; key: string }
  development: { id: string; key: string }
}> {
  const production = await tx.environment.create({
    data: { id: newId(), projectId, key: 'production', name: 'Production', isDefault: true },
  })
  const development = await tx.environment.create({
    data: { id: newId(), projectId, key: 'development', name: 'Development', isDefault: false },
  })
  return { production, development }
}

/** Minimal client surface for definition seeding (tx, base or scoped client). */
interface DefinitionWriter {
  eventDefinition: {
    createMany(args: {
      data: { id: string; projectId: string; name: string; isSystem: boolean }[]
      skipDuplicates: boolean
    }): Promise<unknown>
  }
  propertyDefinition: {
    createMany(args: {
      data: {
        id: string
        projectId: string
        name: string
        scope: 'event'
        verified: boolean
      }[]
      skipDuplicates: boolean
    }): Promise<unknown>
  }
}

/**
 * Seed the system event ($autocapture, $pageview, $identify) and property
 * ($current_url, $event_type) definitions for a project. `skipDuplicates` makes it
 * idempotent and race-safe (ON CONFLICT DO NOTHING on the unique name keys), so it
 * is shared by org bootstrap, `projects.create` and the boot-time backfill.
 */
export async function seedSystemDefinitions(
  tx: DefinitionWriter,
  projectId: string,
): Promise<void> {
  await tx.eventDefinition.createMany({
    data: SYSTEM_EVENTS.map((name) => ({ id: newId(), projectId, name, isSystem: true })),
    skipDuplicates: true,
  })
  await tx.propertyDefinition.createMany({
    data: SYSTEM_PROPERTIES.map((name) => ({
      id: newId(),
      projectId,
      name,
      scope: 'event' as const,
      verified: true,
    })),
    skipDuplicates: true,
  })
}

/** Project ids whose count of matching definitions is below `expected`. */
async function projectsMissing(
  allIds: string[],
  counts: { projectId: string; _count: { _all: number } }[],
  expected: number,
): Promise<Set<string>> {
  const have = new Map(counts.map((c) => [c.projectId, c._count._all]))
  return new Set(allIds.filter((id) => (have.get(id) ?? 0) < expected))
}

/**
 * Idempotent backfill: seed system definitions for every project missing any of
 * them (projects created via `projects.create` before the fix). Two grouped
 * counts + one id scan, so a boot with nothing to repair does no writes.
 * Returns the number of projects repaired.
 */
export async function backfillSystemDefinitions(client: PrismaClient): Promise<number> {
  const [projects, eventCounts, propCounts] = await Promise.all([
    client.project.findMany({ select: { id: true } }),
    client.eventDefinition.groupBy({
      by: ['projectId'],
      where: { name: { in: [...SYSTEM_EVENTS] } },
      _count: { _all: true },
    }),
    client.propertyDefinition.groupBy({
      by: ['projectId'],
      where: { name: { in: [...SYSTEM_PROPERTIES] }, scope: 'event' },
      _count: { _all: true },
    }),
  ])
  const ids = projects.map((p) => p.id)
  const missing = new Set([
    ...(await projectsMissing(ids, eventCounts, SYSTEM_EVENTS.length)),
    ...(await projectsMissing(ids, propCounts, SYSTEM_PROPERTIES.length)),
  ])
  for (const id of missing) {
    await client.$transaction((tx) => seedSystemDefinitions(tx, id))
  }
  return missing.size
}

/**
 * Idempotent backfill: give every project that has NO environments the default
 * pair. Projects created via `projects.create` before the fix are in this state.
 * Returns the number of projects repaired.
 */
export async function backfillProjectEnvironments(client: PrismaClient): Promise<number> {
  const orphans = await client.project.findMany({
    where: { environments: { none: {} } },
    select: { id: true },
  })
  let repaired = 0
  for (const { id } of orphans) {
    try {
      await client.$transaction((tx) => createDefaultEnvironments(tx, id))
      repaired++
    } catch (err) {
      // Lost a race with another booting replica / lazy fallback: already repaired.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err
    }
  }
  return repaired
}

export interface BootstrapOrgInput {
  orgName: string
  slug: string
  userId: string
}

export interface BootstrapOrgResult {
  org: { id: string; name: string; slug: string }
  project: { id: string; name: string }
  // Newly seeded environments for the Default project — `production`
  // is `isDefault`, `development` is not. Callers (signup flow, seed) use these
  // ids to attach initial API keys/flags without a second query.
  environments: {
    production: { id: string; key: string }
    development: { id: string; key: string }
  }
  // Newly seeded default DataSource for the Default project — the
  // sole `clickhouse` row, `isDefault: true`. No caller needs the id post-
  // bootstrap yet, but returned now for the same reason `environments` is.
  dataSource: { id: string }
  // Effective quota limits for the freshly bootstrapped org — no
  // overrides exist yet, so this is just the plan's values (or all-zero if
  // `free` hasn't been seeded). Callers with Redis access (apps/api) use this
  // to write the `usage:limits:<org_id>` mirror without a second query.
  limits: EffectiveLimits
}

/**
 * Create the starter shape for a brand-new org inside an existing transaction.
 * The caller owns the transaction (so signup can also create the user + session
 * atomically) and must have already resolved a unique `slug`.
 */
export async function bootstrapOrg(
  tx: Prisma.TransactionClient,
  { orgName, slug, userId }: BootstrapOrgInput,
): Promise<BootstrapOrgResult> {
  // Attach the default (`free`) plan by key if it has been seeded. Look up
  // rather than assume a fixed id so `seed.ts`'s upsert remains the single
  // source of truth for plan ids.
  const defaultPlan = await tx.plan.findUnique({ where: { key: defaultPlanKey() } })

  const org = await tx.org.create({
    data: { id: newId(), name: orgName, slug, planId: defaultPlan?.id },
  })

  await tx.orgMembership.create({
    data: { id: newId(), orgId: org.id, userId, role: 'org_admin' },
  })

  const project = await tx.project.create({
    data: { id: newId(), orgId: org.id, name: 'Default' },
  })

  const { production: productionEnv, development: developmentEnv } =
    await createDefaultEnvironments(tx, project.id)

  await seedSystemDefinitions(tx, project.id)

  const dataSource = await tx.dataSource.create({
    data: {
      id: newId(),
      projectId: project.id,
      name: 'Clickroom ClickHouse',
      type: 'clickhouse',
      status: 'connected',
      isDefault: true,
      config: {},
      createdBy: userId,
    },
  })

  return {
    org: { id: org.id, name: org.name, slug: org.slug },
    project: { id: project.id, name: project.name },
    environments: {
      production: { id: productionEnv.id, key: productionEnv.key },
      development: { id: developmentEnv.id, key: developmentEnv.key },
    },
    dataSource: { id: dataSource.id },
    limits: effectiveLimits(org, defaultPlan),
  }
}
