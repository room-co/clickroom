import { clickhouse } from '@clickroom/clickhouse'
import { prisma } from '@clickroom/db'
import { appRouter } from '@clickroom/trpc-router'
import {
  QUOTA_LIMITS_TTL_SECONDS,
  quotaLimitsCacheKey,
  writeQuotaLimitsMirror,
} from '@clickroom/trpc-router/lib/quota.cache.js'
import { redis } from '@clickroom/trpc-router/lib/redis.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authService, callAs, cleanupOrg, cleanupUser, makeCtx } from './helpers.js'

const suffix = Date.now().toString(36)
const createdUserIds: string[] = []
const createdOrgIds: string[] = []
const createdPlanIds: string[] = []

// Only the CH-data suite needs a live ClickHouse; ping once at collection time
// so we can skip gracefully (mirrors events.test.ts).
const chAvailable = await clickhouse
  .ping()
  .then((r) => r.success)
  .catch(() => false)

function callerFor(userId: string, orgForToken: string) {
  return appRouter.createCaller(
    makeCtx({ tokenPayload: { sub: userId, sessionId: 'test', orgId: orgForToken } }),
  )
}

afterAll(async () => {
  for (const oid of createdOrgIds) await cleanupOrg(oid)
  for (const uid of createdUserIds) await cleanupUser(uid)
  for (const pid of createdPlanIds) await prisma.plan.delete({ where: { id: pid } }).catch(() => {})
  await redis.quit()
  await prisma.$disconnect()
})

describe.skipIf(!chAvailable)('usage.summary over seeded ClickHouse + Postgres data', () => {
  let adminUserId: string
  let orgId: string
  /** The suite's dedicated Plan. Its key is not the signup default, so this org IS entitled to overage. */
  let planId: string
  let projectId: string

  // Comfortably inside the current UTC calendar month at test run time — the
  // router computes [monthStart, monthEnd) from `now`, so seeded rows must
  // land there.
  const now = new Date()
  const inMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 12, 0, 0))
  const inMonthTs = inMonth.toISOString().replace('T', ' ').replace('Z', '')
  // Previous month — must NOT be counted.
  const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12, 0, 0))
  const prevMonthTs = prevMonth.toISOString().replace('T', ' ').replace('Z', '')

  beforeAll(async () => {
    // The shared ioredis client is connected eagerly at construction (see
    // lib/redis.ts), but mirror this suite's `waitFor`-free style: make sure
    // it's usable before asserting against it directly (mirrors flags.test.ts).
    if (redis.status !== 'ready' && redis.status !== 'connecting') {
      await redis.connect()
    }

    const s = await authService.signup({
      email: `usage-admin-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Usage Org ${suffix}`,
    })
    adminUserId = s.user.id
    orgId = s.org!.id
    createdUserIds.push(adminUserId)
    createdOrgIds.push(orgId)

    const project = await prisma.project.findFirstOrThrow({ where: { orgId } })
    projectId = project.id

    // Attach a dedicated Plan (rather than relying on `free` being seeded in
    // the test database — global setup only runs migrations, not seed.ts) so
    // `planKey` is deterministic, then override every limit on the org so
    // over-limit flags are deterministic too: 2 seats (admin already occupies
    // 1), 1 flag, 3 events/month, 2 flag-calls/month.
    const plan = await prisma.plan.create({
      data: {
        id: `usage-plan-${suffix}`,
        key: `usage-test-${suffix}`,
        name: 'Usage Test Plan',
        maxSeats: 100,
        maxFlags: 100,
        maxEventsPerMonth: 100_000n,
        maxFlagCallsPerMonth: 100_000n,
        allowsOverage: true,
      },
    })
    createdPlanIds.push(plan.id)
    planId = plan.id
    await prisma.org.update({
      where: { id: orgId },
      data: {
        planId: plan.id,
        maxSeatsOverride: 2,
        maxFlagsOverride: 1,
        maxEventsPerMonthOverride: 3n,
        maxFlagCallsPerMonthOverride: 2n,
      },
    })

    const defaultEnv = await prisma.environment.findFirstOrThrow({
      where: { projectId, isDefault: true },
    })
    await prisma.featureFlag.create({
      data: {
        id: `usage-flag-${suffix}`,
        projectId,
        key: `usage-flag-${suffix}`,
        active: true,
        environmentId: defaultEnv.id,
        filters: { groups: [{ properties: [], rollout_percentage: 100, variant: null }] },
      },
    })

    // 3 events THIS month (== the 3/month limit, so overLimit should be true)
    // + 1 event last month (must be excluded from the monthly count). Each
    // in-month row uses a DIFFERENT distinct_id — the `events` ReplacingMergeTree
    // sort key is (project_id, toDate(timestamp), event, cityHash64(distinct_id)),
    // so same-day rows sharing a distinct_id would collapse under FINAL
    // (see events.test.ts's identical note).
    await clickhouse.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        {
          uuid: '11111111-0000-0000-0000-000000000001',
          project_id: projectId,
          event: 'pageview',
          distinct_id: `usage-user-a-${suffix}`,
          timestamp: inMonthTs,
          created_at: inMonthTs,
          properties: '{}',
          elements_chain: '',
        },
        {
          uuid: '11111111-0000-0000-0000-000000000002',
          project_id: projectId,
          event: 'pageview',
          distinct_id: `usage-user-b-${suffix}`,
          timestamp: inMonthTs,
          created_at: inMonthTs,
          properties: '{}',
          elements_chain: '',
        },
        {
          uuid: '11111111-0000-0000-0000-000000000003',
          project_id: projectId,
          event: 'pageview',
          distinct_id: `usage-user-c-${suffix}`,
          timestamp: inMonthTs,
          created_at: inMonthTs,
          properties: '{}',
          elements_chain: '',
        },
        {
          uuid: '11111111-0000-0000-0000-000000000099',
          project_id: projectId,
          event: 'pageview',
          distinct_id: `usage-user-${suffix}`,
          timestamp: prevMonthTs,
          created_at: prevMonthTs,
          properties: '{}',
          elements_chain: '',
        },
      ],
    })

    // 1 flag-call this month (under the 2/month limit) + 1 last month
    // (excluded).
    await clickhouse.insert({
      table: 'flag_events',
      format: 'JSONEachRow',
      values: [
        {
          uuid: '22222222-0000-0000-0000-000000000001',
          project_id: projectId,
          flag_key: `usage-flag-${suffix}`,
          distinct_id: `usage-user-${suffix}`,
          response: 'true',
          timestamp: inMonthTs,
          created_at: inMonthTs,
        },
        {
          uuid: '22222222-0000-0000-0000-000000000099',
          project_id: projectId,
          flag_key: `usage-flag-${suffix}`,
          distinct_id: `usage-user-${suffix}`,
          response: 'true',
          timestamp: prevMonthTs,
          created_at: prevMonthTs,
        },
      ],
    })
  })

  afterAll(async () => {
    await clickhouse
      .command({
        query: 'DELETE FROM events WHERE project_id = {pid:String}',
        query_params: { pid: projectId },
      })
      .catch(() => {})
    await clickhouse
      .command({
        query: 'DELETE FROM flag_events WHERE project_id = {pid:String}',
        query_params: { pid: projectId },
      })
      .catch(() => {})
  })

  it('reports lifetime + monthly usage against effective limits, with numeric fields', async () => {
    const caller = callerFor(adminUserId, orgId)
    const result = await callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
      caller.usage.summary(),
    )

    expect(result.planKey).toBe(`usage-test-${suffix}`)

    // Seats: 1 admin membership, cap 2 → under limit.
    expect(result.seats).toEqual({ used: 1, limit: 2, percent: 50, overLimit: false })
    expect(typeof result.seats.used).toBe('number')

    // Flags: 1 created, cap 1 → AT limit (over).
    expect(result.flags).toEqual({ used: 1, limit: 1, percent: 100, overLimit: true })

    // Events: 3 this month (prev-month row excluded), cap 3 → AT limit (over),
    // but not OVER-limit yet, so overageUnits is 0.
    expect(result.eventsThisMonth).toEqual({
      used: 3,
      limit: 3,
      percent: 100,
      overLimit: true,
      overageUnits: 0,
    })
    expect(typeof result.eventsThisMonth.used).toBe('number')

    // Flag-calls: 1 this month (prev-month row excluded), cap 2 → under limit.
    expect(result.flagCallsThisMonth).toEqual({
      used: 1,
      limit: 2,
      percent: 50,
      overLimit: false,
      overageUnits: 0,
    })

    // Monthly reset boundary: start of next UTC calendar month.
    const resetsAt = new Date(result.monthlyResetsAt)
    const now = new Date()
    expect(resetsAt.getUTCFullYear()).toBe(
      now.getUTCMonth() === 11 ? now.getUTCFullYear() + 1 : now.getUTCFullYear(),
    )
    expect(resetsAt.getUTCMonth()).toBe((now.getUTCMonth() + 1) % 12)
    expect(resetsAt.getUTCDate()).toBe(1)
    expect(resetsAt.getUTCHours()).toBe(0)

    // Default policy is 'block' (never bill without opt-in), and at
    // AT-limit (not over) usage, overageUnits reports 0 on both monthly metrics.
    expect(result.overagePolicy).toBe('block')
    expect(result.eventsThisMonth.overageUnits).toBe(0)
    expect(result.flagCallsThisMonth.overageUnits).toBe(0)
  })

  it('setOveragePolicy persists the org column and re-mirrors Redis immediately', async () => {
    const caller = callerFor(adminUserId, orgId)
    const res = await callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
      caller.usage.setOveragePolicy({ policy: 'allow' }),
    )
    expect(res).toEqual({ ok: true })

    const org = await prisma.org.findUniqueOrThrow({ where: { id: orgId } })
    expect(org.overagePolicy).toBe('allow')

    const mirrored = await redis.hget(quotaLimitsCacheKey(orgId), 'overagePolicy')
    expect(mirrored).toBe('allow')

    // The mirror this router writes must be mortal. An immortal
    // `usage:limits:*` hash is what pinned prod at maxEventsPerMonth=0 and
    // 402'd every event and flag call indefinitely.
    const ttl = await redis.ttl(quotaLimitsCacheKey(orgId))
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(QUOTA_LIMITS_TTL_SECONDS)

    // Restore 'block' so later assertions in this file aren't order-coupled.
    await callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
      caller.usage.setOveragePolicy({ policy: 'block' }),
    )
    const restoredMirror = await redis.hget(quotaLimitsCacheKey(orgId), 'overagePolicy')
    expect(restoredMirror).toBe('block')
  })

  it('usage.summary reports a positive overageUnits delta once CH usage exceeds the effective limit', async () => {
    // 3 events are already seeded THIS month (see beforeAll). Tighten the
    // monthly events override below the seeded usage so eventsThisMonth goes
    // genuinely over-limit — flagCallsThisMonth (1 used, cap 2) stays under,
    // so its overageUnits must stay 0 in the same response.
    await prisma.org.update({
      where: { id: orgId },
      data: { maxEventsPerMonthOverride: 2n },
    })

    const caller = callerFor(adminUserId, orgId)
    const result = await callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
      caller.usage.summary(),
    )

    expect(result.eventsThisMonth).toEqual({
      used: 3,
      limit: 2,
      percent: 150,
      overLimit: true,
      overageUnits: 1,
    })
    expect(result.flagCallsThisMonth.overageUnits).toBe(0)

    // Restore the original override for order-independence.
    await prisma.org.update({
      where: { id: orgId },
      data: { maxEventsPerMonthOverride: 3n },
    })
  })

  it('counts two same-key/different-uuid events as 2, not collapsed to 1 (regression)', async () => {
    // Regression fixture for bug: `events` is a
    // ReplacingMergeTree(created_at) whose sort key used to be (project_id,
    // toDate(timestamp), event, cityHash64(distinct_id)) — no uuid in the key —
    // so two GENUINELY DISTINCT events sharing (project, same calendar day, same
    // event name, same distinct_id) but with different uuids would collapse to
    // one row, both under FINAL and permanently after a background merge. The ORDER BY later gained
    // sipHash64(uuid), and the usage count moved
    // buildOrgEventUsage off `count() FROM events FINAL` onto `uniqExact(uuid)`
    // with no FINAL. This test inserts exactly that same-key/different-uuid
    // shape and asserts usage.summary's eventsThisMonth.used counts BOTH.
    //
    // Sanity check (reasoned, not re-run against reverted schema
    // task notes): pre-fix, the ORDER BY had no uuid term, so these two rows would
    // share the exact same sort key and ClickHouse's ReplacingMergeTree would keep
    // only one of them once `FINAL` (or a background merge) applied — the old
    // `count() FROM events FINAL` query would have reported 1, not 2, for these
    // two rows. `uniqExact(uuid)` (no FINAL) is immune to that collapse because it
    // counts distinct uuids directly rather than relying on row survival after
    // dedup, and the schema fix means FINAL itself no longer collapses them either.
    const dedupDistinctId = `usage-dedup-${suffix}`
    await clickhouse.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        {
          uuid: '33333333-0000-0000-0000-000000000001',
          project_id: projectId,
          event: 'pageview',
          distinct_id: dedupDistinctId,
          timestamp: inMonthTs,
          created_at: inMonthTs,
          properties: '{}',
          elements_chain: '',
        },
        {
          uuid: '33333333-0000-0000-0000-000000000002',
          project_id: projectId,
          event: 'pageview',
          distinct_id: dedupDistinctId,
          timestamp: inMonthTs,
          created_at: inMonthTs,
          properties: '{}',
          elements_chain: '',
        },
      ],
    })

    // Raise the events cap well above beforeAll's 3 seeded events + these 2 new
    // ones so overLimit/overageUnits don't interfere with the count assertion.
    await prisma.org.update({
      where: { id: orgId },
      data: { maxEventsPerMonthOverride: 100n },
    })

    const caller = callerFor(adminUserId, orgId)
    const result = await callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
      caller.usage.summary(),
    )

    // 3 events from beforeAll + these 2 same-key/different-uuid events = 5.
    // Pre-fix this would have reported 4 (the two dedup rows collapsed to 1).
    expect(result.eventsThisMonth.used).toBe(5)

    // Restore the original override for order-independence with later assertions.
    await prisma.org.update({
      where: { id: orgId },
      data: { maxEventsPerMonthOverride: 3n },
    })
  })

  it("cross-tenant isolation: another org cannot read or mutate this org's overage policy", async () => {
    const other = await authService.signup({
      email: `usage-other-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Usage Other Org ${suffix}`,
    })
    const otherUserId = other.user.id
    const otherOrgId = other.org!.id
    createdUserIds.push(otherUserId)
    createdOrgIds.push(otherOrgId)

    // `signup` lands an org on the default plan, which is NOT entitled to
    // overage — so move it onto the suite's plan, otherwise the 'allow' below
    // is refused and this test would be asserting the entitlement gate rather
    // than the tenant isolation it exists to cover. (The gate has its own
    // tests further down.)
    await prisma.org.update({ where: { id: otherOrgId }, data: { planId } })

    const otherCaller = callerFor(otherUserId, otherOrgId)

    // Mutating as the OTHER org's caller only ever touches otherOrgId — never
    // this suite's `orgId` — because setOveragePolicy scopes to `ctx.orgId`
    // (derived from the caller's own token/session), not a client-supplied id.
    await callAs({ userId: otherUserId, orgId: otherOrgId, orgRole: 'org_admin' }, () =>
      otherCaller.usage.setOveragePolicy({ policy: 'allow' }),
    )

    const thisOrg = await prisma.org.findUniqueOrThrow({ where: { id: orgId } })
    expect(thisOrg.overagePolicy).toBe('block')

    const otherOrgRow = await prisma.org.findUniqueOrThrow({ where: { id: otherOrgId } })
    expect(otherOrgRow.overagePolicy).toBe('allow')

    // The other org's fresh summary sees its OWN zeroed-out usage/limits, not
    // this suite's seeded CH data or plan overrides.
    const otherResult = await callAs(
      { userId: otherUserId, orgId: otherOrgId, orgRole: 'org_admin' },
      () => otherCaller.usage.summary(),
    )
    expect(otherResult.overagePolicy).toBe('allow')
    expect(otherResult.eventsThisMonth.used).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Overage entitlement. `setOveragePolicy` is gated `org:update`, and every
// self-signup user is `org_admin` of the org bootstrapped for them — so the
// mutation is reachable by anyone who can create an account. Switching to
// 'allow' lifts the monthly event/flag-call cap in capture-rs
// (`apply_policy_gate`), which is only sound on a plan someone is billed for.
// Without this gate, "sign up free, open Settings, toggle Allow overage" was a
// self-serve path to unmetered ingest.
//
// Seats/flags are deliberately NOT covered here: `assertUnderQuota` never reads
// the policy, so they stay hard caps regardless — asserted below so a future
// change that wires the policy into that gate trips this test.
// ---------------------------------------------------------------------------
describe('setOveragePolicy entitlement', () => {
  let userId: string
  let orgId: string

  beforeAll(async () => {
    const s = await authService.signup({
      email: `usage-entitle-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Usage Entitlement Org ${suffix}`,
    })
    userId = s.user.id
    orgId = s.org!.id
    createdUserIds.push(userId)
    createdOrgIds.push(orgId)

    // Pin an explicitly UNENTITLED plan rather than leaning on `signup`'s
    // default: global test setup runs migrations but not seed.ts, so whether
    // `free` even exists depends on suite order. This asserts the semantics of
    // the `allowsOverage` column itself, not the absence of a seeded row.
    const plan = await prisma.plan.create({
      data: {
        id: `entitle-free-${suffix}`,
        key: `entitle-unpaid-${suffix}`,
        name: 'Entitlement Test Free Plan',
        maxSeats: 3,
        maxFlags: 5,
        maxEventsPerMonth: 10_000n,
        maxFlagCallsPerMonth: 50_000n,
        allowsOverage: false,
      },
    })
    createdPlanIds.push(plan.id)
    await prisma.org.update({ where: { id: orgId }, data: { planId: plan.id } })
  })

  it('refuses an org whose plan has allowsOverage=false', async () => {
    const caller = callerFor(userId, orgId)

    // Exactly the request a free-tier user's browser would send.
    await expect(
      callAs({ userId, orgId, orgRole: 'org_admin' }, () =>
        caller.usage.setOveragePolicy({ policy: 'allow' }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    // The column must be untouched — a rejected mutation may not half-apply.
    const org = await prisma.org.findUniqueOrThrow({ where: { id: orgId } })
    expect(org.overagePolicy).toBe('block')
  })

  it('refuses an org with no plan at all (fails closed)', async () => {
    const s = await authService.signup({
      email: `usage-noplan-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Usage No Plan Org ${suffix}`,
    })
    createdUserIds.push(s.user.id)
    createdOrgIds.push(s.org!.id)
    await prisma.org.update({ where: { id: s.org!.id }, data: { planId: null } })

    const caller = callerFor(s.user.id, s.org!.id)
    await expect(
      callAs({ userId: s.user.id, orgId: s.org!.id, orgRole: 'org_admin' }, () =>
        caller.usage.setOveragePolicy({ policy: 'allow' }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('advertises the entitlement on usage.summary so the UI can disable the control', async () => {
    const caller = callerFor(userId, orgId)
    const summary = await callAs({ userId, orgId, orgRole: 'org_admin' }, () =>
      caller.usage.summary(),
    )
    expect(summary.canSelfEnableOverage).toBe(false)
  })

  it('permits it once the org is moved to a non-default plan, and still permits block either way', async () => {
    const caller = callerFor(userId, orgId)

    // 'block' is never a privilege escalation — allowed even while unentitled.
    await callAs({ userId, orgId, orgRole: 'org_admin' }, () =>
      caller.usage.setOveragePolicy({ policy: 'block' }),
    )

    const plan = await prisma.plan.create({
      data: {
        id: `entitle-plan-${suffix}`,
        key: `entitle-paid-${suffix}`,
        name: 'Entitlement Test Plan',
        maxSeats: 10,
        maxFlags: 10,
        maxEventsPerMonth: 1_000n,
        maxFlagCallsPerMonth: 1_000n,
        allowsOverage: true,
      },
    })
    createdPlanIds.push(plan.id)
    await prisma.org.update({ where: { id: orgId }, data: { planId: plan.id } })

    await callAs({ userId, orgId, orgRole: 'org_admin' }, () =>
      caller.usage.setOveragePolicy({ policy: 'allow' }),
    )
    const org = await prisma.org.findUniqueOrThrow({ where: { id: orgId } })
    expect(org.overagePolicy).toBe('allow')

    const summary = await callAs({ userId, orgId, orgRole: 'org_admin' }, () =>
      caller.usage.summary(),
    )
    expect(summary.canSelfEnableOverage).toBe(true)

    // Overage never buys seats or flags — those ignore the policy entirely.
    expect(summary.seats.limit).toBe(10)
    expect(summary.flags.limit).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// the `usage:limits:<org_id>` mirror must expire.
//
// It used to be written with a bare HSET and no TTL, so the key was immortal:
// prod mirrored `maxEventsPerMonth=0` (empty `Plan` table ⇒ `planId=NULL` ⇒
// `effectiveLimits` fails closed to 0) and then 402'd every event and every
// flag call forever — fixing Postgres changed nothing, because nothing ever
// re-read it. The TTL is the backstop that makes the mirror eventually
// consistent with Postgres no matter who wrote to Postgres or how.
//
// Redis-only; no ClickHouse needed, so this suite runs unconditionally.
// ---------------------------------------------------------------------------
describe('writeQuotaLimitsMirror TTL', () => {
  const mirrorOrgId = `ttl-org-${suffix}`
  const key = quotaLimitsCacheKey(mirrorOrgId)

  const limits = {
    maxSeats: 10,
    maxFlags: 10,
    maxEventsPerMonth: 10_000n,
    maxFlagCallsPerMonth: 50_000n,
    overagePolicy: 'block' as const,
  }

  beforeAll(async () => {
    if (redis.status !== 'ready' && redis.status !== 'connecting') {
      await redis.connect()
    }
    await redis.del(key)
  })

  it('sets a bounded TTL on write — the key is never immortal', async () => {
    await writeQuotaLimitsMirror(mirrorOrgId, limits)

    expect(await redis.hgetall(key)).toEqual({
      maxEventsPerMonth: '10000',
      maxFlagCallsPerMonth: '50000',
      overagePolicy: 'block',
    })

    // -1 is ioredis/Redis for "key exists but has no expiry" — the exact bug.
    const ttl = await redis.ttl(key)
    expect(ttl).not.toBe(-1)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(QUOTA_LIMITS_TTL_SECONDS)
    expect(QUOTA_LIMITS_TTL_SECONDS).toBe(300)
  })

  it('re-arms the TTL on rewrite rather than leaving a hash behind without one', async () => {
    // Simulate a pre-fix immortal key, then let a normal rewrite heal it.
    await redis.hset(key, { maxEventsPerMonth: '0' })
    await redis.persist(key)
    expect(await redis.ttl(key)).toBe(-1)

    await writeQuotaLimitsMirror(mirrorOrgId, limits)

    const ttl = await redis.ttl(key)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(QUOTA_LIMITS_TTL_SECONDS)
    // And the poisoned 0 is gone.
    expect(await redis.hget(key, 'maxEventsPerMonth')).toBe('10000')

    await redis.del(key)
  })
})
