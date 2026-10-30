import {
  backfillProjectEnvironments,
  backfillSystemDefinitions,
  newId,
  prisma,
} from '@clickroom/db'
import { appRouter } from '@clickroom/trpc-router'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authService, callAs, cleanupOrg, cleanupUser, makeCtx } from './helpers.js'

const suffix = Date.now().toString(36)
const createdUserIds: string[] = []
const createdOrgIds: string[] = []

let adminUserId: string
let orgId: string
let projectId: string

beforeAll(async () => {
  const s = await authService.signup({
    email: `projects-admin-${suffix}@test.invalid`,
    password: 'password123',
    orgName: `Projects Org ${suffix}`,
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

function admin() {
  return { userId: adminUserId, orgId, orgRole: 'org_admin' as const }
}

describe('projects CRUD', () => {
  it('list returns the seeded default project', async () => {
    const caller = callerFor(adminUserId, orgId)
    const rows = await callAs(admin(), () => caller.projects.list())
    expect(rows.some((p) => p.id === projectId)).toBe(true)
  })

  it('create bootstraps default environments so keys can be created', async () => {
    const caller = callerFor(adminUserId, orgId)
    const created = await callAs(admin(), () => caller.projects.create({ name: 'Env Project' }))
    const envs = await prisma.environment.findMany({ where: { projectId: created.id } })
    expect(envs.map((e) => e.key).sort()).toEqual(['development', 'production'])
    expect(envs.filter((e) => e.isDefault).map((e) => e.key)).toEqual(['production'])

    const { key } = await callAs(admin(), () =>
      caller.projects.keys.create({ projectId: created.id, type: 'write' }),
    )
    expect(key.env).toBe('production')
  })

  it('key creation heals a legacy project that has no environments', async () => {
    const legacy = await prisma.project.create({
      data: { id: newId(), orgId, name: 'Legacy No Env' },
    })
    const caller = callerFor(adminUserId, orgId)
    const { key } = await callAs(admin(), () =>
      caller.projects.keys.create({ projectId: legacy.id, type: 'write' }),
    )
    expect(key.env).toBe('production')
  })

  it('backfillProjectEnvironments repairs env-less projects idempotently', async () => {
    const orphan = await prisma.project.create({
      data: { id: newId(), orgId, name: 'Orphan' },
    })
    expect(await backfillProjectEnvironments(prisma)).toBeGreaterThanOrEqual(1)
    const envs = await prisma.environment.findMany({ where: { projectId: orphan.id } })
    expect(envs).toHaveLength(2)
    expect(await backfillProjectEnvironments(prisma)).toBe(0)
  })

  it('create seeds system event and property definitions', async () => {
    const caller = callerFor(adminUserId, orgId)
    const created = await callAs(admin(), () => caller.projects.create({ name: 'Defs Project' }))
    const events = await prisma.eventDefinition.findMany({ where: { projectId: created.id } })
    expect(events.map((e) => e.name).sort()).toEqual(['$autocapture', '$identify', '$pageview'])
    expect(events.every((e) => e.isSystem)).toBe(true)
    const props = await prisma.propertyDefinition.findMany({ where: { projectId: created.id } })
    expect(props.map((p) => p.name).sort()).toEqual(['$current_url', '$event_type'])
  })

  it('backfillSystemDefinitions repairs projects idempotently', async () => {
    const orphan = await prisma.project.create({
      data: { id: newId(), orgId, name: 'No Defs' },
    })
    expect(await backfillSystemDefinitions(prisma)).toBeGreaterThanOrEqual(1)
    expect(await prisma.eventDefinition.count({ where: { projectId: orphan.id } })).toBe(3)
    expect(await prisma.propertyDefinition.count({ where: { projectId: orphan.id } })).toBe(2)
    expect(await backfillSystemDefinitions(prisma)).toBe(0)
  })

  it('create adds a new project with default fields', async () => {
    const caller = callerFor(adminUserId, orgId)
    const created = await callAs(admin(), () => caller.projects.create({ name: 'New Project' }))
    expect(created.name).toBe('New Project')
    expect(created.timezone).toBe('UTC')
    expect(created.dataRetentionDays).toBe(90)
    expect(created.domain).toBeNull()

    const rows = await callAs(admin(), () => caller.projects.list())
    expect(rows.some((p) => p.id === created.id)).toBe(true)
  })

  it('update changes name, timezone, domain, and retention', async () => {
    const caller = callerFor(adminUserId, orgId)
    await callAs(admin(), () =>
      caller.projects.update({
        id: projectId,
        name: 'Renamed Project',
        timezone: 'America/New_York',
        domain: 'https://example.com',
        dataRetentionDays: 30,
      }),
    )

    const updated = await prisma.project.findUniqueOrThrow({ where: { id: projectId } })
    expect(updated.name).toBe('Renamed Project')
    expect(updated.timezone).toBe('America/New_York')
    expect(updated.domain).toBe('https://example.com')
    expect(updated.dataRetentionDays).toBe(30)
  })

  it('update rejects an unknown project id (NOT_FOUND)', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.projects.update({ id: 'does-not-exist', name: 'x' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('delete removes a project', async () => {
    const caller = callerFor(adminUserId, orgId)
    const created = await callAs(admin(), () => caller.projects.create({ name: 'To Delete' }))
    await callAs(admin(), () => caller.projects.delete({ id: created.id }))

    const rows = await callAs(admin(), () => caller.projects.list())
    expect(rows.some((p) => p.id === created.id)).toBe(false)
  })

  it('delete rejects an unknown project id (NOT_FOUND)', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.projects.delete({ id: 'does-not-exist' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('projects cross-tenant isolation', () => {
  it('org A caller gets NOT_FOUND updating org B project', async () => {
    const b = await authService.signup({
      email: `projects-tenant-b-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Projects Tenant B ${suffix}`,
    })
    createdUserIds.push(b.user.id)
    createdOrgIds.push(b.org!.id)
    const bProject = await prisma.project.findFirstOrThrow({ where: { orgId: b.org!.id } })

    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.projects.update({ id: bProject.id, name: 'hijacked' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await expect(
      callAs(admin(), () => caller.projects.delete({ id: bProject.id })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const stillThere = await prisma.project.findUnique({ where: { id: bProject.id } })
    expect(stillThere?.name).toBe('Default')
  })
})
