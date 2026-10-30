import { prisma } from '@clickroom/db'
import { appRouter } from '@clickroom/trpc-router'
import type { InsightConfigInput } from '@clickroom/trpc-router/trpc/routers/insights.schema.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authService, callAs, cleanupOrg, cleanupUser, makeCtx } from './helpers.js'

const suffix = Date.now().toString(36)
const createdUserIds: string[] = []
const createdOrgIds: string[] = []

let adminUserId: string
let orgId: string
let projectId: string
let insightId: string

const range = { from: '2020-01-01T00:00:00.000Z', to: '2035-01-01T00:00:00.000Z' }

const trendConfig: InsightConfigInput = {
  type: 'trend',
  event: '$pageview',
  interval: 'day',
  range,
}

beforeAll(async () => {
  const s = await authService.signup({
    email: `dashboard-admin-${suffix}@test.invalid`,
    password: 'password123',
    orgName: `Dashboard Org ${suffix}`,
  })
  adminUserId = s.user.id
  orgId = s.org!.id
  createdUserIds.push(adminUserId)
  createdOrgIds.push(orgId)

  const project = await prisma.project.findFirstOrThrow({ where: { orgId } })
  projectId = project.id

  const caller = callerFor(adminUserId, orgId)
  const insight = await callAs(admin(), () =>
    caller.insights.create({
      projectId,
      name: 'Widget insight',
      config: trendConfig,
    }),
  )
  insightId = insight.id
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

describe('dashboard widgets CRUD', () => {
  it('addWidget with no layout defaults to a 4x6 tile stacked below existing widgets', async () => {
    const caller = callerFor(adminUserId, orgId)

    const first = await callAs(admin(), () => caller.dashboard.addWidget({ projectId, insightId }))
    expect(first).toMatchObject({ insightId, x: 0, y: 0, w: 4, h: 6 })

    const second = await callAs(admin(), () => caller.dashboard.addWidget({ projectId, insightId }))
    expect(second).toMatchObject({ insightId, x: 0, y: 6, w: 4, h: 6 })

    await callAs(admin(), () => caller.dashboard.removeWidget({ projectId, id: first.id }))
    await callAs(admin(), () => caller.dashboard.removeWidget({ projectId, id: second.id }))
  })

  it('lists widgets with the joined insight and persists layout/rangeKey updates', async () => {
    const caller = callerFor(adminUserId, orgId)

    const created = await callAs(admin(), () =>
      caller.dashboard.addWidget({
        projectId,
        insightId,
        layout: { x: 1, y: 2, w: 3, h: 4 },
      }),
    )
    expect(created).toMatchObject({ x: 1, y: 2, w: 3, h: 4 })

    const list = await callAs(admin(), () => caller.dashboard.widgets({ projectId }))
    const found = list.find((w) => w.id === created.id)
    expect(found).toBeTruthy()
    expect(found?.insight).toMatchObject({ id: insightId, name: 'Widget insight', type: 'trend' })

    await callAs(admin(), () =>
      caller.dashboard.updateLayout({
        projectId,
        layouts: [{ id: created.id, x: 5, y: 6, w: 7, h: 8 }],
      }),
    )
    const afterLayout = await callAs(admin(), () => caller.dashboard.widgets({ projectId }))
    expect(afterLayout.find((w) => w.id === created.id)).toMatchObject({
      x: 5,
      y: 6,
      w: 7,
      h: 8,
    })

    const withRange = await callAs(admin(), () =>
      caller.dashboard.updateWidget({ projectId, id: created.id, rangeKey: '7d' }),
    )
    expect(withRange.rangeKey).toBe('7d')

    const cleared = await callAs(admin(), () =>
      caller.dashboard.updateWidget({ projectId, id: created.id, rangeKey: null }),
    )
    expect(cleared.rangeKey).toBeNull()

    await callAs(admin(), () => caller.dashboard.removeWidget({ projectId, id: created.id }))
    const afterRemove = await callAs(admin(), () => caller.dashboard.widgets({ projectId }))
    expect(afterRemove.map((w) => w.id)).not.toContain(created.id)

    const row = await prisma.dashboardWidget.findUnique({ where: { id: created.id } })
    expect(row).not.toBeNull()
    expect(row?.deletedAt).not.toBeNull()
  })

  it('updateWidget on a missing id throws NOT_FOUND', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () =>
        caller.dashboard.updateWidget({ projectId, id: 'nope', rangeKey: '7d' }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('removeWidget on a missing id throws NOT_FOUND', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.dashboard.removeWidget({ projectId, id: 'nope' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('addWidget referencing an insight from another project fails closed', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () =>
        caller.dashboard.addWidget({ projectId, insightId: 'no-such-insight' }),
      ),
    ).rejects.toThrow()
  })
})

describe('dashboard cross-tenant isolation', () => {
  async function otherTenantProject(label: string) {
    const b = await authService.signup({
      email: `dashboard-tenant-${label}-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Dashboard Tenant ${label} ${suffix}`,
    })
    createdUserIds.push(b.user.id)
    createdOrgIds.push(b.org!.id)
    const bProject = await prisma.project.findFirstOrThrow({ where: { orgId: b.org!.id } })
    return bProject.id
  }

  it('widgets on another org project fails closed', async () => {
    const bProjectId = await otherTenantProject('widgets')
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.dashboard.widgets({ projectId: bProjectId })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('addWidget on another org project fails closed', async () => {
    const bProjectId = await otherTenantProject('add')
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.dashboard.addWidget({ projectId: bProjectId, insightId })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('updateLayout on another org project fails closed', async () => {
    const bProjectId = await otherTenantProject('layout')
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () =>
        caller.dashboard.updateLayout({
          projectId: bProjectId,
          layouts: [{ id: 'anything', x: 0, y: 0, w: 1, h: 1 }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('removeWidget on another org project fails closed', async () => {
    const bProjectId = await otherTenantProject('remove')
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () =>
        caller.dashboard.removeWidget({ projectId: bProjectId, id: 'anything' }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('dashboard permissions', () => {
  it('a viewer may list widgets but not add/update/remove', async () => {
    const v = await authService.signup({
      email: `dashboard-viewer-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Dashboard Viewer Org ${suffix}`,
    })
    createdUserIds.push(v.user.id)
    createdOrgIds.push(v.org!.id)
    const vOrgId = v.org!.id
    const vProject = await prisma.project.findFirstOrThrow({ where: { orgId: vOrgId } })
    const vAdmin = { userId: v.user.id, orgId: vOrgId, orgRole: 'org_admin' as const }
    const viewer = { userId: v.user.id, orgId: vOrgId, orgRole: 'viewer' as const }
    const caller = callerFor(v.user.id, vOrgId)

    const vInsight = await callAs(vAdmin, () =>
      caller.insights.create({
        projectId: vProject.id,
        name: 'Viewer insight',
        config: trendConfig,
      }),
    )
    const widget = await callAs(vAdmin, () =>
      caller.dashboard.addWidget({ projectId: vProject.id, insightId: vInsight.id }),
    )

    await expect(
      callAs(viewer, () => caller.dashboard.widgets({ projectId: vProject.id })),
    ).resolves.toBeInstanceOf(Array)

    await expect(
      callAs(viewer, () =>
        caller.dashboard.addWidget({ projectId: vProject.id, insightId: vInsight.id }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(
      callAs(viewer, () =>
        caller.dashboard.updateLayout({
          projectId: vProject.id,
          layouts: [{ id: widget.id, x: 1, y: 1, w: 1, h: 1 }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(
      callAs(viewer, () =>
        caller.dashboard.removeWidget({ projectId: vProject.id, id: widget.id }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
