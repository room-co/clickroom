import { hashPassword } from '@clickroom/auth'
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
let targetUserEmail: string

beforeAll(async () => {
  const s = await authService.signup({
    email: `rbac-admin-${suffix}@test.invalid`,
    password: 'password123',
    orgName: `RBAC Org ${suffix}`,
  })
  adminUserId = s.user.id
  orgId = s.org!.id
  createdUserIds.push(adminUserId)
  createdOrgIds.push(orgId)

  const project = await prisma.project.findFirstOrThrow({ where: { orgId } })
  projectId = project.id

  // bootstrapOrg only seeds `production` + `development` — this
  // suite also mints a key scoped to `staging`, so create it explicitly as a
  // real `Environment` row (custom environments are no longer a fixed enum).
  await prisma.environment.create({
    data: { id: newId(), projectId, key: 'staging', name: 'Staging' },
  })

  // No `Plan` row exists in the isolated test DB (only `migrate deploy` runs
  // there, not the seed script) — without an override, `effectiveLimits`
  // fails closed to 0 seats. Override so this suite's invite
  // exercises RBAC, not the quota gate (covered separately by quota.test.ts).
  await prisma.org.update({ where: { id: orgId }, data: { maxSeatsOverride: 1000 } })

  // A standalone user that can be invited into the org.
  targetUserEmail = `rbac-target-${suffix}@test.invalid`
  const target = await prisma.user.create({
    data: { id: newId(), email: targetUserEmail, passwordHash: await hashPassword('password123') },
  })
  createdUserIds.push(target.id)
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

describe('orgScopedProcedure', () => {
  it('rejects a request with no active org context (FORBIDDEN)', async () => {
    const caller = callerFor(adminUserId)
    // No callAs → no ALS store → orgScopedProcedure rejects.
    await expect(caller.projects.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('RBAC matrix', () => {
  it('viewer cannot projects.create (FORBIDDEN)', async () => {
    const caller = callerFor(adminUserId)
    await expect(
      callAs({ userId: adminUserId, orgId, orgRole: 'viewer' }, () =>
        caller.projects.create({ name: 'Nope' }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('member cannot org.members.invite (FORBIDDEN)', async () => {
    const caller = callerFor(adminUserId)
    await expect(
      callAs({ userId: adminUserId, orgId, orgRole: 'member' }, () =>
        caller.org.members.invite({ email: targetUserEmail, role: 'viewer' }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('admin can projects.create and org.members.invite', async () => {
    const caller = callerFor(adminUserId)
    const created = await callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
      caller.projects.create({ name: `Admin Project ${suffix}` }),
    )
    expect(created.name).toBe(`Admin Project ${suffix}`)

    const invited = await callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
      caller.org.members.invite({ email: targetUserEmail, role: 'viewer' }),
    )
    expect(invited.email).toBe(targetUserEmail)
    expect(invited.token).toBeTruthy()
  })
})

describe('projects.keys lifecycle', () => {
  it('create returns the secret once; list hides it; revoke sets revokedAt', async () => {
    const caller = callerFor(adminUserId)
    const admin = { userId: adminUserId, orgId, orgRole: 'org_admin' as const }

    const created = await callAs(admin, () =>
      caller.projects.keys.create({ projectId, type: 'write', label: 'CI' }),
    )
    expect(created.token).toMatch(/^ckw_live_/)
    expect(created.key).not.toHaveProperty('keyHash')
    expect(created.key).not.toHaveProperty('token')

    const list = await callAs(admin, () => caller.projects.keys.list({ projectId }))
    const listed = list.find((k) => k.id === created.key.id)
    expect(listed?.keyPrefix).toBe(created.key.keyPrefix)
    expect(list.every((k) => !('keyHash' in k) && !('token' in k))).toBe(true)

    const revoked = await callAs(admin, () =>
      caller.projects.keys.revoke({ keyId: created.key.id, projectId }),
    )
    expect(revoked).toEqual({ ok: true })
    const row = await prisma.apiKey.findUnique({ where: { id: created.key.id } })
    expect(row?.revokedAt).not.toBeNull()
  })

  it('read-type keys use the ckr_live_ prefix', async () => {
    const caller = callerFor(adminUserId)
    const admin = { userId: adminUserId, orgId, orgRole: 'org_admin' as const }
    const created = await callAs(admin, () =>
      caller.projects.keys.create({ projectId, type: 'read' }),
    )
    expect(created.token).toMatch(/^ckr_live_/)
  })

  it('write-type keys persist and return publicToken via list', async () => {
    const caller = callerFor(adminUserId)
    const admin = { userId: adminUserId, orgId, orgRole: 'org_admin' as const }
    const created = await callAs(admin, () =>
      caller.projects.keys.create({ projectId, type: 'write', label: 'Public Token' }),
    )
    expect(created.key.publicToken).toBe(created.token)

    const list = await callAs(admin, () => caller.projects.keys.list({ projectId }))
    const listed = list.find((k) => k.id === created.key.id)
    expect(listed?.publicToken).toBe(created.token)

    const row = await prisma.apiKey.findUnique({ where: { id: created.key.id } })
    expect(row?.publicToken).toBe(created.token)
  })

  it('read-type keys leave publicToken null', async () => {
    const caller = callerFor(adminUserId)
    const admin = { userId: adminUserId, orgId, orgRole: 'org_admin' as const }
    const created = await callAs(admin, () =>
      caller.projects.keys.create({ projectId, type: 'read', label: 'Read Only' }),
    )
    expect(created.key.publicToken).toBeNull()

    const list = await callAs(admin, () => caller.projects.keys.list({ projectId }))
    const listed = list.find((k) => k.id === created.key.id)
    expect(listed?.publicToken).toBeNull()

    const row = await prisma.apiKey.findUnique({ where: { id: created.key.id } })
    expect(row?.publicToken).toBeNull()
  })

  it('defaults scopes/env/expiresAt when omitted', async () => {
    const caller = callerFor(adminUserId)
    const admin = { userId: adminUserId, orgId, orgRole: 'org_admin' as const }
    const created = await callAs(admin, () =>
      caller.projects.keys.create({ projectId, type: 'write' }),
    )
    expect(created.key.scopes).toEqual([])
    expect(created.key.env).toBe('production')
    expect(created.key.expiresAt).toBeNull()
  })

  it('persists scopes/env and derives expiresAt from expiry', async () => {
    const caller = callerFor(adminUserId)
    const admin = { userId: adminUserId, orgId, orgRole: 'org_admin' as const }
    const before = Date.now()
    const created = await callAs(admin, () =>
      caller.projects.keys.create({
        projectId,
        type: 'read',
        scopes: ['events:write', 'flags:read'],
        env: 'staging',
        expiry: '30d',
      }),
    )
    expect(created.key.scopes).toEqual(['events:write', 'flags:read'])
    expect(created.key.env).toBe('staging')
    const expiresAt = created.key.expiresAt
    expect(expiresAt).not.toBeNull()
    const deltaDays = ((expiresAt as Date).getTime() - before) / (24 * 60 * 60 * 1000)
    expect(deltaDays).toBeGreaterThan(29.9)
    expect(deltaDays).toBeLessThan(30.1)
  })

  it('delete hard-removes the key; deleting a missing key throws NOT_FOUND', async () => {
    const caller = callerFor(adminUserId)
    const admin = { userId: adminUserId, orgId, orgRole: 'org_admin' as const }
    const created = await callAs(admin, () =>
      caller.projects.keys.create({ projectId, type: 'write', label: 'ToDelete' }),
    )
    const deleted = await callAs(admin, () =>
      caller.projects.keys.delete({ keyId: created.key.id, projectId }),
    )
    expect(deleted).toEqual({ ok: true })
    const row = await prisma.apiKey.findUnique({ where: { id: created.key.id } })
    expect(row).toBeNull()

    await expect(
      callAs(admin, () => caller.projects.keys.delete({ keyId: created.key.id, projectId })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('cross-tenant isolation', () => {
  it('a caller scoped to org A cannot see or rename org B projects', async () => {
    const b = await authService.signup({
      email: `tenant-b-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Tenant B ${suffix}`,
    })
    createdUserIds.push(b.user.id)
    createdOrgIds.push(b.org!.id)
    const bProject = await prisma.project.findFirstOrThrow({ where: { orgId: b.org!.id } })

    const caller = callerFor(adminUserId)
    const admin = { userId: adminUserId, orgId, orgRole: 'org_admin' as const }

    const projects = await callAs(admin, () => caller.projects.list())
    expect(projects.some((p) => p.id === bProject.id)).toBe(false)

    await expect(
      callAs(admin, () => caller.projects.update({ id: bProject.id, name: 'hijacked' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // And org B's project is untouched.
    const stillThere = await prisma.project.findUnique({ where: { id: bProject.id } })
    expect(stillThere?.name).toBe('Default')
  })
})
