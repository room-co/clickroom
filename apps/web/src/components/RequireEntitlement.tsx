import type { EntitlementAction } from '@clickroom/db'
import { Navigate, Outlet } from 'react-router'
import { SkeletonCard, SkeletonText } from '@/components/skeletons'
import { UpgradeCard } from '@/components/UpgradeCard'
import { useEntitlement } from '@/lib/use-entitlement'
import { useInternalFlag } from '@/lib/use-internal-flag'

/**
 * Route guard for a plan-gated (and optionally
 * flag-gated) feature. Same shape as `RequireAuth.tsx`: skeleton while
 * checking, then decide.
 *
 * The two gates are deliberately different kinds of thing, and deny
 * differently:
 *
 * - `flag` (a `useInternalFlag` rollout kill-switch) off → `<Navigate to="/">`.
 *   The feature does not exist for this org yet; there is nothing to upsell.
 *   It returns `false` with no write key, so self-hosted/local builds are off
 *   by default — that is the intended default, not a bug.
 * - flag on but the plan isn't entitled → `<UpgradeCard>`. A real upsell.
 *
 * Neither is a security boundary. `entitlementMiddleware` on the gated tRPC
 * procedures is what actually protects the data.
 */
export function RequireEntitlement({ action, flag }: { action: EntitlementAction; flag?: string }) {
  const flagEnabled = useInternalFlag(flag ?? '', true)
  const { allowed, isLoading, feature, upgradeTo } = useEntitlement(action)

  if (flag && !flagEnabled) return <Navigate to="/" replace />

  if (isLoading) {
    return (
      <div className="p-5 space-y-4">
        <SkeletonText lines={1} className="max-w-[180px]" />
        <SkeletonCard lines={4} />
      </div>
    )
  }

  if (!allowed) return <UpgradeCard feature={feature} upgradeTo={upgradeTo} />

  return <Outlet />
}
