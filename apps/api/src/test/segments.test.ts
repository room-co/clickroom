import { prisma } from '@clickroom/db'
import { appRouter } from '@clickroom/trpc-router'
import type { SegmentDefinitionInput } from '@clickroom/trpc-router/trpc/routers/segments.schema.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authService, callAs, cleanupOrg, cleanupUser, makeCtx } from './helpers.js'

const suffix = Date.now().toString(36)
const createdUserIds: string[] = []
const createdOrgIds: string[] = []

let adminUserId: string
let orgId: string
let projectId: string

const traitDefinition: SegmentDefinitionInput = {
  version: 1,
  root: {
    combinator: 'AND',
    conditions: [{ type: 'trait', key: 'plan', operator: 'exact', value: 'pro' }],
  },
}

const behavioralDefinition: SegmentDefinitionInput = {
  version: 1,
  root: {
    combinator: 'OR',
    conditions: [{ type: 'behavioral', event: 'purchase', count: 2, days: 30 }],
  },
}

beforeAll(async () => {
  const s = await authService.signup({
    email: `segments-admin-${suffix}@test.invalid`,
    password: 'password123',
    orgName: `Segments Org ${suffix}`,
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

describe('segments.create', () => {
  it('creates a segment with a trait condition', async () => {
    const caller = callerFor(adminUserId, orgId)
    const segment = await callAs(admin(), () =>
      caller.segments.create({
        projectId,
        name: 'Pro Plan Users',
        description: 'Users on the pro plan',
        definition: traitDefinition,
      }),
    )
    expect(segment).toMatchObject({ name: 'Pro Plan Users', description: 'Users on the pro plan' })
    expect(segment.definition).toEqual(traitDefinition)
  })

  it('creates a segment with a behavioral condition', async () => {
    const caller = callerFor(adminUserId, orgId)
    const segment = await callAs(admin(), () =>
      caller.segments.create({
        projectId,
        name: 'Repeat Purchasers',
        definition: behavioralDefinition,
      }),
    )
    expect(segment.definition).toEqual(behavioralDefinition)
  })

  it('rejects an unsupported definition version', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () =>
        caller.segments.create({
          projectId,
          name: 'Bad version',
          definition: {
            // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid input
            version: 2 as any,
            root: { combinator: 'AND', conditions: [] },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('rejects an invalid operator', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () =>
        caller.segments.create({
          projectId,
          name: 'Bad operator',
          definition: {
            version: 1,
            root: {
              combinator: 'AND',
              conditions: [
                // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid input
                { type: 'trait', key: 'plan', operator: 'regex', value: 'pro' } as any,
              ],
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('segments.list / get', () => {
  it('lists non-deleted segments ordered by name', async () => {
    const caller = callerFor(adminUserId, orgId)
    await callAs(admin(), () =>
      caller.segments.create({
        projectId,
        name: 'Aardvark Segment',
        definition: traitDefinition,
      }),
    )
    const rows = await callAs(admin(), () => caller.segments.list({ projectId }))
    expect(rows.map((r) => r.name)).toContain('Aardvark Segment')
    const names = rows.map((r) => r.name)
    expect([...names].sort()).toEqual(names)
  })

  it('get returns the segment; NOT_FOUND for missing id', async () => {
    const caller = callerFor(adminUserId, orgId)
    const created = await callAs(admin(), () =>
      caller.segments.create({
        projectId,
        name: 'Gettable Segment',
        definition: traitDefinition,
      }),
    )
    const segment = await callAs(admin(), () => caller.segments.get({ projectId, id: created.id }))
    expect(segment.id).toBe(created.id)
    await expect(
      callAs(admin(), () => caller.segments.get({ projectId, id: 'nope' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('segments.update / delete', () => {
  it('update patches name/description/definition', async () => {
    const caller = callerFor(adminUserId, orgId)
    const created = await callAs(admin(), () =>
      caller.segments.create({
        projectId,
        name: 'To Update',
        definition: traitDefinition,
      }),
    )
    const updated = await callAs(admin(), () =>
      caller.segments.update({
        projectId,
        id: created.id,
        patch: { name: 'Updated Name', definition: behavioralDefinition },
      }),
    )
    expect(updated.name).toBe('Updated Name')
    expect(updated.definition).toEqual(behavioralDefinition)
  })

  it('update on a missing id throws NOT_FOUND', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () =>
        caller.segments.update({ projectId, id: 'nope', patch: { name: 'x' } }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('soft delete hides the segment from list and get', async () => {
    const caller = callerFor(adminUserId, orgId)
    const created = await callAs(admin(), () =>
      caller.segments.create({
        projectId,
        name: 'To Delete',
        definition: traitDefinition,
      }),
    )
    await callAs(admin(), () => caller.segments.delete({ projectId, id: created.id }))

    const rows = await callAs(admin(), () => caller.segments.list({ projectId }))
    expect(rows.map((r) => r.id)).not.toContain(created.id)

    await expect(
      callAs(admin(), () => caller.segments.get({ projectId, id: created.id })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('delete on a missing id throws NOT_FOUND', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.segments.delete({ projectId, id: 'nope' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('segments.latestSnapshot', () => {
  it('returns null when no snapshot has been materialized yet', async () => {
    const caller = callerFor(adminUserId, orgId)
    const created = await callAs(admin(), () =>
      caller.segments.create({
        projectId,
        name: 'No Snapshot Yet',
        definition: traitDefinition,
      }),
    )
    const result = await callAs(admin(), () =>
      caller.segments.latestSnapshot({ projectId, segmentId: created.id }),
    )
    expect(result).toBeNull()
  })

  it('returns the most recently computed snapshot when multiple exist', async () => {
    const caller = callerFor(adminUserId, orgId)
    const created = await callAs(admin(), () =>
      caller.segments.create({
        projectId,
        name: 'Multi Snapshot Segment',
        definition: traitDefinition,
      }),
    )

    const older = await prisma.segmentSnapshot.create({
      data: {
        id: `snap-older-${suffix}`,
        projectId,
        segmentId: created.id,
        memberCount: 3,
        status: 'ready',
        computedAt: new Date(Date.now() - 60_000),
      },
    })
    const newer = await prisma.segmentSnapshot.create({
      data: {
        id: `snap-newer-${suffix}`,
        projectId,
        segmentId: created.id,
        memberCount: 9,
        status: 'ready',
        computedAt: new Date(),
      },
    })

    const result = await callAs(admin(), () =>
      caller.segments.latestSnapshot({ projectId, segmentId: created.id }),
    )
    expect(result?.id).toBe(newer.id)
    expect(result?.id).not.toBe(older.id)
    expect(result?.memberCount).toBe(9)
  })

  it('a caller in org A gets NOT_FOUND for org B project', async () => {
    const b = await authService.signup({
      email: `segments-snapshot-tenant-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Segments Snapshot Tenant Org ${suffix}`,
    })
    createdUserIds.push(b.user.id)
    createdOrgIds.push(b.org!.id)
    const bProject = await prisma.project.findFirstOrThrow({ where: { orgId: b.org!.id } })

    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () =>
        caller.segments.latestSnapshot({ projectId: bProject.id, segmentId: 'anything' }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('segments cross-tenant isolation', () => {
  it('a caller in org A gets NOT_FOUND for org B project', async () => {
    const b = await authService.signup({
      email: `segments-tenant-b-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Segments Tenant B ${suffix}`,
    })
    createdUserIds.push(b.user.id)
    createdOrgIds.push(b.org!.id)
    const bProject = await prisma.project.findFirstOrThrow({ where: { orgId: b.org!.id } })

    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.segments.list({ projectId: bProject.id })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('get on another org project fails closed', async () => {
    const b = await authService.signup({
      email: `segments-tenant-c-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Segments Tenant C ${suffix}`,
    })
    createdUserIds.push(b.user.id)
    createdOrgIds.push(b.org!.id)
    const bProject = await prisma.project.findFirstOrThrow({ where: { orgId: b.org!.id } })

    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.segments.get({ projectId: bProject.id, id: 'anything' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('segments permissions', () => {
  it('a viewer may list/get but not create/update/delete/materialize', async () => {
    const v = await authService.signup({
      email: `segments-viewer-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Segments Viewer Org ${suffix}`,
    })
    createdUserIds.push(v.user.id)
    createdOrgIds.push(v.org!.id)
    const vOrgId = v.org!.id
    const vProject = await prisma.project.findFirstOrThrow({ where: { orgId: vOrgId } })
    const viewer = { userId: v.user.id, orgId: vOrgId, orgRole: 'viewer' as const }
    const caller = callerFor(v.user.id, vOrgId)

    await expect(
      callAs(viewer, () => caller.segments.list({ projectId: vProject.id })),
    ).resolves.toBeInstanceOf(Array)

    await expect(
      callAs(viewer, () =>
        caller.segments.create({
          projectId: vProject.id,
          name: 'nope',
          definition: traitDefinition,
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(
      callAs(viewer, () =>
        caller.segments.update({
          projectId: vProject.id,
          id: 'whatever',
          patch: { name: 'nope' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(
      callAs(viewer, () => caller.segments.delete({ projectId: vProject.id, id: 'whatever' })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(
      callAs(viewer, () => caller.segments.materialize({ projectId: vProject.id, id: 'whatever' })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
