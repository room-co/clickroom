// IMPORTANT: `./env` must be imported first — it loads `.env.e2e` and sets
// `process.env.DATABASE_URL` as a side effect *before* `@clickroom/db` is
// imported below. `@clickroom/db`'s `prisma` singleton (packages/db/src/client.ts)
// constructs its `PrismaPg` adapter from `process.env.DATABASE_URL` at module
// **import** time, so import order here is load-bearing.
import './env'
import { prisma } from '@clickroom/db'

/**
 * Seed data (packages/db/src/seed.e2e.ts) generates org/project ids at
 * runtime via `newId()` (ULID) rather than fixed values, so tests resolve
 * them by their known, stable natural keys (org slug / project name) via a
 * plain DB lookup instead of hardcoding ids.
 */
export async function getOrgIdBySlug(slug: string): Promise<string> {
  const org = await prisma.org.findUniqueOrThrow({ where: { slug } })
  return org.id
}

export async function getProjectIdBySlug(orgSlug: string, projectName: string): Promise<string> {
  const org = await prisma.org.findUniqueOrThrow({ where: { slug: orgSlug } })
  const project = await prisma.project.findFirstOrThrow({
    where: { orgId: org.id, name: projectName },
  })
  return project.id
}

/**
 * Direct DB soft-delete of a `FeatureFlag` by `(projectId, key)`, bypassing
 * the UI/API entirely — for specs' crash-proof cleanup (`test.afterEach`/
 * `finally`) so a flag a test created always stops counting against the
 * `e2e` org's `maxFlags` quota (`assertUnderQuota('flags', ...)` in
 * `apps/api/src/trpc/routers/flags.router.ts`, which counts
 * `deletedAt: null` rows) even if the test body throws or times out before
 * reaching its own UI-driven delete step. Soft-delete (not a hard `delete`)
 * to match the app's own delete semantics and avoid the `ON DELETE
 * RESTRICT` FK from `FlagAudit`/`Experiment` onto `FeatureFlag.id` that a
 * hard delete could violate once a flag has audit rows or a linked
 * experiment.
 *
 * No-op (does not throw) if no matching, not-already-deleted flag exists —
 * safe to call unconditionally from cleanup code regardless of how far a
 * test got before failing.
 */
export async function deleteFeatureFlagByKey(projectId: string, key: string): Promise<void> {
  await prisma.featureFlag.updateMany({
    where: { projectId, key, deletedAt: null },
    data: { deletedAt: new Date() },
  })
}

export { prisma }
