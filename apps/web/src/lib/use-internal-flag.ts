import { isFeatureEnabled, onFeatureFlags } from '@clickroom/sdk-js'
import { useEffect, useState } from 'react'
import { getDeployment } from '@/lib/runtime-config'

/**
 * Reads an internal `internal-*` rollout flag and keeps it live
 * across the SDK's own flag refreshes — the `feature_flag_poll_interval`
 * poll configured in `analytics.ts`'s `initAnalytics()`, or a manual
 * `identify()` re-fetch. Thin wrapper over the SDK's own
 * `isFeatureEnabled`/`onFeatureFlags`, mirroring the external-store shape of
 * `useFlagsStream.ts`.
 *
 * No-ops to `false` when no write key is configured: `isFeatureEnabled`
 * already returns `false` with no `flagClient` in that case (see
 * `packages/sdk-js/src/index.ts`), so this hook adds no redundant guard.
 *
 * Self-host: there is no dogfood org to host these flags, so callers pass
 * `selfHostValue` to pin the answer (`true` = feature always on, `false` =
 * always off) instead of reading a flag nobody can set. The hook still runs
 * unconditionally; only its result is overridden.
 */
export function useInternalFlag(key: string, selfHostValue?: boolean): boolean {
  const [enabled, setEnabled] = useState(() => isFeatureEnabled(key))

  useEffect(() => {
    // Re-sync in case the flag resolved between the initial render and this
    // effect (e.g. flags finished loading right after mount).
    setEnabled(isFeatureEnabled(key))

    onFeatureFlags((flags) => {
      setEnabled(Boolean(flags[key]))
    })
  }, [key])

  if (selfHostValue !== undefined && getDeployment() === 'self_host') return selfHostValue
  return enabled
}
