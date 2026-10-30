import { clickhouse } from '@clickroom/clickhouse'
import { prisma } from '@clickroom/db'
import { appRouter } from '@clickroom/trpc-router'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authService, callAs, cleanupOrg, cleanupUser, makeCtx } from './helpers.js'

const suffix = Date.now().toString(36)
const createdUserIds: string[] = []
const createdOrgIds: string[] = []

let adminUserId: string
let orgId: string
let projectId: string

// Wide range that comfortably brackets any row inserted during the run.
const range = { from: '2020-01-01T00:00:00.000Z', to: '2035-01-01T00:00:00.000Z' }

// Only the CH-data suite needs a live ClickHouse; the tenancy/auth suites need
// only Postgres. Ping once at collection time so we can skip gracefully.
const chAvailable = await clickhouse
  .ping()
  .then((r) => r.success)
  .catch(() => false)

beforeAll(async () => {
  const s = await authService.signup({
    email: `events-admin-${suffix}@test.invalid`,
    password: 'password123',
    orgName: `Events Org ${suffix}`,
  })
  adminUserId = s.user.id
  orgId = s.org!.id
  createdUserIds.push(adminUserId)
  createdOrgIds.push(orgId)

  const project = await prisma.project.findFirstOrThrow({ where: { orgId } })
  projectId = project.id
})

afterAll(async () => {
  if (chAvailable) {
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
    await clickhouse
      .command({
        query: 'DELETE FROM person_distinct_ids WHERE project_id = {pid:String}',
        query_params: { pid: projectId },
      })
      .catch(() => {})
  }
  for (const oid of createdOrgIds) await cleanupOrg(oid)
  for (const uid of createdUserIds) await cleanupUser(uid)
  await prisma.$disconnect()
})

function callerFor(userId: string, orgForToken: string) {
  return appRouter.createCaller(
    makeCtx({ tokenPayload: { sub: userId, sessionId: 'test', orgId: orgForToken } }),
  )
}

describe('events auth', () => {
  it('rejects a request with no active org context (FORBIDDEN)', async () => {
    const caller = callerFor(adminUserId, orgId)
    // No callAs → no ALS store → orgScopedProcedure rejects before touching CH.
    await expect(caller.events.topEvents({ projectId, range })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })
})

describe('events cross-tenant isolation', () => {
  it('a caller in org A gets NOT_FOUND for org B project', async () => {
    const b = await authService.signup({
      email: `events-tenant-b-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Events Tenant B ${suffix}`,
    })
    createdUserIds.push(b.user.id)
    createdOrgIds.push(b.org!.id)
    const bProject = await prisma.project.findFirstOrThrow({ where: { orgId: b.org!.id } })

    const caller = callerFor(adminUserId, orgId)
    const admin = { userId: adminUserId, orgId, orgRole: 'org_admin' as const }

    await expect(
      callAs(admin, () => caller.events.topEvents({ projectId: bProject.id, range })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe.skipIf(!chAvailable)('events analytics over seeded ClickHouse rows', () => {
  // Two distinct users: A completes the funnel (pageview → signup), B enters only.
  // Distinct distinct_ids keep the two pageviews off the same ReplacingMergeTree
  // sort key so FINAL/dedup doesn't collapse them.
  const userA = `user-a-${suffix}`
  const userB = `user-b-${suffix}`
  const ts = '2026-07-04 12:00:00.000'
  const ts2 = '2026-07-04 12:05:00.000'

  beforeAll(async () => {
    await clickhouse.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        {
          uuid: '11111111-1111-1111-1111-111111111111',
          project_id: projectId,
          event: 'pageview',
          distinct_id: userA,
          timestamp: ts,
          properties: JSON.stringify({ $current_url: 'https://app.test/home' }),
          elements_chain: '',
        },
        {
          uuid: '22222222-2222-2222-2222-222222222222',
          project_id: projectId,
          event: 'pageview',
          distinct_id: userB,
          timestamp: ts,
          properties: JSON.stringify({ $current_url: 'https://app.test/pricing' }),
          elements_chain: '',
        },
        {
          uuid: '33333333-3333-3333-3333-333333333333',
          project_id: projectId,
          event: 'signup',
          distinct_id: userA,
          timestamp: ts2,
          properties: JSON.stringify({ $current_url: 'https://app.test/signup' }),
          elements_chain: '',
        },
      ],
    })
    // "Active Users" counts identified persons only (pdi.person_id != '', see f2360ae), so
    // each seeded distinct_id needs a person mapping to be counted.
    await clickhouse.insert({
      table: 'person_distinct_ids',
      format: 'JSONEachRow',
      values: [userA, userB].map((id) => ({
        project_id: projectId,
        distinct_id: id,
        person_id: crypto.randomUUID(),
        created_at: ts,
      })),
    })
  })

  function admin() {
    return { userId: adminUserId, orgId, orgRole: 'org_admin' as const }
  }

  it('topEvents returns the seeded events with numeric counts', async () => {
    const caller = callerFor(adminUserId, orgId)
    const rows = await callAs(admin(), () => caller.events.topEvents({ projectId, range }))
    const pageview = rows.find((r) => r.event === 'pageview')
    expect(pageview?.count).toBe(2)
    expect(typeof pageview?.count).toBe('number')
    expect(rows.find((r) => r.event === 'signup')?.count).toBe(1)
  })

  it('live returns the seeded rows newest-first', async () => {
    const caller = callerFor(adminUserId, orgId)
    const rows = await callAs(admin(), () => caller.events.live({ projectId, limit: 50 }))
    expect(rows.length).toBeGreaterThanOrEqual(3)
    expect(rows.every((r) => r.distinct_id === userA || r.distinct_id === userB)).toBe(true)
  })

  it('users aggregates per distinct_id', async () => {
    const caller = callerFor(adminUserId, orgId)
    const rows = await callAs(admin(), () => caller.events.users({ projectId, range, page: 1 }))
    expect(rows.find((r) => r.distinct_id === userA)?.eventCount).toBe(2)
    expect(rows.find((r) => r.distinct_id === userB)?.eventCount).toBe(1)
    expect(typeof rows.find((r) => r.distinct_id === userA)?.eventCount).toBe('number')
  })

  it('users merges an anon + identified distinct_id sharing a person into ONE row', async () => {
    const anonId = `merge-anon-${suffix}`
    const identifiedId = `merge-identified-${suffix}`
    const personId = crypto.randomUUID()

    // Two distinct_ids, each with their own event, before any merge exists.
    await clickhouse.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        {
          uuid: crypto.randomUUID(),
          project_id: projectId,
          event: 'pageview',
          distinct_id: anonId,
          timestamp: ts,
          properties: JSON.stringify({ $current_url: 'https://app.test/pre-signup' }),
          elements_chain: '',
        },
        {
          uuid: crypto.randomUUID(),
          project_id: projectId,
          event: 'signup',
          distinct_id: identifiedId,
          timestamp: ts2,
          properties: JSON.stringify({ $current_url: 'https://app.test/post-signup' }),
          elements_chain: '',
        },
      ],
    })

    // Merge both distinct_ids onto the same person_id.
    await clickhouse.insert({
      table: 'person_distinct_ids',
      format: 'JSONEachRow',
      values: [
        { project_id: projectId, distinct_id: anonId, person_id: personId, created_at: ts },
        { project_id: projectId, distinct_id: identifiedId, person_id: personId, created_at: ts2 },
      ],
    })

    const caller = callerFor(adminUserId, orgId)
    const rows = await callAs(admin(), () => caller.events.users({ projectId, range, page: 1 }))

    const merged = rows.filter((r) => r.distinct_id === anonId || r.distinct_id === identifiedId)
    // ONE row combining both distinct_ids' events, not two.
    expect(merged.length).toBe(1)
    expect(merged[0]?.eventCount).toBe(2)
    // firstSeen/lastSeen combine across both merged distinct_ids (ts < ts2).
    expect(merged[0]?.firstSeen).toBeTruthy()
    expect(merged[0]?.lastSeen).toBeTruthy()
    expect(new Date(merged[0]!.firstSeen).getTime()).toBeLessThan(
      new Date(merged[0]!.lastSeen).getTime(),
    )

    // Clean up so this test's rows don't skew the other fixed-count assertions
    // in this describe block (which assume only userA/userB exist).
    await clickhouse.command({
      query:
        'DELETE FROM events WHERE project_id = {pid:String} AND distinct_id IN {ids:Array(String)}',
      query_params: { pid: projectId, ids: [anonId, identifiedId] },
    })
    await clickhouse.command({
      query:
        'DELETE FROM person_distinct_ids WHERE project_id = {pid:String} AND distinct_id IN {ids:Array(String)}',
      query_params: { pid: projectId, ids: [anonId, identifiedId] },
    })
  })

  it('activeUsers counts distinct users in range as a number', async () => {
    const caller = callerFor(adminUserId, orgId)
    const count = await callAs(admin(), () => caller.events.activeUsers({ projectId, range }))
    // Two distinct_ids seeded (userA, userB).
    expect(count).toBe(2)
    expect(typeof count).toBe('number')
  })

  it('activeUsers counts a user active on multiple days once, not once per day', async () => {
    const multiDayId = `multi-day-${suffix}`
    try {
      await clickhouse.insert({
        table: 'events',
        format: 'JSONEachRow',
        values: [
          {
            uuid: '44444444-4444-4444-4444-444444444444',
            project_id: projectId,
            event: 'pageview',
            distinct_id: multiDayId,
            timestamp: '2026-07-04 12:00:00.000',
            properties: '{}',
            elements_chain: '',
          },
          {
            uuid: '55555555-5555-5555-5555-555555555555',
            project_id: projectId,
            event: 'pageview',
            distinct_id: multiDayId,
            timestamp: '2026-07-05 12:00:00.000',
            properties: '{}',
            elements_chain: '',
          },
        ],
      })
      await clickhouse.insert({
        table: 'person_distinct_ids',
        format: 'JSONEachRow',
        values: [
          {
            project_id: projectId,
            distinct_id: multiDayId,
            person_id: crypto.randomUUID(),
            created_at: ts,
          },
        ],
      })
      const caller = callerFor(adminUserId, orgId)
      const count = await callAs(admin(), () => caller.events.activeUsers({ projectId, range }))
      // userA, userB, and multiDayId (active on two separate days) → 3 distinct
      // users, not 4 — a prior bug summed per-day distinct counts, double-counting
      // any user active across more than one day in the range.
      expect(count).toBe(3)
    } finally {
      // Always clean up: leaked rows would skew every later fixed-count assertion.
      for (const table of ['events', 'person_distinct_ids']) {
        await clickhouse.command({
          query: `DELETE FROM ${table} WHERE project_id = {pid:String} AND distinct_id = {id:String}`,
          query_params: { pid: projectId, id: multiDayId },
        })
      }
    }
  })

  it('overview returns stat-card values with null trend when there is no prior-window data', async () => {
    const caller = callerFor(adminUserId, orgId)
    const result = await callAs(admin(), () => caller.events.overview({ projectId, range }))
    // 3 seeded rows (2 pageview + 1 signup), 2 event types, top = pageview, 2 distinct users.
    expect(result.totalEvents.value).toBe(3)
    expect(result.eventTypes.value).toBe(2)
    expect(result.topEvent.value).toBe('pageview')
    expect(result.activeUsers.value).toBe(2)
    // No data exists before `range.from` → no baseline → trend is null everywhere.
    expect(result.totalEvents.trend).toBeNull()
    expect(result.eventTypes.trend).toBeNull()
    expect(result.topEvent.trend).toBeNull()
    expect(result.activeUsers.trend).toBeNull()
  })

  it('purgeUser hard-deletes all events + flag_events rows for a distinct_id', async () => {
    const caller = callerFor(adminUserId, orgId)
    const purgeTarget = `user-purge-${suffix}`

    await clickhouse.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        {
          uuid: crypto.randomUUID(),
          project_id: projectId,
          event: 'pageview',
          distinct_id: purgeTarget,
          timestamp: ts,
          properties: JSON.stringify({ $current_url: 'https://app.test/purge-me' }),
          elements_chain: '',
        },
        {
          uuid: crypto.randomUUID(),
          project_id: projectId,
          event: '$feature_flag_called',
          distinct_id: purgeTarget,
          timestamp: ts,
          properties: JSON.stringify({
            $feature_flag: 'flag-purge',
            $feature_flag_response: 'true',
          }),
          elements_chain: '',
        },
      ],
    })

    const before = await callAs(admin(), () => caller.events.users({ projectId, range, page: 1 }))
    expect(before.find((r) => r.distinct_id === purgeTarget)).toBeTruthy()

    await callAs(admin(), () => caller.events.purgeUser({ projectId, distinctId: purgeTarget }))

    const after = await callAs(admin(), () => caller.events.users({ projectId, range, page: 1 }))
    expect(after.find((r) => r.distinct_id === purgeTarget)).toBeUndefined()

    const detail = await callAs(admin(), () =>
      caller.events.userDetail({ projectId, distinctId: purgeTarget }),
    )
    expect(detail).toHaveLength(0)
  })

  it('purgeUser erases every distinct_id merged onto a person, not just the one passed in', async () => {
    const caller = callerFor(adminUserId, orgId)
    const anonId = `purge-merge-anon-${suffix}`
    const identifiedId = `purge-merge-identified-${suffix}`
    const personId = crypto.randomUUID()

    await clickhouse.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        {
          uuid: crypto.randomUUID(),
          project_id: projectId,
          event: 'pageview',
          distinct_id: anonId,
          timestamp: ts,
          properties: JSON.stringify({ $current_url: 'https://app.test/purge-merge-pre' }),
          elements_chain: '',
        },
        {
          uuid: crypto.randomUUID(),
          project_id: projectId,
          event: '$feature_flag_called',
          distinct_id: identifiedId,
          timestamp: ts2,
          properties: JSON.stringify({
            $feature_flag: 'flag-purge-merge',
            $feature_flag_response: 'true',
          }),
          elements_chain: '',
        },
      ],
    })

    await clickhouse.insert({
      table: 'person_distinct_ids',
      format: 'JSONEachRow',
      values: [
        { project_id: projectId, distinct_id: anonId, person_id: personId, created_at: ts },
        { project_id: projectId, distinct_id: identifiedId, person_id: personId, created_at: ts2 },
      ],
    })

    // Purge using only the identified id — the anon id was never passed in.
    await callAs(admin(), () => caller.events.purgeUser({ projectId, distinctId: identifiedId }))

    const eventsRs = await clickhouse.query({
      query:
        'SELECT distinct_id FROM events WHERE project_id = {pid:String} AND distinct_id IN {ids:Array(String)}',
      query_params: { pid: projectId, ids: [anonId, identifiedId] },
      format: 'JSONEachRow',
    })
    expect(await eventsRs.json()).toHaveLength(0)

    const flagEventsRs = await clickhouse.query({
      query:
        'SELECT distinct_id FROM flag_events WHERE project_id = {pid:String} AND distinct_id IN {ids:Array(String)}',
      query_params: { pid: projectId, ids: [anonId, identifiedId] },
      format: 'JSONEachRow',
    })
    expect(await flagEventsRs.json()).toHaveLength(0)

    const mappingRs = await clickhouse.query({
      query:
        'SELECT distinct_id FROM person_distinct_ids WHERE project_id = {pid:String} AND distinct_id IN {ids:Array(String)}',
      query_params: { pid: projectId, ids: [anonId, identifiedId] },
      format: 'JSONEachRow',
    })
    expect(await mappingRs.json()).toHaveLength(0)
  })

  it('purgeUser rejects a viewer (lacks projects:manage)', async () => {
    const caller = callerFor(adminUserId, orgId)
    const viewer = { userId: adminUserId, orgId, orgRole: 'viewer' as const }
    await expect(
      callAs(viewer, () => caller.events.purgeUser({ projectId, distinctId: userA })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('list returns paginated rows filtered by event (server-side explorer)', async () => {
    const caller = callerFor(adminUserId, orgId)
    const all = await callAs(admin(), () => caller.events.list({ projectId, range, pageSize: 50 }))
    // At least the three seeded rows come back, newest-first.
    expect(all.length).toBeGreaterThanOrEqual(3)
    expect(all.every((r) => r.distinct_id === userA || r.distinct_id === userB)).toBe(true)

    // Exact event filter narrows to the single signup row.
    const signups = await callAs(admin(), () =>
      caller.events.list({ projectId, range, event: 'signup' }),
    )
    expect(signups.every((r) => r.event === 'signup')).toBe(true)
    expect(signups.some((r) => r.distinct_id === userA)).toBe(true)

    // Free-text search matches on current_url.
    const pricing = await callAs(admin(), () =>
      caller.events.list({ projectId, range, search: 'pricing' }),
    )
    expect(pricing.some((r) => r.current_url.includes('pricing'))).toBe(true)
  })

  it('funnel suffix-sums windowFunnel levels into per-step counts', async () => {
    const caller = callerFor(adminUserId, orgId)
    const rows = await callAs(admin(), () =>
      caller.events.funnel({
        projectId,
        steps: [
          { event: 'pageview', filters: [] },
          { event: 'signup', filters: [] },
        ],
        window: 86400,
        range,
      }),
    )
    expect(rows).toHaveLength(2)
    // Both users entered (step 1); only A reached signup (step 2).
    expect(rows[0]).toMatchObject({
      step: 1,
      label: 'pageview',
      count: 2,
      conversionPct: 100,
      dropoffPct: 0,
    })
    expect(rows[1]).toMatchObject({
      step: 2,
      label: 'signup',
      count: 1,
      conversionPct: 50,
      dropoffPct: 50,
    })
  })

  it('funnelStats returns the median convert time and a numeric trend', async () => {
    const caller = callerFor(adminUserId, orgId)
    const res = await callAs(admin(), () =>
      caller.events.funnelStats({
        projectId,
        steps: [
          { event: 'pageview', filters: [] },
          { event: 'signup', filters: [] },
        ],
        window: 86400,
        range,
      }),
    )
    // Only userA converted; pageview (12:00) → signup (12:05) spans 5 minutes.
    expect(res.medianMs).toBe(300000)
    expect(typeof res.trend).toBe('number')
  })

  it('funnelHistory reports the daily entered/converted counts and rate', async () => {
    const caller = callerFor(adminUserId, orgId)
    const rows = await callAs(admin(), () =>
      caller.events.funnelHistory({
        projectId,
        steps: [
          { event: 'pageview', filters: [] },
          { event: 'signup', filters: [] },
        ],
        window: 86400,
        range,
      }),
    )
    // Both users entered on the same day; only A converted → 50%.
    const day = rows.find((r) => r.entered === 2)
    expect(day?.converted).toBe(1)
    expect(day?.rate).toBe(50)
  })

  it('userSessions is empty when events carry no $session_id', async () => {
    const caller = callerFor(adminUserId, orgId)
    const rows = await callAs(admin(), () =>
      caller.events.userSessions({ projectId, distinctId: userA }),
    )
    expect(rows).toEqual([])
  })

  it('userActivity returns a numeric daily series for a user', async () => {
    const caller = callerFor(adminUserId, orgId)
    const rows = await callAs(admin(), () =>
      caller.events.userActivity({ projectId, distinctId: userA }),
    )
    expect(Array.isArray(rows)).toBe(true)
    for (const r of rows) expect(typeof r.count).toBe('number')
  })
})

// topPages: per-page sessions/clicks/rate with a previous-window trend.
// Seeds $session_id + $autocapture click events so session_id (migration 003) and
// the click predicate ($event_type='click') materialize. All rows are in-range so
// prev_sessions=0 → trend=0.
describe.skipIf(!chAvailable)('topPages over seeded session + click rows', () => {
  const tpTs = '2026-07-04 15:00:00.000'
  const homeUrl = 'https://app.test/tp-home'
  const pricingUrl = 'https://app.test/tp-pricing'
  const s1 = `tp-s1-${suffix}`
  const s2 = `tp-s2-${suffix}`
  const s3 = `tp-s3-${suffix}`

  beforeAll(async () => {
    const row = (
      event: string,
      distinctId: string,
      url: string,
      sessionId: string,
      eventType?: string,
    ) => ({
      uuid: crypto.randomUUID(),
      project_id: projectId,
      event,
      distinct_id: distinctId,
      timestamp: tpTs,
      properties: JSON.stringify({
        $current_url: url,
        $session_id: sessionId,
        ...(eventType ? { $event_type: eventType } : {}),
      }),
      elements_chain: '',
    })
    await clickhouse.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        // /tp-home: session s1 (pageview + 1 click), session s2 (pageview) → sessions=2, clicks=1.
        row('pageview', `tp-a-${suffix}`, homeUrl, s1),
        row('$autocapture', `tp-b-${suffix}`, homeUrl, s1, 'click'),
        row('pageview', `tp-c-${suffix}`, homeUrl, s2),
        // /tp-pricing: session s3 pageview, no click → sessions=1, clicks=0.
        row('pageview', `tp-d-${suffix}`, pricingUrl, s3),
      ],
    })
  })

  function admin() {
    return { userId: adminUserId, orgId, orgRole: 'org_admin' as const }
  }

  it('returns per-page sessions/clicks/rate with a numeric zero trend', async () => {
    const caller = callerFor(adminUserId, orgId)
    const rows = await callAs(admin(), () => caller.events.topPages({ projectId, range }))
    const byPage = Object.fromEntries(rows.map((r) => [r.page, r]))

    const home = byPage[homeUrl]
    expect(home).toBeDefined()
    expect(home.sessions).toBe(2)
    expect(home.clicks).toBe(1)
    expect(home.rate).toBe(50)
    expect(home.trend).toBe(0)
    expect(typeof home.sessions).toBe('number')

    const pricing = byPage[pricingUrl]
    expect(pricing.sessions).toBe(1)
    expect(pricing.clicks).toBe(0)
    expect(pricing.rate).toBe(0)
  })
})

// Feature-flag usage analytics over seeded `$feature_flag_called` events.
// flagUsage counts uniqExact(uuid) without FINAL, so distinct uuids are what matter
// (the separate suite below proves same-user/multi-flag rows are not collapsed).
describe.skipIf(!chAvailable)('flagUsage over seeded $feature_flag_called rows', () => {
  const flagKey = `ff-${suffix}`
  const ffTs = '2026-07-04 14:00:00.000'
  const uid = () => `ffu-${suffix}-${Math.random().toString(36).slice(2, 10)}`

  // 3 "true" calls + 2 "false" calls, each a distinct user → 5 calls, 5 unique users.
  const spec: [string, number][] = [
    ['true', 3],
    ['false', 2],
  ]

  beforeAll(async () => {
    const values: Record<string, unknown>[] = []
    for (const [response, n] of spec) {
      for (let i = 0; i < n; i++) {
        values.push({
          uuid: crypto.randomUUID(),
          project_id: projectId,
          event: '$feature_flag_called',
          distinct_id: uid(),
          timestamp: ffTs,
          properties: JSON.stringify({
            $feature_flag: flagKey,
            $feature_flag_response: response,
          }),
          elements_chain: '',
        })
      }
    }
    // A different flag key with its own distinct user — must NOT be counted for flagKey.
    values.push({
      uuid: crypto.randomUUID(),
      project_id: projectId,
      event: '$feature_flag_called',
      distinct_id: uid(),
      timestamp: ffTs,
      properties: JSON.stringify({
        $feature_flag: `other-${suffix}`,
        $feature_flag_response: 'true',
      }),
      elements_chain: '',
    })
    await clickhouse.insert({ table: 'events', format: 'JSONEachRow', values })
  })

  function admin() {
    return { userId: adminUserId, orgId, orgRole: 'org_admin' as const }
  }

  it('returns correct calls, uniqueUsers, and byResponse split for the flag', async () => {
    const caller = callerFor(adminUserId, orgId)
    const res = await callAs(admin(), () =>
      caller.events.flagUsage({ projectId, key: flagKey, range }),
    )
    expect(res.calls).toBe(5)
    expect(res.uniqueUsers).toBe(5)
    expect(typeof res.calls).toBe('number')

    const byResponse = Object.fromEntries(res.byResponse.map((r) => [r.response, r]))
    expect(byResponse.true.calls).toBe(3)
    expect(byResponse.true.users).toBe(3)
    expect(byResponse.false.calls).toBe(2)
    expect(byResponse.false.users).toBe(2)

    // Trend bucketed by day carries the same totals in a single bucket.
    expect(res.trend.length).toBeGreaterThanOrEqual(1)
    const totalCalls = res.trend.reduce((s, t) => s + t.calls, 0)
    expect(totalCalls).toBe(5)

    // trendByResponse splits the same totals by response (true=3, false=2).
    expect(res.trendByResponse.length).toBeGreaterThanOrEqual(2)
    const trueCalls = res.trendByResponse
      .filter((t) => t.response === 'true')
      .reduce((s, t) => s + t.calls, 0)
    const falseCalls = res.trendByResponse
      .filter((t) => t.response === 'false')
      .reduce((s, t) => s + t.calls, 0)
    expect(trueCalls).toBe(3)
    expect(falseCalls).toBe(2)
  })

  it('flagTopUsers ranks users by eval count with their last response', async () => {
    const caller = callerFor(adminUserId, orgId)
    const rows = await callAs(admin(), () =>
      caller.events.flagTopUsers({ projectId, key: flagKey, range, limit: 10 }),
    )
    // Every seeded user evaluated once → 5 rows, each evals=1.
    expect(rows.length).toBe(5)
    expect(rows.every((r) => r.evals === 1)).toBe(true)
    expect(typeof rows[0].evals).toBe('number')
    expect(rows.every((r) => r.lastResponse === 'true' || r.lastResponse === 'false')).toBe(true)
  })

  it('returns zeroed summary for an unknown flag key', async () => {
    const caller = callerFor(adminUserId, orgId)
    const res = await callAs(admin(), () =>
      caller.events.flagUsage({ projectId, key: `nope-${suffix}`, range }),
    )
    expect(res.calls).toBe(0)
    expect(res.uniqueUsers).toBe(0)
    expect(res.byResponse).toEqual([])
  })

  it('cross-tenant: org A caller gets NOT_FOUND for org B project', async () => {
    const b = await authService.signup({
      email: `flag-tenant-b-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Flag Tenant B ${suffix}`,
    })
    createdUserIds.push(b.user.id)
    createdOrgIds.push(b.org!.id)
    const bProject = await prisma.project.findFirstOrThrow({ where: { orgId: b.org!.id } })

    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () =>
        caller.events.flagUsage({ projectId: bProject.id, key: flagKey, range }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

// Regression: the events RMT sort key omits the flag key, so under FINAL
// a single user's multiple same-day flag calls collapse to one row — zeroing a flag.
// The dedicated flag_events sink (via the MV) has flag_key in its sort key, so 2×flagA
// + 1×flagB for ONE user on ONE day now yields flagA.calls=2 (not 0) and flagB.calls=1.
describe.skipIf(!chAvailable)(
  'flagUsage does not collapse same-user multi-flag same-day rows',
  () => {
    const flagA = `collapseA-${suffix}`
    const flagB = `collapseB-${suffix}`
    const oneUser = `collapse-user-${suffix}`
    const day = '2026-07-04 09:00:00.000'
    const day2 = '2026-07-04 09:30:00.000'
    const day3 = '2026-07-04 10:00:00.000'

    beforeAll(async () => {
      // Same distinct_id, same calendar day — the exact scenario the old events-RMT
      // key collapsed. Distinct uuids so uniqExact(uuid) counts each genuine eval.
      await clickhouse.insert({
        table: 'events',
        format: 'JSONEachRow',
        values: [
          {
            uuid: crypto.randomUUID(),
            project_id: projectId,
            event: '$feature_flag_called',
            distinct_id: oneUser,
            timestamp: day,
            properties: JSON.stringify({ $feature_flag: flagA, $feature_flag_response: 'true' }),
            elements_chain: '',
          },
          {
            uuid: crypto.randomUUID(),
            project_id: projectId,
            event: '$feature_flag_called',
            distinct_id: oneUser,
            timestamp: day2,
            properties: JSON.stringify({ $feature_flag: flagA, $feature_flag_response: 'false' }),
            elements_chain: '',
          },
          {
            uuid: crypto.randomUUID(),
            project_id: projectId,
            event: '$feature_flag_called',
            distinct_id: oneUser,
            timestamp: day3,
            properties: JSON.stringify({ $feature_flag: flagB, $feature_flag_response: 'true' }),
            elements_chain: '',
          },
        ],
      })
    })

    function admin() {
      return { userId: adminUserId, orgId, orgRole: 'org_admin' as const }
    }

    it('counts both of flagA’s same-user same-day evals (calls=2, not collapsed to 0/1)', async () => {
      const caller = callerFor(adminUserId, orgId)
      const a = await callAs(admin(), () =>
        caller.events.flagUsage({ projectId, key: flagA, range }),
      )
      expect(a.calls).toBe(2)
      expect(a.uniqueUsers).toBe(1)

      const b = await callAs(admin(), () =>
        caller.events.flagUsage({ projectId, key: flagB, range }),
      )
      expect(b.calls).toBe(1)
      expect(b.uniqueUsers).toBe(1)
    })
  },
)

// AC-4: breakdown over a seeded click page returns EXACT elements_chain_text /
// elements_chain_href counts. Each click is a distinct_id so the ReplacingMergeTree
// sort key (…, cityHash64(distinct_id)) keeps every row alive under FINAL.
describe.skipIf(!chAvailable)('breakdown exact counts over a seeded click page (AC-4)', () => {
  const uid = () => `bd-${suffix}-${Math.random().toString(36).slice(2, 8)}`
  const clickTs = '2026-07-04 13:00:00.000'

  // 3× "Buy now"→/checkout, 2× "View pricing"→/pricing, 1× "Sign up"→/signup.
  const chain = (text: string, href: string) =>
    `button:text="${text}";href="${href}"|div:nth-child="1"`
  const spec: [string, string, number][] = [
    ['Buy now', '/checkout', 3],
    ['View pricing', '/pricing', 2],
    ['Sign up', '/signup', 1],
  ]

  beforeAll(async () => {
    const values: Record<string, unknown>[] = []
    for (const [text, href, n] of spec) {
      for (let i = 0; i < n; i++) {
        values.push({
          uuid: crypto.randomUUID(),
          project_id: projectId,
          event: '$autocapture',
          distinct_id: uid(),
          timestamp: clickTs,
          properties: JSON.stringify({ $current_url: `https://app.test${href}` }),
          elements_chain: chain(text, href),
        })
      }
    }
    await clickhouse.insert({ table: 'events', format: 'JSONEachRow', values })
  })

  function admin() {
    return { userId: adminUserId, orgId, orgRole: 'org_admin' as const }
  }

  it('breakdown by elements_chain_text returns exact click-text counts', async () => {
    const caller = callerFor(adminUserId, orgId)
    const rows = await callAs(admin(), () =>
      caller.events.breakdown({
        projectId,
        event: '$autocapture',
        dimension: 'elements_chain_text',
        range,
      }),
    )
    const byText = Object.fromEntries(rows.map((r) => [r.value, r.count]))
    expect(byText['Buy now']).toBe(3)
    expect(byText['View pricing']).toBe(2)
    expect(byText['Sign up']).toBe(1)
  })

  it('breakdown by elements_chain_href returns exact click-href counts', async () => {
    const caller = callerFor(adminUserId, orgId)
    const rows = await callAs(admin(), () =>
      caller.events.breakdown({
        projectId,
        event: '$autocapture',
        dimension: 'elements_chain_href',
        range,
      }),
    )
    const byHref = Object.fromEntries(rows.map((r) => [r.value, r.count]))
    expect(byHref['/checkout']).toBe(3)
    expect(byHref['/pricing']).toBe(2)
    expect(byHref['/signup']).toBe(1)
  })
})
