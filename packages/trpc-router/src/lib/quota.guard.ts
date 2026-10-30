import { TRPCError } from '@trpc/server'

// Lifetime-count quota gate for tRPC mutations.C — seats + flags
// created). Reads the same `QUOTA_ENFORCE` env var as capture-rs's monthly
// gate (`quota.rs`.B/D/E) so track-only mode can be flipped in one
// place across both the hot path (Rust) and the control plane (tRPC).
// Default is on (enforce) — set `QUOTA_ENFORCE=false` to count-only.
export function isQuotaEnforced(): boolean {
  return process.env.QUOTA_ENFORCE !== 'false'
}

export type QuotaMetric = 'seats' | 'flags'

const METRIC_LABEL: Record<QuotaMetric, string> = {
  seats: 'Seat',
  flags: 'Feature flag',
}

/**
 * Throw a quota-exceeded error when `current >= limit`. No-ops entirely when
 * `QUOTA_ENFORCE=false` (never throws, matching the Rust side's "counting
 * always happens, rejection is gated" semantics — these lifetime counts are
 * derived synchronously from Postgres, so there is nothing separate to count).
 *
 * There is no custom TRPCError code in this codebase (`TRPCError.code` is
 * typed to the standard TRPC_ERROR_CODE_KEY union) — `TOO_MANY_REQUESTS` is
 * otherwise unused by any router, so `error.data?.code === 'TOO_MANY_REQUESTS'`
 * reliably identifies a quota block on the client. The stable machine-readable
 * marker is carried in `cause.code` ('quota_exceeded') for server-side
 * logging/tests, and echoed in the message for quick debugging.
 */
export function assertUnderQuota(metric: QuotaMetric, current: number, limit: number): void {
  if (!isQuotaEnforced()) return
  if (current < limit) return
  throw new TRPCError({
    code: 'TOO_MANY_REQUESTS',
    message: `${METRIC_LABEL[metric]} limit reached (quota_exceeded): ${current}/${limit} used.`,
    cause: { code: 'quota_exceeded', metric, limit, current },
  })
}
