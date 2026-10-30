import { hashApiKey } from '@clickroom/auth'
import { prisma, requestContextStorage } from '@clickroom/db'
import { appRouter } from '@clickroom/trpc-router'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeRequestContextMiddleware } from '../request-context/request-context.middleware.js'
import { authService, callAs, cleanupOrg, cleanupUser, JWT_SECRET, makeCtx } from './helpers.js'

const suffix = Date.now().toString(36)
const createdUserIds: string[] = []
const createdOrgIds: string[] = []

let adminUserId: string
let orgId: string
let projectId: string

beforeAll(async () => {
  const s = await authService.signup({
    email: `mcp-admin-${suffix}@test.invalid`,
    password: 'password123',
    orgName: `MCP Org ${suffix}`,
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

function callerFor(userId: string) {
  return appRouter.createCaller(
    makeCtx({ tokenPayload: { sub: userId, sessionId: 'test', orgId } }),
  )
}

const admin = () => ({ userId: adminUserId, orgId, orgRole: 'org_admin' as const })

// --- middleware test doubles ------------------------------------------------

function makeReq(token?: string): { headers: Record<string, string> } {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} }
}

function makeRes() {
  const state: { statusCode: number | null; body: unknown } = { statusCode: null, body: null }
  const res = {
    status(code: number) {
      state.statusCode = code
      return res
    },
    json(body: unknown) {
      state.body = body
      return res
    },
  }
  return { res, state }
}

/** Run the real Express middleware with `token` and report the outcome. */
async function runMiddleware(token: string) {
  const middleware = makeRequestContextMiddleware(prisma, JWT_SECRET)
  const { res, state } = makeRes()
  let nextCalled = false
  let store: ReturnType<typeof requestContextStorage.getStore> | undefined
  const next = () => {
    nextCalled = true
    store = requestContextStorage.getStore()
  }
  // biome-ignore lint/suspicious/noExplicitAny: minimal Express req/res stubs
  await middleware(makeReq(token) as any, res as any, next as any)
  return { nextCalled, store, statusCode: state.statusCode, body: state.body }
}

describe('mcpKey.create', () => {
  it('returns the plaintext token once; only its hash is persisted', async () => {
    const caller = callerFor(adminUserId)
    const created = await callAs(admin(), () => caller.mcpKey.create({ projectId, label: 'Agent' }))

    expect(created.token).toMatch(/^ckmcp_[0-9a-f]{16}\.[0-9a-f]{48}$/)
    expect(created.key).not.toHaveProperty('keyHash')
    expect(created.key).not.toHaveProperty('token')
    expect(created.key.userId).toBe(adminUserId)

    const row = await prisma.apiKey.findUnique({ where: { id: created.key.id } })
    expect(row?.keyHash).not.toBe(created.token)
    expect(row?.selector).toBe(created.token.split('.')[0].slice('ckmcp_'.length))
    // The stored hash is over the secret half, not the whole token.
    const secret = created.token.split('.')[1]
    expect(row?.keyHash).toBe(hashApiKey(secret))
  })

  it('viewer cannot call mcpKey.create (FORBIDDEN)', async () => {
    const caller = callerFor(adminUserId)
    await expect(
      callAs({ userId: adminUserId, orgId, orgRole: 'viewer' }, () =>
        caller.mcpKey.create({ projectId, label: 'Nope' }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('viewer cannot call mcpKey.list/revoke/delete (FORBIDDEN)', async () => {
    const caller = callerFor(adminUserId)
    const viewer = { userId: adminUserId, orgId, orgRole: 'viewer' as const }
    await expect(callAs(viewer, () => caller.mcpKey.list({ projectId }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(
      callAs(viewer, () => caller.mcpKey.revoke({ keyId: 'x', projectId })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      callAs(viewer, () => caller.mcpKey.delete({ keyId: 'x', projectId })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('mcpKey.list', () => {
  it('never returns plaintext token or keyHash', async () => {
    const caller = callerFor(adminUserId)
    const created = await callAs(admin(), () =>
      caller.mcpKey.create({ projectId, label: 'ListMe' }),
    )
    const list = await callAs(admin(), () => caller.mcpKey.list({ projectId }))
    const listed = list.find((k) => k.id === created.key.id)
    expect(listed).toBeDefined()
    expect(listed).not.toHaveProperty('keyHash')
    expect(listed).not.toHaveProperty('token')
    expect(listed).not.toHaveProperty('selector')
    expect(JSON.stringify(list)).not.toContain(created.token)
  })
})

describe('mcpKey.revoke / delete', () => {
  it('revoke sets revokedAt; delete hard-removes; missing key -> NOT_FOUND', async () => {
    const caller = callerFor(adminUserId)
    const created = await callAs(admin(), () =>
      caller.mcpKey.create({ projectId, label: 'Revoke Me' }),
    )
    const revoked = await callAs(admin(), () =>
      caller.mcpKey.revoke({ keyId: created.key.id, projectId }),
    )
    expect(revoked).toEqual({ ok: true })
    const row = await prisma.apiKey.findUnique({ where: { id: created.key.id } })
    expect(row?.revokedAt).not.toBeNull()

    const deleted = await callAs(admin(), () =>
      caller.mcpKey.delete({ keyId: created.key.id, projectId }),
    )
    expect(deleted).toEqual({ ok: true })
    expect(await prisma.apiKey.findUnique({ where: { id: created.key.id } })).toBeNull()

    await expect(
      callAs(admin(), () => caller.mcpKey.delete({ keyId: created.key.id, projectId })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('request-context middleware: ckmcp_ bearer', () => {
  it('resolves the pinned project + acting user and sets authSource "mcp"', async () => {
    const caller = callerFor(adminUserId)
    const created = await callAs(admin(), () =>
      caller.mcpKey.create({ projectId, label: 'Middleware' }),
    )

    const { nextCalled, store, statusCode } = await runMiddleware(created.token)
    expect(statusCode).toBeNull()
    expect(nextCalled).toBe(true)
    expect(store).toMatchObject({
      userId: adminUserId,
      orgId,
      projectId,
      orgRole: 'org_admin',
      authSource: 'mcp',
    })

    const row = await prisma.apiKey.findUnique({ where: { id: created.key.id } })
    expect(row?.lastUsedAt).not.toBeNull()
  })

  it('a revoked token -> 401, next() not called', async () => {
    const caller = callerFor(adminUserId)
    const created = await callAs(admin(), () =>
      caller.mcpKey.create({ projectId, label: 'ToRevoke' }),
    )
    await callAs(admin(), () => caller.mcpKey.revoke({ keyId: created.key.id, projectId }))

    const { nextCalled, statusCode } = await runMiddleware(created.token)
    expect(nextCalled).toBe(false)
    expect(statusCode).toBe(401)
  })

  it('an expired token -> 401, next() not called', async () => {
    const caller = callerFor(adminUserId)
    const created = await callAs(admin(), () =>
      caller.mcpKey.create({ projectId, label: 'ToExpire' }),
    )
    await prisma.apiKey.update({
      where: { id: created.key.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    const { nextCalled, statusCode } = await runMiddleware(created.token)
    expect(nextCalled).toBe(false)
    expect(statusCode).toBe(401)
  })

  it('an unknown selector -> 401', async () => {
    const { nextCalled, statusCode } = await runMiddleware(
      'ckmcp_0000000000000000.000000000000000000000000000000000000000000000000',
    )
    expect(nextCalled).toBe(false)
    expect(statusCode).toBe(401)
  })

  it('a malformed ckmcp_ token -> 401', async () => {
    const { nextCalled, statusCode } = await runMiddleware('ckmcp_no-dot-here')
    expect(nextCalled).toBe(false)
    expect(statusCode).toBe(401)
  })

  it('a tampered secret against a valid selector -> 401', async () => {
    const caller = callerFor(adminUserId)
    const created = await callAs(admin(), () =>
      caller.mcpKey.create({ projectId, label: 'Tamper' }),
    )
    const [selector] = created.token.slice('ckmcp_'.length).split('.')
    const tampered = `ckmcp_${selector}.${'f'.repeat(48)}`

    const { nextCalled, statusCode } = await runMiddleware(tampered)
    expect(nextCalled).toBe(false)
    expect(statusCode).toBe(401)
  })
})

describe('cross-tenant isolation', () => {
  it('an org-A caller cannot mint/list/revoke keys against an org-B project (NOT_FOUND)', async () => {
    const b = await authService.signup({
      email: `mcp-tenant-b-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `MCP Tenant B ${suffix}`,
    })
    createdUserIds.push(b.user.id)
    createdOrgIds.push(b.org!.id)
    const bProject = await prisma.project.findFirstOrThrow({ where: { orgId: b.org!.id } })

    const caller = callerFor(adminUserId)
    await expect(
      callAs(admin(), () => caller.mcpKey.create({ projectId: bProject.id, label: 'Hijack' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      callAs(admin(), () => caller.mcpKey.list({ projectId: bProject.id })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it("a token minted for org A's project resolves org A, not the caller's active org", async () => {
    const caller = callerFor(adminUserId)
    const created = await callAs(admin(), () =>
      caller.mcpKey.create({ projectId, label: 'Pinned' }),
    )
    const { store } = await runMiddleware(created.token)
    expect(store?.orgId).toBe(orgId)
    expect(store?.projectId).toBe(projectId)
  })
})
