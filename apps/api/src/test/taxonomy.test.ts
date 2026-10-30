import { newId, prisma } from '@clickroom/db'
import { appRouter } from '@clickroom/trpc-router'
import { redis } from '@clickroom/trpc-router/lib/redis.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authService, callAs, cleanupOrg, cleanupUser, makeCtx } from './helpers.js'

const suffix = Date.now().toString(36)
const createdUserIds: string[] = []
const createdOrgIds: string[] = []

let adminUserId: string
let orgId: string
let projectId: string

// Seeded taxonomy row ids (cleaned up via cleanupOrg's cascade on the org).
let signupEventId: string
let hiddenEventId: string
let planPropId: string

beforeAll(async () => {
  const s = await authService.signup({
    email: `tax-admin-${suffix}@test.invalid`,
    password: 'password123',
    orgName: `Taxonomy Org ${suffix}`,
  })
  adminUserId = s.user.id
  orgId = s.org!.id
  createdUserIds.push(adminUserId)
  createdOrgIds.push(orgId)

  const project = await prisma.project.findFirstOrThrow({ where: { orgId } })
  projectId = project.id

  // Two events (one hidden) + two properties (one linked to `signup` via
  // EventProperty, one unlinked) mirror the discovery rows ingest-rs writes.
  signupEventId = newId()
  hiddenEventId = newId()
  planPropId = newId()
  const otherPropId = newId()

  await prisma.eventDefinition.createMany({
    data: [
      { id: signupEventId, projectId, name: 'signup', verified: false, hidden: false },
      { id: hiddenEventId, projectId, name: 'internal_ping', verified: false, hidden: true },
    ],
  })
  await prisma.propertyDefinition.createMany({
    data: [
      { id: planPropId, projectId, name: 'plan', scope: 'event', propertyType: 'String' },
      { id: otherPropId, projectId, name: 'unrelated', scope: 'event', propertyType: 'String' },
    ],
  })
  await prisma.eventProperty.create({
    data: { id: newId(), projectId, eventName: 'signup', propertyName: 'plan' },
  })
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

describe('taxonomy auth', () => {
  it('rejects a request with no active org context (FORBIDDEN)', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(caller.taxonomy.events.list({ projectId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('a viewer may read but not update (permission enforcement)', async () => {
    const v = await authService.signup({
      email: `tax-viewer-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Taxonomy Viewer Org ${suffix}`,
    })
    createdUserIds.push(v.user.id)
    createdOrgIds.push(v.org!.id)
    const vOrgId = v.org!.id
    const vProject = await prisma.project.findFirstOrThrow({ where: { orgId: vOrgId } })
    const viewer = { userId: v.user.id, orgId: vOrgId, orgRole: 'viewer' as const }
    const caller = callerFor(v.user.id, vOrgId)

    // viewer has projects:read → list works.
    await expect(
      callAs(viewer, () => caller.taxonomy.events.list({ projectId: vProject.id })),
    ).resolves.toBeInstanceOf(Array)

    // viewer lacks projects:manage → update rejected.
    await expect(
      callAs(viewer, () =>
        caller.taxonomy.events.update({ projectId: vProject.id, id: 'nope', verified: true }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('taxonomy cross-tenant isolation', () => {
  it('a caller in org A gets NOT_FOUND for org B project', async () => {
    const b = await authService.signup({
      email: `tax-tenant-b-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Taxonomy Tenant B ${suffix}`,
    })
    createdUserIds.push(b.user.id)
    createdOrgIds.push(b.org!.id)
    const bProject = await prisma.project.findFirstOrThrow({ where: { orgId: b.org!.id } })

    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.taxonomy.events.list({ projectId: bProject.id })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('taxonomy events.list', () => {
  it('returns non-hidden events and excludes hidden by default', async () => {
    const caller = callerFor(adminUserId, orgId)
    const rows = await callAs(admin(), () => caller.taxonomy.events.list({ projectId }))
    const names = rows.map((r) => r.name)
    expect(names).toContain('signup')
    expect(names).not.toContain('internal_ping')
    // volume30d serialized JSON-safe (BigInt → number).
    expect(typeof rows.find((r) => r.name === 'signup')?.volume30d).toBe('number')
  })

  it('includes hidden events with includeHidden', async () => {
    const caller = callerFor(adminUserId, orgId)
    const rows = await callAs(admin(), () =>
      caller.taxonomy.events.list({ projectId, includeHidden: true }),
    )
    expect(rows.map((r) => r.name)).toContain('internal_ping')
  })

  it('filters by search (case-insensitive)', async () => {
    const caller = callerFor(adminUserId, orgId)
    const rows = await callAs(admin(), () =>
      caller.taxonomy.events.list({ projectId, search: 'SIGN' }),
    )
    expect(rows.map((r) => r.name)).toEqual(['signup'])
  })
})

describe('taxonomy properties.list', () => {
  it('lists event-scope properties, excluding hidden', async () => {
    const caller = callerFor(adminUserId, orgId)
    const rows = await callAs(admin(), () =>
      caller.taxonomy.properties.list({ projectId, scope: 'event' }),
    )
    const names = rows.map((r) => r.name)
    expect(names).toContain('plan')
    expect(names).toContain('unrelated')
  })

  it('filters to properties linked to an event via eventName', async () => {
    const caller = callerFor(adminUserId, orgId)
    const rows = await callAs(admin(), () =>
      caller.taxonomy.properties.list({ projectId, scope: 'event', eventName: 'signup' }),
    )
    expect(rows.map((r) => r.name)).toEqual(['plan'])
  })
})

describe('taxonomy updates', () => {
  it('events.update sets fields and busts the cache', async () => {
    const caller = callerFor(adminUserId, orgId)
    const updated = await callAs(admin(), () =>
      caller.taxonomy.events.update({
        projectId,
        id: signupEventId,
        description: 'User signed up',
        verified: true,
      }),
    )
    expect(updated).toMatchObject({ verified: true, description: 'User signed up' })

    // Cache was busted → the re-read reflects the write immediately.
    const rows = await callAs(admin(), () => caller.taxonomy.events.list({ projectId }))
    expect(rows.find((r) => r.name === 'signup')?.verified).toBe(true)
  })

  it('events.update on a missing id throws NOT_FOUND', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () =>
        caller.taxonomy.events.update({ projectId, id: 'does-not-exist', hidden: true }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('properties.update with propertyType sets typeLocked=true', async () => {
    const caller = callerFor(adminUserId, orgId)
    const updated = await callAs(admin(), () =>
      caller.taxonomy.properties.update({
        projectId,
        id: planPropId,
        propertyType: 'Numeric',
      }),
    )
    expect(updated).toMatchObject({ propertyType: 'Numeric', typeLocked: true })

    const fresh = await prisma.propertyDefinition.findFirstOrThrow({ where: { id: planPropId } })
    expect(fresh.typeLocked).toBe(true)
    expect(fresh.propertyType).toBe('Numeric')
  })
})

describe('taxonomy events.create', () => {
  it('creates a new event definition', async () => {
    const caller = callerFor(adminUserId, orgId)
    const created = await callAs(admin(), () =>
      caller.taxonomy.events.create({ projectId, name: 'checkout_started' }),
    )
    expect(created).toMatchObject({ name: 'checkout_started', enforcementMode: 'none' })
  })

  it('upserts (ensures) rather than erroring when the event already exists', async () => {
    const caller = callerFor(adminUserId, orgId)
    // 'signup' was already seeded in beforeAll — this must not throw a
    // uniqueness conflict, and should apply the requested enforcementMode.
    const ensured = await callAs(admin(), () =>
      caller.taxonomy.events.create({ projectId, name: 'signup', enforcementMode: 'warn' }),
    )
    expect(ensured).toMatchObject({ id: signupEventId, name: 'signup', enforcementMode: 'warn' })

    const rows = await prisma.eventDefinition.findMany({ where: { projectId, name: 'signup' } })
    expect(rows).toHaveLength(1)
  })
})

describe('taxonomy events.setSchema', () => {
  it('persists required + type per property and refreshes the capture:schema cache', async () => {
    const caller = callerFor(adminUserId, orgId)
    // Enable enforcement so this event shows up in the cache blob.
    await callAs(admin(), () =>
      caller.taxonomy.events.update({ projectId, id: signupEventId, enforcementMode: 'strict' }),
    )

    await callAs(admin(), () =>
      caller.taxonomy.events.setSchema({
        projectId,
        event: 'signup',
        properties: [
          { name: 'plan', type: 'Numeric', required: true },
          { name: 'referrer', type: 'String', required: false },
        ],
      }),
    )

    const planProp = await prisma.propertyDefinition.findFirstOrThrow({
      where: { projectId, name: 'plan', scope: 'event' },
    })
    expect(planProp).toMatchObject({ propertyType: 'Numeric', typeLocked: true })

    const link = await prisma.eventProperty.findFirstOrThrow({
      where: { projectId, eventName: 'signup', propertyName: 'plan' },
    })
    expect(link.required).toBe(true)

    const raw = await redis.get(`capture:schema:${projectId}`)
    expect(raw).toBeTruthy()
    const cached = JSON.parse(raw as string)
    expect(cached.signup).toMatchObject({
      mode: 'strict',
      required: ['plan'],
      types: { plan: 'Numeric', referrer: 'String' },
    })
  })
})
