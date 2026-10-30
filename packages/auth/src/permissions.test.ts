import { describe, expect, it } from 'vitest'
import { assertCan, can, type OrgRole, type Permission } from './permissions.js'

const ALL: Permission[] = [
  'org:update',
  'members:manage',
  'projects:manage',
  'projects:read',
  'keys:manage',
  'flags:write',
  'flags:read',
  'taxonomy:read',
]

// Expected grant matrix per spec.
const EXPECTED: Record<OrgRole, Set<Permission>> = {
  org_admin: new Set(ALL),
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

describe('permissions matrix', () => {
  const roles: OrgRole[] = ['org_admin', 'member', 'viewer']
  for (const role of roles) {
    for (const permission of ALL) {
      const allowed = EXPECTED[role].has(permission)
      it(`${role} ${allowed ? 'CAN' : 'CANNOT'} ${permission}`, () => {
        expect(can(role, permission)).toBe(allowed)
        if (allowed) {
          expect(() => assertCan(role, permission)).not.toThrow()
        } else {
          expect(() => assertCan(role, permission)).toThrow()
        }
      })
    }
  }
})

describe('invariants', () => {
  it('viewer cannot create flags or projects', () => {
    expect(can('viewer', 'flags:write')).toBe(false)
    expect(can('viewer', 'projects:manage')).toBe(false)
  })

  it('member cannot manage members or update org', () => {
    expect(can('member', 'members:manage')).toBe(false)
    expect(can('member', 'org:update')).toBe(false)
  })

  it('org_admin can do everything', () => {
    for (const permission of ALL) {
      expect(can('org_admin', permission)).toBe(true)
    }
  })
})
