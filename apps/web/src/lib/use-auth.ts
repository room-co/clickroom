import { can, type Permission } from './permissions'
import { trpc } from './trpc'

/**
 * Current user/org/role, cached via React Query (`trpc.auth.me`) — safe to
 * call from multiple components, the query is deduped by key. `can()` mirrors
 * the server's RBAC check for UI gating (show/hide/disable); the server
 * (`requirePermission` in apps/api/src/trpc/trpc.ts) remains the actual
 * enforcement boundary.
 */
export function useAuth() {
  const meQuery = trpc.auth.me.useQuery()
  const role = meQuery.data?.role ?? null

  return {
    user: meQuery.data?.user ?? null,
    org: meQuery.data?.org ?? null,
    role,
    isLoading: meQuery.isLoading,
    can: (permission: Permission) => (role ? can(role, permission) : false),
  }
}
