// apps/api/trpc/routers — Web Analytics pure ClickHouse query builders.
//
// Sibling to web-analytics.router.ts, mirroring the packages/clickhouse/src/queries.ts
// split: every builder here is PURE (returns { query, query_params }, never executes) and
// the router stays thin — it calls a builder, runs it via `clickhouse.query`, and shapes
// the JSON rows for the client. See events.router.ts + packages/clickhouse/src/queries.ts
// for the precedent this follows (esp. the prev-window comparison pattern at queries.ts
// buildTopPages/buildOverviewEvents).
//
// SAFETY: same rule as packages/clickhouse/src/queries.ts — user-controlled input is
// never interpolated into SQL. Values go through bound params ({name:Type}); the only
// identifier-shaped inputs (`groupBy` column choice for sources/devices) are resolved
// through a hardcoded allowlist map, never through the raw string.

import type { BuiltQuery, DateRange } from '@clickroom/clickhouse'
import { EXCLUDE_SYNTHETIC } from '@clickroom/clickhouse'

/** Shared WHERE fragment pinning tenant + time window. Uses bound params only. */
const PROJECT_AND_RANGE =
  'project_id = {project_id:String} AND timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}'

const PAGEVIEW_EVENT = "event = '$pageview'"

/**
 * Browser-traffic predicate. `session_id` is MATERIALIZED from `properties.$session_id`,
 * which only the browser SDK sets — it is empty for server-side/sdk-node events and for
 * rows written before the column existed (MATERIALIZED columns are never backfilled).
 * Visitors and sessions have to agree on the population, otherwise a distinct_id whose
 * only events are session-less counts as a visitor with zero sessions.
 *
 * This also transparently excludes synthetic server-side rows (flag exposures from
 * endpoint_flags.rs, deploy probes) from every visitor/session count — they set no
 * $session_id. So the visitorsExpr()-based builders need no extra EXCLUDE_SYNTHETIC
 * gate; only buildWebRetention's `scope:'all'` path, which drops WEB_EVENT, does.
 */
const WEB_EVENT = "session_id != ''"

/**
 * Dedup'd `distinct_id -> person_id` map for the tenant. `person_distinct_ids` is a
 * ReplacingMergeTree(created_at) ordered by (project_id, distinct_id), so it can't be read
 * raw — argMax picks the winning row per distinct_id without paying for FINAL.
 */
const PERSON_MAP_CTE = `person_map AS (
      SELECT distinct_id, argMax(person_id, created_at) AS person_id
      FROM person_distinct_ids
      WHERE project_id = {project_id:String}
      GROUP BY distinct_id
    )`

/** Attaches `person_map` to an `events` scan. Pairs with PERSON_MAP_CTE + PERSON_KEY. */
const PERSON_JOIN = 'LEFT JOIN person_map ON person_map.distinct_id = events.distinct_id'

/**
 * Person-resolved visitor identity. `distinct_id` is an anonymous per-browser UUID
 * until `$identify` swaps it for the real user id, while the session id does NOT rotate on
 * identify — so counting distinct_id raw scores one human who logs in as two visitors
 * inside one session, which is how visitors could exceed sessions. Unmapped rows (never
 * identified) fall back to their own distinct_id.
 */
const PERSON_KEY = "coalesce(nullIf(person_map.person_id, ''), events.distinct_id)"

/** Uniq person-resolved visitors, scoped to browser traffic. */
function visitorsExpr(extraCondition?: string): string {
  const condition = extraCondition ? `${WEB_EVENT} AND ${extraCondition}` : WEB_EVENT
  return `uniqExactIf(${PERSON_KEY}, ${condition})`
}

/**
 * Optional host/domain filter fragment (31.5) — appended to a WHERE clause only
 * when `host` is present. Never emits a `host = NULL`/`host = ''` comparison when
 * omitted; the caller simply gets an empty string to splice in. Bound param only,
 * no string interpolation of the value itself.
 */
function hostFilter(host?: string): string {
  return host ? ' AND host = {host:String}' : ''
}

/** Adds `host` to a query_params object only when present, so unfiltered calls
 * never send an unused bound param. */
function hostParam(host?: string): { host?: string } {
  return host ? { host } : {}
}

// ---------------------------------------------------------------------------
// 1. Overview (visitors / pageviews / sessions + prev-window comparison)
// ---------------------------------------------------------------------------

export interface OverviewArgs {
  projectId: string
  range: DateRange
  /**
   * Lower bound of the PREVIOUS comparison window (`YYYY-MM-DD HH:mm:ss.SSS` UTC).
   * The query scans the widened range [prevFrom, range.to] once and splits current
   * vs. previous at `range.from` via conditional aggregation — same pattern as
   * packages/clickhouse/src/queries.ts's buildTopPages/buildOverviewEvents.
   */
  prevFrom: string
  /** Optional host/domain filter (31.5) — omitted entirely when not provided. */
  host?: string
}

/**
 * Visitors (uniq person, browser traffic only), pageviews (uniq uuid on $pageview),
 * and sessions (uniq non-empty session_id) for the range plus the same-length prior
 * period, in ONE scan over [prevFrom, range.to]. Visitors and sessions are both scoped
 * to WEB_EVENT and visitors is person-resolved, so `sessions >= visitors` holds.
 * Row shape: { visitors, prev_visitors, pageviews, prev_pageviews, sessions,
 * prev_sessions } — all strings in JSON; the caller coerces to number.
 */
export function buildWebOverview({ projectId, range, prevFrom, host }: OverviewArgs): BuiltQuery {
  const query = `
    WITH ${PERSON_MAP_CTE}
    SELECT
      ${visitorsExpr('timestamp >= {from:DateTime64(3)}')} AS visitors,
      ${visitorsExpr('timestamp < {from:DateTime64(3)}')} AS prev_visitors,
      uniqExactIf(uuid, ${PAGEVIEW_EVENT} AND timestamp >= {from:DateTime64(3)}) AS pageviews,
      uniqExactIf(uuid, ${PAGEVIEW_EVENT} AND timestamp < {from:DateTime64(3)}) AS prev_pageviews,
      uniqExactIf(session_id, ${WEB_EVENT} AND timestamp >= {from:DateTime64(3)}) AS sessions,
      uniqExactIf(session_id, ${WEB_EVENT} AND timestamp < {from:DateTime64(3)}) AS prev_sessions
    FROM events
    ${PERSON_JOIN}
    WHERE project_id = {project_id:String}
      AND timestamp >= {prev_from:DateTime64(3)}
      AND timestamp <= {to:DateTime64(3)}
      ${hostFilter(host)}
  `
  return {
    query,
    query_params: {
      project_id: projectId,
      from: range.from,
      to: range.to,
      prev_from: prevFrom,
      ...hostParam(host),
    },
  }
}

// ---------------------------------------------------------------------------
// 2. Trend (visitors + pageviews time series)
// ---------------------------------------------------------------------------

export type WebAnalyticsInterval = 'day' | 'week'

export interface TrendArgs {
  projectId: string
  range: DateRange
  interval: WebAnalyticsInterval
  /** Optional host/domain filter (31.5) — omitted entirely when not provided. */
  host?: string
}

/**
 * Visitors + pageviews bucketed by day or week, for the recharts area chart. Visitors
 * uses the same person-resolved, browser-scoped definition as the overview card so the
 * chart and the card can't disagree.
 * Row shape: { bucket: string, visitors: string, pageviews: string }.
 */
export function buildWebTrend({ projectId, range, interval, host }: TrendArgs): BuiltQuery {
  const bucketFn = interval === 'week' ? 'toStartOfWeek' : 'toStartOfDay'
  const query = `
    WITH ${PERSON_MAP_CTE}
    SELECT
      ${bucketFn}(timestamp) AS bucket,
      ${visitorsExpr()} AS visitors,
      uniqExactIf(uuid, ${PAGEVIEW_EVENT}) AS pageviews
    FROM events
    ${PERSON_JOIN}
    WHERE ${PROJECT_AND_RANGE}
      ${hostFilter(host)}
    GROUP BY bucket
    ORDER BY bucket
  `
  return {
    query,
    query_params: {
      project_id: projectId,
      from: range.from,
      to: range.to,
      ...hostParam(host),
    },
  }
}

// ---------------------------------------------------------------------------
// 3. Top paths (visitors / views / bounce rate)
// ---------------------------------------------------------------------------

export interface TopPathsArgs {
  projectId: string
  range: DateRange
  limit?: number
  /** Optional host/domain filter (31.5) — omitted entirely when not provided. */
  host?: string
}

/**
 * Per-path visitors, pageviews, and bounce rate. Bounce = share of that path's
 * sessions that only ever recorded a single pageview across their whole session
 * (not just on this path) — resolved via a `session_id` having-count(*)=1
 * subquery scoped to the same project+range, joined back on session_id.
 * Row shape: { path, visitors, views, bounce_sessions, total_sessions } — the
 * router computes the bounce-rate percentage from the last two.
 */
export function buildWebTopPaths({ projectId, range, limit = 20, host }: TopPathsArgs): BuiltQuery {
  const query = `
    WITH ${PERSON_MAP_CTE},
    single_pageview_sessions AS (
      SELECT session_id
      FROM events
      WHERE ${PROJECT_AND_RANGE} AND ${WEB_EVENT} AND ${PAGEVIEW_EVENT}
        ${hostFilter(host)}
      GROUP BY session_id
      HAVING count() = 1
    )
    SELECT
      path,
      ${visitorsExpr()} AS visitors,
      uniqExactIf(uuid, ${PAGEVIEW_EVENT}) AS views,
      uniqExactIf(session_id, ${WEB_EVENT} AND session_id IN (SELECT session_id FROM single_pageview_sessions)) AS bounce_sessions,
      uniqExactIf(session_id, ${WEB_EVENT}) AS total_sessions
    FROM events
    ${PERSON_JOIN}
    WHERE ${PROJECT_AND_RANGE} AND ${PAGEVIEW_EVENT} AND path != ''
      ${hostFilter(host)}
    GROUP BY path
    ORDER BY views DESC
    LIMIT {limit:UInt32}
  `
  return {
    query,
    query_params: {
      project_id: projectId,
      from: range.from,
      to: range.to,
      limit,
      ...hostParam(host),
    },
  }
}

// ---------------------------------------------------------------------------
// 4. Sources (channel_type / utm_source breakdown)
// ---------------------------------------------------------------------------

export type SourcesGroupBy = 'channel' | 'utm_source'

/** Allowlist: `groupBy` is never interpolated raw — CH can't bind identifiers. */
const SOURCES_COLUMNS: Record<SourcesGroupBy, string> = {
  channel: 'channel_type',
  utm_source: 'utm_source',
}

export interface SourcesArgs {
  projectId: string
  range: DateRange
  groupBy?: SourcesGroupBy
  limit?: number
  /** Optional host/domain filter (31.5) — omitted entirely when not provided. */
  host?: string
}

/**
 * Visitors + pageviews grouped by traffic source (channel_type by default, or
 * utm_source for the drill-down). Row shape: { value, visitors, views }.
 */
export function buildWebSources({
  projectId,
  range,
  groupBy = 'channel',
  limit = 20,
  host,
}: SourcesArgs): BuiltQuery {
  const column = SOURCES_COLUMNS[groupBy]
  const query = `
    WITH ${PERSON_MAP_CTE}
    SELECT
      ${column} AS value,
      ${visitorsExpr()} AS visitors,
      uniqExactIf(uuid, ${PAGEVIEW_EVENT}) AS views
    FROM events
    ${PERSON_JOIN}
    WHERE ${PROJECT_AND_RANGE} AND ${WEB_EVENT}
      ${hostFilter(host)}
    GROUP BY value
    ORDER BY visitors DESC
    LIMIT {limit:UInt32}
  `
  return {
    query,
    query_params: {
      project_id: projectId,
      from: range.from,
      to: range.to,
      limit,
      ...hostParam(host),
    },
  }
}

// ---------------------------------------------------------------------------
// 5. Devices (device_type / browser / os breakdown)
// ---------------------------------------------------------------------------

export type DevicesGroupBy = 'device' | 'browser' | 'os'

/** Allowlist: `groupBy` is never interpolated raw — CH can't bind identifiers. */
const DEVICES_COLUMNS: Record<DevicesGroupBy, string> = {
  device: 'device_type',
  browser: 'browser',
  os: 'os',
}

export interface DevicesArgs {
  projectId: string
  range: DateRange
  groupBy?: DevicesGroupBy
  limit?: number
  /** Optional host/domain filter (31.5) — omitted entirely when not provided. */
  host?: string
}

/**
 * Visitors + pageviews grouped by device dimension (device_type by default, or
 * browser/os). Row shape: { value, visitors, views }.
 */
export function buildWebDevices({
  projectId,
  range,
  groupBy = 'device',
  limit = 20,
  host,
}: DevicesArgs): BuiltQuery {
  const column = DEVICES_COLUMNS[groupBy]
  const query = `
    WITH ${PERSON_MAP_CTE}
    SELECT
      ${column} AS value,
      ${visitorsExpr()} AS visitors,
      uniqExactIf(uuid, ${PAGEVIEW_EVENT}) AS views
    FROM events
    ${PERSON_JOIN}
    WHERE ${PROJECT_AND_RANGE} AND ${WEB_EVENT}
      ${hostFilter(host)}
    GROUP BY value
    ORDER BY visitors DESC
    LIMIT {limit:UInt32}
  `
  return {
    query,
    query_params: {
      project_id: projectId,
      from: range.from,
      to: range.to,
      limit,
      ...hostParam(host),
    },
  }
}

// ---------------------------------------------------------------------------
// 6. Retention (weekly cohort grid)
// ---------------------------------------------------------------------------

export interface RetentionArgs {
  projectId: string
  range: DateRange
  /** Cap on the number of cohort rows returned (most recent first upstream). */
  cohortWeeks?: number
  /** Optional host/domain filter (31.5) — omitted entirely when not provided. */
  host?: string
  /**
   * Which population to retain over.
   *
   * `'web'` (default) restricts to browser traffic (`session_id != ''`) — correct for the
   * Web Analytics page, whose whole frame of reference is site visitors.
   *
   * `'all'` counts every event. The Insights retention chart uses this: a product-analytics
   * cohort should not silently drop server-side (`sdk-node`) users, who never set
   * `$session_id` and would otherwise be invisible — indistinguishable from churn.
   */
  scope?: 'web' | 'all'
}

/**
 * Weekly cohort retention: for each first-seen week (`min(toStartOfWeek(timestamp))`
 * per person, within the range), the count of that cohort's visitors seen again in each
 * subsequent week offset. Cohorts are keyed on the person-resolved id, so a visitor who
 * logs in mid-cohort doesn't churn out of their own cohort and reappear as a new one.
 * Capped to the last `cohortWeeks` cohorts.
 * Row shape: { cohort_week: string, week_offset: string, visitors: string } — the
 * router pivots this into a grid and divides by each cohort's week_offset=0 size
 * to get the retention fraction.
 */
export function buildWebRetention({
  projectId,
  range,
  cohortWeeks = 8,
  host,
  scope = 'web',
}: RetentionArgs): BuiltQuery {
  // `'web'` gates on WEB_EVENT (session_id != ''), which already excludes synthetic
  // server-side rows since they carry no $session_id. `'all'` drops that gate to keep
  // server-side (sdk-node) users in their cohort, so it must exclude synthetic rows
  // (server-side flag exposures + deploy probes) explicitly — otherwise keys like
  // `postdeploy` form their own bogus cohorts.
  const scopeFilter = scope === 'web' ? ` AND ${WEB_EVENT}` : ` AND ${EXCLUDE_SYNTHETIC}`
  const query = `
    WITH ${PERSON_MAP_CTE},
    first_seen AS (
      SELECT ${PERSON_KEY} AS person_key, min(toStartOfWeek(timestamp)) AS cohort_week
      FROM events
      ${PERSON_JOIN}
      WHERE ${PROJECT_AND_RANGE}${scopeFilter}
        ${hostFilter(host)}
      GROUP BY person_key
    ),
    recent_cohorts AS (
      SELECT DISTINCT cohort_week
      FROM first_seen
      ORDER BY cohort_week DESC
      LIMIT {cohort_weeks:UInt32}
    ),
    activity AS (
      SELECT DISTINCT ${PERSON_KEY} AS person_key, toStartOfWeek(timestamp) AS active_week
      FROM events
      ${PERSON_JOIN}
      WHERE ${PROJECT_AND_RANGE}${scopeFilter}
        ${hostFilter(host)}
    )
    SELECT
      first_seen.cohort_week AS cohort_week,
      dateDiff('week', first_seen.cohort_week, activity.active_week) AS week_offset,
      uniqExact(first_seen.person_key) AS visitors
    FROM first_seen
    INNER JOIN activity ON activity.person_key = first_seen.person_key
    WHERE activity.active_week >= first_seen.cohort_week
      AND first_seen.cohort_week IN (SELECT cohort_week FROM recent_cohorts)
    GROUP BY cohort_week, week_offset
    ORDER BY cohort_week DESC, week_offset ASC
  `
  return {
    query,
    query_params: {
      project_id: projectId,
      from: range.from,
      to: range.to,
      // Caps the number of distinct first-seen cohort weeks returned (most
      // recent first) — not a per-row limit.
      cohort_weeks: cohortWeeks,
      ...hostParam(host),
    },
  }
}

// ---------------------------------------------------------------------------
// 7. Active hours (day-of-week x hour-of-day matrix, tenant-local time)
// ---------------------------------------------------------------------------

export interface ActiveHoursArgs {
  projectId: string
  range: DateRange
  /** IANA timezone (Project.timezone) — buckets toDayOfWeek/toHour in tenant-local time. */
  timezone: string
  /** Optional host/domain filter (31.5) — omitted entirely when not provided. */
  host?: string
}

/**
 * Uniq visitors per (day-of-week, hour-of-day) cell, bucketed in the project's
 * timezone via ClickHouse's timezone-arg overloads of toDayOfWeek/toHour rather
 * than UTC. Row shape: { day_of_week: string, hour: string, visitors: string } —
 * day_of_week is 1 (Monday) .. 7 (Sunday) per CH's toDayOfWeek.
 */
export function buildWebActiveHours({
  projectId,
  range,
  timezone,
  host,
}: ActiveHoursArgs): BuiltQuery {
  const query = `
    WITH ${PERSON_MAP_CTE}
    SELECT
      toDayOfWeek(timestamp, 0, {timezone:String}) AS day_of_week,
      toHour(timestamp, {timezone:String}) AS hour,
      ${visitorsExpr()} AS visitors
    FROM events
    ${PERSON_JOIN}
    WHERE ${PROJECT_AND_RANGE}
      ${hostFilter(host)}
    GROUP BY day_of_week, hour
    ORDER BY day_of_week, hour
  `
  return {
    query,
    query_params: {
      project_id: projectId,
      from: range.from,
      to: range.to,
      timezone,
      ...hostParam(host),
    },
  }
}

// ---------------------------------------------------------------------------
// 8. Hosts (distinct host list for the 31.5 filter Select)
// ---------------------------------------------------------------------------

export interface HostsArgs {
  projectId: string
  /** Lower bound (`YYYY-MM-DD HH:mm:ss.SSS` UTC) — bounded lookback, e.g. 90 days. */
  since: string
}

/**
 * Distinct non-empty hosts seen for the project within the lookback window, used
 * to populate the host/domain filter Select. Row shape: { host: string }.
 */
export function buildWebHosts({ projectId, since }: HostsArgs): BuiltQuery {
  const query = `
    SELECT DISTINCT host
    FROM events
    WHERE project_id = {project_id:String}
      AND timestamp >= {since:DateTime64(3)}
      AND host != ''
    ORDER BY host
  `
  return {
    query,
    query_params: {
      project_id: projectId,
      since,
    },
  }
}
