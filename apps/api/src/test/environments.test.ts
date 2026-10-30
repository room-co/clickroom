import { newId, prisma } from '@clickroom/db'
import { appRouter } from '@clickroom/trpc-router'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authService, callAs, cleanupOrg, cleanupUser, makeCtx } from './helpers.js'

const suffix = Date.now().toString(36)
const createdUserIds: string[] = []
const createdOrgIds: string[] = []

let adminUserId: string
let orgId: string
let projectId: string
let productionEnvId: string

beforeAll(async () => {
  const s = await authService.signup({
    email: `env-admin-${suffix}@test.invalid`,
    password: 'password123',
    orgName: `Env Org ${suffix}`,
  })
  adminUserId = s.user.id
  orgId = s.org!.id
  createdUserIds.push(adminUserId)
  createdOrgIds.push(orgId)

  const project = await prisma.project.findFirstOrThrow({ where: { orgId } })
  projectId = project.id

  const productionEnv = await prisma.environment.findFirstOrThrow({
    where: { projectId, key: 'production' },
  })
  productionEnvId = productionEnv.id
})

afterAll(async () => {
  for (const oid of createdOrgIds) await cleanupOrg(oid)
  for (const uid of createdUserIds) await cleanupUser(uid)
  await prisma.$disconnect()
})

function callerFor(userId: string) {
  return appRouter.createCaller(
    makeCtx({ tokenPayload: { sub: userId, sessionId: 'test', orgId } }),
  )
}

const admin = () => ({ userId: adminUserId, orgId, orgRole: 'org_admin' as const })

describe('environments.create / list', () => {
  it('creates a custom environment and lists it alongside the seeded ones', async () => {
    const caller = callerFor(adminUserId)
    const created = await callAs(admin(), () =>
      caller.environments.create({ projectId, key: 'qa', name: 'QA' }),
    )
    expect(created.key).toBe('qa')
    expect(created.name).toBe('QA')
    expect(created.isDefault).toBe(false)

    const list = await callAs(admin(), () => caller.environments.list({ projectId }))
    const keys = list.map((e) => e.key).sort()
    expect(keys).toEqual(['development', 'production', 'qa'])
  })

  it('rejects an invalid slug', async () => {
    const caller = callerFor(adminUserId)
    await expect(
      callAs(admin(), () =>
        caller.environments.create({ projectId, key: 'Not Valid!', name: 'Bad' }),
      ),
    ).rejects.toThrow()
  })

  it('returns CONFLICT on a duplicate slug within the same project', async () => {
    const caller = callerFor(adminUserId)
    await callAs(admin(), () =>
      caller.environments.create({ projectId, key: 'dup-env', name: 'Dup' }),
    )
    await expect(
      callAs(admin(), () =>
        caller.environments.create({ projectId, key: 'dup-env', name: 'Dup Again' }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('environments.update', () => {
  it('renames name/color without touching the slug', async () => {
    const caller = callerFor(adminUserId)
    const created = await callAs(admin(), () =>
      caller.environments.create({ projectId, key: 'to-rename', name: 'Original' }),
    )
    const updated = await callAs(admin(), () =>
      caller.environments.update({
        projectId,
        id: created.id,
        name: 'Renamed',
        color: '#ff0000',
      }),
    )
    expect(updated.key).toBe('to-rename')
    expect(updated.name).toBe('Renamed')
    expect(updated.color).toBe('#ff0000')
  })

  it('NOT_FOUND for a missing environment id', async () => {
    const caller = callerFor(adminUserId)
    await expect(
      callAs(admin(), () => caller.environments.update({ projectId, id: newId(), name: 'Nope' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('environments.delete', () => {
  it('blocks deletion while a flag or a non-revoked key reference the env, then succeeds', async () => {
    const caller = callerFor(adminUserId)
    const env = await callAs(admin(), () =>
      caller.environments.create({ projectId, key: 'to-delete', name: 'ToDelete' }),
    )

    const flag = await prisma.featureFlag.create({
      data: {
        id: newId(),
        projectId,
        key: `flag-${suffix}`,
        active: false,
        environmentId: env.id,
        filters: { groups: [] },
      },
    })

    await expect(
      callAs(admin(), () => caller.environments.delete({ projectId, id: env.id })),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    await prisma.featureFlag.delete({ where: { id: flag.id } })

    const key = await callAs(admin(), () =>
      caller.projects.keys.create({ projectId, type: 'write', label: 'ToDeleteEnvKey' }),
    )
    await prisma.apiKey.update({
      where: { id: key.key.id },
      data: { environmentId: env.id },
    })

    await expect(
      callAs(admin(), () => caller.environments.delete({ projectId, id: env.id })),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    // Revoking the key clears the block (only non-revoked keys count).
    await prisma.apiKey.update({
      where: { id: key.key.id },
      data: { revokedAt: new Date() },
    })

    const deleted = await callAs(admin(), () =>
      caller.environments.delete({ projectId, id: env.id }),
    )
    expect(deleted).toEqual({ ok: true })

    const row = await prisma.environment.findUnique({ where: { id: env.id } })
    expect(row).toBeNull()
  })

  it('NOT_FOUND when deleting a missing environment', async () => {
    const caller = callerFor(adminUserId)
    await expect(
      callAs(admin(), () => caller.environments.delete({ projectId, id: newId() })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('cross-tenant isolation', () => {
  it('a caller scoped to org A cannot list, update, or delete org B environments', async () => {
    const b = await authService.signup({
      email: `env-tenant-b-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Env Tenant B ${suffix}`,
    })
    createdUserIds.push(b.user.id)
    createdOrgIds.push(b.org!.id)
    const bProject = await prisma.project.findFirstOrThrow({ where: { orgId: b.org!.id } })
    const bEnv = await prisma.environment.findFirstOrThrow({
      where: { projectId: bProject.id, key: 'production' },
    })

    const caller = callerFor(adminUserId)

    await expect(
      callAs(admin(), () => caller.environments.list({ projectId: bProject.id })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await expect(
      callAs(admin(), () =>
        caller.environments.update({ projectId: bProject.id, id: bEnv.id, name: 'hijacked' }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await expect(
      callAs(admin(), () => caller.environments.delete({ projectId: bProject.id, id: bEnv.id })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const stillThere = await prisma.environment.findUnique({ where: { id: bEnv.id } })
    expect(stillThere?.name).toBe('Production')
  })
})

// Sanity check for the seeded id captured in beforeAll (avoids an unused-var lint).
describe('seeded production environment', () => {
  it('is marked isDefault', async () => {
    const row = await prisma.environment.findUniqueOrThrow({ where: { id: productionEnvId } })
    expect(row.isDefault).toBe(true)
  })
})
