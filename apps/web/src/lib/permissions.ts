// Client-side mirror of packages/auth/src/permissions.ts. Duplicated (not
// imported) because @clickroom/auth pulls in argon2 (native Node addon) via
// its single package export — unsafe to bundle into the browser. Keep this
// file's role→permission mapping in sync with the server copy by hand.

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

/** True if `role` is granted `permission`. Mirrors @clickroom/auth's `can()` — UI-side gating only, the server is the enforcement boundary. */
export function can(role: OrgRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission)
}
