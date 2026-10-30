import { REFRESH_TOKEN_COOKIE } from '@clickroom/auth'
import { prisma } from '@clickroom/db'
import { appRouter } from '@clickroom/trpc-router'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanupOrg, cleanupUser, makeCtx, makeRes } from './helpers.js'

const suffix = Date.now().toString(36)
const createdUserIds: string[] = []
const createdOrgIds: string[] = []

afterAll(async () => {
  for (const orgId of createdOrgIds) await cleanupOrg(orgId)
  for (const userId of createdUserIds) await cleanupUser(userId)
  await prisma.$disconnect()
})

describe('auth.signup', () => {
  it('creates org + admin membership + Default project + system defs, returns a token', async () => {
    const caller = appRouter.createCaller(makeCtx({ res: makeRes() }))
    const result = await caller.auth.signup({
      email: `signup-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Signup Org ${suffix}`,
    })
    createdUserIds.push(result.user.id)
    createdOrgIds.push(result.org!.id)

    expect(typeof result.accessToken).toBe('string')
    expect(result.org).toMatchObject({ name: `Signup Org ${suffix}` })

    const membership = await prisma.orgMembership.findFirst({ where: { orgId: result.org!.id } })
    expect(membership?.role).toBe('org_admin')
    expect(membership?.userId).toBe(result.user.id)

    const project = await prisma.project.findFirst({ where: { orgId: result.org!.id } })
    expect(project?.name).toBe('Default')

    const events = await prisma.eventDefinition.findMany({ where: { projectId: project!.id } })
    expect(events.map((e) => e.name).sort()).toEqual(['$autocapture', '$identify', '$pageview'])
    expect(events.every((e) => e.isSystem)).toBe(true)

    const props = await prisma.propertyDefinition.findMany({ where: { projectId: project!.id } })
    expect(props.map((p) => p.name).sort()).toEqual(['$current_url', '$event_type'])
  })

  it('rejects a duplicate email with CONFLICT', async () => {
    const email = `dupe-${suffix}@test.invalid`
    const caller = appRouter.createCaller(makeCtx({ res: makeRes() }))
    const r = await caller.auth.signup({
      email,
      password: 'password123',
      orgName: `Dupe ${suffix}`,
    })
    createdUserIds.push(r.user.id)
    createdOrgIds.push(r.org!.id)

    await expect(
      caller.auth.signup({ email, password: 'password123', orgName: `Dupe2 ${suffix}` }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('auth.login', () => {
  it('returns a token for valid credentials and UNAUTHORIZED for a bad password', async () => {
    const email = `login-${suffix}@test.invalid`
    const signupCaller = appRouter.createCaller(makeCtx({ res: makeRes() }))
    const s = await signupCaller.auth.signup({
      email,
      password: 'password123',
      orgName: `Login Org ${suffix}`,
    })
    createdUserIds.push(s.user.id)
    createdOrgIds.push(s.org!.id)

    const caller = appRouter.createCaller(makeCtx({ res: makeRes() }))
    const ok = await caller.auth.login({ email, password: 'password123' })
    expect(typeof ok.accessToken).toBe('string')
    expect(ok.org?.id).toBe(s.org!.id)

    await expect(caller.auth.login({ email, password: 'wrong-password' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })
})

describe('auth.refresh', () => {
  it('rotates the refresh token and invalidates the old one', async () => {
    const res = makeRes()
    const caller = appRouter.createCaller(makeCtx({ res }))
    const s = await caller.auth.signup({
      email: `refresh-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Refresh Org ${suffix}`,
    })
    createdUserIds.push(s.user.id)
    createdOrgIds.push(s.org!.id)

    const oldRt = res._cookies[REFRESH_TOKEN_COOKIE]
    expect(oldRt).toBeTruthy()

    const res2 = makeRes()
    const refreshCaller = appRouter.createCaller(
      makeCtx({ res: res2, cookies: { [REFRESH_TOKEN_COOKIE]: oldRt } }),
    )
    const refreshed = await refreshCaller.auth.refresh()
    expect(typeof refreshed.accessToken).toBe('string')
    expect(refreshed.org?.id).toBe(s.org!.id) // active org survives refresh

    const newRt = res2._cookies[REFRESH_TOKEN_COOKIE]
    expect(newRt).toBeTruthy()
    expect(newRt).not.toBe(oldRt)

    // The old (rotated-out) refresh token is no longer valid.
    const staleCaller = appRouter.createCaller(
      makeCtx({ cookies: { [REFRESH_TOKEN_COOKIE]: oldRt } }),
    )
    await expect(staleCaller.auth.refresh()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })
})
