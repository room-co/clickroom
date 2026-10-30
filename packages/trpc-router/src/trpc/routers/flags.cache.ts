import {
  type Environment,
  type FlagAuditAction,
  newId,
  type Prisma,
  type ScopedPrismaClient,
} from '@clickroom/db'
import { cacheSetJson, redis } from '../../lib/redis.js'

export const flagsChangedChannel = (projectId: string) => `flags:changed:${projectId}`

// The flag-definitions blob lives under this key and is read by capture-rs (09)
// to evaluate flags without a Postgres round-trip. Long TTL: the api owns this
// key and rewrites it on every flag mutation, so staleness is bounded by writes,
// not by expiry. A day of TTL just bounds drift if a write path is ever missed.
// `env` is now part of the FeatureFlag unique key (projectId, key, environmentId),
// so the cache is partitioned per-env too — each env gets its own blob/key.
// Env is a per-project `Environment` entity, not a fixed enum — the
// slug (`Environment.key`) stays the wire/cache contract unchanged, it just
// arrives as a plain string now instead of a `FlagEnv` union member.
const CACHE_TTL_SECONDS = 86_400
export const flagCacheKey = (projectId: string, env: string) => `flags:def:${projectId}:${env}`

// : the blob shape written by TS on every flag write.
export type FlagBlobEntry = {
  key: string
  active: boolean
  // Gates the exposure write ($feature_flag_called) in the evaluator.
  // Carried through here so a flip on the flag reaches capture-rs on the next
  // version bump — the top-level `version` (sum of flag versions) changes on
  // every write, so any `track` edit re-invalidates the version gate.
  track: boolean
  filters: unknown
  version: number
}
export type FlagBlob = {
  version: number
  flags: FlagBlobEntry[]
}

/**
 * Rebuild and persist Redis blob for a project from Postgres.
 * Includes ALL non-deleted flags (active and inactive — evaluate() handles the
 * active gate). Top-level `version` is the sum of every included flag's version,
 * so any write changes it and consumers can cheaply detect a new definition set.
 * Called in-request after every create/update/toggle/delete, before returning.
 */
export async function rebuildFlagCache(
  pdb: ScopedPrismaClient,
  projectId: string,
  environment: Pick<Environment, 'id' | 'key'>,
): Promise<FlagBlob> {
  const rows = await pdb.featureFlag.findMany({
    where: { deletedAt: null, environmentId: environment.id },
    orderBy: { key: 'asc' },
  })

  const blob: FlagBlob = {
    version: rows.reduce((sum, f) => sum + f.version, 0),
    flags: rows.map((f) => ({
      key: f.key,
      active: f.active,
      track: f.track,
      filters: f.filters,
      version: f.version,
    })),
  }

  await cacheSetJson(flagCacheKey(projectId, environment.key), blob, CACHE_TTL_SECONDS)
  return blob
}

/**
 * Write the FlagAudit row for a mutation and publish a change notification on
 * `flags:changed:<projectId>`. The audit write is durable (part of
 * the request's normal error handling); the publish is best-effort — a missed
 * pub/sub message is a UI-freshness miss, not a correctness bug, since
 * evaluation itself re-reads the Redis cache on every request (09).
 */
export async function recordFlagAudit(
  pdb: ScopedPrismaClient,
  params: {
    flagId: string
    projectId: string
    action: FlagAuditAction
    actorUserId: string
    diff: unknown
    version: number
  },
): Promise<void> {
  await pdb.flagAudit.create({
    data: {
      id: newId(),
      flagId: params.flagId,
      projectId: params.projectId,
      action: params.action,
      actorUserId: params.actorUserId,
      diff: params.diff as Prisma.InputJsonValue,
      version: params.version,
    },
  })
  try {
    await redis.publish(
      flagsChangedChannel(params.projectId),
      JSON.stringify({ flagId: params.flagId, action: params.action, version: params.version }),
    )
  } catch {
    // Best-effort — see doc comment above.
  }
}
