import { prisma } from '@clickroom/db'
import { appRouter } from '@clickroom/trpc-router'
import type { FunnelStepInput } from '@clickroom/trpc-router/trpc/routers/events.router.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authService, callAs, cleanupOrg, cleanupUser, makeCtx } from './helpers.js'

const suffix = Date.now().toString(36)
const createdUserIds: string[] = []
const createdOrgIds: string[] = []

let adminUserId: string
let orgId: string
let projectId: string

const twoStepFunnel: FunnelStepInput[] = [
  { event: 'signup', filters: [] },
  { event: 'purchase', filters: [{ key: 'plan', operator: 'exact', value: 'pro' }] },
]

beforeAll(async () => {
  const s = await authService.signup({
    email: `funnels-admin-${suffix}@test.invalid`,
    password: 'password123',
    orgName: `Funnels Org ${suffix}`,
  })
  adminUserId = s.user.id
  orgId = s.org!.id
  createdUserIds.push(adminUserId)
  createdOrgIds.push(orgId)

  const project = await prisma.project.findFirstOrThrow({ where: { orgId } })
  projectId = project.id
})

afterAll(async () => {
  for (const oid of createdOrgIds) await cleanupOrg(oid)
  for (const uid of createdUserIds) await cleanupUser(uid)
  await prisma.$disconnect()
})

function callerFor(userId: string, orgForToken: string) {
  return appRouter.createCaller(
    makeCtx({ tokenPayload: { sub: userId, sessionId: 'test', orgId: orgForToken } }),
  )
}

const admin = () => ({ userId: adminUserId, orgId, orgRole: 'org_admin' as const })

describe('funnels.create', () => {
  it('creates a funnel with per-step property filters', async () => {
    const caller = callerFor(adminUserId, orgId)
    const funnel = await callAs(admin(), () =>
      caller.funnels.create({
        projectId,
        name: 'Trial to Paid',
        window: 86400,
        steps: twoStepFunnel,
      }),
    )
    expect(funnel).toMatchObject({ name: 'Trial to Paid', window: 86400 })
    expect(funnel.steps).toEqual(twoStepFunnel)
  })

  it('rejects fewer than 2 steps', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () =>
        caller.funnels.create({
          projectId,
          name: 'Too short',
          window: 86400,
          steps: [{ event: 'signup', filters: [] }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('rejects an invalid operator', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () =>
        caller.funnels.create({
          projectId,
          name: 'Bad operator',
          window: 86400,
          steps: [
            { event: 'signup', filters: [] },
            {
              event: 'purchase',
              // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid input
              filters: [{ key: 'plan', operator: 'regex', value: 'pro' } as any],
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('funnels.list / get', () => {
  it('lists non-deleted funnels ordered by name', async () => {
    const caller = callerFor(adminUserId, orgId)
    await callAs(admin(), () =>
      caller.funnels.create({
        projectId,
        name: 'Aardvark Funnel',
        window: 3600,
        steps: twoStepFunnel,
      }),
    )
    const rows = await callAs(admin(), () => caller.funnels.list({ projectId }))
    expect(rows.map((r) => r.name)).toEqual(['Aardvark Funnel', 'Trial to Paid'])
  })

  it('get returns the funnel; NOT_FOUND for missing id', async () => {
    const caller = callerFor(adminUserId, orgId)
    const created = await callAs(admin(), () => caller.funnels.list({ projectId }))
    const id = created[0].id
    const funnel = await callAs(admin(), () => caller.funnels.get({ projectId, id }))
    expect(funnel.id).toBe(id)
    await expect(
      callAs(admin(), () => caller.funnels.get({ projectId, id: 'nope' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('funnels.update / delete', () => {
  it('update patches name/window/steps', async () => {
    const caller = callerFor(adminUserId, orgId)
    const created = await callAs(admin(), () =>
      caller.funnels.create({
        projectId,
        name: 'To Update',
        window: 3600,
        steps: twoStepFunnel,
      }),
    )
    const updated = await callAs(admin(), () =>
      caller.funnels.update({
        projectId,
        id: created.id,
        patch: { name: 'Updated Name', window: 604800 },
      }),
    )
    expect(updated.name).toBe('Updated Name')
    expect(updated.window).toBe(604800)
    expect(updated.steps).toEqual(twoStepFunnel)
  })

  it('update on a missing id throws NOT_FOUND', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.funnels.update({ projectId, id: 'nope', patch: { name: 'x' } })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('soft delete hides the funnel from list and get', async () => {
    const caller = callerFor(adminUserId, orgId)
    const created = await callAs(admin(), () =>
      caller.funnels.create({
        projectId,
        name: 'To Delete',
        window: 3600,
        steps: twoStepFunnel,
      }),
    )
    await callAs(admin(), () => caller.funnels.delete({ projectId, id: created.id }))

    const rows = await callAs(admin(), () => caller.funnels.list({ projectId }))
    expect(rows.map((r) => r.id)).not.toContain(created.id)

    await expect(
      callAs(admin(), () => caller.funnels.get({ projectId, id: created.id })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('delete on a missing id throws NOT_FOUND', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.funnels.delete({ projectId, id: 'nope' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('funnels cross-tenant isolation', () => {
  it('a caller in org A gets NOT_FOUND for org B project', async () => {
    const b = await authService.signup({
      email: `funnels-tenant-b-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Funnels Tenant B ${suffix}`,
    })
    createdUserIds.push(b.user.id)
    createdOrgIds.push(b.org!.id)
    const bProject = await prisma.project.findFirstOrThrow({ where: { orgId: b.org!.id } })

    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.funnels.list({ projectId: bProject.id })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('funnels permissions', () => {
  it('a viewer may list but not create', async () => {
    const v = await authService.signup({
      email: `funnels-viewer-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Funnels Viewer Org ${suffix}`,
    })
    createdUserIds.push(v.user.id)
    createdOrgIds.push(v.org!.id)
    const vOrgId = v.org!.id
    const vProject = await prisma.project.findFirstOrThrow({ where: { orgId: vOrgId } })
    const viewer = { userId: v.user.id, orgId: vOrgId, orgRole: 'viewer' as const }
    const caller = callerFor(v.user.id, vOrgId)

    await expect(
      callAs(viewer, () => caller.funnels.list({ projectId: vProject.id })),
    ).resolves.toBeInstanceOf(Array)

    await expect(
      callAs(viewer, () =>
        caller.funnels.create({
          projectId: vProject.id,
          name: 'nope',
          window: 3600,
          steps: twoStepFunnel,
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
