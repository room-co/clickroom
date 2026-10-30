import { hashPassword } from '@clickroom/auth'
import { newId, prisma } from '@clickroom/db'
import { appRouter } from '@clickroom/trpc-router'
import { afterAll, describe, expect, it } from 'vitest'
import { authService, callAs, cleanupOrg, cleanupUser, makeCtx } from './helpers.js'

const suffix = Date.now().toString(36)
const createdUserIds: string[] = []
const createdOrgIds: string[] = []

function callerFor(userId: string, orgId: string) {
  return appRouter.createCaller(
    makeCtx({ tokenPayload: { sub: userId, sessionId: 'test', orgId } }),
  )
}

const publicCaller = appRouter.createCaller(makeCtx())

async function makeOrg(name: string) {
  const s = await authService.signup({
    email: `${name}-admin-${suffix}@test.invalid`,
    password: 'password123',
    orgName: `${name} Org ${suffix}`,
  })
  const adminUserId = s.user.id
  const orgId = s.org!.id
  createdUserIds.push(adminUserId)
  createdOrgIds.push(orgId)
  await prisma.org.update({ where: { id: orgId }, data: { maxSeatsOverride: 1000 } })
  return { adminUserId, orgId }
}

async function invite(
  orgId: string,
  adminUserId: string,
  email: string,
  role: 'member' | 'viewer' | 'org_admin' = 'member',
) {
  const caller = callerFor(adminUserId, orgId)
  return callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
    caller.org.members.invite({ email, role }),
  )
}

afterAll(async () => {
  for (const oid of createdOrgIds) await cleanupOrg(oid)
  for (const uid of createdUserIds) await cleanupUser(uid)
  await prisma.$disconnect()
})

describe('org.members.invite', () => {
  it('creates a pending invite with a token', async () => {
    const { orgId, adminUserId } = await makeOrg('invite-create')
    const email = `invitee-create-${suffix}@test.invalid`
    const result = await invite(orgId, adminUserId, email, 'viewer')
    expect(result.email).toBe(email)
    expect(result.token).toBeTruthy()

    const row = await prisma.orgInvite.findUnique({ where: { token: result.token } })
    expect(row?.orgId).toBe(orgId)
    expect(row?.role).toBe('viewer')
    expect(row?.acceptedAt).toBeNull()
  })

  it('re-inviting the same email force-expires the prior pending invite', async () => {
    const { orgId, adminUserId } = await makeOrg('invite-resend')
    const email = `invitee-resend-${suffix}@test.invalid`
    const first = await invite(orgId, adminUserId, email)
    const second = await invite(orgId, adminUserId, email)

    const firstRow = await prisma.orgInvite.findUnique({ where: { token: first.token } })
    expect(firstRow?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now())

    const secondRow = await prisma.orgInvite.findUnique({ where: { token: second.token } })
    expect(secondRow?.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('rejects inviting an email already tied to another org (CONFLICT)', async () => {
    const { orgId: orgAId, adminUserId: adminA } = await makeOrg('invite-conflict-a')
    const { adminUserId: adminB } = await makeOrg('invite-conflict-b')
    const bAdmin = await prisma.user.findUniqueOrThrow({ where: { id: adminB } })

    await expect(invite(orgAId, adminA, bAdmin.email)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('auth.getInvite / auth.acceptInvite', () => {
  it('accept creates a user, an org membership at the invited role, and a session', async () => {
    const { orgId, adminUserId } = await makeOrg('invite-accept')
    const email = `invitee-accept-${suffix}@test.invalid`
    const { token } = await invite(orgId, adminUserId, email, 'viewer')

    const fetched = await publicCaller.auth.getInvite({ token })
    expect(fetched.email).toBe(email)
    expect(fetched.role).toBe('viewer')

    const accepted = await publicCaller.auth.acceptInvite({
      token,
      name: 'Invitee Accept',
      password: 'password123',
    })
    expect(accepted.user.email).toBe(email)
    expect(accepted.org?.id).toBe(orgId)
    expect(accepted.accessToken).toBeTruthy()
    createdUserIds.push(accepted.user.id)

    const membership = await prisma.orgMembership.findFirst({
      where: { orgId, userId: accepted.user.id },
    })
    expect(membership?.role).toBe('viewer')

    const inviteRow = await prisma.orgInvite.findUnique({ where: { token } })
    expect(inviteRow?.acceptedAt).not.toBeNull()
  })

  it('rejects an unknown token (NOT_FOUND)', async () => {
    await expect(publicCaller.auth.getInvite({ token: 'not-a-real-token' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('rejects an expired invite (NOT_FOUND)', async () => {
    const { orgId, adminUserId } = await makeOrg('invite-expired')
    const email = `invitee-expired-${suffix}@test.invalid`
    const { token } = await invite(orgId, adminUserId, email)
    await prisma.orgInvite.update({ where: { token }, data: { expiresAt: new Date(0) } })

    await expect(publicCaller.auth.getInvite({ token })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(
      publicCaller.auth.acceptInvite({ token, name: 'X', password: 'password123' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rejects an already-accepted invite (NOT_FOUND)', async () => {
    const { orgId, adminUserId } = await makeOrg('invite-reuse')
    const email = `invitee-reuse-${suffix}@test.invalid`
    const { token } = await invite(orgId, adminUserId, email)
    const accepted = await publicCaller.auth.acceptInvite({
      token,
      name: 'Invitee Reuse',
      password: 'password123',
    })
    createdUserIds.push(accepted.user.id)

    await expect(
      publicCaller.auth.acceptInvite({ token, name: 'Again', password: 'password123' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rejects an invalidated (revoked) invite (NOT_FOUND)', async () => {
    const { orgId, adminUserId } = await makeOrg('invite-revoked')
    const email = `invitee-revoked-${suffix}@test.invalid`
    const { token } = await invite(orgId, adminUserId, email)

    const inviteRow = await prisma.orgInvite.findUniqueOrThrow({ where: { token } })
    const caller = callerFor(adminUserId, orgId)
    const revoked = await callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
      caller.org.members.revokeInvite({ id: inviteRow.id }),
    )
    expect(revoked).toEqual({ ok: true })

    await expect(publicCaller.auth.getInvite({ token })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('rejects accepting when an account with that email already exists (CONFLICT)', async () => {
    const { orgId, adminUserId } = await makeOrg('invite-existing')
    const email = `invitee-existing-${suffix}@test.invalid`
    const { token } = await invite(orgId, adminUserId, email)

    const existing = await prisma.user.create({
      data: { id: newId(), email, passwordHash: await hashPassword('password123') },
    })
    createdUserIds.push(existing.id)

    await expect(
      publicCaller.auth.acceptInvite({ token, name: 'Dup', password: 'password123' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
