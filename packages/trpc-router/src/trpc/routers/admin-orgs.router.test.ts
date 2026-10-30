import { describe, expect, it, vi } from 'vitest'

// Unit test — no Postgres. `admin-orgs.router.ts` reads through the unscoped
// `prisma` singleton (deliberately — see the router's file-header comment), so
// this stubs THAT singleton directly with in-memory tables rather than
// `createScopedClient` (which the router never touches). Mounted standalone
// (not through `../app.router.js`) since other agents are concurrently
// wiring their own `admin.*` sub-routers into `appRouter` .

type Row = Record<string, unknown>

const orgs: Row[] = [
  {
    id: 'org_1',
    name: 'Acme',
    slug: 'acme',
    planId: 'plan_free',
    maxSeatsOverride: null,
    maxFlagsOverride: null,
    maxEventsPerMonthOverride: null,
    maxFlagCallsPerMonthOverride: null,
    overagePolicy: 'block',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  },
]
const plans: Row[] = [
  {
    id: 'plan_free',
    key: 'free',
    name: 'Free',
    maxSeats: 5,
    maxFlags: 10,
    maxEventsPerMonth: 100_000n,
    maxFlagCallsPerMonth: 50_000n,
    allowsOverage: false,
  },
  {
    id: 'plan_pro',
    key: 'pro',
    name: 'Pro',
    maxSeats: 50,
    maxFlags: 100,
    maxEventsPerMonth: 10_000_000n,
    maxFlagCallsPerMonth: 5_000_000n,
    allowsOverage: true,
  },
]
const memberships: Row[] = [
  { orgId: 'org_1', userId: 'user_1', role: 'org_admin', createdAt: new Date('2026-01-02') },
]
const users: Row[] = [{ id: 'user_1', email: 'admin@acme.test', name: 'Admin User' }]
const projects: Row[] = [
  {
    id: 'proj_1',
    orgId: 'org_1',
    name: 'Main',
    timezone: 'UTC',
    domain: null,
    dataRetentionDays: 90,
    createdAt: new Date('2026-01-01'),
  },
]
const apiKeys: Row[] = [
  {
    id: 'key_1',
    projectId: 'proj_1',
    keyHash: 'SHOULD_NEVER_LEAK',
    keyPrefix: 'ck_live_abc',
    type: 'write',
    scopes: [],
    label: 'CI key',
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    createdAt: new Date('2026-01-03'),
  },
]
let auditLogs: Row[] = []

function findPlan(where: Row): Row | undefined {
  return plans.find((p) => Object.entries(where).every(([k, v]) => p[k] === v))
}
function findOrg(where: Row): Row | undefined {
  return orgs.find((o) => Object.entries(where).every(([k, v]) => o[k] === v))
}
function withPlan(org: Row | undefined) {
  if (!org) return org
  return { ...org, plan: plans.find((p) => p.id === org.planId) ?? null }
}

const tables = {
  org: {
    findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
      const org = findOrg(where)
      return include?.plan ? withPlan(org) : org
    },
    findMany: async ({ where, take }: { where?: Row; take?: number } = {}) => {
      let rows = orgs
      const search = (where as { OR?: Row[] } | undefined)?.OR
      if (search) {
        rows = rows.filter((o) =>
          search.some((clause) => {
            const [[field, cond]] = Object.entries(clause)
            const needle = String((cond as Row).contains).toLowerCase()
            return String(o[field]).toLowerCase().includes(needle)
          }),
        )
      }
      const withPlanAndCounts = rows.map((o) => ({
        ...withPlan(o),
        _count: {
          members: memberships.filter((m) => m.orgId === o.id).length,
          projects: projects.filter((p) => p.orgId === o.id).length,
        },
      }))
      return take ? withPlanAndCounts.slice(0, take) : withPlanAndCounts
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const org = findOrg(where)
      if (!org) throw new Error('not found')
      Object.assign(org, data)
      return org
    },
  },
  plan: {
    findUnique: async ({ where }: { where: Row }) => findPlan(where),
  },
  orgMembership: {
    findUnique: async ({ where }: { where: { orgId_userId: Row } }) => {
      const { orgId, userId } = where.orgId_userId
      const m = memberships.find((m) => m.orgId === orgId && m.userId === userId)
      if (!m) return null
      return { ...m, user: users.find((u) => u.id === m.userId) }
    },
    findMany: async ({ where }: { where: Row }) =>
      memberships
        .filter((m) => Object.entries(where).every(([k, v]) => m[k] === v))
        .map((m) => ({ ...m, user: users.find((u) => u.id === m.userId) })),
    update: async ({ where, data }: { where: { orgId_userId: Row }; data: Row }) => {
      const { orgId, userId } = where.orgId_userId
      const m = memberships.find((m) => m.orgId === orgId && m.userId === userId)
      if (!m) throw new Error('not found')
      Object.assign(m, data)
      return m
    },
    count: async ({ where }: { where: Row }) =>
      memberships.filter((m) => Object.entries(where).every(([k, v]) => m[k] === v)).length,
  },
  project: {
    findMany: async ({ where, select }: { where: Row; select?: Row }) => {
      const rows = projects.filter((p) => Object.entries(where).every(([k, v]) => p[k] === v))
      if (!select) return rows
      return rows.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])))
    },
    count: async ({ where }: { where: Row }) =>
      projects.filter((p) => Object.entries(where).every(([k, v]) => p[k] === v)).length,
  },
  apiKey: {
    findMany: async ({ where, select }: { where: Row; select?: Row }) => {
      const projectIds = (where.projectId as { in: string[] }).in
      const rows = apiKeys.filter((k) => projectIds.includes(k.projectId as string))
      if (!select) return rows
      return rows.map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])))
    },
  },
  adminAuditLog: {
    create: async ({ data }: { data: Row }) => {
      auditLogs.push(data)
      return data
    },
    findMany: async ({ where, take }: { where: Row; take?: number }) => {
      const rows = auditLogs
        .filter((r) => Object.entries(where).every(([k, v]) => r[k] === v))
        .slice()
        .reverse()
      return (take ? rows.slice(0, take) : rows).map((r) => ({
        ...r,
        adminUser: { email: 'admin@internal.test' },
      }))
    },
  },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tables),
}

vi.mock('@clickroom/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clickroom/db')>()
  return { ...actual, prisma: tables as unknown }
})

const { adminOrgsRouter } = await import('./admin-orgs.router.js')

function caller() {
  return adminOrgsRouter.createCaller({
    adminUser: { id: 'admin_1', email: 'admin@internal.test' },
  } as unknown as Parameters<typeof adminOrgsRouter.createCaller>[0])
}

describe('admin.orgs', () => {
  it('list searches by name/slug and includes plan + seat/project counts', async () => {
    const result = await caller().list({ search: 'acme', limit: 50 })
    expect(result.orgs).toHaveLength(1)
    expect(result.orgs[0]).toMatchObject({
      id: 'org_1',
      planKey: 'free',
      seatCount: 1,
      projectCount: 1,
    })
  })

  it('get returns effective limits and recent audit log', async () => {
    const result = await caller().get({ orgId: 'org_1' })
    expect(result.planKey).toBe('free')
    expect(result.effectiveLimits).toMatchObject({ maxSeats: 5, maxFlags: 10 })
    expect(result.memberCount).toBe(1)
    expect(result.projectCount).toBe(1)
  })

  it('get throws NOT_FOUND for an unknown org', async () => {
    await expect(caller().get({ orgId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('listMembers returns the roster with user email/name', async () => {
    const result = await caller().listMembers({ orgId: 'org_1' })
    expect(result).toEqual([
      {
        userId: 'user_1',
        email: 'admin@acme.test',
        name: 'Admin User',
        role: 'org_admin',
        joinedAt: memberships[0]?.createdAt,
      },
    ])
  })

  it('setMemberRole updates the role and writes a before/after audit row', async () => {
    auditLogs = []
    const result = await caller().setMemberRole({
      orgId: 'org_1',
      userId: 'user_1',
      role: 'viewer',
    })
    expect(result.role).toBe('viewer')
    expect(memberships[0]?.role).toBe('viewer')
    expect(auditLogs).toHaveLength(1)
    expect(auditLogs[0]).toMatchObject({
      adminUserId: 'admin_1',
      action: 'org.setMemberRole',
      targetOrgId: 'org_1',
      before: { userId: 'user_1', role: 'org_admin' },
      after: { userId: 'user_1', role: 'viewer' },
    })
    // restore for subsequent tests
    memberships[0]!.role = 'org_admin'
  })

  it('setMemberRole throws NOT_FOUND for a non-member', async () => {
    await expect(
      caller().setMemberRole({ orgId: 'org_1', userId: 'user_ghost', role: 'viewer' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('setPlan swaps planId and audits before/after plan keys', async () => {
    auditLogs = []
    const result = await caller().setPlan({ orgId: 'org_1', planKey: 'pro' })
    expect(result.planKey).toBe('pro')
    expect(orgs[0]?.planId).toBe('plan_pro')
    expect(auditLogs[0]).toMatchObject({
      action: 'org.setPlan',
      before: { planKey: 'free' },
      after: { planKey: 'pro' },
    })
    orgs[0]!.planId = 'plan_free'
  })

  it('setPlan throws NOT_FOUND for an unknown plan key', async () => {
    await expect(
      caller().setPlan({ orgId: 'org_1', planKey: 'does-not-exist' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('setLimitOverrides writes numeric overrides and BigInt-safe audit values', async () => {
    auditLogs = []
    const result = await caller().setLimitOverrides({
      orgId: 'org_1',
      maxSeatsOverride: 25,
      maxEventsPerMonthOverride: 500_000,
      maxFlagsOverride: null,
      maxFlagCallsPerMonthOverride: null,
    })
    expect(result.maxSeatsOverride).toBe(25)
    expect(orgs[0]?.maxSeatsOverride).toBe(25)
    expect(orgs[0]?.maxEventsPerMonthOverride).toBe(500_000n)
    expect(auditLogs[0]?.action).toBe('org.setLimitOverrides')
    orgs[0]!.maxSeatsOverride = null
    orgs[0]!.maxEventsPerMonthOverride = null
  })

  it('setOveragePolicy flips the policy and audits it', async () => {
    auditLogs = []
    const result = await caller().setOveragePolicy({ orgId: 'org_1', overagePolicy: 'allow' })
    expect(result.overagePolicy).toBe('allow')
    expect(auditLogs[0]).toMatchObject({
      action: 'org.setOveragePolicy',
      before: { overagePolicy: 'block' },
      after: { overagePolicy: 'allow' },
    })
    orgs[0]!.overagePolicy = 'block'
  })

  it('listProjects returns the org projects', async () => {
    const result = await caller().listProjects({ orgId: 'org_1' })
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('proj_1')
  })

  it('listApiKeys returns metadata only — never keyHash', async () => {
    const result = await caller().listApiKeys({ orgId: 'org_1' })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'key_1', keyPrefix: 'ck_live_abc' })
    expect(result[0]).not.toHaveProperty('keyHash')
    expect(JSON.stringify(result)).not.toContain('SHOULD_NEVER_LEAK')
  })
})
