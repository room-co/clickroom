import type { EffectiveLimits } from '@clickroom/db'
import { redis } from './redis.js'

// The two monthly-window limits mirrored for capture-rs — usage
// tracking + quotas). Redis is the enforcement path; Postgres (`Org`+`Plan`)
// is the fallback on cache miss (same GET-miss-fallback shape as capture-rs's
// `resolve_key`), so a failed/missing mirror write only costs an extra PG
// round-trip on the next capture-rs request, never correctness.
export const quotaLimitsCacheKey = (orgId: string) => `usage:limits:${orgId}`

/**
 * TTL (seconds) on the mirror.: the hash used to be written with no
 * expiry, so a bad value was immortal — the first prod deploy mirrored
 * `maxEventsPerMonth=0` (empty `Plan` table ⇒ `planId=NULL` ⇒ `effectiveLimits`
 * fails closed to 0) and every event AND every flag call 402'd forever, even
 * after Postgres was fixed, because nothing ever re-read Postgres.
 *
 * A TTL makes the mirror eventually consistent with Postgres regardless of who
 * wrote to Postgres or how — including direct SQL, which no application hook
 * can intercept — bounding any limits mistake to a 5-minute blip instead of a
 * permanent hard-stop. The fallback on expiry is one indexed `Org LEFT JOIN
 * Plan` by PK, so the re-resolve cost is negligible.
 */
export const QUOTA_LIMITS_TTL_SECONDS = 300

/**
 * Write (or rewrite) the `usage:limits:<org_id>` Redis hash consumed by
 * capture-rs's quota gate. Called on org bootstrap and on any future
 * plan/override/policy mutation (mirrors the `rebuildFlagCache`
 * rebuild-after-write pattern in `flags.cache.ts`) so the limits (and the
 * Overage policy) Redis holds are never stale relative to Postgres
 * for longer than one write.
 *
 * BigInt limits are stringified — Redis hash fields are strings; capture-rs
 * parses them back to `i64`/`u64` on read. `overagePolicy` is passed through
 * as-is (`'block' | 'allow'`), already a plain string.
 *
 * HSET + EXPIRE go out in one pipeline so a refresh can never leave the hash
 * behind without its expiry (which is exactly the immortal-key state this TTL
 * exists to prevent).
 */
export async function writeQuotaLimitsMirror(
  orgId: string,
  limits: EffectiveLimits,
): Promise<void> {
  try {
    const key = quotaLimitsCacheKey(orgId)
    await redis
      .multi()
      .hset(key, {
        maxEventsPerMonth: limits.maxEventsPerMonth.toString(),
        maxFlagCallsPerMonth: limits.maxFlagCallsPerMonth.toString(),
        overagePolicy: limits.overagePolicy,
      })
      .expire(key, QUOTA_LIMITS_TTL_SECONDS)
      .exec()
  } catch {
    // Best-effort — see doc comment above; capture-rs falls back to Postgres.
  }
}
