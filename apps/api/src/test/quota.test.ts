import { hashPassword } from '@clickroom/auth'
import { newId, prisma } from '@clickroom/db'
import { appRouter } from '@clickroom/trpc-router'
import type { FlagFilters } from '@clickroom/trpc-router/trpc/routers/flags.router.js'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authService, callAs, cleanupOrg, cleanupUser, makeCtx } from './helpers.js'

const suffix = Date.now().toString(36)
const createdUserIds: string[] = []
const createdOrgIds: string[] = []

const booleanFilters: FlagFilters = {
  groups: [{ properties: [], rollout_percentage: 100, variant: null }],
}

function callerFor(userId: string, orgForToken: string) {
  return appRouter.createCaller(
    makeCtx({ tokenPayload: { sub: userId, sessionId: 'test', orgId: orgForToken } }),
  )
}

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
  const project = await prisma.project.findFirstOrThrow({ where: { orgId } })
  return { adminUserId, orgId, projectId: project.id }
}

async function makeStandaloneUser(name: string) {
  const email = `${name}-${suffix}@test.invalid`
  const user = await prisma.user.create({
    data: { id: newId(), email, passwordHash: await hashPassword('password123') },
  })
  createdUserIds.push(user.id)
  return { userId: user.id, email }
}

afterAll(async () => {
  for (const oid of createdOrgIds) await cleanupOrg(oid)
  for (const uid of createdUserIds) await cleanupUser(uid)
  await prisma.$disconnect()
})

describe('seat quota (org.members.invite)', () => {
  let orgId: string
  let adminUserId: string

  beforeEach(async () => {
    const org = await makeOrg(`seat-${Math.random().toString(36).slice(2)}`)
    orgId = org.orgId
    adminUserId = org.adminUserId
    // Signup already creates one orgMembership (the admin) — cap seats at 1
    // so the org starts already AT the limit.
    await prisma.org.update({ where: { id: orgId }, data: { maxSeatsOverride: 1 } })
  })

  afterEach(() => {
    delete process.env.QUOTA_ENFORCE
  })

  it('blocks invite exactly at the seat limit (quota_exceeded)', async () => {
    const { email } = await makeStandaloneUser('seat-blocked')
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
        caller.org.members.invite({ email, role: 'member' }),
      ),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' })

    const count = await prisma.orgMembership.count({ where: { orgId } })
    expect(count).toBe(1)
  })

  it('allows invite while under the limit', async () => {
    await prisma.org.update({ where: { id: orgId }, data: { maxSeatsOverride: 2 } })
    const { email } = await makeStandaloneUser('seat-allowed')
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
        caller.org.members.invite({ email, role: 'member' }),
      ),
    ).resolves.toMatchObject({ email })

    // The invite is pending, not an accepted membership yet — it counts
    // toward the seat limit (so the org can't over-invite) without bumping
    // orgMembership until the invitee accepts.
    const inviteCount = await prisma.orgInvite.count({ where: { orgId, acceptedAt: null } })
    expect(inviteCount).toBe(1)
    const memberCount = await prisma.orgMembership.count({ where: { orgId } })
    expect(memberCount).toBe(1)
  })

  it('never throws when QUOTA_ENFORCE=false, even at/over the limit', async () => {
    process.env.QUOTA_ENFORCE = 'false'
    const { email } = await makeStandaloneUser('seat-unenforced')
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
        caller.org.members.invite({ email, role: 'member' }),
      ),
    ).resolves.toMatchObject({ email })
  })

  it('cross-tenant isolation: org B at its own limit does not block org A', async () => {
    const orgB = await makeOrg(`seat-b-${Math.random().toString(36).slice(2)}`)
    await prisma.org.update({ where: { id: orgB.orgId }, data: { maxSeatsOverride: 1 } })

    // org A is under its (default free-plan) limit, org B is at its limit of 1.
    await prisma.org.update({ where: { id: orgId }, data: { maxSeatsOverride: 5 } })

    const { email: emailB } = await makeStandaloneUser('seat-crossb')
    const callerB = callerFor(orgB.adminUserId, orgB.orgId)
    await expect(
      callAs({ userId: orgB.adminUserId, orgId: orgB.orgId, orgRole: 'org_admin' }, () =>
        callerB.org.members.invite({ email: emailB, role: 'member' }),
      ),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' })

    const { email: emailA } = await makeStandaloneUser('seat-crossa')
    const callerA = callerFor(adminUserId, orgId)
    await expect(
      callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
        callerA.org.members.invite({ email: emailA, role: 'member' }),
      ),
    ).resolves.toMatchObject({ email: emailA })
  })
})

describe('flags quota (flags.create)', () => {
  let orgId: string
  let adminUserId: string
  let projectId: string

  beforeEach(async () => {
    const org = await makeOrg(`flag-${Math.random().toString(36).slice(2)}`)
    orgId = org.orgId
    adminUserId = org.adminUserId
    projectId = org.projectId
    await prisma.org.update({ where: { id: orgId }, data: { maxFlagsOverride: 1 } })
  })

  afterEach(() => {
    delete process.env.QUOTA_ENFORCE
  })

  it('allows create while under the limit, then blocks exactly at the limit', async () => {
    const caller = callerFor(adminUserId, orgId)
    await callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
      caller.flags.create({
        projectId,
        key: `flag-under-${suffix}`,
        active: true,
        filters: booleanFilters,
      }),
    )

    await expect(
      callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
        caller.flags.create({
          projectId,
          key: `flag-over-${suffix}`,
          active: true,
          filters: booleanFilters,
        }),
      ),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' })

    const count = await prisma.featureFlag.count({ where: { projectId, deletedAt: null } })
    expect(count).toBe(1)
  })

  it('never throws when QUOTA_ENFORCE=false, even at/over the limit', async () => {
    const caller = callerFor(adminUserId, orgId)
    await callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
      caller.flags.create({
        projectId,
        key: `flag-first-${suffix}`,
        active: true,
        filters: booleanFilters,
      }),
    )

    process.env.QUOTA_ENFORCE = 'false'
    await expect(
      callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
        caller.flags.create({
          projectId,
          key: `flag-second-${suffix}`,
          active: true,
          filters: booleanFilters,
        }),
      ),
    ).resolves.toMatchObject({ key: `flag-second-${suffix}` })
  })

  it('cross-tenant isolation: org B at its flag limit does not block org A', async () => {
    const orgB = await makeOrg(`flag-b-${Math.random().toString(36).slice(2)}`)
    await prisma.org.update({ where: { id: orgB.orgId }, data: { maxFlagsOverride: 1 } })

    const callerB = callerFor(orgB.adminUserId, orgB.orgId)
    await callAs({ userId: orgB.adminUserId, orgId: orgB.orgId, orgRole: 'org_admin' }, () =>
      callerB.flags.create({
        projectId: orgB.projectId,
        key: `flag-b-first-${suffix}`,
        active: true,
        filters: booleanFilters,
      }),
    )
    await expect(
      callAs({ userId: orgB.adminUserId, orgId: orgB.orgId, orgRole: 'org_admin' }, () =>
        callerB.flags.create({
          projectId: orgB.projectId,
          key: `flag-b-second-${suffix}`,
          active: true,
          filters: booleanFilters,
        }),
      ),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' })

    // org A still has its own (independent) allowance of 1, untouched by org B.
    const callerA = callerFor(adminUserId, orgId)
    await expect(
      callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
        callerA.flags.create({
          projectId,
          key: `flag-a-${suffix}`,
          active: true,
          filters: booleanFilters,
        }),
      ),
    ).resolves.toMatchObject({ key: `flag-a-${suffix}` })
  })
})
