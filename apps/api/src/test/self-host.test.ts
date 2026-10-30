import { verifyPassword } from '@clickroom/auth'
import {
  effectiveLimits,
  enforceSelfHostPlans,
  ensureBootstrapAdmin,
  newId,
  prisma,
  resetUserPassword,
} from '@clickroom/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { resolveApiConfig } from '../env.js'
import { authService, cleanupOrg, cleanupUser } from './helpers.js'

// Self_host bootstrap + password reset against the real test DB.
const suffix = Date.now().toString(36)
const userIds: string[] = []
const orgIds: string[] = []
const adminEmails: string[] = []
const saved = process.env.CLICKROOM_DEPLOYMENT

beforeAll(async () => {
  // Reference data the self_host bootstrap attaches by key; idempotent upsert.
  await prisma.plan.upsert({
    where: { key: 'unlimited' },
    update: {},
    create: {
      id: newId(),
      key: 'unlimited',
      name: 'Unlimited',
      maxSeats: 1_000_000,
      maxFlags: 1_000_000,
      maxEventsPerMonth: 1_000_000_000_000_000n,
      maxFlagCallsPerMonth: 1_000_000_000_000_000n,
      allowsOverage: true,
    },
  })
})

afterEach(() => {
  if (saved === undefined) delete process.env.CLICKROOM_DEPLOYMENT
  else process.env.CLICKROOM_DEPLOYMENT = saved
})

afterAll(async () => {
  for (const id of orgIds) await cleanupOrg(id)
  for (const id of userIds) await cleanupUser(id)
  for (const email of adminEmails) {
    const admin = await prisma.adminUser.findUnique({ where: { email } })
    if (admin) {
      await prisma.adminAuditLog.deleteMany({ where: { adminUserId: admin.id } })
      await prisma.adminUser.delete({ where: { id: admin.id } })
    }
  }
  await prisma.$disconnect()
})

describe('self_host org bootstrap', () => {
  it('attaches the unlimited plan and unlimited limits', async () => {
    process.env.CLICKROOM_DEPLOYMENT = 'self_host'
    const result = await authService.signup({
      email: `sh-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `SH Org ${suffix}`,
    })
    userIds.push(result.user.id)
    orgIds.push(result.org!.id)
    const org = await prisma.org.findUniqueOrThrow({
      where: { id: result.org!.id },
      include: { plan: true },
    })
    expect(org.plan?.key).toBe('unlimited')
    const { limits } = { limits: effectiveLimits(org, org.plan) }
    expect(limits.maxEventsPerMonth).toBeGreaterThan(10n ** 12n)
  })
})

describe('user:reset-password', () => {
  it('sets a working new password and signs the user out everywhere', async () => {
    const signup = await authService.signup({
      email: `reset-${suffix}@test.invalid`,
      password: 'old-password-1',
      orgName: `Reset Org ${suffix}`,
    })
    userIds.push(signup.user.id)
    orgIds.push(signup.org!.id)
    expect(await prisma.session.count({ where: { userId: signup.user.id } })).toBeGreaterThan(0)

    const result = await resetUserPassword(prisma, { email: `RESET-${suffix}@test.invalid` })
    expect(result.status).toBe('reset')
    if (result.status !== 'reset') return
    expect(result.sessionsRevoked).toBeGreaterThan(0)
    expect(await prisma.session.count({ where: { userId: signup.user.id } })).toBe(0)

    const row = await prisma.user.findUniqueOrThrow({ where: { id: signup.user.id } })
    expect(await verifyPassword(row.passwordHash!, result.password)).toBe(true)
    expect(await verifyPassword(row.passwordHash!, 'old-password-1')).toBe(false)
  })

  it('reports unknown users, SSO-only users and weak passwords', async () => {
    expect(await resetUserPassword(prisma, { email: `nobody-${suffix}@test.invalid` })).toEqual({
      status: 'not_found',
    })
    const sso = await prisma.user.create({
      data: { id: newId(), email: `sso-${suffix}@test.invalid`, passwordHash: null },
    })
    userIds.push(sso.id)
    expect((await resetUserPassword(prisma, { email: sso.email })).status).toBe('sso_only')
    await expect(
      resetUserPassword(prisma, { email: sso.email, password: 'short' }),
    ).rejects.toThrow(/at least/)
  })
})

describe('first-boot admin (CLICKROOM_ADMIN_EMAIL)', () => {
  it('creates the admin once and never rotates it on restart', async () => {
    const email = `boot-${suffix}@test.invalid`
    adminEmails.push(email)
    const env = { CLICKROOM_ADMIN_EMAIL: email, CLICKROOM_ADMIN_PASSWORD: 'first-boot-password' }
    const logs: string[] = []
    const first = await ensureBootstrapAdmin(prisma, env, (l) => logs.push(l))
    expect(first?.status).toBe('created')
    expect(logs.join('\n')).not.toContain('first-boot-password')

    const before = await prisma.adminUser.findUniqueOrThrow({ where: { email } })
    const second = await ensureBootstrapAdmin(
      prisma,
      { ...env, CLICKROOM_ADMIN_PASSWORD: 'different-password-2' },
      () => {},
    )
    expect(second?.status).toBe('exists')
    const after = await prisma.adminUser.findUniqueOrThrow({ where: { email } })
    expect(after.passwordHash).toBe(before.passwordHash)
  })

  it('does nothing when unset and rejects a half-configured pair', async () => {
    expect(await ensureBootstrapAdmin(prisma, {}, () => {})).toBeNull()
    await expect(ensureBootstrapAdmin(prisma, { CLICKROOM_ADMIN_EMAIL: 'a@b.co' })).rejects.toThrow(
      /together/,
    )
  })
})

describe('resolveApiConfig', () => {
  const secrets = {
    JWT_SECRET: 'a',
    ADMIN_JWT_SECRET: 'b',
    MCP_OAUTH_STATE_SECRET: 'c',
    INTERNAL_QUERY_SECRET: 'd',
  }
  const dev = { NODE_ENV: 'development' }

  it('defaults to self_host / first_user_only / stdout', () => {
    expect(resolveApiConfig(dev, false)).toMatchObject({
      deployment: 'self_host',
      signupMode: 'first_user_only',
      adminPasswordSink: 'stdout',
    })
  })

  it('dev/test fall back to the committed dev literals', () => {
    for (const NODE_ENV of ['development', 'test']) {
      const cfg = resolveApiConfig({ NODE_ENV }, false)
      expect(cfg.secrets.jwt).toBe('dev-only-change-me')
      expect(cfg.secrets.adminJwt).toBe('dev-only-admin-secret-change-me')
      expect(cfg.secrets.mcpOAuthState).toBe('dev-mcp-oauth-state-secret')
    }
  })

  it('self_host production fails closed on missing secrets', () => {
    expect(() => resolveApiConfig({}, true)).toThrow(/JWT_SECRET/)
    expect(() => resolveApiConfig({ ...secrets, JWT_SECRET: '' }, true)).toThrow(/JWT_SECRET/)
    expect(() => resolveApiConfig({ ...secrets, INTERNAL_QUERY_SECRET: '' }, true)).toThrow(
      /INTERNAL_QUERY_SECRET/,
    )
    expect(resolveApiConfig(secrets, true).deployment).toBe('self_host')
  })

  it.each([
    'JWT_SECRET',
    'ADMIN_JWT_SECRET',
    'MCP_OAUTH_STATE_SECRET',
  ])('production refuses to boot without %s (self_host and cloud)', (name) => {
    for (const CLICKROOM_DEPLOYMENT of ['self_host', 'cloud']) {
      const env = { ...secrets, CLICKROOM_DEPLOYMENT, NODE_ENV: 'production', [name]: undefined }
      expect(() => resolveApiConfig(env)).toThrow(new RegExp(name))
    }
  })

  it('never falls back to dev literals when NODE_ENV is unset or unrecognised', () => {
    expect(() => resolveApiConfig({}, false)).toThrow(/JWT_SECRET/)
    expect(() => resolveApiConfig({ NODE_ENV: 'prod' }, false)).toThrow(/JWT_SECRET/)
  })

  it('cloud production only needs the signing secrets (no INTERNAL_QUERY_SECRET requirement)', () => {
    const cfg = resolveApiConfig(
      {
        CLICKROOM_DEPLOYMENT: 'cloud',
        NODE_ENV: 'production',
        JWT_SECRET: 'a',
        ADMIN_JWT_SECRET: 'b',
        MCP_OAUTH_STATE_SECRET: 'c',
      },
      true,
    )
    expect(cfg).toMatchObject({ deployment: 'cloud', adminPasswordSink: 'ssm' })
  })

  it('rejects invalid enum values', () => {
    expect(() => resolveApiConfig({ ...dev, SIGNUP_MODE: 'nope' }, false)).toThrow(/SIGNUP_MODE/)
  })
})

describe('enforceSelfHostPlans', () => {
  it('moves free-plan orgs with overrides to unlimited and is idempotent', async () => {
    process.env.CLICKROOM_DEPLOYMENT = 'cloud'
    const signup = await authService.signup({
      email: `shplan-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `SH Plan ${suffix}`,
    })
    userIds.push(signup.user.id)
    orgIds.push(signup.org!.id)
    const free = await prisma.plan.upsert({
      where: { key: 'free' },
      update: {},
      create: {
        id: newId(),
        key: 'free',
        name: 'Free',
        maxSeats: 3,
        maxFlags: 10,
        maxEventsPerMonth: 1000n,
        maxFlagCallsPerMonth: 1000n,
        allowsOverage: false,
      },
    })
    await prisma.org.update({
      where: { id: signup.org!.id },
      data: { planId: free.id, maxEventsPerMonthOverride: 5n },
    })

    process.env.CLICKROOM_DEPLOYMENT = 'cloud'
    expect(await enforceSelfHostPlans(prisma)).toBe(0) // no-op outside self_host
    const untouched = await prisma.org.findUniqueOrThrow({ where: { id: signup.org!.id } })
    expect(untouched.planId).toBe(free.id)

    process.env.CLICKROOM_DEPLOYMENT = 'self_host'
    expect(await enforceSelfHostPlans(prisma)).toBeGreaterThanOrEqual(1)
    const fixed = await prisma.org.findUniqueOrThrow({
      where: { id: signup.org!.id },
      include: { plan: true },
    })
    expect(fixed.plan?.key).toBe('unlimited')
    expect(fixed.maxEventsPerMonthOverride).toBeNull()
    expect(await enforceSelfHostPlans(prisma)).toBe(0)
  })
})
