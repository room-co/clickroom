// SSO DB services. Ported from the reference implementation's
// apps/api/src/test/sso-services.test.ts, stripped of all Team/team_role
// coverage — Clickroom's tenancy is Org → Project only, so group mappings
// resolve straight to an OrgRole.
//
// Runs against the live `clickroom_test` Postgres (vitest.config.ts points
// DATABASE_URL at TEST_DATABASE_URL). Skips gracefully when the DB is
// unreachable, matching the pattern in ./scoped-client.test.ts. The only
// mocked boundary is `node:dns/promises` resolveTxt (network DNS).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const resolveTxtMock = vi.fn<(hostname: string) => Promise<string[][]>>()
vi.mock('node:dns/promises', () => ({
  resolveTxt: (hostname: string) => resolveTxtMock(hostname),
}))

const { prisma } = await import('./client.js')
const { newId } = await import('./client.js')
const { OrgDomainService } = await import('./org-domain.service.js')
const { SsoGroupMappingService } = await import('./sso-group-mapping.service.js')
const { SsoProvisioningService } = await import('./sso-provisioning.service.js')

let dbUp = false
const suffix = Date.now().toString(36)

let orgId = ''
let otherOrgId = ''
let connectionId = ''
const createdUserIds: string[] = []

async function makeConnection(forOrgId: string): Promise<string> {
  const conn = await prisma.ssoConnection.create({
    data: {
      id: newId(),
      orgId: forOrgId,
      protocol: 'saml',
      displayName: 'Test IdP',
      enabled: true,
      defaultOrgRole: 'viewer',
      secretsEnvelope: '{}',
    },
  })
  return conn.id
}

beforeAll(async () => {
  try {
    const org = await prisma.org.create({
      data: { id: newId(), name: `SSO Svc Org ${suffix}`, slug: `sso-svc-${suffix}` },
    })
    orgId = org.id
    connectionId = await makeConnection(orgId)

    const otherOrg = await prisma.org.create({
      data: { id: newId(), name: `SSO Other Org ${suffix}`, slug: `sso-other-${suffix}` },
    })
    otherOrgId = otherOrg.id

    dbUp = true
  } catch {
    dbUp = false
  }
})

afterAll(async () => {
  if (!dbUp) {
    await prisma.$disconnect().catch(() => {})
    return
  }
  if (createdUserIds.length > 0) {
    await prisma.userSsoIdentity.deleteMany({ where: { userId: { in: createdUserIds } } })
    await prisma.orgMembership.deleteMany({ where: { userId: { in: createdUserIds } } })
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  }
  await prisma.userSsoIdentity.deleteMany({ where: { ssoConnectionId: connectionId } })
  await prisma.ssoGroupMapping.deleteMany({ where: { ssoConnectionId: connectionId } })
  await prisma.ssoConnection.deleteMany({ where: { orgId } })
  await prisma.orgDomain.deleteMany({ where: { orgId } })
  await prisma.org.delete({ where: { id: orgId } })
  await prisma.org.delete({ where: { id: otherOrgId } })
  await prisma.$disconnect()
})

// ---------------------------------------------------------------------------
// OrgDomainService
// ---------------------------------------------------------------------------
describe('OrgDomainService', () => {
  it('add() generates a verification token and normalizes the domain', async () => {
    if (!dbUp) return
    const svc = new OrgDomainService(prisma)
    const record = await svc.add(orgId, '  ACME.TEST  ')
    expect(record.domain).toBe('acme.test')
    expect(record.verificationToken).toMatch(/^[0-9a-f]{32}$/)
    expect(record.verifiedAt).toBeNull()
    await prisma.orgDomain.delete({ where: { id: record.id } })
  })

  it('verifyDomain() sets verifiedAt when a TXT record matches the token', async () => {
    if (!dbUp) return
    const svc = new OrgDomainService(prisma)
    const record = await svc.add(orgId, `verify-match-${suffix}.test`)

    resolveTxtMock.mockResolvedValueOnce([['some-other-value'], [record.verificationToken]])

    const result = await svc.verifyDomain(record.id)
    expect(result.verified).toBe(true)

    const reloaded = await prisma.orgDomain.findUnique({ where: { id: record.id } })
    expect(reloaded?.verifiedAt).not.toBeNull()
    await prisma.orgDomain.delete({ where: { id: record.id } })
  })

  it('verifyDomain() leaves verifiedAt null when no TXT record matches', async () => {
    if (!dbUp) return
    const svc = new OrgDomainService(prisma)
    const record = await svc.add(orgId, `verify-nomatch-${suffix}.test`)

    resolveTxtMock.mockResolvedValueOnce([['totally-wrong-token']])

    const result = await svc.verifyDomain(record.id)
    expect(result.verified).toBe(false)

    const reloaded = await prisma.orgDomain.findUnique({ where: { id: record.id } })
    expect(reloaded?.verifiedAt).toBeNull()
    await prisma.orgDomain.delete({ where: { id: record.id } })
  })

  it('verifyDomain() returns false when DNS lookup throws (NXDOMAIN)', async () => {
    if (!dbUp) return
    const svc = new OrgDomainService(prisma)
    const record = await svc.add(orgId, `verify-nxdomain-${suffix}.test`)

    resolveTxtMock.mockRejectedValueOnce(new Error('queryTxt ENOTFOUND'))

    const result = await svc.verifyDomain(record.id)
    expect(result.verified).toBe(false)
    const reloaded = await prisma.orgDomain.findUnique({ where: { id: record.id } })
    expect(reloaded?.verifiedAt).toBeNull()
    await prisma.orgDomain.delete({ where: { id: record.id } })
  })

  it('resolveOrgByEmailDomain() returns org + connection for a VERIFIED domain', async () => {
    if (!dbUp) return
    const svc = new OrgDomainService(prisma)
    const domain = `resolve-verified-${suffix}.test`
    const record = await svc.add(orgId, domain)
    await prisma.orgDomain.update({ where: { id: record.id }, data: { verifiedAt: new Date() } })

    const resolved = await svc.resolveOrgByEmailDomain(`someone@${domain}`)
    expect(resolved).not.toBeNull()
    expect(resolved?.org.id).toBe(orgId)
    expect(resolved?.connection?.id).toBe(connectionId)

    await prisma.orgDomain.delete({ where: { id: record.id } })
  })

  it('resolveOrgByEmailDomain() returns null for an UNVERIFIED domain', async () => {
    if (!dbUp) return
    const svc = new OrgDomainService(prisma)
    const domain = `resolve-unverified-${suffix}.test`
    const record = await svc.add(orgId, domain)

    const resolved = await svc.resolveOrgByEmailDomain(`someone@${domain}`)
    expect(resolved).toBeNull()

    await prisma.orgDomain.delete({ where: { id: record.id } })
  })

  it('resolveOrgByEmailDomain() returns null for an unknown domain', async () => {
    if (!dbUp) return
    const svc = new OrgDomainService(prisma)
    const resolved = await svc.resolveOrgByEmailDomain(`x@no-such-domain-${suffix}.test`)
    expect(resolved).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// SsoGroupMappingService.resolveMappings
// ---------------------------------------------------------------------------
describe('SsoGroupMappingService.resolveMappings', () => {
  it('picks the highest-precedence org role among matched groups', async () => {
    if (!dbUp) return
    const svc = new SsoGroupMappingService(prisma)
    await svc.upsert(connectionId, { idpGroup: 'g-viewer', orgRole: 'viewer' })
    await svc.upsert(connectionId, { idpGroup: 'g-admin', orgRole: 'org_admin' })
    await svc.upsert(connectionId, { idpGroup: 'g-member', orgRole: 'member' })

    const resolved = await svc.resolveMappings(connectionId, ['g-viewer', 'g-member', 'g-admin'])
    expect(resolved.orgRole).toBe('org_admin')

    const resolved2 = await svc.resolveMappings(connectionId, ['g-viewer', 'g-member'])
    expect(resolved2.orgRole).toBe('member')

    await prisma.ssoGroupMapping.deleteMany({ where: { ssoConnectionId: connectionId } })
  })

  it('returns null orgRole when no groups match', async () => {
    if (!dbUp) return
    const svc = new SsoGroupMappingService(prisma)
    await svc.upsert(connectionId, { idpGroup: 'g-admin', orgRole: 'org_admin' })

    const resolved = await svc.resolveMappings(connectionId, ['unrelated-group'])
    expect(resolved.orgRole).toBeNull()

    await prisma.ssoGroupMapping.deleteMany({ where: { ssoConnectionId: connectionId } })
  })

  it('delete is scoped to the connection — foreign mapping survives', async () => {
    if (!dbUp) return
    const svc = new SsoGroupMappingService(prisma)
    const mapping = await svc.upsert(connectionId, {
      idpGroup: `scoped-delete-${suffix}`,
      orgRole: 'member',
    })

    await svc.delete(mapping.id, 'some-other-connection-id')
    const survivor = await prisma.ssoGroupMapping.findUnique({ where: { id: mapping.id } })
    expect(survivor).not.toBeNull()

    await svc.delete(mapping.id, connectionId)
    const gone = await prisma.ssoGroupMapping.findUnique({ where: { id: mapping.id } })
    expect(gone).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// SsoProvisioningService.provision
// ---------------------------------------------------------------------------
describe('SsoProvisioningService.provision', () => {
  it('(a) creates a new password-less user + membership with the mapped role', async () => {
    if (!dbUp) return
    const svc = new SsoProvisioningService(prisma)
    const mapSvc = new SsoGroupMappingService(prisma)
    await mapSvc.upsert(connectionId, { idpGroup: 'eng', orgRole: 'member' })

    const email = `jit-new-${suffix}@acme.test`
    const { userId } = await svc.provision({
      orgId,
      connectionId,
      externalId: `ext-new-${suffix}`,
      email,
      fullName: 'JIT New User',
      groups: ['eng'],
    })
    createdUserIds.push(userId)

    const user = await prisma.user.findUnique({ where: { id: userId } })
    expect(user?.passwordHash).toBeNull()
    expect(user?.email).toBe(email)

    const membership = await prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId, userId } },
    })
    expect(membership?.role).toBe('member')

    const identity = await prisma.userSsoIdentity.findUnique({
      where: {
        ssoConnectionId_externalId: {
          ssoConnectionId: connectionId,
          externalId: `ext-new-${suffix}`,
        },
      },
    })
    expect(identity?.lastLoginAt).not.toBeNull()

    await mapSvc.delete(
      (await prisma.ssoGroupMapping.findFirstOrThrow({ where: { idpGroup: 'eng' } })).id,
      connectionId,
    )
  })

  it('(b) links an existing user by email instead of creating a new one', async () => {
    if (!dbUp) return
    const svc = new SsoProvisioningService(prisma)
    const email = `jit-link-${suffix}@acme.test`
    const existing = await prisma.user.create({
      data: { id: newId(), email, passwordHash: 'argon-hash', name: 'Existing User' },
    })
    createdUserIds.push(existing.id)

    const { userId } = await svc.provision({
      orgId,
      connectionId,
      externalId: `ext-link-${suffix}`,
      email,
      fullName: 'Existing User',
      groups: [],
    })

    expect(userId).toBe(existing.id)
    // Password is untouched — we only link, never null out an existing password.
    const reloaded = await prisma.user.findUnique({ where: { id: existing.id } })
    expect(reloaded?.passwordHash).toBe('argon-hash')
  })

  it('(c) a returning IdP subject matches by externalId, not email, and bumps lastLoginAt', async () => {
    if (!dbUp) return
    const svc = new SsoProvisioningService(prisma)
    const externalId = `ext-existing-${suffix}`
    const email = `jit-existing-${suffix}@acme.test`

    const first = await svc.provision({
      orgId,
      connectionId,
      externalId,
      email,
      fullName: 'Existing Identity',
      groups: [],
    })
    createdUserIds.push(first.userId)

    const identityAfterFirst = await prisma.userSsoIdentity.findUnique({
      where: { ssoConnectionId_externalId: { ssoConnectionId: connectionId, externalId } },
    })
    const firstLogin = identityAfterFirst!.lastLoginAt!

    await new Promise((r) => setTimeout(r, 10))

    // Same externalId but a DIFFERENT email — must still resolve to the SAME
    // user via the identity link rather than creating/linking by email.
    const differentEmail = `jit-existing-changed-${suffix}@acme.test`
    const second = await svc.provision({
      orgId,
      connectionId,
      externalId,
      email: differentEmail,
      fullName: 'Existing Identity',
      groups: [],
    })
    expect(second.userId).toBe(first.userId)

    const identityAfterSecond = await prisma.userSsoIdentity.findUnique({
      where: { ssoConnectionId_externalId: { ssoConnectionId: connectionId, externalId } },
    })
    expect(identityAfterSecond!.lastLoginAt!.getTime()).toBeGreaterThanOrEqual(firstLogin.getTime())
    expect(identityAfterSecond!.email).toBe(differentEmail)
  })

  it('(e) uses connection.defaultOrgRole when no group matches', async () => {
    if (!dbUp) return
    const svc = new SsoProvisioningService(prisma)
    // Connection defaultOrgRole is 'viewer' (set at creation).
    const { userId } = await svc.provision({
      orgId,
      connectionId,
      externalId: `ext-default-${suffix}`,
      email: `jit-default-${suffix}@acme.test`,
      fullName: 'Default Role User',
      groups: ['no-mapping-exists'],
    })
    createdUserIds.push(userId)

    const membership = await prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId, userId } },
    })
    expect(membership?.role).toBe('viewer')
  })

  it('(f) monotonic — never downgrades an existing org_admin (breakglass)', async () => {
    if (!dbUp) return
    const svc = new SsoProvisioningService(prisma)
    const user = await prisma.user.create({
      data: {
        id: newId(),
        email: `jit-nodowngrade-${suffix}@acme.test`,
        passwordHash: null,
        name: 'Existing Admin',
      },
    })
    createdUserIds.push(user.id)
    await prisma.orgMembership.create({
      data: { id: newId(), orgId, userId: user.id, role: 'org_admin' },
    })

    // SSO login with no matching groups → resolves to defaultOrgRole ('viewer').
    await svc.provision({
      orgId,
      connectionId,
      externalId: `ext-nodowngrade-${suffix}`,
      email: `jit-nodowngrade-${suffix}@acme.test`,
      fullName: 'Existing Admin',
      groups: ['no-mapping-exists'],
    })

    const membership = await prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId, userId: user.id } },
    })
    // Role preserved — login did not strip admin.
    expect(membership?.role).toBe('org_admin')
  })

  it('(g) monotonic — still elevates when a mapping resolves a higher role', async () => {
    if (!dbUp) return
    const svc = new SsoProvisioningService(prisma)
    const mapSvc = new SsoGroupMappingService(prisma)
    const user = await prisma.user.create({
      data: {
        id: newId(),
        email: `jit-elevate-${suffix}@acme.test`,
        passwordHash: null,
        name: 'Climbing User',
      },
    })
    createdUserIds.push(user.id)
    await prisma.orgMembership.create({
      data: { id: newId(), orgId, userId: user.id, role: 'member' },
    })

    await mapSvc.upsert(connectionId, { idpGroup: 'admins', orgRole: 'org_admin' })

    await svc.provision({
      orgId,
      connectionId,
      externalId: `ext-elevate-${suffix}`,
      email: `jit-elevate-${suffix}@acme.test`,
      fullName: 'Climbing User',
      groups: ['admins'],
    })

    const membership = await prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId, userId: user.id } },
    })
    expect(membership?.role).toBe('org_admin')

    await prisma.ssoGroupMapping.deleteMany({ where: { ssoConnectionId: connectionId } })
  })

  it('rejects when the connection does not belong to the target org', async () => {
    if (!dbUp) return
    const svc = new SsoProvisioningService(prisma)
    await expect(
      svc.provision({
        orgId: otherOrgId, // connectionId belongs to `orgId`, not `otherOrgId`
        connectionId,
        externalId: `ext-wrong-org-${suffix}`,
        email: `jit-wrong-org-${suffix}@acme.test`,
        fullName: 'Wrong Org',
        groups: [],
      }),
    ).rejects.toThrow(/does not belong to the target org/i)
  })
})
