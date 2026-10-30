import { hashPassword } from '@clickroom/auth'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Unit test — no Postgres/Redis. `admin-auth.router.ts` reads through
// `ctx.prisma` directly (unlike admin-orgs.router.ts, which imports the
// `@clickroom/db` singleton), so this stubs a fake `ctx.prisma` per-call
// rather than mocking `@clickroom/db`'s exported `prisma`. Redis is mocked
// because the sign-in/TOTP rate limiters (../../lib/rate-limit.ts) dial a
// real ioredis connection at module load otherwise — see
// support.router.test.ts for the same pattern in this package.
vi.mock('../../lib/redis.js', () => ({
  redis: { incr: async () => 1, pexpire: async () => 'OK', del: async () => 1 },
}))

type Row = Record<string, unknown>

const CORRECT_PASSWORD = 'Correct-Horse-Battery-Staple-1!'
let correctPasswordHash: string

let adminUsers: Row[] = []
let auditLogs: Row[] = []

function applyUpdate(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in (value as Row)) {
      row[key] = (row[key] as number) + ((value as Row).increment as number)
    } else {
      row[key] = value
    }
  }
}

function pick(row: Row, select?: Row): Row {
  if (!select) return row
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]))
}

const fakePrisma = {
  adminUser: {
    findUnique: async ({ where, select }: { where: Row; select?: Row }) => {
      const row = adminUsers.find((u) => Object.entries(where).every(([k, v]) => u[k] === v))
      return row ? pick(row, select) : null
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = adminUsers.find((u) => u.id === where.id)
      if (!row) throw new Error('not found')
      applyUpdate(row, data)
      return row
    },
  },
  adminAuditLog: {
    create: async ({ data }: { data: Row }) => {
      auditLogs.push(data)
      return data
    },
  },
}

function fakeCtx() {
  return {
    prisma: fakePrisma as unknown,
    req: { ip: '127.0.0.1', cookies: {} },
    res: { cookie: vi.fn(), clearCookie: vi.fn() },
    tokenPayload: null,
    adminUser: null,
    authService: {} as unknown,
  }
}

const { adminAuthRouter } = await import('./admin-auth.router.js')
const { completeAdminSignIn } = await import('./admin-auth.helpers.js')

function caller() {
  return adminAuthRouter.createCaller(
    fakeCtx() as Parameters<typeof adminAuthRouter.createCaller>[0],
  )
}

let adminRowCounter = 0

function makeAdminRow(overrides: Row = {}): Row {
  adminRowCounter += 1
  return {
    id: `admin_${adminRowCounter}`,
    email: `admin${adminRowCounter}@internal.test`,
    passwordHash: correctPasswordHash,
    isDisabled: false,
    totpSecretEnc: null,
    totpPendingEnc: null,
    totpEnrolledAt: null,
    loginLockedAt: null,
    failedLoginCount: 0,
    fullName: null,
    lastLoginAt: null,
    ...overrides,
  }
}

describe('admin-auth lockout + enumeration-safety', () => {
  beforeEach(async () => {
    correctPasswordHash ??= await hashPassword(CORRECT_PASSWORD)
    adminUsers = []
    auditLogs = []
  })

  it('locks after exactly LOCKOUT_THRESHOLD (3) failed password attempts', async () => {
    const admin = makeAdminRow()
    adminUsers.push(admin)

    for (let i = 0; i < 2; i++) {
      await expect(
        caller().login({ email: admin.email as string, password: 'totally-wrong' }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: 'Invalid credentials.' })
    }
    expect(admin.loginLockedAt).toBeNull()
    expect(admin.failedLoginCount).toBe(2)

    // 3rd failure crosses the threshold.
    await expect(
      caller().login({ email: admin.email as string, password: 'totally-wrong' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: 'Invalid credentials.' })
    expect(admin.failedLoginCount).toBe(3)
    expect(admin.loginLockedAt).toBeInstanceOf(Date)
  })

  it('a locked account still rejects a subsequent CORRECT-password attempt with the same generic error', async () => {
    const admin = makeAdminRow()
    adminUsers.push(admin)
    for (let i = 0; i < 3; i++) {
      await expect(
        caller().login({ email: admin.email as string, password: 'totally-wrong' }),
      ).rejects.toBeDefined()
    }
    expect(admin.loginLockedAt).toBeInstanceOf(Date)
    const failedCountAtLock = admin.failedLoginCount

    // 4th attempt, correct password this time — the real password compare
    // still runs (timing parity), but the loginLockedAt check rejects it
    // before any token is issued, and NOTHING resets failedLoginCount here —
    // login() throws immediately after the lock check without ever calling
    // registerLoginFailure or completeAdminSignIn.
    await expect(
      caller().login({ email: admin.email as string, password: CORRECT_PASSWORD }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: 'Invalid credentials.' })
    expect(admin.loginLockedAt).toBeInstanceOf(Date)
    expect(admin.failedLoginCount).toBe(failedCountAtLock)
  })

  it('completeAdminSignIn resets failedLoginCount on a later success but does NOT clear loginLockedAt (only admin:unlock does)', async () => {
    const admin = makeAdminRow({ failedLoginCount: 2, loginLockedAt: new Date() })
    adminUsers.push(admin)

    await completeAdminSignIn(
      {
        prisma: fakePrisma as unknown as Parameters<typeof completeAdminSignIn>[0]['prisma'],
        res: { cookie: vi.fn() } as unknown as Parameters<typeof completeAdminSignIn>[0]['res'],
      },
      { id: admin.id as string, email: admin.email as string },
      'totp',
      'admin-jwt-secret',
    )

    expect(admin.failedLoginCount).toBe(0)
    // The lock survives a successful re-auth — it is a deliberate one-way
    // gate that only the separate admin:unlock CLI clears.
    expect(admin.loginLockedAt).not.toBeNull()
  })

  it('missing email, wrong password, and a locked account throw the identical UNAUTHORIZED shape', async () => {
    const wrongPasswordAdmin = makeAdminRow()
    const lockedAdmin = makeAdminRow({ loginLockedAt: new Date(), failedLoginCount: 3 })
    adminUsers.push(wrongPasswordAdmin, lockedAdmin)

    const results = await Promise.allSettled([
      caller().login({ email: 'ghost@nowhere.test', password: 'whatever' }),
      caller().login({ email: wrongPasswordAdmin.email as string, password: 'totally-wrong' }),
      caller().login({ email: lockedAdmin.email as string, password: CORRECT_PASSWORD }),
    ])

    for (const result of results) {
      expect(result.status).toBe('rejected')
      const reason = result.status === 'rejected' ? result.reason : undefined
      expect(reason).toMatchObject({ code: 'UNAUTHORIZED', message: 'Invalid credentials.' })
    }
  })

  it('writes an audit row per failed attempt and one admin.login.locked row at the threshold', async () => {
    const admin = makeAdminRow()
    adminUsers.push(admin)

    for (let i = 0; i < 3; i++) {
      await expect(
        caller().login({ email: admin.email as string, password: 'totally-wrong' }),
      ).rejects.toBeDefined()
    }

    const actions = auditLogs.map((row) => row.action)
    expect(actions.filter((a) => a === 'admin.login.failed')).toHaveLength(3)
    expect(actions.filter((a) => a === 'admin.login.locked')).toHaveLength(1)
  })
})
