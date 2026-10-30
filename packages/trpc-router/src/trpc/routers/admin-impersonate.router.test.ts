import { describe, expect, it, vi } from 'vitest'

// Unit test — no Postgres. `admin.impersonate` routes through `ctx.authService`
// (AuthService.createImpersonatedSession/stopImpersonatedSession) and
// `ctx.prisma` for the audit row, so this stubs both with in-memory tables
// rather than a real Prisma client. `AuthService` itself is exercised
// un-mocked (real class from ../../services/auth.service.js) so the 30-minute
// cap and the refresh()-rejects-a-stale-impersonated-session guard are tested
// against the real implementation, not a re-description of it.

type Row = Record<string, unknown>

const IMPERSONATION_TTL_MS = 30 * 60 * 1000

let users: Row[]
let orgs: Row[]
let memberships: Row[]
let sessions: Row[]
let auditLogs: Row[]

function resetFixtures(): void {
  users = [{ id: 'user_1', email: 'customer@acme.test', name: 'Customer One' }]
  orgs = [{ id: 'org_1', name: 'Acme', slug: 'acme' }]
  memberships = [{ orgId: 'org_1', userId: 'user_1', role: 'member' }]
  sessions = []
  auditLogs = []
}
resetFixtures()

const fakePrisma = {
  user: {
    findUnique: async ({ where }: { where: Row }) => users.find((u) => u.id === where.id) ?? null,
  },
  org: {
    findUnique: async ({ where }: { where: Row }) => orgs.find((o) => o.id === where.id) ?? null,
  },
  orgMembership: {
    findUnique: async ({ where }: { where: { orgId_userId: Row } }) => {
      const { orgId, userId } = where.orgId_userId
      const m = memberships.find((m) => m.orgId === orgId && m.userId === userId)
      if (!m) return null
      return { ...m, org: orgs.find((o) => o.id === m.orgId) }
    },
  },
  session: {
    create: async ({ data }: { data: Row }) => {
      sessions.push({ ...data })
      return data
    },
    findFirst: async ({ where, include }: { where: Row; include?: Row }) => {
      const s = sessions.find((s) => Object.entries(where).every(([k, v]) => s[k] === v))
      if (!s) return null
      return include?.user ? { ...s, user: users.find((u) => u.id === s.userId) } : s
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const s = sessions.find((s) => s.id === where.id)
      if (!s) throw new Error('not found')
      Object.assign(s, data)
      return s
    },
    deleteMany: async ({ where }: { where: Row }) => {
      const before = sessions.length
      sessions = sessions.filter((s) => !Object.entries(where).every(([k, v]) => s[k] === v))
      return { count: before - sessions.length }
    },
  },
  adminAuditLog: {
    create: async ({ data }: { data: Row }) => {
      auditLogs.push(data)
      return data
    },
  },
  $transaction: async <T>(fn: (tx: typeof fakePrisma) => Promise<T>): Promise<T> => fn(fakePrisma),
}

vi.mock('@clickroom/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clickroom/db')>()
  return { ...actual, prisma: fakePrisma as unknown }
})

const { AuthService } = await import('../../services/auth.service.js')
const { adminImpersonateRouter } = await import('./admin-impersonate.router.js')

const authService = new AuthService(
  fakePrisma as unknown as ConstructorParameters<typeof AuthService>[0],
  'tenant-jwt-secret',
)

function caller() {
  return adminImpersonateRouter.createCaller({
    adminUser: { id: 'admin_1', email: 'admin@internal.test' },
    prisma: fakePrisma as unknown,
    authService,
  } as unknown as Parameters<typeof adminImpersonateRouter.createCaller>[0])
}

describe('admin.impersonate', () => {
  it('start() mints a session capped at 30 minutes and writes the impersonate.start audit row', async () => {
    resetFixtures()
    const before = Date.now()

    const result = await caller().start({
      userId: 'user_1',
      orgId: 'org_1',
      reason: 'Reproducing a support ticket bug for customer.',
    })

    expect(result.accessToken).toBeTruthy()
    expect(result.refreshToken).toBeTruthy()
    expect(sessions).toHaveLength(1)
    const session = sessions[0] as Row
    expect(session.impersonatedByAdminId).toBe('admin_1')

    const expiresAt = session.impersonationExpiresAt as Date
    expect(expiresAt).toBeInstanceOf(Date)
    const deltaMs = expiresAt.getTime() - before
    // ~30 minutes out, generous tolerance for test execution time.
    expect(deltaMs).toBeGreaterThan(IMPERSONATION_TTL_MS - 5000)
    expect(deltaMs).toBeLessThanOrEqual(IMPERSONATION_TTL_MS + 5000)
    // expiresAt (the refresh-token TTL) is ALSO capped, not just impersonationExpiresAt.
    expect(session.expiresAt).toEqual(session.impersonationExpiresAt)

    expect(auditLogs).toHaveLength(1)
    expect(auditLogs[0]).toMatchObject({
      adminUserId: 'admin_1',
      action: 'impersonate.start',
      targetOrgId: 'org_1',
      after: { userId: 'user_1', reason: 'Reproducing a support ticket bug for customer.' },
    })
  })

  it('start() rejects a reason shorter than the 10-character minimum', async () => {
    resetFixtures()
    await expect(
      caller().start({ userId: 'user_1', orgId: 'org_1', reason: 'short' }),
    ).rejects.toThrow()
  })

  it('refresh() rejects once impersonationExpiresAt has passed, without pushing expiresAt back out', async () => {
    resetFixtures()
    const result = await caller().start({
      userId: 'user_1',
      orgId: 'org_1',
      reason: 'Reproducing a support ticket bug for customer.',
    })

    // Simulate time passing: backdate the Session row directly, as if the
    // 30-minute window has elapsed.
    const session = sessions[0] as Row
    const past = new Date(Date.now() - 60_000)
    session.impersonationExpiresAt = past
    session.expiresAt = past

    await expect(authService.refresh(result.refreshToken)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })

    // The rejected refresh must not have rotated expiresAt back out past the cap.
    expect(session.expiresAt).toEqual(past)
  })

  it('stop() ends the impersonated session early and writes the impersonate.stop audit row', async () => {
    resetFixtures()
    const result = await caller().start({
      userId: 'user_1',
      orgId: 'org_1',
      reason: 'Reproducing a support ticket bug for customer.',
    })
    const sessionId = (sessions[0] as Row).id as string

    await caller().stop({ sessionId })

    expect(sessions).toHaveLength(0)
    expect(auditLogs.map((a) => a.action)).toContain('impersonate.stop')
    void result
  })
})
