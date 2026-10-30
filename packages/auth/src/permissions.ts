/**
 * RBAC permission model. Roles align by VALUE with the Prisma
 * `OrgRole` enum in @clickroom/db — do not import Prisma here (pure library).
 */

export type OrgRole = 'org_admin' | 'member' | 'viewer'

export type Permission =
  | 'org:update'
  | 'members:manage'
  | 'projects:manage'
  | 'projects:read'
  | 'keys:manage'
  | 'flags:write'
  | 'flags:read'
  | 'taxonomy:read'

const ALL_PERMISSIONS: readonly Permission[] = [
  'org:update',
  'members:manage',
  'projects:manage',
  'projects:read',
  'keys:manage',
  'flags:write',
  'flags:read',
  'taxonomy:read',
]

export const ROLE_PERMISSIONS: Record<OrgRole, ReadonlySet<Permission>> = {
  org_admin: new Set(ALL_PERMISSIONS),
  member: new Set<Permission>([
    'projects:manage',
    'projects:read',
    'keys:manage',
    'flags:write',
    'flags:read',
    'taxonomy:read',
  ]),
  viewer: new Set<Permission>(['projects:read', 'flags:read', 'taxonomy:read']),
}

/** True if `role` is granted `permission`. */
export function can(role: OrgRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission)
}

/**
 * Throw if `role` lacks `permission`. The API layer maps this Error to a tRPC
 * FORBIDDEN response.
 */
export function assertCan(role: OrgRole, permission: Permission): void {
  if (!can(role, permission)) {
    throw new Error(`Forbidden: role "${role}" lacks permission "${permission}"`)
  }
}
