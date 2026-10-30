import { clickhouse } from '@clickroom/clickhouse'
import { prisma } from '@clickroom/db'
import { appRouter } from '@clickroom/trpc-router'
import type { InsightConfigInput } from '@clickroom/trpc-router/trpc/routers/insights.schema.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authService, callAs, cleanupOrg, cleanupUser, makeCtx } from './helpers.js'

const suffix = Date.now().toString(36)
const createdUserIds: string[] = []
const createdOrgIds: string[] = []

let adminUserId: string
let orgId: string
let projectId: string

// Wide range that comfortably brackets any row inserted during the run — same
// convention as events.test.ts.
const range = { from: '2020-01-01T00:00:00.000Z', to: '2035-01-01T00:00:00.000Z' }

// Only the CH-seeded `results` suite needs a live ClickHouse; CRUD/permission/
// tenancy suites need only Postgres. Ping once at collection time so we can
// skip gracefully, mirroring events.test.ts's `chAvailable` gate.
const chAvailable = await clickhouse
  .ping()
  .then((r) => r.success)
  .catch(() => false)

const trendConfig: InsightConfigInput = {
  type: 'trend',
  event: '$pageview',
  interval: 'day',
  range,
}

const usersConfig: InsightConfigInput = {
  type: 'users',
  window: 'day',
  range,
}

const funnelConfig: InsightConfigInput = {
  type: 'funnel',
  steps: [
    { event: '$pageview', filters: [] },
    { event: 'signup', filters: [] },
  ],
  window: 86_400,
  range,
}

const retentionConfig: InsightConfigInput = {
  type: 'retention',
  range,
  cohortWeeks: 8,
}

const breakdownConfig: InsightConfigInput = {
  type: 'breakdown',
  dimension: 'referring_domain',
  event: '$pageview',
  range,
  limit: 10,
}

beforeAll(async () => {
  const s = await authService.signup({
    email: `insights-admin-${suffix}@test.invalid`,
    password: 'password123',
    orgName: `Insights Org ${suffix}`,
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

const admin = () => ({ userId: adminUserId, orgId, orgRole: 'org_admin' as const })

describe('insights CRUD', () => {
  it('creates, gets, lists, updates, and deletes a trend insight', async () => {
    const caller = callerFor(adminUserId, orgId)

    const created = await callAs(admin(), () =>
      caller.insights.create({
        projectId,
        name: 'Pageviews trend',
        description: 'Daily pageviews',
        tags: ['traffic'],
        config: trendConfig,
      }),
    )
    expect(created).toMatchObject({ name: 'Pageviews trend', type: 'trend' })
    expect(created.config).toEqual(trendConfig)

    const got = await callAs(admin(), () => caller.insights.get({ projectId, id: created.id }))
    expect(got.id).toBe(created.id)

    const list = await callAs(admin(), () => caller.insights.list({ projectId }))
    expect(list.map((i) => i.id)).toContain(created.id)

    const updated = await callAs(admin(), () =>
      caller.insights.update({
        projectId,
        id: created.id,
        patch: { name: 'Renamed trend', config: usersConfig },
      }),
    )
    expect(updated.name).toBe('Renamed trend')
    expect(updated.type).toBe('users')
    expect(updated.config).toEqual(usersConfig)

    await callAs(admin(), () => caller.insights.delete({ projectId, id: created.id }))
    const afterDelete = await callAs(admin(), () => caller.insights.list({ projectId }))
    expect(afterDelete.map((i) => i.id)).not.toContain(created.id)
  })

  it('get on a missing id throws NOT_FOUND', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.insights.get({ projectId, id: 'nope' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('update on a missing id throws NOT_FOUND', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () =>
        caller.insights.update({ projectId, id: 'nope', patch: { name: 'x' } }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('delete on a missing id throws NOT_FOUND', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.insights.delete({ projectId, id: 'nope' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('soft delete hides the insight from list but the row survives', async () => {
    const caller = callerFor(adminUserId, orgId)
    const created = await callAs(admin(), () =>
      caller.insights.create({
        projectId,
        name: 'To delete',
        config: trendConfig,
      }),
    )
    await callAs(admin(), () => caller.insights.delete({ projectId, id: created.id }))

    const list = await callAs(admin(), () => caller.insights.list({ projectId }))
    expect(list.map((i) => i.id)).not.toContain(created.id)

    await expect(
      callAs(admin(), () => caller.insights.get({ projectId, id: created.id })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const row = await prisma.insight.findUnique({ where: { id: created.id } })
    expect(row).not.toBeNull()
    expect(row?.deletedAt).not.toBeNull()
  })
})

describe('insights.toggleFavorite', () => {
  it('flips isFavorite and persists the change', async () => {
    const caller = callerFor(adminUserId, orgId)
    const created = await callAs(admin(), () =>
      caller.insights.create({
        projectId,
        name: 'Favorite me',
        config: trendConfig,
      }),
    )
    expect(created.isFavorite).toBe(false)

    const toggled = await callAs(admin(), () =>
      caller.insights.toggleFavorite({ projectId, id: created.id }),
    )
    expect(toggled.isFavorite).toBe(true)

    const got = await callAs(admin(), () => caller.insights.get({ projectId, id: created.id }))
    expect(got.isFavorite).toBe(true)

    const toggledBack = await callAs(admin(), () =>
      caller.insights.toggleFavorite({ projectId, id: created.id }),
    )
    expect(toggledBack.isFavorite).toBe(false)
    const gotAgain = await callAs(admin(), () => caller.insights.get({ projectId, id: created.id }))
    expect(gotAgain.isFavorite).toBe(false)
  })

  it('toggleFavorite on a missing id throws NOT_FOUND', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.insights.toggleFavorite({ projectId, id: 'nope' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('insights cross-tenant isolation', () => {
  async function otherTenantProject(label: string) {
    const b = await authService.signup({
      email: `insights-tenant-${label}-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Insights Tenant ${label} ${suffix}`,
    })
    createdUserIds.push(b.user.id)
    createdOrgIds.push(b.org!.id)
    const bProject = await prisma.project.findFirstOrThrow({ where: { orgId: b.org!.id } })
    return bProject.id
  }

  it('get on another org project fails closed', async () => {
    const bProjectId = await otherTenantProject('get')
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.insights.get({ projectId: bProjectId, id: 'anything' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('update on another org project fails closed', async () => {
    const bProjectId = await otherTenantProject('update')
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () =>
        caller.insights.update({
          projectId: bProjectId,
          id: 'anything',
          patch: { name: 'nope' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('delete on another org project fails closed', async () => {
    const bProjectId = await otherTenantProject('delete')
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.insights.delete({ projectId: bProjectId, id: 'anything' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('toggleFavorite on another org project fails closed', async () => {
    const bProjectId = await otherTenantProject('toggle')
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () =>
        caller.insights.toggleFavorite({ projectId: bProjectId, id: 'anything' }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('results on another org project fails closed', async () => {
    const bProjectId = await otherTenantProject('results')
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.insights.results({ projectId: bProjectId, id: 'anything' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('list on another org project fails closed', async () => {
    const bProjectId = await otherTenantProject('list')
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.insights.list({ projectId: bProjectId })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('insights permissions', () => {
  it('a viewer may list/get/results but not create/update/delete/toggleFavorite', async () => {
    const v = await authService.signup({
      email: `insights-viewer-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Insights Viewer Org ${suffix}`,
    })
    createdUserIds.push(v.user.id)
    createdOrgIds.push(v.org!.id)
    const vOrgId = v.org!.id
    const vProject = await prisma.project.findFirstOrThrow({ where: { orgId: vOrgId } })
    const vAdmin = { userId: v.user.id, orgId: vOrgId, orgRole: 'org_admin' as const }
    const viewer = { userId: v.user.id, orgId: vOrgId, orgRole: 'viewer' as const }
    const caller = callerFor(v.user.id, vOrgId)

    // Seed one insight as admin so the viewer has something to read.
    const created = await callAs(vAdmin, () =>
      caller.insights.create({
        projectId: vProject.id,
        name: 'Viewer readable',
        config: trendConfig,
      }),
    )

    await expect(
      callAs(viewer, () => caller.insights.list({ projectId: vProject.id })),
    ).resolves.toBeInstanceOf(Array)

    await expect(
      callAs(viewer, () => caller.insights.get({ projectId: vProject.id, id: created.id })),
    ).resolves.toMatchObject({ id: created.id })

    if (chAvailable) {
      await expect(
        callAs(viewer, () => caller.insights.results({ projectId: vProject.id, id: created.id })),
      ).resolves.toMatchObject({ type: 'trend' })
    }

    await expect(
      callAs(viewer, () =>
        caller.insights.create({
          projectId: vProject.id,
          name: 'nope',
          config: trendConfig,
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(
      callAs(viewer, () =>
        caller.insights.update({
          projectId: vProject.id,
          id: created.id,
          patch: { name: 'nope' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(
      callAs(viewer, () =>
        caller.insights.toggleFavorite({ projectId: vProject.id, id: created.id }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    await expect(
      callAs(viewer, () => caller.insights.delete({ projectId: vProject.id, id: created.id })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe.skipIf(!chAvailable)('insights.results over seeded ClickHouse rows', () => {
  const userA = `insights-user-a-${suffix}`
  const userB = `insights-user-b-${suffix}`
  // A server-side (sdk-node) user: no `$session_id`, ever. Retention must still see them.
  const userC = `insights-user-c-server-${suffix}`
  // Seed relative to "now" so the rows always sit inside a 7d-from-now window.
  // A hardcoded date would silently fall out of that window as the calendar moves.
  const chTimestamp = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '')
  // 3 days back: comfortably inside a 7d-from-now window, but outside a
  // 1-day window ending now (which the "snap to 2 months" test relies on).
  const seededAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
  const ts = chTimestamp(seededAt)
  const ts2 = chTimestamp(new Date(seededAt.getTime() + 5 * 60 * 1000)) // +5min

  // Every seeded row carries `$session_id` because these simulate *browser* events,
  // and the browser SDK always sets it. The retention insight goes through
  // buildWebRetention, which is browser-scoped (`session_id != ''`) — a row without
  // `$session_id` materializes session_id='' and is excluded, yielding zero cohorts.
  // One session per user: retention keys on the person, not the session.
  const sessionA = `insights-sess-a-${suffix}`
  const sessionB = `insights-sess-b-${suffix}`

  beforeAll(async () => {
    await clickhouse.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        {
          uuid: crypto.randomUUID(),
          project_id: projectId,
          event: '$pageview',
          distinct_id: userA,
          timestamp: ts,
          properties: JSON.stringify({
            $current_url: 'https://app.test/home',
            $referrer: 'https://google.com/search?q=clickroom',
            $session_id: sessionA,
          }),
          elements_chain: '',
        },
        {
          uuid: crypto.randomUUID(),
          project_id: projectId,
          event: '$pageview',
          distinct_id: userB,
          timestamp: ts,
          properties: JSON.stringify({
            $current_url: 'https://app.test/pricing',
            $referrer: 'https://google.com/search?q=clickroom',
            $session_id: sessionB,
          }),
          elements_chain: '',
        },
        {
          uuid: crypto.randomUUID(),
          project_id: projectId,
          event: 'signup',
          distinct_id: userA,
          timestamp: ts2,
          properties: JSON.stringify({
            $current_url: 'https://app.test/signup',
            $session_id: sessionA,
          }),
          elements_chain: '',
        },
        // Server-side event: no `$session_id`, no `$current_url`. Deliberately a bespoke
        // event name so it stays out of the `$pageview`-scoped trend/funnel/breakdown
        // assertions above, while still counting as a user for `users` and `retention`.
        {
          uuid: crypto.randomUUID(),
          project_id: projectId,
          event: 'server_task_run',
          distinct_id: userC,
          timestamp: ts,
          properties: JSON.stringify({ source: 'sdk-node' }),
          elements_chain: '',
        },
      ],
    })
  })

  async function createInsight(config: InsightConfigInput) {
    const caller = callerFor(adminUserId, orgId)
    return callAs(admin(), () =>
      caller.insights.create({ projectId, name: `Results ${config.type}`, config }),
    )
  }

  async function createAndGetResults(config: InsightConfigInput) {
    const created = await createInsight(config)
    const caller = callerFor(adminUserId, orgId)
    return callAs(admin(), () => caller.insights.results({ projectId, id: created.id }))
  }

  it('trend returns a series of {bucket, value} points', async () => {
    const result = await createAndGetResults(trendConfig)
    expect(result.type).toBe('trend')
    if (result.type !== 'trend') throw new Error('unreachable')
    expect(Array.isArray(result.series)).toBe(true)
    expect(result.series.length).toBeGreaterThan(0)
    for (const point of result.series) {
      expect(typeof point.bucket).toBe('string')
      expect(typeof point.value).toBe('number')
    }
    const total = result.series.reduce((sum, p) => sum + p.value, 0)
    expect(total).toBe(2)
  })

  it('users returns a {type, window, series} shape, not a bare count', async () => {
    const result = await createAndGetResults(usersConfig)
    expect(result.type).toBe('users')
    if (result.type !== 'users') throw new Error('unreachable')
    expect(result.window).toBe('day')
    expect(Array.isArray(result.series)).toBe(true)
    expect(result.series.length).toBeGreaterThan(0)
    for (const point of result.series) {
      expect(typeof point.bucket).toBe('string')
      expect(typeof point.value).toBe('number')
    }
    // userA + userB (browser) + userC (server-side). The `users` insight counts every
    // active user, not just browser traffic.
    const total = result.series.reduce((sum, p) => sum + p.value, 0)
    expect(total).toBe(3)
  })

  it('funnel returns per-step counts with conversion percentages', async () => {
    const result = await createAndGetResults(funnelConfig)
    expect(result.type).toBe('funnel')
    if (result.type !== 'funnel') throw new Error('unreachable')
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0]).toMatchObject({ step: 1, label: '$pageview', count: 2 })
    expect(result.steps[1]).toMatchObject({ step: 2, label: 'signup', count: 1 })
    expect(typeof result.medianMs).toBe('number')
  })

  it('retention returns cohort rows with a size and a retention array', async () => {
    const result = await createAndGetResults(retentionConfig)
    expect(result.type).toBe('retention')
    if (result.type !== 'retention') throw new Error('unreachable')
    expect(Array.isArray(result.cohorts)).toBe(true)
    expect(result.cohorts.length).toBeGreaterThan(0)
    for (const cohort of result.cohorts) {
      expect(typeof cohort.cohortWeek).toBe('string')
      expect(typeof cohort.size).toBe('number')
      expect(Array.isArray(cohort.retention)).toBe(true)
    }
    // userA/userB were first seen this week -> the current cohort should
    // include both at week_offset 0.
    const thisWeekCohort = result.cohorts.find((c) => c.size >= 2)
    expect(thisWeekCohort).toBeTruthy()
  })

  // Regression guard: the Insights retention chart runs buildWebRetention with
  // scope:'all'. Under the default 'web' scope the `session_id != ''` gate erases
  // server-side (sdk-node) users — userC would silently vanish from their own cohort
  // and read as churn. All three seeded users share one first-seen week, so the
  // cohort must be size 3, not 2.
  it('retention counts server-side users, not just browser traffic', async () => {
    const result = await createAndGetResults(retentionConfig)
    if (result.type !== 'retention') throw new Error('unreachable')
    const sizes = result.cohorts.map((c) => c.size)
    expect(Math.max(...sizes)).toBe(3)
  })

  it('breakdown returns ranked {value, count} rows', async () => {
    const result = await createAndGetResults(breakdownConfig)
    expect(result.type).toBe('breakdown')
    if (result.type !== 'breakdown') throw new Error('unreachable')
    expect(Array.isArray(result.rows)).toBe(true)
    const byDomain = Object.fromEntries(result.rows.map((r) => [r.value, r.count]))
    expect(byDomain['google.com']).toBe(2)
  })

  it('a stale stored range with rangeKey resolves near "now" instead of the frozen range', async () => {
    // Stored `range` deliberately excludes the seeded events (2021), but
    // `rangeKey: '7d'` should make the server recompute a window ending now,
    // which does bracket the seeded events (seeded 2h before now).
    const staleRange = { from: '2021-01-01T00:00:00.000Z', to: '2021-01-02T00:00:00.000Z' }
    const created = await createInsight({
      type: 'trend',
      event: '$pageview',
      interval: 'day',
      range: staleRange,
      rangeKey: '7d',
    })
    const caller = callerFor(adminUserId, orgId)
    const result = await callAs(admin(), () =>
      caller.insights.results({ projectId, id: created.id }),
    )
    expect(result.type).toBe('trend')
    if (result.type !== 'trend') throw new Error('unreachable')
    const total = result.series.reduce((sum, p) => sum + p.value, 0)
    expect(total).toBe(2)
  })

  it('rangeOverride on results takes precedence over stored range/rangeKey', async () => {
    // Stored config comfortably brackets the seeded events; the override
    // deliberately excludes them (2021), so a non-zero result would mean the
    // override was ignored.
    const created = await createInsight(trendConfig)
    const caller = callerFor(adminUserId, orgId)
    const result = await callAs(admin(), () =>
      caller.insights.results({
        projectId,
        id: created.id,
        rangeOverride: { from: '2021-01-01T00:00:00.000Z', to: '2021-01-02T00:00:00.000Z' },
      }),
    )
    expect(result.type).toBe('trend')
    if (result.type !== 'trend') throw new Error('unreachable')
    const total = result.series.reduce((sum, p) => sum + p.value, 0)
    expect(total).toBe(0)
  })

  it('a users query with window "month" snaps a too-narrow range to cover at least 2 months', async () => {
    const created = await createInsight({
      type: 'users',
      window: 'month',
      range,
    })
    const caller = callerFor(adminUserId, orgId)
    // Override is a 1-day span ending "now" — far narrower than a month's
    // worth of buckets, and (by itself) would exclude the seeded events
    // (seeded 3 days back). If the server snaps the range to at least ~2 months
    // back from `to`, the seeded events fall back into range.
    const result = await callAs(admin(), () =>
      caller.insights.results({
        projectId,
        id: created.id,
        rangeOverride: {
          from: new Date(Date.now() - 86_400_000).toISOString(),
          to: new Date().toISOString(),
        },
      }),
    )
    expect(result.type).toBe('users')
    if (result.type !== 'users') throw new Error('unreachable')
    expect(result.window).toBe('month')
    // userA + userB (browser) + userC (server-side) — all three seeded events fall
    // back into the snapped range.
    const total = result.series.reduce((sum, p) => sum + p.value, 0)
    expect(total).toBe(3)
  })
})
