/**
 * Integration tests for the SSO admin config tRPC router,
 * apps/api/src/trpc/routers/sso.router.ts). Real DB, no mocks — follows the
 * `appRouter.createCaller` + `callAs` pattern from
 * apps/api/src/test/org-ai-settings.test.ts.
 *
 * Covers:
 *  - A non-admin (member) calling a mutating procedure is rejected FORBIDDEN.
 *  - `getSpMetadata` returns self-consistent ACS/entity/metadata URLs.
 *  - A cross-org connection id (or domain/mapping id) access returns NOT_FOUND.
 */
import crypto from 'node:crypto'
import { newId, prisma } from '@clickroom/db'
import { appRouter } from '@clickroom/trpc-router'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { callAs, cleanupOrg, cleanupUser, makeCtx } from './helpers.js'

const suffix = Date.now().toString(36)
const createdUserIds: string[] = []
const createdOrgIds: string[] = []

// SsoConnectionService.upsert seals secrets via packages/auth's sealJson,
// which requires SSO_SECRETS_KEY. apps/api's env.ts (not imported by this
// test file) normally supplies a dev default at process boot — set one
// directly here, same pattern org-ai-settings.test.ts uses for
// AI_ENCRYPTION_KEY.
const originalSsoSecretsKey = process.env.SSO_SECRETS_KEY

beforeEach(() => {
  process.env.SSO_SECRETS_KEY = crypto.randomBytes(32).toString('hex')
})

afterEach(() => {
  if (originalSsoSecretsKey === undefined) delete process.env.SSO_SECRETS_KEY
  else process.env.SSO_SECRETS_KEY = originalSsoSecretsKey
})

function callerFor(userId: string, orgId: string) {
  return appRouter.createCaller(
    makeCtx({ tokenPayload: { sub: userId, sessionId: 'test', orgId } }),
  )
}

async function makeOrgWithMember(name: string) {
  const org = await prisma.org.create({
    data: { id: newId(), name: `${name} Org ${suffix}`, slug: `${name}-${suffix}` },
  })
  createdOrgIds.push(org.id)

  const admin = await prisma.user.create({
    data: { id: newId(), email: `${name}-admin-${suffix}@test.invalid`, passwordHash: 'unused' },
  })
  const member = await prisma.user.create({
    data: { id: newId(), email: `${name}-member-${suffix}@test.invalid`, passwordHash: 'unused' },
  })
  createdUserIds.push(admin.id, member.id)

  await prisma.orgMembership.createMany({
    data: [
      { id: newId(), orgId: org.id, userId: admin.id, role: 'org_admin' },
      { id: newId(), orgId: org.id, userId: member.id, role: 'member' },
    ],
  })

  return { orgId: org.id, adminUserId: admin.id, memberUserId: member.id }
}

afterAll(async () => {
  // cleanupOrg (test/helpers.ts) predates and doesn't know about the
  // SSO tables — clear them first so the FK to Org doesn't block deletion.
  for (const oid of createdOrgIds) {
    const connections = await prisma.ssoConnection.findMany({ where: { orgId: oid } })
    await prisma.ssoGroupMapping.deleteMany({
      where: { ssoConnectionId: { in: connections.map((c) => c.id) } },
    })
    await prisma.ssoConnection.deleteMany({ where: { orgId: oid } })
    await prisma.orgDomain.deleteMany({ where: { orgId: oid } })
  }
  for (const oid of createdOrgIds) await cleanupOrg(oid)
  for (const uid of createdUserIds) await cleanupUser(uid)
  await prisma.$disconnect()
})

describe('sso.* — non-admin rejection', () => {
  it('rejects a member calling upsertConnection with FORBIDDEN', async () => {
    const { orgId, memberUserId } = await makeOrgWithMember('sso-nonadmin')
    const caller = callerFor(memberUserId, orgId)

    await expect(
      callAs({ userId: memberUserId, orgId, orgRole: 'member' }, () =>
        caller.sso.upsertConnection({
          protocol: 'oidc',
          displayName: 'Should Not Work',
          oidcIssuerUrl: 'https://idp.example.com',
          oidcClientId: 'client-id',
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('rejects a member calling setEnforced, addDomain, and upsertGroupMapping with FORBIDDEN', async () => {
    const { orgId, memberUserId } = await makeOrgWithMember('sso-nonadmin2')
    const caller = callerFor(memberUserId, orgId)

    await expect(
      callAs({ userId: memberUserId, orgId, orgRole: 'member' }, () =>
        caller.sso.setEnforced({ enforced: true }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(
      callAs({ userId: memberUserId, orgId, orgRole: 'member' }, () =>
        caller.sso.addDomain({ domain: 'example.com' }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(
      callAs({ userId: memberUserId, orgId, orgRole: 'member' }, () =>
        caller.sso.upsertGroupMapping({
          connectionId: 'whatever',
          idpGroup: 'engineering',
          orgRole: 'member',
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('also rejects read-only getConnection/listDomains for a member', async () => {
    const { orgId, memberUserId } = await makeOrgWithMember('sso-nonadmin3')
    const caller = callerFor(memberUserId, orgId)

    await expect(
      callAs({ userId: memberUserId, orgId, orgRole: 'member' }, () => caller.sso.getConnection()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(
      callAs({ userId: memberUserId, orgId, orgRole: 'member' }, () => caller.sso.listDomains()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('sso.getSpMetadata', () => {
  it('returns self-consistent ACS/entity/metadata URLs for the org connection', async () => {
    const { orgId, adminUserId } = await makeOrgWithMember('sso-metadata')
    const caller = callerFor(adminUserId, orgId)

    await callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
      caller.sso.upsertConnection({
        protocol: 'saml',
        displayName: 'Test SAML IdP',
        samlIdpEntityId: 'https://idp.example.com/entity',
        samlIdpSsoUrl: 'https://idp.example.com/sso',
        samlIdpX509Cert: 'FAKE-CERT',
      }),
    )

    const connection = await callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
      caller.sso.getConnection(),
    )
    expect(connection).not.toBeNull()

    const metadata = await callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
      caller.sso.getSpMetadata(),
    )

    expect(metadata.protocol).toBe('saml')
    // acsUrl and callbackUrl must be scoped to this connection's id and share
    // the same origin as the metadata/entity URLs — "self-consistent".
    expect(metadata.acsUrl).toContain(`/auth/sso/${connection?.id}/acs`)
    expect(metadata.callbackUrl).toContain(`/auth/sso/${connection?.id}/callback`)
    expect(metadata.metadataUrl).toContain(`/auth/sso/${connection?.id}/metadata`)
    expect(metadata.spEntityId.length).toBeGreaterThan(0)
    expect(metadata.metadataXml).toContain(metadata.acsUrl)
    expect(metadata.metadataXml).toContain('EntityDescriptor')

    const acsOrigin = new URL(metadata.acsUrl).origin
    const metadataOrigin = new URL(metadata.metadataUrl).origin
    const callbackOrigin = new URL(metadata.callbackUrl).origin
    expect(metadataOrigin).toBe(acsOrigin)
    expect(callbackOrigin).toBe(acsOrigin)
  })

  it('throws NOT_FOUND when the org has no SSO connection configured', async () => {
    const { orgId, adminUserId } = await makeOrgWithMember('sso-metadata-missing')
    const caller = callerFor(adminUserId, orgId)

    await expect(
      callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
        caller.sso.getSpMetadata(),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('sso.* — cross-org tampering guard', () => {
  it('returns NOT_FOUND when listGroupMappings is called with another org’s connection id', async () => {
    const orgA = await makeOrgWithMember('sso-cross-a')
    const orgB = await makeOrgWithMember('sso-cross-b')

    const callerA = callerFor(orgA.adminUserId, orgA.orgId)
    await callAs({ userId: orgA.adminUserId, orgId: orgA.orgId, orgRole: 'org_admin' }, () =>
      callerA.sso.upsertConnection({
        protocol: 'oidc',
        displayName: 'Org A IdP',
        oidcIssuerUrl: 'https://idp-a.example.com',
        oidcClientId: 'client-a',
      }),
    )
    const connectionA = await callAs(
      { userId: orgA.adminUserId, orgId: orgA.orgId, orgRole: 'org_admin' },
      () => callerA.sso.getConnection(),
    )
    expect(connectionA).not.toBeNull()

    // Org B's admin tries to read Org A's connection's group mappings by id.
    const callerB = callerFor(orgB.adminUserId, orgB.orgId)
    await expect(
      callAs({ userId: orgB.adminUserId, orgId: orgB.orgId, orgRole: 'org_admin' }, () =>
        callerB.sso.listGroupMappings({ connectionId: connectionA?.id ?? '' }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await expect(
      callAs({ userId: orgB.adminUserId, orgId: orgB.orgId, orgRole: 'org_admin' }, () =>
        callerB.sso.upsertGroupMapping({
          connectionId: connectionA?.id ?? '',
          idpGroup: 'engineering',
          orgRole: 'member',
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns NOT_FOUND when verifyDomain/removeDomain target another org’s domain id', async () => {
    const orgA = await makeOrgWithMember('sso-cross-dom-a')
    const orgB = await makeOrgWithMember('sso-cross-dom-b')

    const callerA = callerFor(orgA.adminUserId, orgA.orgId)
    const added = await callAs(
      { userId: orgA.adminUserId, orgId: orgA.orgId, orgRole: 'org_admin' },
      () => callerA.sso.addDomain({ domain: `cross-${suffix}.test.invalid` }),
    )
    const domains = await callAs(
      { userId: orgA.adminUserId, orgId: orgA.orgId, orgRole: 'org_admin' },
      () => callerA.sso.listDomains(),
    )
    const domainId = domains.find((d) => d.domain === added.domain)?.id
    expect(domainId).toBeTruthy()

    const callerB = callerFor(orgB.adminUserId, orgB.orgId)
    await expect(
      callAs({ userId: orgB.adminUserId, orgId: orgB.orgId, orgRole: 'org_admin' }, () =>
        callerB.sso.verifyDomain({ domainId: domainId ?? '' }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await expect(
      callAs({ userId: orgB.adminUserId, orgId: orgB.orgId, orgRole: 'org_admin' }, () =>
        callerB.sso.removeDomain({ domainId: domainId ?? '' }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
