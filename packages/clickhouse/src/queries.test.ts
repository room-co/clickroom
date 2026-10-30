import { describe, expect, it } from 'vitest'
import {
  type BreakdownDimension,
  buildActiveUsers,
  buildActiveUsersTotal,
  buildBreakdown,
  buildDistinctIdGroup,
  buildEventById,
  buildEventList,
  buildExperimentExposures,
  buildExperimentFunnelByVariant,
  buildExperimentMeanByVariant,
  buildExperimentRatioByVariant,
  buildExperimentRetentionByVariant,
  buildFlagTopUsers,
  buildFlagUsageByResponse,
  buildFlagUsageSummary,
  buildFlagUsageTrend,
  buildFlagUsageTrendByResponse,
  buildFunnel,
  buildFunnelHistory,
  buildFunnelStats,
  buildLive,
  buildOrgEventUsage,
  buildOrgFlagCallUsage,
  buildOverviewActiveUsers,
  buildOverviewEvents,
  buildPropertyValues,
  buildSegmentCount,
  buildSegmentMembers,
  buildSessionEvents,
  buildSupportCsat,
  buildSupportDeflectionRate,
  buildSupportVolumeByCategory,
  buildSupportVolumeTrend,
  buildSurveyOpenResponses,
  buildSurveyQuestionBreakdown,
  buildSurveyRespondent,
  buildSurveyResponseRate,
  buildSurveyScore,
  buildSurveySegmentBreakdown,
  buildSurveyTrend,
  buildTopEvents,
  buildTopPages,
  buildTraitValues,
  buildTrend,
  buildUserActivity,
  buildUserDetail,
  buildUserFlagsAtTime,
  buildUserSessions,
  buildUserSummary,
  buildUsers,
  compileSegmentDefinition,
  type FunnelStep,
  type SegmentDefinition,
} from './queries.js'

// A projectId that would be catastrophic if interpolated raw into SQL.
const INJECT = "p_inject'; DROP TABLE events; --"
const RANGE = { from: '2026-07-01T00:00:00Z', to: '2026-07-04T00:00:00Z' }

/** Assert none of the given user inputs appear as raw text in the SQL string. */
function assertNoRawInterpolation(query: string, values: string[]) {
  for (const v of values) {
    expect(query).not.toContain(v)
  }
}

describe('buildTopEvents', () => {
  it('builds a grouped/ordered/limited uniqExact(uuid) count query with bound params, no FINAL', () => {
    const { query, query_params } = buildTopEvents({ projectId: INJECT, range: RANGE, limit: 5 })
    expect(query).toContain('SELECT event, uniqExact(uuid) AS count')
    expect(query).not.toContain('FINAL')
    expect(query).toContain('GROUP BY event')
    expect(query).toContain('ORDER BY count DESC')
    expect(query).toContain('LIMIT {limit:UInt32}')
    expect(query).toContain('project_id = {project_id:String}')
    expect(query).toContain('timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}')
    expect(query_params).toEqual({ project_id: INJECT, from: RANGE.from, to: RANGE.to, limit: 5 })
    assertNoRawInterpolation(query, [INJECT, RANGE.from, RANGE.to])
  })

  it('defaults limit to 20', () => {
    const { query_params } = buildTopEvents({ projectId: 'p1', range: RANGE })
    expect(query_params.limit).toBe(20)
  })
})

describe('buildTopPages', () => {
  const PREV_FROM = '2026-06-28 00:00:00.000'

  it('builds a per-page current/previous conditional-aggregation query with bound params', () => {
    const { query, query_params } = buildTopPages({
      projectId: INJECT,
      range: RANGE,
      prevFrom: PREV_FROM,
      limit: 5,
    })
    expect(query).toContain('current_url AS page')
    expect(query).toContain(
      "uniqExactIf(session_id, session_id != '' AND timestamp >= {from:DateTime64(3)}) AS sessions",
    )
    expect(query).toContain(
      "uniqExactIf(session_id, session_id != '' AND timestamp < {from:DateTime64(3)}) AS prev_sessions",
    )
    expect(query).toContain("JSONExtractString(properties, '$event_type') = 'click'")
    expect(query).toContain('uniqExactIf(uuid,')
    expect(query).toContain('AS clicks')
    expect(query).toContain('AS prev_clicks')
    expect(query).toContain('AS click_sessions')
    expect(query).not.toContain('FINAL')
    expect(query).toContain('project_id = {project_id:String}')
    expect(query).toContain('timestamp >= {prev_from:DateTime64(3)}')
    expect(query).toContain('timestamp <= {to:DateTime64(3)}')
    expect(query).toContain("current_url != ''")
    expect(query).toContain('GROUP BY page')
    expect(query).toContain('HAVING sessions > 0')
    expect(query).toContain('ORDER BY sessions DESC')
    expect(query).toContain('LIMIT {limit:UInt32}')
    expect(query_params).toEqual({
      project_id: INJECT,
      from: RANGE.from,
      to: RANGE.to,
      prev_from: PREV_FROM,
      limit: 5,
    })
    assertNoRawInterpolation(query, [INJECT, RANGE.from, RANGE.to, PREV_FROM])
  })

  it('defaults limit to 10', () => {
    const { query_params } = buildTopPages({ projectId: 'p1', range: RANGE, prevFrom: PREV_FROM })
    expect(query_params.limit).toBe(10)
  })
})

describe('buildOverviewEvents', () => {
  const PREV_FROM = '2026-06-28 00:00:00.000'

  it('builds a per-event current/previous conditional-aggregation query with bound params', () => {
    const { query, query_params } = buildOverviewEvents({
      projectId: INJECT,
      range: RANGE,
      prevFrom: PREV_FROM,
    })
    expect(query).toContain('SELECT')
    expect(query).toContain('event')
    expect(query).toContain('uniqExactIf(uuid, timestamp >= {from:DateTime64(3)}) AS count')
    expect(query).toContain('uniqExactIf(uuid, timestamp < {from:DateTime64(3)}) AS prev_count')
    expect(query).not.toContain('FINAL')
    expect(query).toContain('project_id = {project_id:String}')
    expect(query).toContain('timestamp >= {prev_from:DateTime64(3)}')
    expect(query).toContain('timestamp <= {to:DateTime64(3)}')
    expect(query).toContain('GROUP BY event')
    expect(query).toContain('ORDER BY count DESC')
    expect(query_params).toEqual({
      project_id: INJECT,
      from: RANGE.from,
      to: RANGE.to,
      prev_from: PREV_FROM,
    })
    assertNoRawInterpolation(query, [INJECT, RANGE.from, RANGE.to, PREV_FROM])
  })
})

describe('buildOverviewActiveUsers', () => {
  const PREV_FROM = '2026-06-28 00:00:00.000'

  it('builds current/previous active-user (identified) and visitor (anon) conditional aggregations with bound params', () => {
    const { query, query_params } = buildOverviewActiveUsers({
      projectId: INJECT,
      range: RANGE,
      prevFrom: PREV_FROM,
    })
    // Active users = identified persons only (person_id != '').
    expect(query).toContain("uniqExactIf(pdi.person_id, pdi.person_id != '' AND")
    expect(query).toContain('AS active_cur')
    expect(query).toContain('AS active_prev')
    // Visitors = anonymous devices (no person mapping).
    expect(query).toContain("uniqExactIf(events.distinct_id, pdi.person_id = '' AND")
    expect(query).toContain('AS visitors_cur')
    expect(query).toContain('AS visitors_prev')
    // Both metrics exclude synthetic/server-side rows.
    expect(query).toContain("events.event = '_clickroom_probe'")
    expect(query).toContain(
      "JSONExtractString(events.properties, '$lib') IN ('', 'clickroom-server')",
    )
    // LEFT JOIN resolves the current person mapping.
    expect(query).toContain('LEFT JOIN')
    expect(query).toContain('FROM person_distinct_ids')
    expect(query).toContain(
      'ON pdi.project_id = events.project_id AND pdi.distinct_id = events.distinct_id',
    )
    expect(query).toContain('events.project_id = {project_id:String}')
    expect(query).toContain('events.timestamp >= {prev_from:DateTime64(3)}')
    expect(query).toContain('events.timestamp <= {to:DateTime64(3)}')
    expect(query_params).toEqual({
      project_id: INJECT,
      from: RANGE.from,
      to: RANGE.to,
      prev_from: PREV_FROM,
    })
    assertNoRawInterpolation(query, [INJECT, RANGE.from, RANGE.to, PREV_FROM])
  })
})

describe('buildActiveUsersTotal', () => {
  // Regression guard: the whole-range Active Users count must count
  // identified persons only and must NOT readmit the two synthetic sources that inflated
  // the dashboard count — deploy/healthcheck probes (`_clickroom_probe`) and server-side
  // flag exposures (`$feature_flag_called` with `$lib` in ('', 'clickroom-server')). This
  // is the defense-in-depth net for pre-`track` rows; do not let it silently drop.
  it('counts identified persons only, excluding probes and server exposures', () => {
    const { query, query_params } = buildActiveUsersTotal({ projectId: INJECT, range: RANGE })
    // Identified persons only.
    expect(query).toContain("uniqExactIf(pdi.person_id, pdi.person_id != '' AND")
    // Excludes deploy/healthcheck probes.
    expect(query).toContain("events.event = '_clickroom_probe'")
    // Excludes server-side flag exposures ($lib '' or 'clickroom-server').
    expect(query).toContain(
      "JSONExtractString(events.properties, '$lib') IN ('', 'clickroom-server')",
    )
    expect(query).toContain('events.project_id = {project_id:String}')
    expect(query).toContain('events.timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}')
    expect(query_params).toEqual({ project_id: INJECT, from: RANGE.from, to: RANGE.to })
    assertNoRawInterpolation(query, [INJECT, RANGE.from, RANGE.to])
  })
})

describe('buildTrend', () => {
  it('uses toStartOfHour for hour interval', () => {
    const { query, query_params } = buildTrend({
      projectId: 'p1',
      event: 'pageview',
      range: RANGE,
      interval: 'hour',
    })
    expect(query).toContain('toStartOfHour(timestamp) AS bucket')
    expect(query).toContain('uniqExact(uuid) AS count')
    expect(query).not.toContain('FINAL')
    expect(query).toContain('event = {event:String}')
    expect(query).toContain('ORDER BY bucket')
    expect(query_params.event).toBe('pageview')
  })

  it('uses toStartOfDay for day interval', () => {
    const { query } = buildTrend({ projectId: 'p1', event: 'e', range: RANGE, interval: 'day' })
    expect(query).toContain('toStartOfDay(timestamp) AS bucket')
  })

  // The Dashboard chart's sessions series is backed by this column. It used to be
  // fabricated client-side as `events * 0.42`; guard against a regression to that.
  it('counts real sessions from session_id, browser-scoped', () => {
    const { query } = buildTrend({ projectId: 'p1', range: RANGE, interval: 'hour' })
    expect(query).toContain("uniqExactIf(session_id, session_id != '') AS sessions")
    // Browser-scoping gate must be present — without it, server-side sdk-node events
    // (which never set $session_id) would fold into an empty-string session bucket.
    expect(query).toContain("session_id != ''")
  })

  it('does not interpolate the event name', () => {
    const { query } = buildTrend({
      projectId: INJECT,
      event: INJECT,
      range: RANGE,
      interval: 'day',
    })
    assertNoRawInterpolation(query, [INJECT])
  })

  it('omits the event filter and param when event is not given', () => {
    const { query, query_params } = buildTrend({ projectId: 'p1', range: RANGE, interval: 'day' })
    expect(query).not.toContain('event = {event:String}')
    expect(query_params.event).toBeUndefined()
  })

  it('leaves the query/params unchanged when filters is omitted', () => {
    const withFilters = buildTrend({ projectId: 'p1', event: 'e', range: RANGE, interval: 'day' })
    const withoutFilters = buildTrend({
      projectId: 'p1',
      event: 'e',
      range: RANGE,
      interval: 'day',
      filters: [],
    })
    expect(withFilters.query).toBe(withoutFilters.query)
    expect(withFilters.query_params).toEqual(withoutFilters.query_params)
  })

  it('ANDs a bound property filter into the WHERE clause', () => {
    const { query, query_params } = buildTrend({
      projectId: 'p1',
      event: 'e',
      range: RANGE,
      interval: 'day',
      filters: [{ key: '$browser', operator: 'exact', value: 'Chrome' }],
    })
    expect(query).toContain(
      'event = {event:String} AND JSONExtractString(properties, {kf_0:String}) = {vf_0:String}',
    )
    expect(query_params).toMatchObject({ kf_0: '$browser', vf_0: 'Chrome' })
  })

  it('never interpolates filter key/value raw into the SQL string', () => {
    const { query } = buildTrend({
      projectId: 'p1',
      event: 'e',
      range: RANGE,
      interval: 'day',
      filters: [{ key: INJECT, operator: 'exact', value: INJECT }],
    })
    assertNoRawInterpolation(query, [INJECT])
  })
})

describe('buildOrgEventUsage', () => {
  // NOTE: this suite only asserts SQL *shape* (string contents / bound
  // params) — it never executes against a live ClickHouse, so it cannot itself prove
  // that two rows sharing (project_id, day, event, distinct_id) with different uuids
  // are both counted. That live regression coverage — insert two same-key/
  // different-uuid rows, assert the count is 2 not 1 — lives in
  // apps/api/src/test/usage.test.ts's "counts two same-key/different-uuid events as
  // 2, not collapsed to 1" test, which exercises buildOrgEventUsage end-to-end via
  // usage.summary() against real ClickHouse + Postgres. What this suite DOES verify,
  // and what makes that live behavior possible, is the query shape itself:
  // `uniqExact(uuid)` with no `FINAL` — asserted below — which counts every distinct
  // uuid regardless of ReplacingMergeTree's coarser (project_id, day, event,
  // cityHash64(distinct_id), sipHash64(uuid)) sort-key collapsing.
  it('counts events with uniqExact(uuid), NO FINAL, across every project id in the org, bound as Array(String)', () => {
    const monthStart = new Date('2026-07-01T00:00:00.000Z')
    const monthEnd = new Date('2026-08-01T00:00:00.000Z')
    const { query, query_params } = buildOrgEventUsage({
      projectIds: [INJECT, 'p2'],
      monthStart,
      monthEnd,
    })
    expect(query).toContain('FROM events')
    expect(query).toContain('uniqExact(uuid) AS count')
    expect(query).not.toContain('FINAL')
    expect(query).toContain('project_id IN {project_ids:Array(String)}')
    expect(query).toContain('created_at >= {month_start:DateTime64(3)}')
    expect(query).toContain('created_at < {month_end:DateTime64(3)}')
    expect(query_params).toEqual({
      project_ids: [INJECT, 'p2'],
      month_start: '2026-07-01 00:00:00.000',
      month_end: '2026-08-01 00:00:00.000',
    })
    // The malicious project id is only ever a bound array element, never
    // spliced into the SQL string itself.
    assertNoRawInterpolation(query, [INJECT])
  })
})

describe('buildOrgFlagCallUsage', () => {
  it('counts flag_events with uniqExact(uuid), NO FINAL, across every project id', () => {
    const monthStart = new Date('2026-07-01T00:00:00.000Z')
    const monthEnd = new Date('2026-08-01T00:00:00.000Z')
    const { query, query_params } = buildOrgFlagCallUsage({
      projectIds: [INJECT, 'p2'],
      monthStart,
      monthEnd,
    })
    expect(query).toContain('FROM flag_events')
    expect(query).toContain('uniqExact(uuid) AS count')
    expect(query).not.toContain('FINAL')
    expect(query).toContain('project_id IN {project_ids:Array(String)}')
    expect(query).toContain('created_at >= {month_start:DateTime64(3)}')
    expect(query).toContain('created_at < {month_end:DateTime64(3)}')
    expect(query_params).toEqual({
      project_ids: [INJECT, 'p2'],
      month_start: '2026-07-01 00:00:00.000',
      month_end: '2026-08-01 00:00:00.000',
    })
    assertNoRawInterpolation(query, [INJECT])
  })
})

describe('buildBreakdown', () => {
  it('injects an allowlisted column as a validated identifier', () => {
    const { query, query_params } = buildBreakdown({
      projectId: 'p1',
      event: 'click',
      dimension: 'current_url',
      range: RANGE,
      limit: 10,
    })
    expect(query).toContain('current_url AS value')
    expect(query).toContain('uniqExact(uuid) AS count')
    expect(query).not.toContain('FINAL')
    expect(query).toContain("current_url != ''")
    expect(query).toContain('event = {event:String}')
    expect(query).toContain('LIMIT {limit:UInt32}')
    expect(query_params).toEqual({
      project_id: 'p1',
      from: RANGE.from,
      to: RANGE.to,
      event: 'click',
      limit: 10,
    })
  })

  it('accepts all allowlisted dimensions', () => {
    const dims: BreakdownDimension[] = [
      'elements_chain_text',
      'elements_chain_href',
      'current_url',
      'path',
      'referring_domain',
    ]
    for (const dimension of dims) {
      const { query } = buildBreakdown({ projectId: 'p1', event: 'e', dimension, range: RANGE })
      expect(query).toContain(`${dimension} AS value`)
    }
  })

  it('leaves the query/params unchanged when filters is omitted', () => {
    const withFilters = buildBreakdown({
      projectId: 'p1',
      event: 'click',
      dimension: 'current_url',
      range: RANGE,
    })
    const withoutFilters = buildBreakdown({
      projectId: 'p1',
      event: 'click',
      dimension: 'current_url',
      range: RANGE,
      filters: [],
    })
    expect(withFilters.query).toBe(withoutFilters.query)
    expect(withFilters.query_params).toEqual(withoutFilters.query_params)
  })

  it('ANDs a bound property filter into the WHERE clause', () => {
    const { query, query_params } = buildBreakdown({
      projectId: 'p1',
      event: 'click',
      dimension: 'current_url',
      range: RANGE,
      filters: [{ key: 'plan', operator: 'gt', value: 10 }],
    })
    expect(query).toContain(
      "current_url != '' AND JSONExtractFloat(properties, {kf_0:String}) > {vf_0:Float64}",
    )
    expect(query_params).toMatchObject({ kf_0: 'plan', vf_0: 10 })
  })

  it('never interpolates filter key/value raw into the SQL string', () => {
    const { query } = buildBreakdown({
      projectId: 'p1',
      event: 'click',
      dimension: 'current_url',
      range: RANGE,
      filters: [{ key: INJECT, operator: 'exact', value: INJECT }],
    })
    assertNoRawInterpolation(query, [INJECT])
  })

  it('throws on an unknown dimension (no SQL built)', () => {
    expect(() =>
      buildBreakdown({
        projectId: 'p1',
        event: 'e',
        // biome-ignore lint/suspicious/noExplicitAny: testing runtime allowlist rejection
        dimension: 'properties; DROP TABLE events' as any,
        range: RANGE,
      }),
    ).toThrow(/Invalid breakdown dimension/)
  })
})

describe('buildLive', () => {
  it('selects recent events with no range filter by default', () => {
    const { query, query_params } = buildLive({ projectId: INJECT, limit: 25 })
    expect(query).toContain('SELECT uuid, event, distinct_id, timestamp, current_url')
    expect(query).toContain('FROM events FINAL')
    expect(query).toContain('ORDER BY timestamp DESC')
    expect(query).toContain('LIMIT {limit:UInt32}')
    expect(query).not.toContain('BETWEEN')
    expect(query_params).toEqual({ project_id: INJECT, limit: 25 })
    assertNoRawInterpolation(query, [INJECT])
  })

  it('adds a bound range filter when provided', () => {
    const { query, query_params } = buildLive({ projectId: 'p1', range: RANGE })
    expect(query).toContain('timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}')
    expect(query_params.from).toBe(RANGE.from)
    expect(query_params.to).toBe(RANGE.to)
  })
})

describe('buildEventList', () => {
  it('pins project + range and paginates, no filters by default', () => {
    const { query, query_params } = buildEventList({ projectId: INJECT, range: RANGE })
    expect(query).toContain('SELECT uuid, event, distinct_id, timestamp, current_url')
    expect(query).toContain('FROM events FINAL')
    expect(query).toContain('project_id = {project_id:String}')
    expect(query).toContain('timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}')
    expect(query).toContain('ORDER BY timestamp DESC')
    expect(query).toContain('LIMIT {pageSize:UInt32} OFFSET {offset:UInt32}')
    expect(query).not.toContain('ILIKE')
    expect(query).not.toContain('event = {event:String}')
    expect(query_params).toEqual({
      project_id: INJECT,
      from: RANGE.from,
      to: RANGE.to,
      pageSize: 50,
      offset: 0,
    })
    assertNoRawInterpolation(query, [INJECT, RANGE.from, RANGE.to])
  })

  it('computes offset from page/pageSize', () => {
    const { query_params } = buildEventList({
      projectId: 'p1',
      range: RANGE,
      page: 3,
      pageSize: 25,
    })
    expect(query_params.offset).toBe(50)
    expect(query_params.pageSize).toBe(25)
  })

  it('binds exact event + distinct_id filters when provided', () => {
    const { query, query_params } = buildEventList({
      projectId: 'p1',
      range: RANGE,
      event: INJECT,
      distinctId: INJECT,
    })
    expect(query).toContain('event = {event:String}')
    expect(query).toContain('distinct_id = {distinct_id:String}')
    expect(query_params.event).toBe(INJECT)
    expect(query_params.distinct_id).toBe(INJECT)
    assertNoRawInterpolation(query, [INJECT])
  })

  it('binds a wrapped %search% ILIKE across event/distinct_id/current_url', () => {
    const { query, query_params } = buildEventList({
      projectId: 'p1',
      range: RANGE,
      search: INJECT,
    })
    expect(query).toContain('event ILIKE {search:String}')
    expect(query).toContain('distinct_id ILIKE {search:String}')
    expect(query).toContain('current_url ILIKE {search:String}')
    expect(query_params.search).toBe(`%${INJECT}%`)
    assertNoRawInterpolation(query, [INJECT])
  })
})

describe('buildFunnel', () => {
  const asSteps = (events: string[]): FunnelStep[] =>
    events.map((event) => ({ event, filters: [] }))

  it('binds N step params + window and builds windowFunnel SQL', () => {
    const eventNames = ['view', 'add_to_cart', 'checkout']
    const steps = asSteps(eventNames)
    const { query, query_params } = buildFunnel({
      projectId: INJECT,
      steps,
      window: 3600,
      range: RANGE,
    })
    expect(query).toContain('windowFunnel({window:UInt32})(toDateTime(timestamp)')
    expect(query).toContain('event = {s0:String}')
    expect(query).toContain('event = {s1:String}')
    expect(query).toContain('event = {s2:String}')
    expect(query).toContain('event IN ({s0:String}, {s1:String}, {s2:String})')
    expect(query).toContain('GROUP BY level')
    // one param per step + project_id, from, to, window
    expect(query_params).toEqual({
      project_id: INJECT,
      from: RANGE.from,
      to: RANGE.to,
      window: 3600,
      s0: 'view',
      s1: 'add_to_cart',
      s2: 'checkout',
    })
    assertNoRawInterpolation(query, [INJECT, ...eventNames])
  })

  it('throws below 2 steps', () => {
    expect(() =>
      buildFunnel({ projectId: 'p1', steps: asSteps(['only']), window: 60, range: RANGE }),
    ).toThrow(/2\.\.8 steps/)
  })

  it('throws above 8 steps', () => {
    const steps = asSteps(Array.from({ length: 9 }, (_, i) => `e${i}`))
    expect(() => buildFunnel({ projectId: 'p1', steps, window: 60, range: RANGE })).toThrow(
      /2\.\.8 steps/,
    )
  })

  it('applies an exact property filter as a bound JSONExtractString predicate', () => {
    const steps: FunnelStep[] = [
      { event: 'view', filters: [{ key: '$browser', operator: 'exact', value: 'Chrome' }] },
      { event: 'checkout', filters: [] },
    ]
    const { query, query_params } = buildFunnel({
      projectId: 'p1',
      steps,
      window: 3600,
      range: RANGE,
    })
    expect(query).toContain(
      'event = {s0:String} AND JSONExtractString(properties, {k0_0:String}) = {v0_0:String}',
    )
    expect(query_params).toMatchObject({
      k0_0: '$browser',
      v0_0: 'Chrome',
    })
    // the filter key/value are bound params, never interpolated into the SQL string
    assertNoRawInterpolation(query, ['$browser', 'Chrome'])
  })

  it('supports is_set filters without a value param', () => {
    const steps: FunnelStep[] = [
      { event: 'view', filters: [{ key: 'plan', operator: 'is_set', value: null }] },
      { event: 'checkout', filters: [] },
    ]
    const { query, query_params } = buildFunnel({
      projectId: 'p1',
      steps,
      window: 60,
      range: RANGE,
    })
    expect(query).toContain('JSONHas(properties, {k0_0:String}) = 1')
    expect(query_params.k0_0).toBe('plan')
    expect(query_params.v0_0).toBeUndefined()
  })
})

describe('buildFunnelStats', () => {
  it('binds step + filter params and keeps first/last cond unfiltered', () => {
    const steps: FunnelStep[] = [
      { event: 'view', filters: [{ key: 'plan', operator: 'gt', value: 10 }] },
      { event: 'checkout', filters: [] },
    ]
    const { query, query_params } = buildFunnelStats({
      projectId: 'p1',
      steps,
      window: 3600,
      range: RANGE,
      prevFrom: '2026-06-28 00:00:00.000',
    })
    expect(query).toContain('JSONExtractFloat(properties, {k0_0:String}) > {v0_0:Float64}')
    expect(query).toContain('minIf(timestamp, event = {s0:String})')
    expect(query).toContain('maxIf(timestamp, event = {s1:String})')
    expect(query_params).toMatchObject({ k0_0: 'plan', v0_0: 10 })
  })
})

describe('buildFunnelHistory', () => {
  it('binds step + filter params and buckets by first-step day', () => {
    const steps: FunnelStep[] = [
      { event: 'view', filters: [{ key: 'q', operator: 'icontains', value: 'sale' }] },
      { event: 'checkout', filters: [] },
    ]
    const { query, query_params } = buildFunnelHistory({
      projectId: 'p1',
      steps,
      window: 3600,
      range: RANGE,
    })
    expect(query).toContain(
      'positionCaseInsensitive(JSONExtractString(properties, {k0_0:String}), {v0_0:String}) > 0',
    )
    expect(query).toContain('toStartOfDay(first_ts) AS bucket')
    expect(query_params).toMatchObject({ k0_0: 'q', v0_0: 'sale' })
  })
})

describe('buildPropertyValues', () => {
  it('builds a grouped/ordered/limited value-frequency query with bound params', () => {
    const { query, query_params } = buildPropertyValues({
      projectId: INJECT,
      event: 'checkout',
      key: '$browser',
      range: RANGE,
      limit: 10,
    })
    expect(query).toContain('JSONExtractString(properties, {key:String}) AS v')
    expect(query).toContain('uniqExact(uuid) AS c')
    expect(query).not.toContain('FINAL')
    expect(query).toContain('project_id = {project_id:String}')
    expect(query).toContain('event = {event:String}')
    expect(query).toContain("JSONExtractString(properties, {key:String}) != ''")
    expect(query).toContain('GROUP BY v')
    expect(query).toContain('ORDER BY c DESC')
    expect(query).toContain('LIMIT {limit:UInt16}')
    expect(query_params).toEqual({
      project_id: INJECT,
      event: 'checkout',
      key: '$browser',
      from: RANGE.from,
      to: RANGE.to,
      limit: 10,
    })
    assertNoRawInterpolation(query, [INJECT])
  })

  it('defaults limit to 25', () => {
    const { query_params } = buildPropertyValues({
      projectId: 'p1',
      event: 'view',
      key: 'plan',
      range: RANGE,
    })
    expect(query_params.limit).toBe(25)
  })
})

describe('buildTraitValues', () => {
  it('builds a $identify-pinned $set value-frequency query with bound params, no event param', () => {
    const { query, query_params } = buildTraitValues({
      projectId: INJECT,
      key: 'plan',
      range: RANGE,
      limit: 10,
    })
    expect(query).toContain(
      "JSONExtractString(JSONExtractRaw(properties, '$set'), {key:String}) AS v",
    )
    expect(query).toContain("event = '$identify'")
    expect(query).toContain('project_id = {project_id:String}')
    expect(query).toContain(
      "JSONExtractString(JSONExtractRaw(properties, '$set'), {key:String}) != ''",
    )
    expect(query).toContain('GROUP BY v')
    expect(query).toContain('ORDER BY c DESC')
    expect(query).toContain('LIMIT {limit:UInt16}')
    // No `event` bound param — unlike buildPropertyValues, this never takes an event.
    expect(query_params).toEqual({
      project_id: INJECT,
      key: 'plan',
      from: RANGE.from,
      to: RANGE.to,
      limit: 10,
    })
    assertNoRawInterpolation(query, [INJECT])
  })

  it('defaults limit to 25', () => {
    const { query_params } = buildTraitValues({
      projectId: 'p1',
      key: 'plan',
      range: RANGE,
    })
    expect(query_params.limit).toBe(25)
  })
})

describe('buildUsers', () => {
  it('aggregates by resolved person (LEFT JOIN person_distinct_ids) with pagination', () => {
    const { query, query_params } = buildUsers({
      projectId: 'p1',
      range: RANGE,
      page: 2,
      pageSize: 25,
    })
    expect(query).toContain('argMax(events.distinct_id, events.timestamp) AS distinct_id')
    expect(query).toContain('min(events.timestamp) AS firstSeen')
    expect(query).toContain('max(events.timestamp) AS lastSeen')
    expect(query).toContain('uniqExact(events.uuid) AS eventCount')
    expect(query).toContain('argMax(events.current_url, events.timestamp) AS lastUrl')
    expect(query).toContain(
      "argMaxIf(JSONExtractRaw(events.properties, '$set'), events.timestamp, events.event = '$identify') AS traits",
    )
    // LEFT JOIN resolves the current person mapping; grouping is by the resolved
    // person, not raw distinct_id, so merged distinct_ids collapse into one row.
    expect(query).toContain('LEFT JOIN')
    expect(query).toContain('FROM person_distinct_ids')
    expect(query).toContain(
      'ON pdi.project_id = events.project_id AND pdi.distinct_id = events.distinct_id',
    )
    expect(query).toContain("GROUP BY coalesce(nullIf(pdi.person_id, ''), events.distinct_id)")
    expect(query).toContain('LIMIT {pageSize:UInt32} OFFSET {offset:UInt32}')
    expect(query).not.toContain('ILIKE')
    expect(query_params.offset).toBe(25)
    expect(query_params.pageSize).toBe(25)
    // no country/geo column
    expect(query).not.toContain('country')
  })

  it('binds a wrapped %search% ILIKE filter when search given', () => {
    const { query, query_params } = buildUsers({
      projectId: 'p1',
      range: RANGE,
      search: INJECT,
    })
    expect(query).toContain('events.distinct_id ILIKE {search:String}')
    expect(query_params.search).toBe(`%${INJECT}%`)
    assertNoRawInterpolation(query, [INJECT])
  })
})

describe('buildActiveUsers', () => {
  it('counts distinct PERSONS (LEFT JOIN person_distinct_ids) with bound params (never interpolated)', () => {
    const { query, query_params } = buildActiveUsers({
      projectId: INJECT,
      range: RANGE,
      window: 'day',
    })
    expect(query).toContain(
      "uniqExact(coalesce(nullIf(pdi.person_id, ''), events.distinct_id)) AS count",
    )
    expect(query).toContain('LEFT JOIN')
    expect(query).toContain('FROM person_distinct_ids')
    expect(query).toContain(
      'ON pdi.project_id = events.project_id AND pdi.distinct_id = events.distinct_id',
    )
    expect(query).toContain('events.project_id = {project_id:String}')
    expect(query).toContain('events.timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}')
    expect(query_params).toEqual({ project_id: INJECT, from: RANGE.from, to: RANGE.to })
    assertNoRawInterpolation(query, [INJECT, RANGE.from, RANGE.to])
  })

  it('groups by bucket and orders by bucket for every window', () => {
    const { query } = buildActiveUsers({ projectId: 'p1', range: RANGE, window: 'day' })
    expect(query).toContain('GROUP BY bucket')
    expect(query).toContain('ORDER BY bucket')
    expect(query).toContain('AS bucket')
  })

  it.each([
    ['day', 'toStartOfDay'],
    ['week', 'toStartOfWeek'],
    ['month', 'toStartOfMonth'],
  ] as const)('maps window=%s to bucket function %s', (window, bucketFn) => {
    const { query, query_params } = buildActiveUsers({ projectId: INJECT, range: RANGE, window })
    expect(query).toContain(`${bucketFn}(events.timestamp) AS bucket`)
    expect(query_params).toEqual({ project_id: INJECT, from: RANGE.from, to: RANGE.to })
    assertNoRawInterpolation(query, [INJECT, RANGE.from, RANGE.to])
  })
})

// A flag key that would be catastrophic if interpolated raw into SQL.
const FLAG_INJECT = "x' OR '1'='1"

describe('buildFlagUsageSummary', () => {
  it('reads flag_events with real flag_key column, binds flag_key, never interpolates', () => {
    const { query, query_params } = buildFlagUsageSummary({
      projectId: INJECT,
      key: FLAG_INJECT,
      range: RANGE,
    })
    // Reads the dedicated flag_events sink; uniqExact(uuid) with NO FINAL (plain MergeTree).
    expect(query).toContain('FROM flag_events')
    expect(query).toContain('uniqExact(uuid) AS calls')
    expect(query).toContain('uniqExact(distinct_id) AS users')
    expect(query).not.toContain('FINAL')
    expect(query).not.toContain('JSONExtractString')
    expect(query).toContain('project_id = {project_id:String}')
    expect(query).toContain('timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}')
    expect(query).toContain('flag_key = {flag_key:String}')
    expect(query_params).toEqual({
      project_id: INJECT,
      from: RANGE.from,
      to: RANGE.to,
      flag_key: FLAG_INJECT,
    })
    // No `event` param anymore — flag_events holds only flag-call rows.
    expect(query_params).not.toHaveProperty('event')
    // Malicious key + project appear ONLY in params, never in the SQL string.
    assertNoRawInterpolation(query, [INJECT, FLAG_INJECT, RANGE.from, RANGE.to])
  })
})

describe('buildFlagUsageByResponse', () => {
  it('groups by the response column, binds flag_key, never interpolates', () => {
    const { query, query_params } = buildFlagUsageByResponse({
      projectId: 'p1',
      key: FLAG_INJECT,
      range: RANGE,
    })
    expect(query).toContain('FROM flag_events')
    expect(query).toContain('SELECT response, uniqExact(uuid) AS calls')
    expect(query).toContain('uniqExact(distinct_id) AS users')
    expect(query).not.toContain('FINAL')
    expect(query).not.toContain('JSONExtractString')
    expect(query).toContain('GROUP BY response')
    expect(query).toContain('ORDER BY calls DESC')
    expect(query).toContain('flag_key = {flag_key:String}')
    expect(query_params).toEqual({
      project_id: 'p1',
      from: RANGE.from,
      to: RANGE.to,
      flag_key: FLAG_INJECT,
    })
    expect(query_params).not.toHaveProperty('event')
    assertNoRawInterpolation(query, [FLAG_INJECT])
  })
})

describe('buildFlagUsageTrend', () => {
  it('uses toStartOfHour for hour interval', () => {
    const { query, query_params } = buildFlagUsageTrend({
      projectId: 'p1',
      key: 'new-checkout',
      range: RANGE,
      interval: 'hour',
    })
    expect(query).toContain('FROM flag_events')
    expect(query).toContain('toStartOfHour(timestamp) AS bucket')
    expect(query).toContain('uniqExact(uuid) AS calls')
    expect(query).toContain('uniqExact(distinct_id) AS users')
    expect(query).not.toContain('FINAL')
    expect(query).not.toContain('JSONExtractString')
    expect(query).toContain('GROUP BY bucket')
    expect(query).toContain('ORDER BY bucket')
    expect(query_params).not.toHaveProperty('event')
    expect(query_params.flag_key).toBe('new-checkout')
  })

  it('uses toStartOfDay for day interval', () => {
    const { query } = buildFlagUsageTrend({
      projectId: 'p1',
      key: 'k',
      range: RANGE,
      interval: 'day',
    })
    expect(query).toContain('toStartOfDay(timestamp) AS bucket')
  })

  it('binds flag_key and never interpolates a malicious key', () => {
    const { query, query_params } = buildFlagUsageTrend({
      projectId: INJECT,
      key: FLAG_INJECT,
      range: RANGE,
      interval: 'day',
    })
    expect(query).toContain('flag_key = {flag_key:String}')
    expect(query_params.flag_key).toBe(FLAG_INJECT)
    assertNoRawInterpolation(query, [INJECT, FLAG_INJECT])
  })
})

describe('buildFlagUsageTrendByResponse', () => {
  it('groups by bucket + response and uses toStartOfHour for hour interval', () => {
    const { query, query_params } = buildFlagUsageTrendByResponse({
      projectId: 'p1',
      key: 'new-checkout',
      range: RANGE,
      interval: 'hour',
    })
    expect(query).toContain('FROM flag_events')
    expect(query).toContain('toStartOfHour(timestamp) AS bucket')
    expect(query).toContain('SELECT toStartOfHour(timestamp) AS bucket, response')
    expect(query).toContain('uniqExact(uuid) AS calls')
    expect(query).toContain('uniqExact(distinct_id) AS users')
    expect(query).not.toContain('FINAL')
    expect(query).toContain('GROUP BY bucket, response')
    expect(query).toContain('ORDER BY bucket')
    expect(query_params).not.toHaveProperty('event')
    expect(query_params.flag_key).toBe('new-checkout')
  })

  it('uses toStartOfDay for day interval', () => {
    const { query } = buildFlagUsageTrendByResponse({
      projectId: 'p1',
      key: 'k',
      range: RANGE,
      interval: 'day',
    })
    expect(query).toContain('toStartOfDay(timestamp) AS bucket')
    expect(query).toContain('GROUP BY bucket, response')
  })

  it('binds flag_key and never interpolates a malicious key', () => {
    const { query, query_params } = buildFlagUsageTrendByResponse({
      projectId: INJECT,
      key: FLAG_INJECT,
      range: RANGE,
      interval: 'day',
    })
    expect(query).toContain('flag_key = {flag_key:String}')
    expect(query_params.flag_key).toBe(FLAG_INJECT)
    assertNoRawInterpolation(query, [INJECT, FLAG_INJECT])
  })
})

describe('buildFlagTopUsers', () => {
  it('ranks users by eval count with last response, binds flag_key + limit', () => {
    const { query, query_params } = buildFlagTopUsers({
      projectId: 'p1',
      key: 'new-checkout',
      range: RANGE,
      limit: 5,
    })
    expect(query).toContain('FROM flag_events')
    expect(query).toContain('SELECT distinct_id, uniqExact(uuid) AS evals')
    expect(query).toContain('argMax(response, timestamp) AS lastResponse')
    expect(query).not.toContain('FINAL')
    expect(query).toContain('GROUP BY distinct_id')
    expect(query).toContain('ORDER BY evals DESC')
    expect(query).toContain('LIMIT {limit:UInt32}')
    expect(query).toContain('flag_key = {flag_key:String}')
    expect(query_params).toEqual({
      project_id: 'p1',
      from: RANGE.from,
      to: RANGE.to,
      flag_key: 'new-checkout',
      limit: 5,
    })
  })

  it('defaults limit to 10', () => {
    const { query_params } = buildFlagTopUsers({ projectId: 'p1', key: 'k', range: RANGE })
    expect(query_params.limit).toBe(10)
  })

  it('never interpolates a malicious key', () => {
    const { query, query_params } = buildFlagTopUsers({
      projectId: INJECT,
      key: FLAG_INJECT,
      range: RANGE,
    })
    expect(query_params.flag_key).toBe(FLAG_INJECT)
    assertNoRawInterpolation(query, [INJECT, FLAG_INJECT])
  })
})

describe('buildUserDetail', () => {
  it('builds a single-user recent-events query expanded to the resolved person', () => {
    const { query, query_params } = buildUserDetail({
      projectId: 'p1',
      distinctId: INJECT,
      limit: 10,
    })
    expect(query).toContain(
      'SELECT uuid, event, timestamp, current_url, properties, elements_chain_text, distinct_id',
    )
    expect(query).toContain('FROM events FINAL')
    // distinctId expands via person_distinct_ids to every distinct_id sharing its
    // resolved person, falling back to the id itself when unmapped — all bound params.
    expect(query).toContain('distinct_id IN (')
    expect(query).toContain('FROM person_distinct_ids')
    expect(query).toContain('argMax(person_id, created_at)')
    expect(query).toContain('UNION ALL SELECT {distinct_id:String}')
    expect(query).toContain('ORDER BY timestamp DESC')
    expect(query_params).toEqual({ project_id: 'p1', distinct_id: INJECT, limit: 10 })
    assertNoRawInterpolation(query, [INJECT])
  })
})

describe('buildEventById', () => {
  it('fetches one event by bound uuid with the full properties blob', () => {
    const { query, query_params } = buildEventById({ projectId: 'p1', uuid: INJECT })
    expect(query).toContain('uuid = {uuid:String}')
    expect(query).toContain('properties')
    expect(query).toContain('LIMIT 1')
    expect(query_params).toEqual({ project_id: 'p1', uuid: INJECT })
    assertNoRawInterpolation(query, [INJECT])
  })
})

describe('buildDistinctIdGroup', () => {
  it("resolves every distinct_id sharing the input distinct_id's person, with bound params", () => {
    const { query, query_params } = buildDistinctIdGroup({ projectId: INJECT, distinctId: INJECT })
    expect(query).toContain('SELECT DISTINCT distinct_id FROM (')
    expect(query).toContain('FROM person_distinct_ids')
    expect(query).toContain('UNION ALL SELECT {distinct_id:String}')
    expect(query_params).toEqual({ project_id: INJECT, distinct_id: INJECT })
    assertNoRawInterpolation(query, [INJECT])
  })
})

describe('buildUserSummary', () => {
  it('aggregates first/last seen + total events for one PERSON, no range', () => {
    const { query, query_params } = buildUserSummary({ projectId: 'p1', distinctId: INJECT })
    expect(query).toContain('min(timestamp) AS firstSeen')
    expect(query).toContain('max(timestamp) AS lastSeen')
    expect(query).toContain('uniqExact(uuid) AS totalEvents')
    expect(query).toContain("uniqExactIf(session_id, session_id != '') AS totalSessions")
    expect(query).toContain(
      "argMaxIf(JSONExtractRaw(properties, '$set'), timestamp, event = '$identify') AS traits",
    )
    // distinctId expands to its resolved person's every distinct_id (+ itself, unmapped).
    expect(query).toContain('distinct_id IN (')
    expect(query).toContain('FROM person_distinct_ids')
    expect(query).toContain('UNION ALL SELECT {distinct_id:String}')
    expect(query).not.toContain('BETWEEN')
    expect(query_params).toEqual({ project_id: 'p1', distinct_id: INJECT })
    assertNoRawInterpolation(query, [INJECT])
  })
})

describe('buildSessionEvents', () => {
  it('builds a chronological single-session timeline with a bound session_id', () => {
    const { query, query_params } = buildSessionEvents({
      projectId: 'p1',
      sessionId: INJECT,
      limit: 200,
    })
    expect(query).toContain(
      'SELECT uuid, event, timestamp, current_url, properties, elements_chain_text',
    )
    expect(query).toContain('FROM events FINAL')
    expect(query).toContain('session_id = {session_id:String}')
    expect(query).toContain('ORDER BY timestamp ASC')
    expect(query).toContain('LIMIT {limit:UInt32}')
    expect(query_params).toEqual({ project_id: 'p1', session_id: INJECT, limit: 200 })
    assertNoRawInterpolation(query, [INJECT])
  })

  it('defaults limit to 200', () => {
    const { query_params } = buildSessionEvents({ projectId: 'p1', sessionId: 's1' })
    expect(query_params.limit).toBe(200)
  })
})

describe('buildUserFlagsAtTime', () => {
  it('returns latest response per flag_key for the resolved person at/before a bound timestamp', () => {
    const { query, query_params } = buildUserFlagsAtTime({
      projectId: 'p1',
      distinctId: INJECT,
      at: '2026-07-04 14:32:01.000',
    })
    expect(query).toContain('FROM flag_events')
    expect(query).toContain('argMax(response, timestamp) AS response')
    expect(query).toContain('timestamp <= {at:DateTime64(3)}')
    expect(query).toContain('GROUP BY flag_key')
    // Same person_distinct_ids expansion as the events-table single-user builders.
    expect(query).toContain('distinct_id IN (')
    expect(query).toContain('FROM person_distinct_ids')
    expect(query).toContain('UNION ALL SELECT {distinct_id:String}')
    expect(query_params).toEqual({
      project_id: 'p1',
      distinct_id: INJECT,
      at: '2026-07-04 14:32:01.000',
    })
    assertNoRawInterpolation(query, [INJECT])
  })
})

describe('buildUserSessions', () => {
  it('lists sessions for the resolved person, newest first', () => {
    const { query, query_params } = buildUserSessions({
      projectId: 'p1',
      distinctId: INJECT,
      limit: 10,
    })
    expect(query).toContain('session_id AS sessionId')
    expect(query).toContain('min(timestamp) AS startedAt')
    expect(query).toContain('max(timestamp) AS endedAt')
    expect(query).toContain("dateDiff('second', min(timestamp), max(timestamp)) AS durationSec")
    expect(query).toContain('uniqExact(uuid) AS events')
    expect(query).toContain("session_id != ''")
    expect(query).toContain('GROUP BY session_id')
    expect(query).toContain('ORDER BY startedAt DESC')
    // distinctId expands to its resolved person's every distinct_id (+ itself, unmapped).
    expect(query).toContain('distinct_id IN (')
    expect(query).toContain('FROM person_distinct_ids')
    expect(query).toContain('UNION ALL SELECT {distinct_id:String}')
    expect(query_params).toEqual({ project_id: 'p1', distinct_id: INJECT, limit: 10 })
    assertNoRawInterpolation(query, [INJECT])
  })

  it('defaults limit to 50', () => {
    const { query_params } = buildUserSessions({ projectId: 'p1', distinctId: 'd1' })
    expect(query_params.limit).toBe(50)
  })
})

describe('buildUserActivity', () => {
  it('buckets per-day event counts for the resolved person over the range', () => {
    const { query, query_params } = buildUserActivity({
      projectId: 'p1',
      distinctId: INJECT,
      range: RANGE,
    })
    expect(query).toContain('toStartOfDay(timestamp) AS bucket')
    expect(query).toContain('uniqExact(uuid) AS count')
    expect(query).toContain('timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}')
    expect(query).toContain('GROUP BY bucket')
    expect(query).toContain('ORDER BY bucket')
    // distinctId expands to its resolved person's every distinct_id (+ itself, unmapped).
    expect(query).toContain('distinct_id IN (')
    expect(query).toContain('FROM person_distinct_ids')
    expect(query).toContain('UNION ALL SELECT {distinct_id:String}')
    expect(query_params).toEqual({
      project_id: 'p1',
      distinct_id: INJECT,
      from: RANGE.from,
      to: RANGE.to,
    })
    assertNoRawInterpolation(query, [INJECT, RANGE.from, RANGE.to])
  })
})

describe('compileSegmentDefinition', () => {
  it('compiles a trait exact condition with bound params', () => {
    const definition: SegmentDefinition = {
      version: 1,
      root: {
        combinator: 'AND',
        conditions: [{ type: 'trait', key: 'plan', operator: 'exact', value: INJECT }],
      },
    }
    const { having, params } = compileSegmentDefinition(definition)
    expect(having).toContain(
      "JSONExtractString(argMaxIf(JSONExtractRaw(events.properties, '$set'), events.timestamp, events.event = '$identify'), {tk0:String}) = {tv0:String}",
    )
    expect(params).toEqual({ tk0: 'plan', tv0: INJECT })
  })

  it('compiles trait gt/lt using JSONExtractFloat', () => {
    const definition: SegmentDefinition = {
      version: 1,
      root: {
        combinator: 'AND',
        conditions: [{ type: 'trait', key: 'age', operator: 'gt', value: 21 }],
      },
    }
    const { having, params } = compileSegmentDefinition(definition)
    expect(having).toContain('JSONExtractFloat(')
    expect(having).toContain('> {tv0:Float64}')
    expect(params).toEqual({ tk0: 'age', tv0: 21 })
  })

  it('compiles trait is_set using JSONHas, no value param', () => {
    const definition: SegmentDefinition = {
      version: 1,
      root: {
        combinator: 'AND',
        conditions: [{ type: 'trait', key: 'email', operator: 'is_set' }],
      },
    }
    const { having, params } = compileSegmentDefinition(definition)
    expect(having).toContain('JSONHas(')
    expect(having).toContain('{tk0:String}) = 1')
    expect(params).toEqual({ tk0: 'email' })
  })

  it('compiles trait icontains using positionCaseInsensitive', () => {
    const definition: SegmentDefinition = {
      version: 1,
      root: {
        combinator: 'AND',
        conditions: [{ type: 'trait', key: 'email', operator: 'icontains', value: '@acme' }],
      },
    }
    const { having } = compileSegmentDefinition(definition)
    expect(having).toContain('positionCaseInsensitive(')
    expect(having).toContain('> 0')
  })

  it('compiles an event_property condition to max(<predicate>) = 1', () => {
    const definition: SegmentDefinition = {
      version: 1,
      root: {
        combinator: 'AND',
        conditions: [{ type: 'event_property', key: 'plan', operator: 'exact', value: INJECT }],
      },
    }
    const { having, params } = compileSegmentDefinition(definition)
    expect(having).toContain(
      'max(JSONExtractString(events.properties, {ek0:String}) = {ev0:String}) = 1',
    )
    expect(params).toEqual({ ek0: 'plan', ev0: INJECT })
    assertNoRawInterpolation(having, [INJECT])
  })

  it('AND-s an event_property condition with events.event when `event` is set', () => {
    const definition: SegmentDefinition = {
      version: 1,
      root: {
        combinator: 'AND',
        conditions: [
          { type: 'event_property', key: 'amount', operator: 'gt', value: 10, event: 'purchase' },
        ],
      },
    }
    const { having, params } = compileSegmentDefinition(definition)
    expect(having).toContain('AND events.event = {eevt0:String}')
    expect(params).toEqual({ ek0: 'amount', ev0: 10, eevt0: 'purchase' })
  })

  it('compiles a behavioral condition to countIf with a resolved lookback window', () => {
    const before = Date.now()
    const definition: SegmentDefinition = {
      version: 1,
      root: {
        combinator: 'AND',
        conditions: [{ type: 'behavioral', event: 'login', count: 3, days: 7 }],
      },
    }
    const { having, params } = compileSegmentDefinition(definition)
    expect(having).toBe(
      '(countIf(events.event = {bev0:String} AND events.timestamp >= {btw0:DateTime64(3)}) >= {bn0:UInt32})',
    )
    expect(params.bev0).toBe('login')
    expect(params.bn0).toBe(3)
    // The param is a *UTC* wall-clock datetime with no zone suffix (what CH's
    // DateTime64 param parser wants). `new Date(str)` on such a string would
    // parse it as LOCAL time per ES spec, skewing `tw` by the runner's UTC
    // offset — re-append the `Z` to read it back as the UTC instant it is.
    expect(params.btw0).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/)
    const tw = new Date(`${params.btw0 as string}Z`).getTime()
    // tw should be ~7 days before "now" at compile time, within a generous tolerance.
    expect(before - tw).toBeGreaterThan(6.9 * 86_400_000)
    expect(before - tw).toBeLessThan(7.1 * 86_400_000)
  })

  it('combines conditions with AND', () => {
    const definition: SegmentDefinition = {
      version: 1,
      root: {
        combinator: 'AND',
        conditions: [
          { type: 'trait', key: 'plan', operator: 'exact', value: 'pro' },
          { type: 'behavioral', event: 'login', count: 1, days: 30 },
        ],
      },
    }
    const { having } = compileSegmentDefinition(definition)
    expect(having).toMatch(/^\(.* AND .*\)$/)
  })

  it('combines conditions with OR', () => {
    const definition: SegmentDefinition = {
      version: 1,
      root: {
        combinator: 'OR',
        conditions: [
          { type: 'trait', key: 'plan', operator: 'exact', value: 'pro' },
          { type: 'trait', key: 'plan', operator: 'exact', value: 'enterprise' },
        ],
      },
    }
    const { having } = compileSegmentDefinition(definition)
    expect(having).toMatch(/^\(.* OR .*\)$/)
  })

  it('recurses into nested groups', () => {
    const definition: SegmentDefinition = {
      version: 1,
      root: {
        combinator: 'AND',
        conditions: [
          { type: 'trait', key: 'plan', operator: 'exact', value: 'pro' },
          {
            combinator: 'OR',
            conditions: [
              { type: 'behavioral', event: 'login', count: 1, days: 7 },
              { type: 'behavioral', event: 'purchase', count: 1, days: 7 },
            ],
          },
        ],
      },
    }
    const { having, params } = compileSegmentDefinition(definition)
    // Outer AND, inner OR nested inside its own parens.
    expect(having).toMatch(/^\(.*AND \(.*OR.*\)\)$/)
    expect(Object.keys(params)).toEqual(
      expect.arrayContaining(['tk0', 'tv0', 'bev1', 'btw1', 'bn1', 'bev2', 'btw2', 'bn2']),
    )
  })

  it('rejects an unknown definition.version', () => {
    const definition = {
      version: 2,
      root: { combinator: 'AND', conditions: [] },
    } as unknown as SegmentDefinition
    expect(() => compileSegmentDefinition(definition)).toThrow(
      /Unsupported segment definition version/,
    )
  })

  it('never interpolates condition values into the compiled HAVING expression', () => {
    const definition: SegmentDefinition = {
      version: 1,
      root: {
        combinator: 'AND',
        conditions: [
          { type: 'trait', key: INJECT, operator: 'exact', value: INJECT },
          { type: 'event_property', key: INJECT, operator: 'exact', value: INJECT, event: INJECT },
          { type: 'behavioral', event: INJECT, count: 1, days: 1 },
        ],
      },
    }
    const { having } = compileSegmentDefinition(definition)
    assertNoRawInterpolation(having, [INJECT])
  })
})

describe('buildSegmentCount', () => {
  const definition: SegmentDefinition = {
    version: 1,
    root: {
      combinator: 'AND',
      conditions: [{ type: 'trait', key: 'plan', operator: 'exact', value: INJECT }],
    },
  }

  it('builds a grouped/HAVING person-count query reusing PERSON_JOIN', () => {
    const { query, query_params } = buildSegmentCount({ projectId: INJECT, definition })
    expect(query).toContain('SELECT count() AS count FROM (')
    expect(query).toContain(
      "SELECT coalesce(nullIf(pdi.person_id, ''), events.distinct_id) AS person_id",
    )
    expect(query).toContain('LEFT JOIN (')
    expect(query).toContain('events.project_id = {project_id:String}')
    expect(query).toContain('GROUP BY person_id')
    expect(query).toContain('HAVING')
    expect(query_params).toEqual({ project_id: INJECT, tk0: 'plan', tv0: INJECT })
    assertNoRawInterpolation(query, [INJECT])
  })

  it('adds a bounded scan_from filter when scanFrom is provided', () => {
    const { query, query_params } = buildSegmentCount({
      projectId: 'p1',
      definition,
      scanFrom: '2026-04-01T00:00:00Z',
    })
    expect(query).toContain('events.timestamp >= {scan_from:DateTime64(3)}')
    expect(query_params.scan_from).toBe('2026-04-01T00:00:00Z')
  })

  it('omits the scan_from filter when scanFrom is not provided (unbounded, materialize-style)', () => {
    const { query, query_params } = buildSegmentCount({ projectId: 'p1', definition })
    expect(query).not.toContain('scan_from')
    expect(query_params.scan_from).toBeUndefined()
  })
})

describe('buildSegmentMembers', () => {
  const definition: SegmentDefinition = {
    version: 1,
    root: {
      combinator: 'AND',
      conditions: [{ type: 'behavioral', event: 'login', count: 1, days: 7 }],
    },
  }

  it('builds a paginated person_id sample query', () => {
    const { query, query_params } = buildSegmentMembers({
      projectId: INJECT,
      definition,
      page: 2,
      pageSize: 10,
    })
    expect(query).toContain('SELECT person_id FROM (')
    expect(query).toContain('GROUP BY person_id')
    expect(query).toContain('HAVING')
    expect(query).toContain('ORDER BY person_id')
    expect(query).toContain('LIMIT {pageSize:UInt32} OFFSET {offset:UInt32}')
    expect(query_params.pageSize).toBe(10)
    expect(query_params.offset).toBe(10) // (page 2 - 1) * pageSize 10
    assertNoRawInterpolation(query, [INJECT])
  })

  it('defaults to page 1 / pageSize 50 when only page is given', () => {
    const { query_params } = buildSegmentMembers({ projectId: 'p1', definition, page: 1 })
    expect(query_params.pageSize).toBe(50)
    expect(query_params.offset).toBe(0)
  })

  it('defaults to page 1 / pageSize 50 when only pageSize is given', () => {
    const { query_params } = buildSegmentMembers({ projectId: 'p1', definition, pageSize: 50 })
    expect(query_params.pageSize).toBe(50)
    expect(query_params.offset).toBe(0)
  })

  it('omits LIMIT/OFFSET entirely when page and pageSize are both omitted (materialize use case)', () => {
    const { query, query_params } = buildSegmentMembers({ projectId: 'p1', definition })
    expect(query).not.toContain('LIMIT')
    expect(query).not.toContain('OFFSET')
    expect(query_params.pageSize).toBeUndefined()
    expect(query_params.offset).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------

const EXP_BASE = {
  projectId: INJECT,
  flagKey: "flag'; DROP TABLE flag_events; --",
  from: RANGE.from,
  to: RANGE.to,
}

describe('buildExperimentExposures', () => {
  it('groups first-exposure timestamps by variant from flag_events, resolved via PERSON_JOIN', () => {
    const { query, query_params } = buildExperimentExposures(EXP_BASE)
    expect(query).toContain('FROM flag_events AS events')
    expect(query).toContain('LEFT JOIN (')
    expect(query).toContain("coalesce(nullIf(pdi.person_id, ''), events.distinct_id) AS person_id")
    expect(query).toContain('min(events.timestamp) AS first_exposure')
    expect(query).toContain('events.flag_key = {flag_key:String}')
    expect(query).toContain('GROUP BY response, person_id')
    expect(query).toContain(
      'SELECT response, uniqExact(person_id) AS exposed, min(first_exposure) AS firstExposure',
    )
    expect(query_params).toEqual({
      project_id: EXP_BASE.projectId,
      flag_key: EXP_BASE.flagKey,
      from: RANGE.from,
      to: RANGE.to,
    })
    assertNoRawInterpolation(query, [EXP_BASE.projectId, EXP_BASE.flagKey])
  })
})

describe('buildExperimentFunnelByVariant', () => {
  it('reuses funnelStepCondition and gates step events on first-exposure timestamp', () => {
    const steps: FunnelStep[] = [
      { event: 'view', filters: [] },
      { event: 'purchase', filters: [{ key: 'plan', operator: 'exact', value: 'tier9x' }] },
    ]
    const { query, query_params } = buildExperimentFunnelByVariant({
      ...EXP_BASE,
      steps,
      window: 3600,
    })
    expect(query).toContain('windowFunnel({window:UInt32})(toDateTime(events.timestamp)')
    expect(query).toContain('event = {s0:String}')
    expect(query).toContain(
      'event = {s1:String} AND JSONExtractString(properties, {k1_0:String}) = {v1_0:String}',
    )
    expect(query).toContain('events.timestamp > ex.first_exposure')
    expect(query).toContain('GROUP BY response, person_id')
    expect(query).toContain('GROUP BY response, level')
    expect(query_params).toMatchObject({
      project_id: EXP_BASE.projectId,
      flag_key: EXP_BASE.flagKey,
      window: 3600,
      s0: 'view',
      s1: 'purchase',
      k1_0: 'plan',
      v1_0: 'tier9x',
    })
    assertNoRawInterpolation(query, [EXP_BASE.projectId, EXP_BASE.flagKey, 'tier9x'])
  })

  it('throws below 2 steps', () => {
    expect(() =>
      buildExperimentFunnelByVariant({
        ...EXP_BASE,
        steps: [{ event: 'only', filters: [] }],
        window: 60,
      }),
    ).toThrow(/2\.\.8 steps/)
  })

  it('throws above 8 steps', () => {
    const steps: FunnelStep[] = Array.from({ length: 9 }, (_, i) => ({
      event: `e${i}`,
      filters: [],
    }))
    expect(() => buildExperimentFunnelByVariant({ ...EXP_BASE, steps, window: 60 })).toThrow(
      /2\.\.8 steps/,
    )
  })
})

describe('buildExperimentMeanByVariant', () => {
  it('sums a numeric property per exposed person after first exposure, then avg/sum per variant', () => {
    const { query, query_params } = buildExperimentMeanByVariant({
      ...EXP_BASE,
      event: 'checkout',
      property: 'revenue',
    })
    expect(query).toContain(
      'sum(JSONExtractFloat(events.properties, {property:String})) AS user_value',
    )
    expect(query).toContain('events.event = {metric_event:String}')
    expect(query).toContain('events.timestamp > ex.first_exposure')
    expect(query).toContain('avg(user_value) AS mean')
    expect(query).toContain('sum(user_value) AS total')
    expect(query_params).toEqual({
      project_id: EXP_BASE.projectId,
      flag_key: EXP_BASE.flagKey,
      from: RANGE.from,
      to: RANGE.to,
      metric_event: 'checkout',
      property: 'revenue',
    })
    assertNoRawInterpolation(query, [EXP_BASE.projectId, EXP_BASE.flagKey, 'checkout', 'revenue'])
  })
})

describe('buildExperimentRatioByVariant', () => {
  it('counts numerator/denominator events per variant after first exposure', () => {
    const { query, query_params } = buildExperimentRatioByVariant({
      ...EXP_BASE,
      numeratorEvent: 'purchase',
      denominatorEvent: 'view',
    })
    expect(query).toContain('countIf(events.event = {numerator_event:String}) AS numerator')
    expect(query).toContain('countIf(events.event = {denominator_event:String}) AS denominator')
    expect(query).toContain('events.timestamp > ex.first_exposure')
    expect(query).toContain(
      'events.event IN ({numerator_event:String}, {denominator_event:String})',
    )
    expect(query_params).toEqual({
      project_id: EXP_BASE.projectId,
      flag_key: EXP_BASE.flagKey,
      from: RANGE.from,
      to: RANGE.to,
      numerator_event: 'purchase',
      denominator_event: 'view',
    })
    assertNoRawInterpolation(query, [EXP_BASE.projectId, EXP_BASE.flagKey, 'purchase', 'view'])
  })
})

describe('buildExperimentRetentionByVariant', () => {
  it('gates the return event on first_exposure + toIntervalDay(days)', () => {
    const { query, query_params } = buildExperimentRetentionByVariant({
      ...EXP_BASE,
      returnEvent: 'login',
      days: 7,
    })
    expect(query).toContain('ret.timestamp >= ex.first_exposure + toIntervalDay({days:UInt32})')
    expect(query).toContain('events.event = {return_event:String}')
    expect(query).toContain('uniqExact(ex.person_id) AS exposed')
    expect(query).toContain("uniqExactIf(ex.person_id, ret.person_id != '') AS retained")
    expect(query_params).toEqual({
      project_id: EXP_BASE.projectId,
      flag_key: EXP_BASE.flagKey,
      from: RANGE.from,
      to: RANGE.to,
      return_event: 'login',
      days: 7,
    })
    assertNoRawInterpolation(query, [EXP_BASE.projectId, EXP_BASE.flagKey, 'login'])
  })
})

// ---------------------------------------------------------------------------
// Survey results builders
// ---------------------------------------------------------------------------

const SURVEY_BASE = {
  projectId: INJECT,
  surveyId: "s_inject'; DROP TABLE survey_events; --",
  from: RANGE.from,
  to: RANGE.to,
}

describe('buildSurveyResponseRate', () => {
  it('computes uniq(sent)/uniq(shown) over deduped events, guarded, bound only', () => {
    const { query, query_params } = buildSurveyResponseRate(SURVEY_BASE)
    expect(query).toContain("uniqExactIf(uuid, interaction = 'shown') AS shown")
    expect(query).toContain("uniqExactIf(uuid, interaction = 'sent') AS responded")
    expect(query).toContain('if(shown = 0, 0, responded / shown) AS rate')
    expect(query).toContain('FROM survey_events')
    expect(query).not.toContain('FINAL')
    expect(query).toContain('project_id = {project_id:String}')
    expect(query).toContain('survey_id = {survey_id:String}')
    expect(query).toContain('timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}')
    expect(query_params).toEqual({
      project_id: SURVEY_BASE.projectId,
      survey_id: SURVEY_BASE.surveyId,
      from: RANGE.from,
      to: RANGE.to,
    })
    assertNoRawInterpolation(query, [SURVEY_BASE.projectId, SURVEY_BASE.surveyId])
  })
})

describe('buildSurveyScore', () => {
  it('CSAT: top-box percentage + average, question bound', () => {
    const { query, query_params } = buildSurveyScore({
      ...SURVEY_BASE,
      questionId: "q_inject'--",
      scoreType: 'csat',
    })
    expect(query).toContain('countIf(v >= 4) AS topBox')
    expect(query).toContain('avg(v) AS average')
    expect(query).toContain('if(responses = 0, 0, topBox / responses) AS score')
    expect(query).toContain('toFloat64OrNull(any(response)) AS v')
    expect(query).toContain("interaction = 'sent'")
    expect(query).toContain('question_id = {question_id:String}')
    expect(query).toContain('WHERE v IS NOT NULL')
    expect(query_params).toEqual({
      project_id: SURVEY_BASE.projectId,
      survey_id: SURVEY_BASE.surveyId,
      from: RANGE.from,
      to: RANGE.to,
      question_id: "q_inject'--",
    })
    assertNoRawInterpolation(query, [SURVEY_BASE.projectId, SURVEY_BASE.surveyId, "q_inject'--"])
  })

  it('CES: score is the average', () => {
    const { query } = buildSurveyScore({ ...SURVEY_BASE, questionId: 'q1', scoreType: 'ces' })
    expect(query).toContain('avg(v) AS average')
    expect(query).toContain('average AS score')
    expect(query).not.toContain('topBox')
  })

  it('NPS: %promoters - %detractors on 0-10 scale', () => {
    const { query } = buildSurveyScore({ ...SURVEY_BASE, questionId: 'q1', scoreType: 'nps' })
    expect(query).toContain('countIf(v >= 9) AS promoters')
    expect(query).toContain('countIf(v <= 6) AS detractors')
    expect(query).toContain('countIf(v >= 7 AND v <= 8) AS passives')
    expect(query).toContain('(promoters - detractors) / responses * 100) AS score')
  })

  it('throws on an unknown score type (allowlist, no interpolation)', () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: exercising the allowlist guard
      buildSurveyScore({ ...SURVEY_BASE, questionId: 'q1', scoreType: 'evil' as any }),
    ).toThrow(/Invalid survey score type/)
  })
})

describe('buildSurveyQuestionBreakdown', () => {
  it('counts each distinct response, deduped by uuid, bound only', () => {
    const { query, query_params } = buildSurveyQuestionBreakdown({
      ...SURVEY_BASE,
      questionId: 'q1',
    })
    expect(query).toContain('SELECT response AS value, uniqExact(uuid) AS count')
    expect(query).toContain('uniqExact(distinct_id) AS users')
    expect(query).toContain("interaction = 'sent'")
    expect(query).toContain('question_id = {question_id:String}')
    expect(query).toContain("response != ''")
    expect(query).toContain('GROUP BY value')
    expect(query).toContain('ORDER BY count DESC')
    expect(query).not.toContain('FINAL')
    expect(query_params).toEqual({
      project_id: SURVEY_BASE.projectId,
      survey_id: SURVEY_BASE.surveyId,
      from: RANGE.from,
      to: RANGE.to,
      question_id: 'q1',
    })
    assertNoRawInterpolation(query, [SURVEY_BASE.projectId, SURVEY_BASE.surveyId])
  })
})

describe('buildSurveyOpenResponses', () => {
  it('lists raw open answers newest-first, paginated, bound only', () => {
    const { query, query_params } = buildSurveyOpenResponses({
      ...SURVEY_BASE,
      questionId: 'q1',
      limit: 21,
      offset: 40,
    })
    expect(query).toContain("interaction = 'sent'")
    expect(query).toContain('question_id = {question_id:String}')
    expect(query).toContain("response != ''")
    expect(query).toContain('GROUP BY uuid')
    expect(query).toContain('ORDER BY ts DESC')
    expect(query).toContain('LIMIT {limit:UInt32} OFFSET {offset:UInt32}')
    expect(query).not.toContain('FINAL')
    expect(query_params).toEqual({
      project_id: SURVEY_BASE.projectId,
      survey_id: SURVEY_BASE.surveyId,
      from: RANGE.from,
      to: RANGE.to,
      question_id: 'q1',
      limit: 21,
      offset: 40,
    })
    assertNoRawInterpolation(query, [SURVEY_BASE.projectId, SURVEY_BASE.surveyId])
  })
})

describe('buildSurveyRespondent', () => {
  it('lists every answered question for one respondent, distinct_id bound', () => {
    const distinctId = "user'; DROP TABLE survey_events; --"
    const { query, query_params } = buildSurveyRespondent({ ...SURVEY_BASE, distinctId })
    expect(query).toContain("interaction = 'sent'")
    expect(query).toContain('distinct_id = {distinct_id:String}')
    expect(query).toContain("response != ''")
    expect(query).toContain('argMax(response, timestamp) AS resp')
    expect(query).toContain('GROUP BY question_id')
    expect(query).not.toContain('FINAL')
    expect(query_params).toEqual({
      project_id: SURVEY_BASE.projectId,
      survey_id: SURVEY_BASE.surveyId,
      from: RANGE.from,
      to: RANGE.to,
      distinct_id: distinctId,
    })
    assertNoRawInterpolation(query, [SURVEY_BASE.projectId, SURVEY_BASE.surveyId, distinctId])
  })
})

describe('buildSurveyTrend', () => {
  it('buckets shown vs sent by day', () => {
    const { query, query_params } = buildSurveyTrend({ ...SURVEY_BASE, interval: 'day' })
    expect(query).toContain('toStartOfDay(timestamp) AS bucket')
    expect(query).toContain("uniqExactIf(uuid, interaction = 'shown') AS shown")
    expect(query).toContain("uniqExactIf(uuid, interaction = 'sent') AS sent")
    expect(query).toContain('GROUP BY bucket')
    expect(query).toContain('ORDER BY bucket')
    expect(query).not.toContain('FINAL')
    expect(query_params).toEqual({
      project_id: SURVEY_BASE.projectId,
      survey_id: SURVEY_BASE.surveyId,
      from: RANGE.from,
      to: RANGE.to,
    })
  })

  it('buckets by hour when interval is hour', () => {
    const { query } = buildSurveyTrend({ ...SURVEY_BASE, interval: 'hour' })
    expect(query).toContain('toStartOfHour(timestamp) AS bucket')
  })
})

describe('buildSurveySegmentBreakdown', () => {
  it('splits response rate by segment membership, segment bound, no interpolation', () => {
    const segmentId = "seg_inject'; DROP TABLE segment_members; --"
    const { query, query_params } = buildSurveySegmentBreakdown({ ...SURVEY_BASE, segmentId })
    expect(query).toContain("'member'")
    expect(query).toContain("'non_member'")
    expect(query).toContain('segment_id = {segment_id:String}')
    expect(query).toContain('argMax(snapshot_id, computed_at)')
    expect(query).toContain('argMax(person_id, created_at) AS person_id')
    expect(query).toContain("coalesce(nullIf(pdi.person_id, ''), se.distinct_id)")
    expect(query).toContain('if(shown = 0, 0, responded / shown) AS rate')
    expect(query).toContain('GROUP BY member')
    expect(query).not.toContain('FINAL')
    expect(query_params).toEqual({
      project_id: SURVEY_BASE.projectId,
      survey_id: SURVEY_BASE.surveyId,
      from: RANGE.from,
      to: RANGE.to,
      segment_id: segmentId,
    })
    assertNoRawInterpolation(query, [SURVEY_BASE.projectId, SURVEY_BASE.surveyId, segmentId])
  })
})

// ---------------------------------------------------------------------------
// Support results builders
// ---------------------------------------------------------------------------

const SUPPORT_BASE = {
  projectId: INJECT,
  formId: "f_inject'; DROP TABLE support_events; --",
  from: RANGE.from,
  to: RANGE.to,
}

const SUPPORT_PARAMS = {
  project_id: SUPPORT_BASE.projectId,
  form_id: SUPPORT_BASE.formId,
  from: RANGE.from,
  to: RANGE.to,
}

describe('buildSupportDeflectionRate', () => {
  it('computes uniq(deflected)/uniq(opened) over deduped events, guarded, bound only', () => {
    const { query, query_params } = buildSupportDeflectionRate(SUPPORT_BASE)
    expect(query).toContain("uniqExactIf(uuid, interaction = 'opened') AS opened")
    expect(query).toContain("uniqExactIf(uuid, interaction = 'deflected') AS deflected")
    expect(query).toContain("uniqExactIf(uuid, interaction = 'ticket_created') AS ticketed")
    expect(query).toContain('if(opened = 0, 0, deflected / opened) AS rate')
    expect(query).toContain('FROM support_events')
    expect(query).not.toContain('FINAL')
    expect(query).toContain('project_id = {project_id:String}')
    expect(query).toContain('form_id = {form_id:String}')
    expect(query).toContain('timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}')
    expect(query_params).toEqual(SUPPORT_PARAMS)
    assertNoRawInterpolation(query, [SUPPORT_BASE.projectId, SUPPORT_BASE.formId])
  })
})

describe('buildSupportVolumeTrend', () => {
  it('buckets the full funnel by day, bound only', () => {
    const { query, query_params } = buildSupportVolumeTrend({ ...SUPPORT_BASE, interval: 'day' })
    expect(query).toContain('toStartOfDay(timestamp) AS bucket')
    expect(query).toContain("uniqExactIf(uuid, interaction = 'shown') AS shown")
    expect(query).toContain("uniqExactIf(uuid, interaction = 'opened') AS opened")
    expect(query).toContain("uniqExactIf(uuid, interaction = 'deflected') AS deflected")
    expect(query).toContain("uniqExactIf(uuid, interaction = 'ticket_created') AS created")
    expect(query).toContain("uniqExactIf(uuid, interaction = 'ticket_resolved') AS resolved")
    expect(query).toContain('GROUP BY bucket')
    expect(query).toContain('ORDER BY bucket')
    expect(query).not.toContain('FINAL')
    expect(query_params).toEqual(SUPPORT_PARAMS)
    assertNoRawInterpolation(query, [SUPPORT_BASE.projectId, SUPPORT_BASE.formId])
  })

  it('buckets by hour when interval is hour', () => {
    const { query } = buildSupportVolumeTrend({ ...SUPPORT_BASE, interval: 'hour' })
    expect(query).toContain('toStartOfHour(timestamp) AS bucket')
  })
})

describe('buildSupportVolumeByCategory', () => {
  it('counts created tickets per category, deduped by uuid, empties excluded', () => {
    const { query, query_params } = buildSupportVolumeByCategory(SUPPORT_BASE)
    expect(query).toContain('SELECT category AS value, uniqExact(uuid) AS count')
    expect(query).toContain('uniqExact(distinct_id) AS users')
    expect(query).toContain("interaction = 'ticket_created'")
    expect(query).toContain("category != ''")
    expect(query).toContain('GROUP BY value')
    expect(query).toContain('ORDER BY count DESC')
    expect(query).not.toContain('FINAL')
    expect(query_params).toEqual(SUPPORT_PARAMS)
    assertNoRawInterpolation(query, [SUPPORT_BASE.projectId, SUPPORT_BASE.formId])
  })
})

describe('buildSupportCsat', () => {
  it('averages deduped csat scores with a 4-5 top box, NULLs dropped', () => {
    const { query, query_params } = buildSupportCsat(SUPPORT_BASE)
    expect(query).toContain('any(score) AS v')
    expect(query).toContain("interaction = 'csat'")
    expect(query).toContain('GROUP BY uuid')
    expect(query).toContain('WHERE v IS NOT NULL')
    expect(query).toContain('avg(v) AS average')
    expect(query).toContain('countIf(v >= 4) AS topBox')
    expect(query).toContain('if(responses = 0, 0, topBox / responses) AS score')
    expect(query).not.toContain('FINAL')
    expect(query_params).toEqual(SUPPORT_PARAMS)
    assertNoRawInterpolation(query, [SUPPORT_BASE.projectId, SUPPORT_BASE.formId])
  })
})
