import { describe, expect, it } from 'vitest'
import {
  buildWebActiveHours,
  buildWebDevices,
  buildWebOverview,
  buildWebRetention,
  buildWebSources,
  buildWebTopPaths,
  buildWebTrend,
} from './web-analytics.queries.js'

const projectId = 'proj_1'
const range = { from: '2026-07-07 00:00:00.000', to: '2026-07-14 00:00:00.000' }
const prevFrom = '2026-06-30 00:00:00.000'

/**
 * Every builder that reports "visitors" must person-resolve it and scope it to browser
 * traffic. Counting raw `distinct_id` double-counts a human across `$identify` (the
 * session id doesn't rotate), and an unscoped count picks up server-side events that can
 * never produce a session — together those let visitors exceed sessions.
 */
const visitorBuilders = {
  overview: () => buildWebOverview({ projectId, range, prevFrom }),
  trend: () => buildWebTrend({ projectId, range, interval: 'day' as const }),
  topPaths: () => buildWebTopPaths({ projectId, range }),
  sources: () => buildWebSources({ projectId, range }),
  devices: () => buildWebDevices({ projectId, range }),
  activeHours: () => buildWebActiveHours({ projectId, range, timezone: 'UTC' }),
  retention: () => buildWebRetention({ projectId, range }),
}

describe('web analytics visitor identity', () => {
  for (const [name, build] of Object.entries(visitorBuilders)) {
    it(`${name} joins the dedup'd person map and never counts raw distinct_id`, () => {
      const { query } = build()

      expect(query).toContain('argMax(person_id, created_at)')
      expect(query).toContain('LEFT JOIN person_map ON person_map.distinct_id')
      expect(query).toContain("coalesce(nullIf(person_map.person_id, ''), events.distinct_id)")
      expect(query).not.toMatch(/uniqExact(If)?\(\s*distinct_id/)
    })

    it(`${name} scopes visitors to browser traffic`, () => {
      expect(build().query).toContain("session_id != ''")
    })
  }
})

describe('buildWebOverview', () => {
  it('counts visitors and sessions over the same browser-scoped population', () => {
    const { query, query_params } = buildWebOverview({ projectId, range, prevFrom })

    // Both metrics gated on session_id != '' — the invariant that keeps sessions >= visitors.
    expect(query).toContain(
      "uniqExactIf(coalesce(nullIf(person_map.person_id, ''), events.distinct_id), session_id != '' AND timestamp >= {from:DateTime64(3)}) AS visitors",
    )
    expect(query).toContain(
      "uniqExactIf(session_id, session_id != '' AND timestamp >= {from:DateTime64(3)}) AS sessions",
    )
    expect(query_params).toEqual({
      project_id: projectId,
      from: range.from,
      to: range.to,
      prev_from: prevFrom,
    })
  })

  it('omits the host filter and its bound param when no host is given', () => {
    const { query, query_params } = buildWebOverview({ projectId, range, prevFrom })
    expect(query).not.toContain('host =')
    expect(query_params).not.toHaveProperty('host')
  })

  it('binds host rather than interpolating it', () => {
    const { query, query_params } = buildWebOverview({
      projectId,
      range,
      prevFrom,
      host: 'app.clickroom.co',
    })
    expect(query).toContain('AND host = {host:String}')
    expect(query).not.toContain('app.clickroom.co')
    expect(query_params.host).toBe('app.clickroom.co')
  })
})

describe('buildWebRetention', () => {
  it('keys cohorts on the person, not the distinct_id', () => {
    const { query } = buildWebRetention({ projectId, range })
    expect(query).toContain('INNER JOIN activity ON activity.person_key = first_seen.person_key')
    expect(query).toContain('uniqExact(first_seen.person_key) AS visitors')
  })

  // Web Analytics retains over site visitors, so it must stay browser-scoped.
  it("defaults to the 'web' scope, gating both scans on session_id", () => {
    const { query } = buildWebRetention({ projectId, range })
    // Both the cohort-forming scan (first_seen) and the return-visit scan (activity)
    // must be gated — gating only one would form cohorts from a different population
    // than it measures retention against.
    expect(query.match(/session_id != ''/g)).toHaveLength(2)
  })

  // The Insights retention chart passes scope:'all'. Server-side (sdk-node) users never
  // set $session_id, so the browser gate would erase them from their own cohort — they'd
  // read as churn rather than as the retained users they are.
  it("drops the browser gate under scope:'all' but keeps person resolution", () => {
    const { query } = buildWebRetention({ projectId, range, scope: 'all' })
    expect(query).not.toContain("session_id != ''")
    expect(query).toContain('argMax(person_id, created_at)')
    expect(query).toContain("coalesce(nullIf(person_map.person_id, ''), events.distinct_id)")
    expect(query).toContain('uniqExact(first_seen.person_key) AS visitors')
    // Dropping the browser gate must not readmit synthetic server-side rows: both scans
    // still exclude flag exposures + deploy probes (keys like `postdeploy` else form cohorts).
    expect(query.match(/_clickroom_probe/g)).toHaveLength(2)
    // Regression guard: the exposure exclusion must cover BOTH synthetic
    // sources, not just probes — server-side `$feature_flag_called` rows ($lib '' or
    // 'clickroom-server') must stay out of both the cohort and the return-visit scan.
    expect(
      query.match(
        /JSONExtractString\(events\.properties, '\$lib'\) IN \('', 'clickroom-server'\)/g,
      ),
    ).toHaveLength(2)
  })

  it("still binds the host filter under scope:'all'", () => {
    const { query, query_params } = buildWebRetention({
      projectId,
      range,
      scope: 'all',
      host: 'app.clickroom.co',
    })
    expect(query).toContain('AND host = {host:String}')
    expect(query).not.toContain('app.clickroom.co')
    expect(query_params.host).toBe('app.clickroom.co')
  })
})
