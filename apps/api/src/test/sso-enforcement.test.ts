/**
 * Integration tests for SSO auth-service enforcement. Real
 * DB, no mocks — mirrors the reference implementation's `sso-enforcement.test.ts` minus the
 * feature-entitlement gate (Clickroom ships SSO ungated).
 *
 * Covers:
 *  - AuthService.login rejects a password-less (SSO-only) account with
 *    UNAUTHORIZED "This account uses SSO."
 *  - Enforced verified domain: non-admin member password login → FORBIDDEN.
 *  - Enforced verified domain: org_admin password login still succeeds
 *    (breakglass).
 */
import { hashPassword } from '@clickroom/auth'
import { newId, prisma } from '@clickroom/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authService } from './helpers.js'

const suffix = Date.now().toString(36)

let orgId: string
let connectionId: string
let adminUserId: string
let memberUserId: string
let ssoOnlyUserId: string
const enforcedDomain = `enforced-${suffix}.test.invalid`

const ADMIN_PW = 'AdminPassw0rd!'
const MEMBER_PW = 'MemberPassw0rd!'

beforeAll(async () => {
  const org = await prisma.org.create({
    data: { id: newId(), name: `SSO Enforce Org ${suffix}`, slug: `sso-enforce-${suffix}` },
  })
  orgId = org.id

  const conn = await prisma.ssoConnection.create({
    data: {
      id: newId(),
      orgId,
      protocol: 'oidc',
      displayName: 'Enforced IdP',
      enabled: true,
      enforced: true,
      defaultOrgRole: 'member',
      secretsEnvelope: {},
    },
  })
  connectionId = conn.id

  await prisma.orgDomain.create({
    data: {
      id: newId(),
      orgId,
      domain: enforcedDomain,
      verificationToken: 'x'.repeat(32),
      verifiedAt: new Date(),
    },
  })

  const admin = await prisma.user.create({
    data: {
      id: newId(),
      email: `admin@${enforcedDomain}`,
      passwordHash: await hashPassword(ADMIN_PW),
    },
  })
  const member = await prisma.user.create({
    data: {
      id: newId(),
      email: `member@${enforcedDomain}`,
      passwordHash: await hashPassword(MEMBER_PW),
    },
  })
  const ssoOnly = await prisma.user.create({
    data: { id: newId(), email: `sso-only@${enforcedDomain}`, passwordHash: null },
  })
  adminUserId = admin.id
  memberUserId = member.id
  ssoOnlyUserId = ssoOnly.id

  await prisma.orgMembership.createMany({
    data: [
      { id: newId(), orgId, userId: adminUserId, role: 'org_admin' },
      { id: newId(), orgId, userId: memberUserId, role: 'member' },
      { id: newId(), orgId, userId: ssoOnlyUserId, role: 'member' },
    ],
  })
})

afterAll(async () => {
  const userIds = [adminUserId, memberUserId, ssoOnlyUserId].filter(Boolean)
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.orgMembership.deleteMany({ where: { orgId } })
  await prisma.orgDomain.deleteMany({ where: { orgId } })
  await prisma.ssoConnection.deleteMany({ where: { orgId } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.org.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

describe('AuthService.login — SSO-only account', () => {
  it('rejects a password-less account with UNAUTHORIZED "This account uses SSO."', async () => {
    await expect(
      authService.login({ email: `sso-only@${enforcedDomain}`, password: 'whatever' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: 'This account uses SSO.' })
  })
})

describe('AuthService.login — enforced verified domain', () => {
  it('rejects a non-admin member with FORBIDDEN even with a correct password', async () => {
    await expect(
      authService.login({ email: `member@${enforcedDomain}`, password: MEMBER_PW }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Your organization requires SSO to sign in.',
    })
  })

  it('allows an org_admin to password-login (breakglass)', async () => {
    const result = await authService.login({
      email: `admin@${enforcedDomain}`,
      password: ADMIN_PW,
    })
    expect(result.accessToken).toBeTruthy()
    expect(result.user.id).toBe(adminUserId)
    expect(result.org?.id).toBe(orgId)
  })
})

describe('AuthService.signInViaSso', () => {
  it('creates a session with authMethod "sso" and the connection id', async () => {
    const result = await authService.signInViaSso({
      userId: memberUserId,
      orgId,
      connectionId,
    })
    expect(result.accessToken).toBeTruthy()
    expect(result.user.id).toBe(memberUserId)
    expect(result.org?.id).toBe(orgId)

    const session = await prisma.session.findFirst({
      where: { userId: memberUserId, ssoConnectionId: connectionId },
      orderBy: { createdAt: 'desc' },
    })
    expect(session?.authMethod).toBe('sso')
    expect(session?.activeOrgId).toBe(orgId)
  })

  it('rejects a user with no membership in the target org with FORBIDDEN', async () => {
    const outsider = await prisma.user.create({
      data: { id: newId(), email: `outsider-${suffix}@test.invalid`, passwordHash: null },
    })
    await expect(
      authService.signInViaSso({ userId: outsider.id, orgId, connectionId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await prisma.user.delete({ where: { id: outsider.id } })
  })
})
