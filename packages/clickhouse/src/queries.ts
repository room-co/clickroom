// @clickroom/clickhouse — pure ClickHouse query builders.
//
// Every builder is PURE: it returns { query, query_params } and does NOT execute.
// Callers run the result via `clickhouse.query(buildX(args))` with format 'JSONEachRow'.
//
// SAFETY: user-controlled input is NEVER interpolated into the SQL string. It is
// always passed through @clickhouse/client bound params ({name:Type} placeholders).
// The ONLY exception is `dimension` in buildBreakdown, which is not a value but an
// identifier (column name) — ClickHouse cannot bind identifiers — so it is resolved
// through a hardcoded allowlist map. Unknown dimensions throw before any SQL is built.
//
// Timestamp filters use `timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}`.
// Every builder pins `project_id = {project_id:String}`.

export interface DateRange {
  /** ISO-8601 UTC string, inclusive lower bound. */
  from: string
  /** ISO-8601 UTC string, inclusive upper bound. */
  to: string
}

export type TrendInterval = 'hour' | 'day'

export type BreakdownDimension =
  | 'elements_chain_text'
  | 'elements_chain_href'
  | 'current_url'
  | 'path'
  | 'referring_domain'

export interface BuiltQuery {
  query: string
  query_params: Record<string, unknown>
}

/**
 * Allowlist of columns that may be used as a breakdown dimension. Keys AND values are
 * hardcoded identifiers — the incoming `dimension` is looked up here, so an attacker
 * cannot inject arbitrary SQL through it. Any value not present throws.
 */
const BREAKDOWN_COLUMNS: Record<BreakdownDimension, string> = {
  elements_chain_text: 'elements_chain_text',
  elements_chain_href: 'elements_chain_href',
  current_url: 'current_url',
  // 'path' and 'referring_domain' are existing MATERIALIZED columns on `events`
  // (009_web_analytics_cols.sql) — added here so the "Top pages"/
  // "Top referrers" insight types can use the generic buildBreakdown builder.
  // No new ClickHouse column/migration: both already exist and are populated.
  path: 'path',
  referring_domain: 'referring_domain',
}

/** Shared WHERE fragment pinning tenant + time window. Uses bound params only. */
const PROJECT_AND_RANGE =
  'project_id = {project_id:String} AND timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}'

// ---------------------------------------------------------------------------
// Identity merge — resolve distinct_id -> person_id
// ---------------------------------------------------------------------------
//
// `person_distinct_ids` is a ReplacingMergeTree(created_at) ORDER BY (project_id,
// distinct_id) — many distinct_ids can map to one person_id, and it only dedups on
// background merge/FINAL, so every read here resolves the CURRENT mapping via
// argMax(person_id, created_at) grouped by (project_id, distinct_id) instead of
// relying on FINAL. distinct_ids that were never identified have no row at all.

/**
 * LEFT JOIN fragment that resolves each `events` row's current person mapping.
 * LEFT (not INNER) because unidentified distinct_ids have no row in
 * `person_distinct_ids` and must still surface as their own person — callers
 * group/count by `coalesce(nullIf(pdi.person_id, ''), events.distinct_id)`.
 *
 * The `nullIf(pdi.person_id, '')` is NOT optional: this client does not set
 * `join_use_nulls`, so ClickHouse's default LEFT JOIN behavior fills unmatched
 * right-side columns with the type's default ('' for String) rather than NULL.
 * Without nullIf, `coalesce(pdi.person_id, ...)` would see '' (not NULL) for every
 * unmapped distinct_id and collapse them all into one bogus '' group.
 */
const PERSON_JOIN = `LEFT JOIN (
      SELECT project_id, distinct_id, argMax(person_id, created_at) AS person_id
      FROM person_distinct_ids
      GROUP BY project_id, distinct_id
    ) pdi ON pdi.project_id = events.project_id AND pdi.distinct_id = events.distinct_id`

/**
 * Excludes non-end-user rows from user/visitor counts. Two sources of synthetic
 * distinct_ids pollute the counts otherwise:
 *   1. Server-side flag exposures (`services/capture/src/flags/endpoint_flags.rs`
 *      `record_exposure`) emit `$feature_flag_called` using the caller-supplied
 *      `distinct_id` — deploy scripts / tests pass arbitrary keys (`postdeploy`,
 *      `u1`, bare emails) that each mint a fake "user". These carry no browser
 *      `$lib` (real browser events are `$lib='clickroom-js'`); the server may also
 *      stamp `$lib='clickroom-server'` explicitly.
 *   2. Deploy healthcheck probes emit `_clickroom_probe`.
 * A real user keeps their other (browser/product) events, so they still count; a
 * pure-synthetic key has only excluded events and drops out entirely.
 */
export const EXCLUDE_SYNTHETIC = `NOT (
      events.event = '_clickroom_probe'
      OR (events.event = '$feature_flag_called'
          AND JSONExtractString(events.properties, '$lib') IN ('', 'clickroom-server'))
    )`

/**
 * Bound-param subquery expanding one `distinct_id` to every distinct_id sharing its
 * resolved person (via the same argMax(person_id, created_at) resolution as
 * PERSON_JOIN), falling back to just the input id itself when it has no merge
 * mapping yet. Used by single-user builders so a `distinctId` input keeps
 * resolving to its person's full merged view. All values stay bound params.
 */
const DISTINCT_ID_GROUP_SUBQUERY = `(
      SELECT distinct_id FROM person_distinct_ids
      WHERE project_id = {project_id:String}
        AND person_id = (
          SELECT argMax(person_id, created_at)
          FROM person_distinct_ids
          WHERE project_id = {project_id:String} AND distinct_id = {distinct_id:String}
          GROUP BY project_id, distinct_id
        )
      UNION ALL SELECT {distinct_id:String}
    )`

export interface DistinctIdGroupArgs {
  projectId: string
  distinctId: string
}

/**
 * Resolves every `distinct_id` currently mapped to the same person as the given
 * `distinctId` (via `DISTINCT_ID_GROUP_SUBQUERY`'s argMax resolution), falling back to
 * just `[distinctId]` when it has no `person_distinct_ids` mapping yet. Used by
 * `purgeUser` so a GDPR purge erases every distinct_id under a person, not
 * just the one passed in. Row shape: { distinct_id: string }.
 */
export function buildDistinctIdGroup({ projectId, distinctId }: DistinctIdGroupArgs): BuiltQuery {
  const query = `SELECT DISTINCT distinct_id FROM ${DISTINCT_ID_GROUP_SUBQUERY}`
  return {
    query,
    query_params: { project_id: projectId, distinct_id: distinctId },
  }
}

// ---------------------------------------------------------------------------
// 1. Top events
// ---------------------------------------------------------------------------

export interface TopEventsArgs {
  projectId: string
  range: DateRange
  limit?: number
}

/**
 * Most frequent events in the range.
 * Pure aggregate over events — uses uniqExact(uuid), NO FINAL (the flag_events-proven
 * pattern): cheaper than a FINAL merge pass and defensively correct
 * against not-yet-merged in-flight redelivery duplicates.
 * Row shape: { event: string, count: string } — CH returns uniqExact() as a string
 * in JSON; the caller coerces to number.
 */
export function buildTopEvents({ projectId, range, limit = 20 }: TopEventsArgs): BuiltQuery {
  const query = `
    SELECT event, uniqExact(uuid) AS count
    FROM events
    WHERE ${PROJECT_AND_RANGE}
    GROUP BY event
    ORDER BY count DESC
    LIMIT {limit:UInt32}
  `
  return {
    query,
    query_params: {
      project_id: projectId,
      from: range.from,
      to: range.to,
      limit,
    },
  }
}

// ---------------------------------------------------------------------------
// 1.B Top pages (per-page sessions/clicks + previous-window comparison)
// ---------------------------------------------------------------------------

export interface TopPagesArgs {
  projectId: string
  range: DateRange
  /**
   * Lower bound of the PREVIOUS comparison window (`YYYY-MM-DD HH:mm:ss.SSS` UTC).
   * The query scans the widened range [prevFrom, range.to] once and splits current
   * vs. previous at `range.from` via conditional aggregation.
   */
  prevFrom: string
  limit?: number
}

/**
 * Top pages by session count with a previous-window comparison, computed in ONE
 * scan over [prevFrom, range.to]. Current window is `timestamp >= range.from`;
 * previous window is `timestamp < range.from` (down to prevFrom).
 * Pure aggregate over events — `clicks`/`prev_clicks` use uniqExactIf(uuid, ...),
 * NO FINAL (flag_events-proven pattern): cheaper than a FINAL merge
 * pass and defensively correct against in-flight redelivery duplicates.
 * `sessions`/`prev_sessions`/`click_sessions` were already uniqExactIf(session_id,
 * ...) and are unaffected by per-event duplication.
 * Row shape: { page, sessions, prev_sessions, clicks, prev_clicks } — all counts
 * are strings in JSON; the caller coerces to number.
 */
export function buildTopPages({
  projectId,
  range,
  prevFrom,
  limit = 10,
}: TopPagesArgs): BuiltQuery {
  const clickPredicate = "JSONExtractString(properties, '$event_type') = 'click'"
  const query = `
    SELECT
      current_url AS page,
      uniqExactIf(session_id, session_id != '' AND timestamp >= {from:DateTime64(3)}) AS sessions,
      uniqExactIf(session_id, session_id != '' AND timestamp < {from:DateTime64(3)}) AS prev_sessions,
      uniqExactIf(uuid, ${clickPredicate} AND timestamp >= {from:DateTime64(3)}) AS clicks,
      uniqExactIf(uuid, ${clickPredicate} AND timestamp < {from:DateTime64(3)}) AS prev_clicks,
      uniqExactIf(session_id, ${clickPredicate} AND session_id != '' AND timestamp >= {from:DateTime64(3)}) AS click_sessions
    FROM events
    WHERE project_id = {project_id:String}
      AND timestamp >= {prev_from:DateTime64(3)}
      AND timestamp <= {to:DateTime64(3)}
      AND current_url != ''
    GROUP BY page
    HAVING sessions > 0
    ORDER BY sessions DESC
    LIMIT {limit:UInt32}
  `
  return {
    query,
    query_params: {
      project_id: projectId,
      from: range.from,
      to: range.to,
      prev_from: prevFrom,
      limit,
    },
  }
}

// ---------------------------------------------------------------------------
// 1.C Overview (stat-card metrics with previous-window comparison)
// ---------------------------------------------------------------------------

export interface OverviewArgs {
  projectId: string
  range: DateRange
  /**
   * Lower bound of the PREVIOUS comparison window (`YYYY-MM-DD HH:mm:ss.SSS` UTC).
   * Same widened-scan-then-split pattern as `buildTopPages`.
   */
  prevFrom: string
}

/**
 * Per-event current + previous counts in ONE scan over [prevFrom, range.to].
 * Pure aggregate over events — uses uniqExactIf(uuid, ...), NO FINAL
 * (flag_events-proven pattern).
 * Row shape: { event, count, prev_count } — counts are strings in JSON; caller coerces.
 */
export function buildOverviewEvents({ projectId, range, prevFrom }: OverviewArgs): BuiltQuery {
  const query = `
    SELECT
      event,
      uniqExactIf(uuid, timestamp >= {from:DateTime64(3)}) AS count,
      uniqExactIf(uuid, timestamp < {from:DateTime64(3)}) AS prev_count
    FROM events
    WHERE project_id = {project_id:String}
      AND timestamp >= {prev_from:DateTime64(3)}
      AND timestamp <= {to:DateTime64(3)}
    GROUP BY event
    ORDER BY count DESC
  `
  return {
    query,
    query_params: {
      project_id: projectId,
      from: range.from,
      to: range.to,
      prev_from: prevFrom,
    },
  }
}

/**
 * Two distinct-user metrics, current + previous, in ONE scan over [prevFrom, range.to]:
 *   - active users: identified persons only (`pdi.person_id != ''` — a real login,
 *     with anon devices stitched to the person via `$identify`). distinct_ids sharing
 *     a merged person_id count as one.
 *   - visitors: anonymous devices (no person mapping) counted individually.
 * Both exclude synthetic/server-side rows (see `EXCLUDE_SYNTHETIC`). An unmatched
 * LEFT-JOIN row has `pdi.person_id = ''` (String default), so `!= ''` ⇔ identified.
 * Row shape: { active_cur, active_prev, visitors_cur, visitors_prev } — counts are
 * strings in JSON; caller coerces.
 */
export function buildOverviewActiveUsers({ projectId, range, prevFrom }: OverviewArgs): BuiltQuery {
  const query = `
    SELECT
      uniqExactIf(pdi.person_id, pdi.person_id != '' AND ${EXCLUDE_SYNTHETIC} AND events.timestamp >= {from:DateTime64(3)}) AS active_cur,
      uniqExactIf(pdi.person_id, pdi.person_id != '' AND ${EXCLUDE_SYNTHETIC} AND events.timestamp < {from:DateTime64(3)}) AS active_prev,
      uniqExactIf(events.distinct_id, pdi.person_id = '' AND ${EXCLUDE_SYNTHETIC} AND events.timestamp >= {from:DateTime64(3)}) AS visitors_cur,
      uniqExactIf(events.distinct_id, pdi.person_id = '' AND ${EXCLUDE_SYNTHETIC} AND events.timestamp < {from:DateTime64(3)}) AS visitors_prev
    FROM events
    ${PERSON_JOIN}
    WHERE events.project_id = {project_id:String}
      AND events.timestamp >= {prev_from:DateTime64(3)}
      AND events.timestamp <= {to:DateTime64(3)}
  `
  return {
    query,
    query_params: {
      project_id: projectId,
      from: range.from,
      to: range.to,
      prev_from: prevFrom,
    },
  }
}

// ---------------------------------------------------------------------------
// 2. Trend (time series for a single event)
// ---------------------------------------------------------------------------

export interface TrendArgs {
  projectId: string
  /** Omit for a total-events trend across every event type. */
  event?: string
  range: DateRange
  interval: TrendInterval
  /** Optional AND-ed event-property filters (same DSL as funnel steps). */
  filters?: FunnelStepFilter[]
}

/**
 * Time series bucketed by hour or day, for one event or (if `event` is
 * omitted) totalled across every event type. Optional `filters` narrow to events
 * whose `properties` match every filter (same DSL/compiler as funnel steps —
 * `propertyFilterCondition`).
 * Pure aggregate over events — uses uniqExact(uuid), NO FINAL (flag_events-proven
 * pattern).
 *
 * `sessions` counts distinct `$session_id` per bucket. The `session_id != ''` gate
 * browser-scopes it: `session_id` is MATERIALIZED from `$session_id` (migration 003)
 * and only the browser SDK sets that property, so server-side (sdk-node) events and
 * rows predating the column are excluded. Counted across *all* event types, unlike
 * Web Analytics' SESSIONS tile which scopes to pageview-ish events — so the two
 * numbers legitimately differ. That is intended, not a bug.
 *
 * Row shape: { bucket: string, count: string, sessions: string } — bucket is a
 * DateTime string.
 */
export function buildTrend({ projectId, event, range, interval, filters }: TrendArgs): BuiltQuery {
  const bucketFn = interval === 'hour' ? 'toStartOfHour' : 'toStartOfDay'
  const eventFilter = event ? 'AND event = {event:String}' : ''
  const query_params: Record<string, unknown> = {
    project_id: projectId,
    from: range.from,
    to: range.to,
    ...(event ? { event } : {}),
  }
  const filterCond = filters?.length ? propertyFilterCondition(filters, 'f', query_params) : ''
  const filterClause = filterCond ? ` AND ${filterCond}` : ''
  const query = `
    SELECT
      ${bucketFn}(timestamp) AS bucket,
      uniqExact(uuid) AS count,
      uniqExactIf(session_id, session_id != '') AS sessions
    FROM events
    WHERE ${PROJECT_AND_RANGE} ${eventFilter}${filterClause}
    GROUP BY bucket
    ORDER BY bucket
  `
  return {
    query,
    query_params,
  }
}

// ---------------------------------------------------------------------------
// 2.5 Org usage — monthly source-of-truth for the quota dashboard
// ---------------------------------------------------------------------------
//
// Both builders aggregate across EVERY project in an org (Redis enforces the
// same per-org metric on the hot path Decisions — ClickHouse is
// the billing source of truth). `projectIds` is always bound as an
// `Array(String)` param, never interpolated, mirroring `buildFunnel`'s
// per-step `event IN (...)` pattern but for a single IN list here.

/** Format a JS Date as `YYYY-MM-DD HH:mm:ss.SSS` (UTC) for CH's DateTime64 param parser. */
function toChDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '')
}

export interface OrgUsageArgs {
  projectIds: string[]
  monthStart: Date
  monthEnd: Date
}

/**
 * Total event volume across every project in an org for the current billing
 * month, `[monthStart, monthEnd)`.: switched from `events FINAL` +
 * `count()` to the flag_events-proven `uniqExact(uuid)`, NO FINAL pattern. The
 * old `FINAL` + `count()` combo silently collapsed distinct same-day/event/
 * distinct_id events (the events table's earlier `ORDER BY` lacked a
 * uuid-derived term) and undercounted real billing usage — this is the direct
 * fix for that bug. `uniqExact(uuid)` is also cheaper than a FINAL merge pass
 * and stays correct even against not-yet-merged in-flight redelivery
 * duplicates.
 * Row shape: { count: string } — CH returns aggregates as strings in JSON;
 * the caller coerces to number.
 */
export function buildOrgEventUsage({ projectIds, monthStart, monthEnd }: OrgUsageArgs): BuiltQuery {
  // WHY created_at (ingest time), not timestamp (client-supplied): the hot-path
  // quota gate (services/capture/src/quota.rs) keys its monthly Redis counter on
  // Utc::now() at ingest, never on the client event timestamp. Filtering on
  // `timestamp` here would let backdated events under-report usage relative to
  // what was actually enforced/blocked, diverging display from enforcement.
  const query = `
    SELECT uniqExact(uuid) AS count
    FROM events
    WHERE project_id IN {project_ids:Array(String)}
      AND created_at >= {month_start:DateTime64(3)}
      AND created_at < {month_end:DateTime64(3)}
  `
  return {
    query,
    query_params: {
      project_ids: projectIds,
      month_start: toChDateTime(monthStart),
      month_end: toChDateTime(monthEnd),
    },
  }
}

/**
 * Total flag-evaluation calls across every project in an org for the current
 * billing month, `[monthStart, monthEnd)`. Reads the dedicated `flag_events`
 * sink (`002_flag_events.sql`) — per the existing no-FINAL convention for that
 * table (plain MergeTree; `uniqExact(uuid)` dedups at-least-once redeliveries
 * instead, see the flag_events builders below for the full rationale).
 * Row shape: { count: string }.
 */
export function buildOrgFlagCallUsage({
  projectIds,
  monthStart,
  monthEnd,
}: OrgUsageArgs): BuiltQuery {
  // WHY created_at (ingest time), not timestamp (client-supplied): the hot-path
  // quota gate (services/capture/src/quota.rs) keys its monthly Redis counter on
  // Utc::now() at ingest, never on the client event timestamp. Filtering on
  // `timestamp` here would let backdated events under-report usage relative to
  // what was actually enforced/blocked, diverging display from enforcement.
  const query = `
    SELECT uniqExact(uuid) AS count
    FROM flag_events
    WHERE project_id IN {project_ids:Array(String)}
      AND created_at >= {month_start:DateTime64(3)}
      AND created_at < {month_end:DateTime64(3)}
  `
  return {
    query,
    query_params: {
      project_ids: projectIds,
      month_start: toChDateTime(monthStart),
      month_end: toChDateTime(monthEnd),
    },
  }
}

/**
 * Day-bucketed event volume across every project in an org, `[monthStart,
 * monthEnd)`. Same tenant/rationale as {@link buildOrgEventUsage} (org-wide
 * `project_id IN (...)`, `created_at` not `timestamp` — ingest time is what
 * the hot-path quota gate counts against) but bucketed by day for the admin
 * usage trend chart instead of collapsed to a single total.
 * Row shape: { bucket: string, count: string }.
 */
export function buildOrgEventUsageTrend({
  projectIds,
  monthStart,
  monthEnd,
}: OrgUsageArgs): BuiltQuery {
  const query = `
    SELECT
      toStartOfDay(created_at) AS bucket,
      uniqExact(uuid) AS count
    FROM events
    WHERE project_id IN {project_ids:Array(String)}
      AND created_at >= {month_start:DateTime64(3)}
      AND created_at < {month_end:DateTime64(3)}
    GROUP BY bucket
    ORDER BY bucket
  `
  return {
    query,
    query_params: {
      project_ids: projectIds,
      month_start: toChDateTime(monthStart),
      month_end: toChDateTime(monthEnd),
    },
  }
}

/**
 * Day-bucketed flag-evaluation volume across every project in an org. See
 * {@link buildOrgEventUsageTrend} — same shape, reads `flag_events` instead
 * (matching {@link buildOrgFlagCallUsage}'s source table).
 * Row shape: { bucket: string, count: string }.
 */
export function buildOrgFlagCallUsageTrend({
  projectIds,
  monthStart,
  monthEnd,
}: OrgUsageArgs): BuiltQuery {
  const query = `
    SELECT
      toStartOfDay(created_at) AS bucket,
      uniqExact(uuid) AS count
    FROM flag_events
    WHERE project_id IN {project_ids:Array(String)}
      AND created_at >= {month_start:DateTime64(3)}
      AND created_at < {month_end:DateTime64(3)}
    GROUP BY bucket
    ORDER BY bucket
  `
  return {
    query,
    query_params: {
      project_ids: projectIds,
      month_start: toChDateTime(monthStart),
      month_end: toChDateTime(monthEnd),
    },
  }
}

// ---------------------------------------------------------------------------
// 3. Breakdown (group one event by a whitelisted dimension column)
// ---------------------------------------------------------------------------

export interface BreakdownArgs {
  projectId: string
  event: string
  dimension: BreakdownDimension
  range: DateRange
  limit?: number
  /** Optional AND-ed event-property filters (same DSL as funnel steps). */
  filters?: FunnelStepFilter[]
}

/**
 * Top values of `dimension` for one event. `dimension` is resolved through
 * BREAKDOWN_COLUMNS (allowlist) and injected as a validated identifier — throws on
 * any value outside the allowlist. Optional `filters` narrow to events whose
 * `properties` match every filter (same DSL/compiler as funnel steps —
 * `propertyFilterCondition`).
 * Pure aggregate over events — uses uniqExact(uuid), NO FINAL (flag_events-proven
 * pattern).
 * Row shape: { value: string, count: string }.
 */
export function buildBreakdown({
  projectId,
  event,
  dimension,
  range,
  limit = 20,
  filters,
}: BreakdownArgs): BuiltQuery {
  const column = BREAKDOWN_COLUMNS[dimension]
  if (!column) {
    throw new Error(`Invalid breakdown dimension: ${dimension}`)
  }
  const query_params: Record<string, unknown> = {
    project_id: projectId,
    from: range.from,
    to: range.to,
    event,
    limit,
  }
  const filterCond = filters?.length ? propertyFilterCondition(filters, 'f', query_params) : ''
  const filterClause = filterCond ? ` AND ${filterCond}` : ''
  const query = `
    SELECT ${column} AS value, uniqExact(uuid) AS count
    FROM events
    WHERE ${PROJECT_AND_RANGE} AND event = {event:String} AND ${column} != ''${filterClause}
    GROUP BY value
    ORDER BY count DESC
    LIMIT {limit:UInt32}
  `
  return {
    query,
    query_params,
  }
}

// ---------------------------------------------------------------------------
// 4. Live (most recent events)
// ---------------------------------------------------------------------------

export interface LiveArgs {
  projectId: string
  limit?: number
  /**
   * Optional time window. When omitted, NO timestamp filter is applied (returns the
   * globally most-recent events for the project). Provide a range to bound the scan.
   */
  range?: DateRange
}

/**
 * Recent events stream for a project, newest first.
 * Row-listing (shows actual event rows) — keeps FINAL: now correct
 * post-fix schema fix, and needed so a genuine at-least-once redelivery
 * duplicate never displays as two rows in the live feed. Do not "optimize" this
 * to uniqExact/no-FINAL — that's for pure count/aggregate builders only.
 * Row shape: { uuid, event, distinct_id, timestamp, current_url } (all strings in JSON).
 */
export function buildLive({ projectId, limit = 50, range }: LiveArgs): BuiltQuery {
  const rangeFilter = range
    ? ' AND timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}'
    : ''
  const query = `
    SELECT uuid, event, distinct_id, timestamp, current_url
    FROM events FINAL
    WHERE project_id = {project_id:String}${rangeFilter}
    ORDER BY timestamp DESC
    LIMIT {limit:UInt32}
  `
  const query_params: Record<string, unknown> = {
    project_id: projectId,
    limit,
  }
  if (range) {
    query_params.from = range.from
    query_params.to = range.to
  }
  return { query, query_params }
}

// ---------------------------------------------------------------------------
// 4b. Event list (server-side Events explorer — paginated, filtered)
// ---------------------------------------------------------------------------

export interface EventListArgs {
  projectId: string
  range: DateRange
  /** Exact event-name filter. */
  event?: string
  /** Exact distinct_id filter. */
  distinctId?: string
  /** Free-text substring match over event / distinct_id / current_url (case-insensitive). */
  search?: string
  page?: number
  pageSize?: number
}

/**
 * Paginated, server-side-filtered event explorer for a project, newest first.
 * Every filter is bound as a param — the range and project_id are always pinned.
 * Unlike `buildLive`, this ALWAYS bounds the scan by the range and supports
 * `event` / `distinctId` / free-text `search` filters plus LIMIT/OFFSET pagination.
 * Row-listing (shows actual event rows) — keeps FINAL: now correct
 * post-fix schema fix, and needed so a genuine at-least-once redelivery
 * duplicate never displays as two rows in the explorer. Do not "optimize" this
 * to uniqExact/no-FINAL — that's for pure count/aggregate builders only.
 * Row shape: { uuid, event, distinct_id, timestamp, current_url } (all strings in JSON).
 */
export function buildEventList({
  projectId,
  range,
  event,
  distinctId,
  search,
  page = 1,
  pageSize = 50,
}: EventListArgs): BuiltQuery {
  const offset = (page - 1) * pageSize
  const query_params: Record<string, unknown> = {
    project_id: projectId,
    from: range.from,
    to: range.to,
    pageSize,
    offset,
  }

  const filters: string[] = [PROJECT_AND_RANGE]
  if (event) {
    filters.push('event = {event:String}')
    query_params.event = event
  }
  if (distinctId) {
    filters.push('distinct_id = {distinct_id:String}')
    query_params.distinct_id = distinctId
  }
  if (search) {
    filters.push(
      '(event ILIKE {search:String} OR distinct_id ILIKE {search:String} OR current_url ILIKE {search:String})',
    )
    query_params.search = `%${search}%`
  }

  const query = `
    SELECT uuid, event, distinct_id, timestamp, current_url, schema_valid, schema_errors
    FROM events FINAL
    WHERE ${filters.join(' AND ')}
    ORDER BY timestamp DESC
    LIMIT {pageSize:UInt32} OFFSET {offset:UInt32}
  `
  return { query, query_params }
}

// ---------------------------------------------------------------------------
// 5. Funnel (windowFunnel per user)
// ---------------------------------------------------------------------------

/** Operator vocabulary for funnel-step property filters (mirrors flags ). */
export type FunnelFilterOperator = 'exact' | 'is_not' | 'icontains' | 'gt' | 'lt' | 'is_set'

export interface FunnelStepFilter {
  key: string
  operator: FunnelFilterOperator
  value?: unknown
}

/** One funnel step: an event name plus AND-ed property predicates. */
export interface FunnelStep {
  event: string
  filters: FunnelStepFilter[]
}

/**
 * Compiles an AND-ed list of event-property filters into a SQL condition fragment
 * against the `properties` JSON column, mutating `qp` with the bound params it
 * introduces (`k{prefix}_{j}`/`v{prefix}_{j}` for each filter's key/value). Values
 * are ALWAYS bound params, never interpolated. Returns `''` when `filters` is empty
 * — callers must skip ANDing in an empty fragment.
 *
 * Shared by funnel steps (`funnelStepCondition`) and any other builder that wants
 * the same property-filter DSL (e.g. `buildTrend`/`buildBreakdown`) — do not
 * duplicate this switch elsewhere; extend it here instead.
 */
export function propertyFilterCondition(
  filters: FunnelStepFilter[],
  prefix: string,
  qp: Record<string, unknown>,
): string {
  const parts: string[] = []
  filters.forEach((f, j) => {
    const kName = `k${prefix}_${j}`
    const vName = `v${prefix}_${j}`
    qp[kName] = f.key
    switch (f.operator) {
      case 'exact':
        qp[vName] = String(f.value ?? '')
        parts.push(`JSONExtractString(properties, {${kName}:String}) = {${vName}:String}`)
        break
      case 'is_not':
        qp[vName] = String(f.value ?? '')
        parts.push(`JSONExtractString(properties, {${kName}:String}) != {${vName}:String}`)
        break
      case 'icontains':
        qp[vName] = String(f.value ?? '')
        parts.push(
          `positionCaseInsensitive(JSONExtractString(properties, {${kName}:String}), {${vName}:String}) > 0`,
        )
        break
      case 'gt':
        qp[vName] = Number(f.value)
        parts.push(`JSONExtractFloat(properties, {${kName}:String}) > {${vName}:Float64}`)
        break
      case 'lt':
        qp[vName] = Number(f.value)
        parts.push(`JSONExtractFloat(properties, {${kName}:String}) < {${vName}:Float64}`)
        break
      case 'is_set':
        parts.push(`JSONHas(properties, {${kName}:String}) = 1`)
        break
    }
  })
  return parts.join(' AND ')
}

/**
 * Builds the windowFunnel condition SQL for one step, mutating `qp` with the
 * bound params it introduces (event name as `s{i}`, filter key/value as
 * `k{i}_{j}`/`v{i}_{j}` via `propertyFilterCondition`). Values are ALWAYS bound
 * params, never interpolated.
 */
function funnelStepCondition(step: FunnelStep, i: number, qp: Record<string, unknown>): string {
  const parts = [`event = {s${i}:String}`]
  qp[`s${i}`] = step.event
  const filterCond = propertyFilterCondition(step.filters, String(i), qp)
  if (filterCond) {
    parts.push(filterCond)
  }
  return parts.join(' AND ')
}

export interface FunnelArgs {
  projectId: string
  /** Ordered steps (event + AND-ed property filters), 2..8 steps. */
  steps: FunnelStep[]
  /** Conversion window in seconds. */
  window: number
  range: DateRange
}

/**
 * Ordered conversion funnel using ClickHouse windowFunnel.
 *
 * Each step name binds to a separate param s0..sN (plus k{i}_{j}/v{i}_{j} for any
 * property filters on that step). The inner query computes, per distinct_id, the
 * furthest step reached (windowFunnel level). The outer query groups by that level.
 *
 * ROW SHAPE (documented for the router): { level: number, reached: number } where
 * `reached` is the number of users whose FURTHEST reached level == `level` (an exact
 * bucket, NOT cumulative). Only rows with level > 0 are returned.
 *
 * The caller MUST do a SUFFIX SUM to obtain "users who reached >= step i": the count
 * for step index i (1-based level) = sum of `reached` over all rows with level >= i.
 * Step 1's reached-count therefore equals total users who entered the funnel.
 *
 * DEVIATION from the pure-count-vs-row-listing split: this is neither
 * bucket. The outer `count()` tallies distinct_id GROUPS (one row per user, from the
 * inner `GROUP BY distinct_id`), not raw event rows, so it's already immune to
 * per-event duplication — swapping to uniqExact(uuid) would be meaningless here
 * (there's no per-row uuid left after the GROUP BY/windowFunnel collapse). No FINAL
 * either: windowFunnel just needs each qualifying event to appear at least once in
 * time order to advance a step; a genuine at-least-once redelivery duplicate (same
 * uuid, same timestamp) is a same-step re-match, not a false step advance, so it
 * doesn't change the computed level. Leave both as-is.
 */
export function buildFunnel({ projectId, steps, window, range }: FunnelArgs): BuiltQuery {
  if (steps.length < 2 || steps.length > 8) {
    throw new Error(`Funnel requires 2..8 steps, got ${steps.length}`)
  }
  const query_params: Record<string, unknown> = {
    project_id: projectId,
    from: range.from,
    to: range.to,
    window,
  }
  const stepConditions: string[] = []
  const stepParams: string[] = []
  steps.forEach((step, i) => {
    stepConditions.push(funnelStepCondition(step, i, query_params))
    stepParams.push(`{s${i}:String}`)
  })

  const query = `
    SELECT level, count() AS reached
    FROM (
      SELECT distinct_id,
        windowFunnel({window:UInt32})(toDateTime(timestamp), ${stepConditions.join(', ')}) AS level
      FROM events
      WHERE ${PROJECT_AND_RANGE} AND event IN (${stepParams.join(', ')})
      GROUP BY distinct_id
    )
    WHERE level > 0
    GROUP BY level
    ORDER BY level
  `
  return { query, query_params }
}

// ---------------------------------------------------------------------------
// 6. Users (aggregated per distinct_id, paginated)
// ---------------------------------------------------------------------------

export interface UsersArgs {
  projectId: string
  range: DateRange
  page?: number
  pageSize?: number
  /** Optional substring match on distinct_id (bound as %search%, case-insensitive). */
  search?: string
}

/**
 * Paginated user list aggregated by PERSON: a LEFT JOIN resolves each
 * event's current distinct_id -> person_id mapping and rows are grouped by
 * `coalesce(nullIf(pdi.person_id, ''), events.distinct_id)`, so distinct_ids merged into the
 * same person (e.g. a pre-signup anon id + its post-signup identified id) collapse
 * into ONE row combining both event counts/first-seen/traits; unidentified
 * distinct_ids (no mapping row) keep appearing as their own person via the
 * coalesce fallback.
 * Row shape: { distinct_id, firstSeen, lastSeen, eventCount, lastUrl, traits }.
 * `distinct_id` is the MOST RECENT id for the person (argMax over events.timestamp,
 * same pattern as `traits`/`lastUrl` below) — callers key rows on it today, so the
 * shape stays the same even though it may now stand in for several merged
 * distinct_ids.
 * `traits` is the raw JSON string of the latest `$identify` event's `$set` across the
 * whole person (`''` if never identified) — callers parse it into person traits
 * (email/name/org_*). No persons table exists; this derives traits from the event
 * stream in the same scan, no extra query.
 *
 * `eventCount` is a pure aggregate over events — uses uniqExact(events.uuid), NO
 * FINAL (flag_events-proven pattern): defensively correct against
 * in-flight redelivery duplicates without paying for a FINAL merge pass.
 *
 * NOTE: the events schema has NO country/geo column, so the contract's `lastCountry`
 * field is intentionally OMITTED here (geo enrichment not implemented).
 */
export function buildUsers({
  projectId,
  range,
  page = 1,
  pageSize = 50,
  search,
}: UsersArgs): BuiltQuery {
  const offset = (page - 1) * pageSize
  const searchFilter = search ? ' AND events.distinct_id ILIKE {search:String}' : ''
  const query = `
    SELECT
      argMax(events.distinct_id, events.timestamp) AS distinct_id,
      min(events.timestamp) AS firstSeen,
      max(events.timestamp) AS lastSeen,
      uniqExact(events.uuid) AS eventCount,
      argMax(events.current_url, events.timestamp) AS lastUrl,
      argMaxIf(JSONExtractRaw(events.properties, '$set'), events.timestamp, events.event = '$identify') AS traits
    FROM events
    ${PERSON_JOIN}
    WHERE events.project_id = {project_id:String}
      AND events.timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}${searchFilter}
    GROUP BY coalesce(nullIf(pdi.person_id, ''), events.distinct_id)
    ORDER BY lastSeen DESC
    LIMIT {pageSize:UInt32} OFFSET {offset:UInt32}
  `
  const query_params: Record<string, unknown> = {
    project_id: projectId,
    from: range.from,
    to: range.to,
    pageSize,
    offset,
  }
  if (search) {
    query_params.search = `%${search}%`
  }
  return { query, query_params }
}

// ---------------------------------------------------------------------------
// 7. Active users (distinct-user count in range)
// ---------------------------------------------------------------------------

export interface ActiveUsersArgs {
  projectId: string
  range: DateRange
  /** Bucket granularity — day → DAU, week → WAU, month → MAU. */
  window: 'day' | 'week' | 'month'
}

/**
 * Active-users series bucketed by `window` (day/week/month), resolved to PERSON:
 * a LEFT JOIN maps each event's distinct_id to its current person_id
 * and each bucket's count is over `coalesce(nullIf(pdi.person_id, ''), distinct_id)`,
 * so distinct_ids merged into one person count once per bucket; unidentified
 * distinct_ids (no mapping row) still count individually via the coalesce fallback.
 *
 * Unlike a plain total-distinct-count, this returns ONE ROW PER BUCKET so a
 * `window:'month'` query over a long range yields calendar-month MAU per month
 * (not a single count collapsed over the whole range) — the caller's DAU/WAU/MAU
 * label is otherwise meaningless against an arbitrary date range.
 * `window` maps to ClickHouse's native bucket functions: day → toStartOfDay,
 * week → toStartOfWeek, month → toStartOfMonth.
 * Row shape: { bucket: string, count: string } — bucket is a DateTime string and
 * CH returns uniqExact() as a string in JSON; the caller coerces to number.
 */
export function buildActiveUsers({ projectId, range, window }: ActiveUsersArgs): BuiltQuery {
  const bucketFn =
    window === 'day' ? 'toStartOfDay' : window === 'week' ? 'toStartOfWeek' : 'toStartOfMonth'
  const query = `
    SELECT ${bucketFn}(events.timestamp) AS bucket,
           uniqExact(coalesce(nullIf(pdi.person_id, ''), events.distinct_id)) AS count
    FROM events
    ${PERSON_JOIN}
    WHERE events.project_id = {project_id:String}
      AND events.timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}
    GROUP BY bucket
    ORDER BY bucket
  `
  return {
    query,
    query_params: {
      project_id: projectId,
      from: range.from,
      to: range.to,
    },
  }
}

/**
 * Exact active-user count for a whole range in ONE scan: identified persons only
 * (`pdi.person_id != ''`), synthetic/server-side rows excluded — matches the
 * dashboard "Active Users" card (`buildOverviewActiveUsers`). Unlike
 * `buildActiveUsers` this is not bucketed, so a user active on multiple days within
 * `range` still counts once.
 */
export function buildActiveUsersTotal({
  projectId,
  range,
}: Pick<ActiveUsersArgs, 'projectId' | 'range'>): BuiltQuery {
  const query = `
    SELECT uniqExactIf(pdi.person_id, pdi.person_id != '' AND ${EXCLUDE_SYNTHETIC}) AS count
    FROM events
    ${PERSON_JOIN}
    WHERE events.project_id = {project_id:String}
      AND events.timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}
  `
  return {
    query,
    query_params: {
      project_id: projectId,
      from: range.from,
      to: range.to,
    },
  }
}

// ---------------------------------------------------------------------------
// 9. Feature-flag usage analytics
// ---------------------------------------------------------------------------
//
// Data source: the dedicated `flag_events` sink (migration 002), populated by a
// materialized view off `$feature_flag_called` inserts. Unlike the `events` RMT,
// `flag_events` has real `flag_key` / `response` columns and a sort key that
// INCLUDES flag_key — so per-flag counts are exact. The flag key is ALWAYS a bound
// param ({flag_key:String}) — never interpolated.
//
// IMPORTANT — these queries do NOT use FINAL (flag_events is a plain MergeTree) and
// count uniqExact(uuid), NOT count(). uniqExact(uuid) dedups at-least-once
// redeliveries (same uuid) while preserving every genuine evaluation. There is no
// `event` filter here — flag_events contains ONLY flag-call rows by construction.

/** Shared WHERE fragment for flag_events: tenant + time window + flag key. All bound. */
const FLAG_PROJECT_RANGE_KEY = `${PROJECT_AND_RANGE} AND flag_key = {flag_key:String}`

/**
 * `FLAG_PROJECT_RANGE_KEY` plus an optional `AND env = {env:String}` fragment.
 * Env is not required — callers that omit it get the pre-existing cross-env
 * aggregate (back-compat with any consumer that hasn't been updated to pass one).
 */
function flagWhere(env: string | undefined): string {
  return env ? `${FLAG_PROJECT_RANGE_KEY} AND env = {env:String}` : FLAG_PROJECT_RANGE_KEY
}

/** Shared param object for flag_events queries, including `env` only when set. */
function flagParams(
  projectId: string,
  key: string,
  range: DateRange,
  env: string | undefined,
): Record<string, unknown> {
  return {
    project_id: projectId,
    from: range.from,
    to: range.to,
    flag_key: key,
    ...(env ? { env } : {}),
  }
}

export interface FlagUsageSummaryArgs {
  projectId: string
  /** The flag key (flag_events.flag_key). Bound as a param, never interpolated. */
  key: string
  range: DateRange
  /** Optional environment filter (flag_events.env). Omit for cross-env aggregate. */
  env?: string
}

/**
 * Total calls + distinct users for one flag over the range.
 * Row shape: { calls: string, users: string } — CH returns aggregates as strings in
 * JSON; the caller coerces to number.
 */
export function buildFlagUsageSummary({
  projectId,
  key,
  range,
  env,
}: FlagUsageSummaryArgs): BuiltQuery {
  const query = `
    SELECT uniqExact(uuid) AS calls, uniqExact(distinct_id) AS users
    FROM flag_events
    WHERE ${flagWhere(env)}
  `
  return { query, query_params: flagParams(projectId, key, range, env) }
}

export interface FlagUsageByResponseArgs {
  projectId: string
  key: string
  range: DateRange
  env?: string
}

/**
 * Calls + distinct users for one flag, split by its stringified response
 * ("true"/"false"/variant key).
 * Row shape: { response: string, calls: string, users: string }.
 */
export function buildFlagUsageByResponse({
  projectId,
  key,
  range,
  env,
}: FlagUsageByResponseArgs): BuiltQuery {
  const query = `
    SELECT response, uniqExact(uuid) AS calls, uniqExact(distinct_id) AS users
    FROM flag_events
    WHERE ${flagWhere(env)}
    GROUP BY response
    ORDER BY calls DESC
  `
  return { query, query_params: flagParams(projectId, key, range, env) }
}

export interface FlagUsageTrendArgs {
  projectId: string
  key: string
  range: DateRange
  interval: TrendInterval
  env?: string
}

/**
 * Time series (bucketed by hour or day) of calls + distinct users for one flag.
 * Row shape: { bucket: string, calls: string, users: string }.
 */
export function buildFlagUsageTrend({
  projectId,
  key,
  range,
  interval,
  env,
}: FlagUsageTrendArgs): BuiltQuery {
  const bucketFn = interval === 'hour' ? 'toStartOfHour' : 'toStartOfDay'
  const query = `
    SELECT ${bucketFn}(timestamp) AS bucket, uniqExact(uuid) AS calls, uniqExact(distinct_id) AS users
    FROM flag_events
    WHERE ${flagWhere(env)}
    GROUP BY bucket
    ORDER BY bucket
  `
  return { query, query_params: flagParams(projectId, key, range, env) }
}

export interface FlagUsageTrendByResponseArgs {
  projectId: string
  key: string
  range: DateRange
  interval: TrendInterval
  env?: string
}

/**
 * Time series (bucketed by hour or day) of calls + distinct users for one flag,
 * SPLIT by response — feeds the true-vs-false stacked/area chart.
 * Row shape: { bucket: string, response: string, calls: string, users: string }.
 */
export function buildFlagUsageTrendByResponse({
  projectId,
  key,
  range,
  interval,
  env,
}: FlagUsageTrendByResponseArgs): BuiltQuery {
  const bucketFn = interval === 'hour' ? 'toStartOfHour' : 'toStartOfDay'
  const query = `
    SELECT ${bucketFn}(timestamp) AS bucket, response, uniqExact(uuid) AS calls, uniqExact(distinct_id) AS users
    FROM flag_events
    WHERE ${flagWhere(env)}
    GROUP BY bucket, response
    ORDER BY bucket
  `
  return { query, query_params: flagParams(projectId, key, range, env) }
}

export interface FlagTopUsersArgs {
  projectId: string
  key: string
  range: DateRange
  limit?: number
  env?: string
}

/**
 * Top users of one flag by evaluation count, with each user's most recent response.
 * Row shape: { distinct_id: string, evals: string, lastResponse: string } — CH
 * returns the aggregate count as a string; the caller coerces to number.
 */
export function buildFlagTopUsers({
  projectId,
  key,
  range,
  limit = 10,
  env,
}: FlagTopUsersArgs): BuiltQuery {
  const query = `
    SELECT distinct_id, uniqExact(uuid) AS evals, argMax(response, timestamp) AS lastResponse
    FROM flag_events
    WHERE ${flagWhere(env)}
    GROUP BY distinct_id
    ORDER BY evals DESC
    LIMIT {limit:UInt32}
  `
  return { query, query_params: { ...flagParams(projectId, key, range, env), limit } }
}

/** Shared WHERE fragment for cross-flag flag_events queries: tenant + time window only. */
const FLAG_PROJECT_RANGE = PROJECT_AND_RANGE

export interface FlagsOverviewSummaryArgs {
  projectId: string
  range: DateRange
}

/**
 * Total calls + distinct users across ALL flags over the range (no flag_key filter).
 * Row shape: { calls: string, users: string }.
 */
export function buildFlagsOverviewSummary({
  projectId,
  range,
}: FlagsOverviewSummaryArgs): BuiltQuery {
  const query = `
    SELECT uniqExact(uuid) AS calls, uniqExact(distinct_id) AS users
    FROM flag_events
    WHERE ${FLAG_PROJECT_RANGE}
  `
  return { query, query_params: { project_id: projectId, from: range.from, to: range.to } }
}

export interface FlagsOverviewByEnvArgs {
  projectId: string
  range: DateRange
}

/**
 * Calls + distinct users across all flags, split by env.
 * Row shape: { env: string, calls: string, users: string }.
 */
export function buildFlagsOverviewByEnv({ projectId, range }: FlagsOverviewByEnvArgs): BuiltQuery {
  const query = `
    SELECT env, uniqExact(uuid) AS calls, uniqExact(distinct_id) AS users
    FROM flag_events
    WHERE ${FLAG_PROJECT_RANGE}
    GROUP BY env
    ORDER BY calls DESC
  `
  return { query, query_params: { project_id: projectId, from: range.from, to: range.to } }
}

export interface FlagsTopFlagsArgs {
  projectId: string
  range: DateRange
  limit?: number
}

/**
 * Top flags by evaluation count across all envs.
 * Row shape: { flag_key: string, calls: string, users: string }.
 */
export function buildFlagsTopFlags({
  projectId,
  range,
  limit = 10,
}: FlagsTopFlagsArgs): BuiltQuery {
  const query = `
    SELECT flag_key, uniqExact(uuid) AS calls, uniqExact(distinct_id) AS users
    FROM flag_events
    WHERE ${FLAG_PROJECT_RANGE}
    GROUP BY flag_key
    ORDER BY calls DESC
    LIMIT {limit:UInt32}
  `
  return { query, query_params: { project_id: projectId, from: range.from, to: range.to, limit } }
}

// ---------------------------------------------------------------------------
// 8. User detail (recent events for a single user)
// ---------------------------------------------------------------------------

export interface UserDetailArgs {
  projectId: string
  distinctId: string
  limit?: number
}

/**
 * Recent event history for one user, newest first. Resolved to PERSON: `distinctId` expands to every distinct_id sharing its resolved
 * person_id (plus itself, if unmapped), so a signup's pre-login anon activity
 * and post-login identified activity both surface here.
 * Row-listing (shows actual event rows) — keeps FINAL: now correct
 * post-fix schema fix, and needed so a genuine at-least-once redelivery
 * duplicate never displays as two rows. Do not "optimize" this to uniqExact/
 * no-FINAL — that's for pure count/aggregate builders only.
 * Row shape: { uuid, event, timestamp, current_url, properties, elements_chain_text, distinct_id }.
 * `properties` is a JSON string column.
 * `distinct_id` here is the EVENT's own stored id (not the input `distinctId`),
 * since the WHERE clause expands to the whole merged person's distinct_ids —
 * this lets callers see which specific id each event was recorded under.
 */
export function buildUserDetail({
  projectId,
  distinctId,
  limit = 100,
}: UserDetailArgs): BuiltQuery {
  const query = `
    SELECT uuid, event, timestamp, current_url, properties, elements_chain_text, distinct_id
    FROM events FINAL
    WHERE project_id = {project_id:String} AND distinct_id IN ${DISTINCT_ID_GROUP_SUBQUERY}
    ORDER BY timestamp DESC
    LIMIT {limit:UInt32}
  `
  return {
    query,
    query_params: {
      project_id: projectId,
      distinct_id: distinctId,
      limit,
    },
  }
}

// ---------------------------------------------------------------------------
// 8b. Session timeline (all events sharing one $session_id)
// ---------------------------------------------------------------------------

export interface SessionEventsArgs {
  projectId: string
  /** The `$session_id` (materialized session_id column). Bound, never interpolated. */
  sessionId: string
  limit?: number
}

/**
 * Chronological event timeline for one session, oldest first (so the detail page
 * can number steps 1..N in visit order). `session_id` is materialized from
 * `properties.$session_id` (migration 003); the events sort key does NOT include
 * it, so this scans the project's partitions filtered by the bound session id —
 * fine at MVP volume, matching how buildUserDetail scans by distinct_id.
 * Row-listing (shows actual event rows) — keeps FINAL: now correct
 * post-fix schema fix, and needed so a genuine at-least-once redelivery
 * duplicate never displays as two rows in the session timeline. Do not
 * "optimize" this to uniqExact/no-FINAL — that's for pure count/aggregate
 * builders only.
 * Row shape: { uuid, event, timestamp, current_url, properties, elements_chain_text }.
 */
export function buildSessionEvents({
  projectId,
  sessionId,
  limit = 200,
}: SessionEventsArgs): BuiltQuery {
  const query = `
    SELECT uuid, event, timestamp, current_url, properties, elements_chain_text
    FROM events FINAL
    WHERE project_id = {project_id:String} AND session_id = {session_id:String}
    ORDER BY timestamp ASC
    LIMIT {limit:UInt32}
  `
  return {
    query,
    query_params: {
      project_id: projectId,
      session_id: sessionId,
      limit,
    },
  }
}

// ---------------------------------------------------------------------------
// 9. Single event by uuid (event detail page)
// ---------------------------------------------------------------------------

export interface EventByIdArgs {
  projectId: string
  uuid: string
}

/**
 * One event by uuid, with the full `properties` JSON blob and materialized
 * helpers. Device/context fields (screen, referrer, lib, …) live inside
 * `properties` — the client extracts them. Row shape:
 * { uuid, event, distinct_id, timestamp, current_url, properties,
 *   elements_chain_text, elements_chain_href, schema_valid, schema_errors }.
 * `LIMIT 1` because ReplacingMergeTree may hold pre-merge duplicates; newest wins.
 * Row-listing (shows one actual event row) — this is filtered to a single exact
 * `uuid`, so `ORDER BY created_at DESC LIMIT 1` already achieves the same
 * genuine-redelivery-dedup effect `FINAL` would (only true
 * at-least-once redeliveries share a uuid, never distinct events), without the
 * cost of a FINAL merge pass over the whole partition. No FINAL keyword needed
 * here — don't add one, and don't swap this to uniqExact either, it belongs to
 * neither of the two general buckets earlier.
 */
export function buildEventById({ projectId, uuid }: EventByIdArgs): BuiltQuery {
  const query = `
    SELECT uuid, event, distinct_id, timestamp, current_url, properties,
           elements_chain_text, elements_chain_href, schema_valid, schema_errors
    FROM events
    WHERE project_id = {project_id:String} AND uuid = {uuid:String}
    ORDER BY created_at DESC
    LIMIT 1
  `
  return {
    query,
    query_params: {
      project_id: projectId,
      uuid,
    },
  }
}

// ---------------------------------------------------------------------------
// 10. Single-user summary (first/last seen + lifetime event count)
// ---------------------------------------------------------------------------

export interface UserSummaryArgs {
  projectId: string
  distinctId: string
}

/**
 * Lifetime summary for one user (no range), resolved to PERSON:
 * `distinctId` expands to every distinct_id sharing its resolved person_id (plus
 * itself, if unmapped), so the summary combines the whole person's history. Row
 * shape: { firstSeen, lastSeen, totalEvents, totalSessions, traits }. Counts are
 * stringified. `totalSessions` = distinct non-empty `$session_id`s (materialized
 * session_id, migration 003); pre-migration events have an empty id and are
 * excluded, so the count reflects only sessions the SDK actually tagged. `traits`
 * is the raw JSON string of the latest `$identify` event's `$set` across the whole
 * person (`''` if never identified) — same derivation as buildUsers.
 * `totalEvents` is a pure aggregate over events — uses uniqExact(uuid), NO FINAL
 * (flag_events-proven pattern).
 */
export function buildUserSummary({ projectId, distinctId }: UserSummaryArgs): BuiltQuery {
  const query = `
    SELECT
      min(timestamp) AS firstSeen,
      max(timestamp) AS lastSeen,
      uniqExact(uuid) AS totalEvents,
      uniqExactIf(session_id, session_id != '') AS totalSessions,
      argMaxIf(JSONExtractRaw(properties, '$set'), timestamp, event = '$identify') AS traits
    FROM events
    WHERE project_id = {project_id:String} AND distinct_id IN ${DISTINCT_ID_GROUP_SUBQUERY}
  `
  return {
    query,
    query_params: {
      project_id: projectId,
      distinct_id: distinctId,
    },
  }
}

// ---------------------------------------------------------------------------
// 11. Flags a user saw at (or before) a point in time
// ---------------------------------------------------------------------------

export interface UserFlagsAtTimeArgs {
  projectId: string
  distinctId: string
  /** Upper bound (inclusive) — the event timestamp. `YYYY-MM-DD HH:mm:ss.SSS` UTC. */
  at: string
}

/**
 * Latest flag response per flag_key for one user as of `at`, from the flag_events
 * sink. Resolved to PERSON: `distinctId` expands to every distinct_id
 * sharing its resolved person_id (plus itself, if unmapped) — the merge mapping is
 * per `project_id`+`distinct_id` regardless of which table reads it, so it applies
 * here the same way as on `events`. Row shape: { flag_key, response }. `response`
 * is the raw evaluated value ('true' | 'false' | variant key). Empty when the
 * person has no exposures ≤ at.
 */
export function buildUserFlagsAtTime({
  projectId,
  distinctId,
  at,
}: UserFlagsAtTimeArgs): BuiltQuery {
  const query = `
    SELECT flag_key, argMax(response, timestamp) AS response
    FROM flag_events
    WHERE project_id = {project_id:String}
      AND distinct_id IN ${DISTINCT_ID_GROUP_SUBQUERY}
      AND timestamp <= {at:DateTime64(3)}
    GROUP BY flag_key
    ORDER BY flag_key
  `
  return {
    query,
    query_params: {
      project_id: projectId,
      distinct_id: distinctId,
      at,
    },
  }
}

// ---------------------------------------------------------------------------
// 12. User sessions (one row per $session_id for a single user)
// ---------------------------------------------------------------------------

export interface UserSessionsArgs {
  projectId: string
  distinctId: string
  limit?: number
}

/**
 * Session list for one user, newest first, resolved to PERSON:
 * `distinctId` expands to every distinct_id sharing its resolved person_id (plus
 * itself, if unmapped), so sessions started under either a pre-merge anon id or a
 * post-merge identified id both appear. A "session" is a distinct non-empty
 * `$session_id` (materialized session_id, migration 003); pre-migration events have
 * an empty id and are excluded. Duration/entry/exit are derived from the session's
 * event timestamps.
 * Row shape: { sessionId, startedAt, endedAt, durationSec, events, pages, entryUrl, exitUrl }
 * — counts/duration are strings in JSON; the caller coerces to number.
 *
 * `events` (the per-session count) is a pure aggregate over events — uses
 * uniqExact(uuid), NO FINAL (flag_events-proven pattern). `pages`
 * was already uniqExact(current_url) and is unaffected by per-event duplication.
 *
 * NOTE: the events schema has NO country/geo column, so the Make prototype's per-session
 * `country` field is intentionally omitted (geo enrichment not implemented).
 */
export function buildUserSessions({
  projectId,
  distinctId,
  limit = 50,
}: UserSessionsArgs): BuiltQuery {
  const query = `
    SELECT
      session_id AS sessionId,
      min(timestamp) AS startedAt,
      max(timestamp) AS endedAt,
      dateDiff('second', min(timestamp), max(timestamp)) AS durationSec,
      uniqExact(uuid) AS events,
      uniqExact(current_url) AS pages,
      argMin(current_url, timestamp) AS entryUrl,
      argMax(current_url, timestamp) AS exitUrl
    FROM events
    WHERE project_id = {project_id:String}
      AND distinct_id IN ${DISTINCT_ID_GROUP_SUBQUERY}
      AND session_id != ''
    GROUP BY session_id
    ORDER BY startedAt DESC
    LIMIT {limit:UInt32}
  `
  return {
    query,
    query_params: {
      project_id: projectId,
      distinct_id: distinctId,
      limit,
    },
  }
}

// ---------------------------------------------------------------------------
// 13. User activity (daily event counts for a single user — sparkline)
// ---------------------------------------------------------------------------

export interface UserActivityArgs {
  projectId: string
  distinctId: string
  range: DateRange
}

/**
 * Per-day event counts for one user over the range — feeds the inline activity
 * sparkline. Mirrors buildTrend but pins distinct_id instead of a single event.
 * Resolved to PERSON: `distinctId` expands to every distinct_id
 * sharing its resolved person_id (plus itself, if unmapped), so the sparkline
 * combines activity across the whole person.
 * Pure aggregate over events — uses uniqExact(uuid), NO FINAL (flag_events-proven
 * pattern).
 * Row shape: { bucket: string, count: string } — bucket is a day DateTime string.
 */
export function buildUserActivity({ projectId, distinctId, range }: UserActivityArgs): BuiltQuery {
  const query = `
    SELECT toStartOfDay(timestamp) AS bucket, uniqExact(uuid) AS count
    FROM events
    WHERE project_id = {project_id:String}
      AND distinct_id IN ${DISTINCT_ID_GROUP_SUBQUERY}
      AND timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}
    GROUP BY bucket
    ORDER BY bucket
  `
  return {
    query,
    query_params: {
      project_id: projectId,
      distinct_id: distinctId,
      from: range.from,
      to: range.to,
    },
  }
}

// ---------------------------------------------------------------------------
// 14. Funnel stats (median time-to-convert + current-vs-previous trend)
// ---------------------------------------------------------------------------

export interface FunnelStatsArgs {
  projectId: string
  steps: FunnelStep[]
  window: number
  range: DateRange
  /** Lower bound of the PREVIOUS comparison window (`YYYY-MM-DD HH:mm:ss.SSS` UTC). */
  prevFrom: string
}

/**
 * Companion to buildFunnel: derives the median entry→conversion time and a
 * current-vs-previous split (for the trend badge) in ONE scan over [prevFrom, to].
 * A user is assigned to the current window when their FIRST-step event lands at
 * `timestamp >= from`, else to the previous window. `convert_ms` is the span from a
 * user's first first-step event to their last last-step event and is only meaningful
 * for full converters (level == step count).
 * Row shape (single row): { medianMs, enteredCur, convertedCur, enteredPrev, convertedPrev }
 * — all strings in JSON; the caller coerces to number.
 *
 * DEVIATION (same reasoning as buildFunnel): the outer countIf()s
 * tally distinct_id GROUPS (one row per user from the inner `GROUP BY
 * distinct_id`), not raw event rows, so they're already immune to per-event
 * duplication — uniqExact(uuid) would be meaningless post-GROUP BY. `convert_ms`
 * is derived from minIf/maxIf(timestamp, ...), also unaffected by a duplicate row
 * at the same timestamp. No FINAL: windowFunnel only needs each qualifying event
 * to appear at least once in order; a genuine redelivery duplicate is a same-step
 * re-match, not a false advance. Leave both as-is.
 */
export function buildFunnelStats({
  projectId,
  steps,
  window,
  range,
  prevFrom,
}: FunnelStatsArgs): BuiltQuery {
  if (steps.length < 2 || steps.length > 8) {
    throw new Error(`Funnel requires 2..8 steps, got ${steps.length}`)
  }
  const query_params: Record<string, unknown> = {
    project_id: projectId,
    from: range.from,
    to: range.to,
    prev_from: prevFrom,
    window,
    step_count: steps.length,
  }
  const stepConditions: string[] = []
  const stepParams: string[] = []
  steps.forEach((step, i) => {
    stepConditions.push(funnelStepCondition(step, i, query_params))
    stepParams.push(`{s${i}:String}`)
  })
  const firstCond = `event = {s0:String}`
  const lastCond = `event = {s${steps.length - 1}:String}`

  const query = `
    SELECT
      quantileIf(0.5)(convert_ms, level >= {step_count:UInt8} AND convert_ms > 0) AS medianMs,
      countIf(is_current) AS enteredCur,
      countIf(is_current AND level >= {step_count:UInt8}) AS convertedCur,
      countIf(NOT is_current) AS enteredPrev,
      countIf(NOT is_current AND level >= {step_count:UInt8}) AS convertedPrev
    FROM (
      SELECT distinct_id,
        windowFunnel({window:UInt32})(toDateTime(timestamp), ${stepConditions.join(', ')}) AS level,
        dateDiff('millisecond', minIf(timestamp, ${firstCond}), maxIf(timestamp, ${lastCond})) AS convert_ms,
        minIf(timestamp, ${firstCond}) >= {from:DateTime64(3)} AS is_current
      FROM events
      WHERE project_id = {project_id:String}
        AND timestamp >= {prev_from:DateTime64(3)}
        AND timestamp <= {to:DateTime64(3)}
        AND event IN (${stepParams.join(', ')})
      GROUP BY distinct_id
    )
    WHERE level > 0
  `
  return { query, query_params }
}

// ---------------------------------------------------------------------------
// 15. Funnel history (daily conversion rate over time)
// ---------------------------------------------------------------------------

export interface FunnelHistoryArgs {
  projectId: string
  steps: FunnelStep[]
  window: number
  range: DateRange
}

/**
 * Daily conversion rate for a funnel — feeds the "conversion over time" area chart.
 * Users are bucketed by the day of their FIRST-step event; each bucket reports how
 * many entered and how many fully converted (windowFunnel level == step count).
 * Row shape: { bucket, entered, converted } — counts are strings in JSON; the caller
 * coerces to number and computes the rate.
 *
 * DEVIATION (same reasoning as buildFunnel/buildFunnelStats): `entered`/
 * `converted` are count()s over distinct_id GROUPS (one row per user from the
 * inner `GROUP BY distinct_id`), not raw event rows — already immune to per-event
 * duplication, so uniqExact(uuid) doesn't apply post-GROUP BY. No FINAL: windowFunnel
 * only needs each qualifying event to appear at least once in order; a genuine
 * redelivery duplicate is a same-step re-match, not a false advance. Leave as-is.
 */
export function buildFunnelHistory({
  projectId,
  steps,
  window,
  range,
}: FunnelHistoryArgs): BuiltQuery {
  if (steps.length < 2 || steps.length > 8) {
    throw new Error(`Funnel requires 2..8 steps, got ${steps.length}`)
  }
  const query_params: Record<string, unknown> = {
    project_id: projectId,
    from: range.from,
    to: range.to,
    window,
    step_count: steps.length,
  }
  const stepConditions: string[] = []
  const stepParams: string[] = []
  steps.forEach((step, i) => {
    stepConditions.push(funnelStepCondition(step, i, query_params))
    stepParams.push(`{s${i}:String}`)
  })
  const firstCond = `event = {s0:String}`

  const query = `
    SELECT
      toStartOfDay(first_ts) AS bucket,
      count() AS entered,
      countIf(level >= {step_count:UInt8}) AS converted
    FROM (
      SELECT distinct_id,
        windowFunnel({window:UInt32})(toDateTime(timestamp), ${stepConditions.join(', ')}) AS level,
        minIf(timestamp, ${firstCond}) AS first_ts
      FROM events
      WHERE ${PROJECT_AND_RANGE} AND event IN (${stepParams.join(', ')})
      GROUP BY distinct_id
    )
    WHERE level > 0
    GROUP BY bucket
    ORDER BY bucket
  `
  return { query, query_params }
}

// ---------------------------------------------------------------------------
// 16. Property-value autocomplete (for funnel-builder filter value inputs)
// ---------------------------------------------------------------------------

export interface PropertyValuesArgs {
  projectId: string
  event: string
  key: string
  range: DateRange
  limit?: number
}

/**
 * Most common values seen for one event property, for autocomplete in the
 * funnel-builder filter row. Pure aggregate over events — uses uniqExact(uuid),
 * NO FINAL (flag_events-proven pattern).
 * Row shape: { v: string, c: string } — `c` is uniqExact() as a string in JSON;
 * the caller only needs `v`.
 */
export function buildPropertyValues({
  projectId,
  event,
  key,
  range,
  limit = 25,
}: PropertyValuesArgs): BuiltQuery {
  const query = `
    SELECT JSONExtractString(properties, {key:String}) AS v, uniqExact(uuid) AS c
    FROM events
    WHERE project_id = {project_id:String} AND event = {event:String}
      AND timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}
      AND JSONExtractString(properties, {key:String}) != ''
    GROUP BY v
    ORDER BY c DESC
    LIMIT {limit:UInt16}
  `
  return {
    query,
    query_params: {
      project_id: projectId,
      event,
      key,
      from: range.from,
      to: range.to,
      limit,
    },
  }
}

export interface TraitValuesArgs {
  projectId: string
  key: string
  range: DateRange
  limit?: number
}

/**
 * Most common values seen for one person trait ($identify $set property), for
 * autocomplete in the segment-builder trait-condition value input. Unlike
 * `buildPropertyValues`, this has no `event` filter param — it's pinned to
 * `event = '$identify'` (a low-volume system event, cheaper to scan than the
 * high-volume events `buildPropertyValues` already scans), since traits only
 * ever arrive on `$identify` events. Same 30d-range + LIMIT 25 guardrails as
 * `buildPropertyValues`. Row shape: { v: string, c: string }.
 */
export function buildTraitValues({
  projectId,
  key,
  range,
  limit = 25,
}: TraitValuesArgs): BuiltQuery {
  const query = `
    SELECT JSONExtractString(JSONExtractRaw(properties, '$set'), {key:String}) AS v, count() AS c
    FROM events
    WHERE project_id = {project_id:String} AND event = '$identify'
      AND timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}
      AND JSONExtractString(JSONExtractRaw(properties, '$set'), {key:String}) != ''
    GROUP BY v
    ORDER BY c DESC
    LIMIT {limit:UInt16}
  `
  return {
    query,
    query_params: {
      project_id: projectId,
      key,
      from: range.from,
      to: range.to,
      limit,
    },
  }
}

// ---------------------------------------------------------------------------
// 17. Segments — saved-filter audience resolution
// ---------------------------------------------------------------------------
//
// A SegmentDefinition is a single root AND/OR group of conditions (trait /
// event_property / behavioral), compiled into one boolean HAVING expression
// evaluated per-person over a GROUP BY on the resolved person id (same
// coalesce(nullIf(pdi.person_id, ''), events.distinct_id) identity resolution
// as buildUsers/buildActiveUsers, via PERSON_JOIN). Every leaf value is bound
// as a query param — never string-interpolated — matching the discipline
// funnelStepCondition already establishes for property filters.

/** Operator vocabulary shared by trait and event_property conditions. */
export type SegmentOperator = 'exact' | 'is_not' | 'icontains' | 'gt' | 'lt' | 'is_set'

export type SegmentCondition =
  | { type: 'trait'; key: string; operator: SegmentOperator; value?: unknown }
  | {
      type: 'event_property'
      key: string
      operator: SegmentOperator
      value?: unknown
      event?: string
    }
  | { type: 'behavioral'; event: string; count: number; days: number }

/** Root (and nested) AND/OR group. Children may be leaf conditions or subgroups. */
export interface SegmentGroup {
  combinator: 'AND' | 'OR'
  conditions: (SegmentCondition | SegmentGroup)[]
}

export interface SegmentDefinition {
  version: 1
  root: SegmentGroup
}

/** Discriminates a group (has `combinator`) from a leaf condition (has `type`). */
function isSegmentGroup(node: SegmentCondition | SegmentGroup): node is SegmentGroup {
  return 'combinator' in node
}

/**
 * Compiles one `trait` condition (latest `$identify` `$set` property, resolved
 * per-person via the same argMaxIf pattern buildUsers uses for `traits`) into a
 * boolean aggregate expression usable in a HAVING clause. `idx` disambiguates
 * bound param names across sibling/nested conditions in the same definition.
 */
function compileTraitCondition(
  cond: Extract<SegmentCondition, { type: 'trait' }>,
  idx: number,
  qp: Record<string, unknown>,
): string {
  const kName = `tk${idx}`
  const vName = `tv${idx}`
  qp[kName] = cond.key
  const traitsRaw =
    "argMaxIf(JSONExtractRaw(events.properties, '$set'), events.timestamp, events.event = '$identify')"
  switch (cond.operator) {
    case 'exact':
      qp[vName] = String(cond.value ?? '')
      return `JSONExtractString(${traitsRaw}, {${kName}:String}) = {${vName}:String}`
    case 'is_not':
      qp[vName] = String(cond.value ?? '')
      return `JSONExtractString(${traitsRaw}, {${kName}:String}) != {${vName}:String}`
    case 'icontains':
      qp[vName] = String(cond.value ?? '')
      return `positionCaseInsensitive(JSONExtractString(${traitsRaw}, {${kName}:String}), {${vName}:String}) > 0`
    case 'gt':
      qp[vName] = Number(cond.value)
      return `JSONExtractFloat(${traitsRaw}, {${kName}:String}) > {${vName}:Float64}`
    case 'lt':
      qp[vName] = Number(cond.value)
      return `JSONExtractFloat(${traitsRaw}, {${kName}:String}) < {${vName}:Float64}`
    case 'is_set':
      return `JSONHas(${traitsRaw}, {${kName}:String}) = 1`
  }
}

/**
 * Compiles one `event_property` condition into `max(<predicate>) = 1`, where
 * `<predicate>` is a funnelStepCondition-style per-row boolean over
 * `events.properties`, optionally AND-ed (inside the max()) with
 * `events.event = {ev:String}` when the condition pins a specific event.
 */
function compileEventPropertyCondition(
  cond: Extract<SegmentCondition, { type: 'event_property' }>,
  idx: number,
  qp: Record<string, unknown>,
): string {
  const kName = `ek${idx}`
  const vName = `ev${idx}`
  qp[kName] = cond.key
  let predicate: string
  switch (cond.operator) {
    case 'exact':
      qp[vName] = String(cond.value ?? '')
      predicate = `JSONExtractString(events.properties, {${kName}:String}) = {${vName}:String}`
      break
    case 'is_not':
      qp[vName] = String(cond.value ?? '')
      predicate = `JSONExtractString(events.properties, {${kName}:String}) != {${vName}:String}`
      break
    case 'icontains':
      qp[vName] = String(cond.value ?? '')
      predicate = `positionCaseInsensitive(JSONExtractString(events.properties, {${kName}:String}), {${vName}:String}) > 0`
      break
    case 'gt':
      qp[vName] = Number(cond.value)
      predicate = `JSONExtractFloat(events.properties, {${kName}:String}) > {${vName}:Float64}`
      break
    case 'lt':
      qp[vName] = Number(cond.value)
      predicate = `JSONExtractFloat(events.properties, {${kName}:String}) < {${vName}:Float64}`
      break
    case 'is_set':
      predicate = `JSONHas(events.properties, {${kName}:String}) = 1`
      break
  }
  if (cond.event) {
    const evNameParam = `eevt${idx}`
    qp[evNameParam] = cond.event
    predicate = `(${predicate}) AND events.event = {${evNameParam}:String}`
  }
  return `max(${predicate}) = 1`
}

/**
 * Compiles one `behavioral` condition ("performed event X >= N times in the
 * last D days") into a countIf aggregate. The lookback window `tw` (now() -
 * days) is resolved to an ISO timestamp and bound as a param here — never
 * interpolated — same as every other leaf value in this compiler.
 *
 * ClickHouse's DateTime64 param parser accepts the `T` separator but rejects
 * a trailing `Z` (see `apps/api/src/trpc/routers/segments.router.ts`'s
 * `scanFromForDays` and `events.router.ts`'s `toChRange` for the same
 * work-around) — strip it here too, or every behavioral condition preview
 * fails with a "cannot be parsed as DateTime64(3)" error.
 */
function compileBehavioralCondition(
  cond: Extract<SegmentCondition, { type: 'behavioral' }>,
  idx: number,
  qp: Record<string, unknown>,
): string {
  const evName = `bev${idx}`
  const twName = `btw${idx}`
  const nName = `bn${idx}`
  qp[evName] = cond.event
  qp[twName] = new Date(Date.now() - cond.days * 86_400_000).toISOString().replace('Z', '')
  qp[nName] = cond.count
  return `countIf(events.event = {${evName}:String} AND events.timestamp >= {${twName}:DateTime64(3)}) >= {${nName}:UInt32}`
}

/**
 * Recursively compiles a SegmentDefinition's root group into one HAVING
 * expression plus the bound params it introduces. Throws on an unrecognized
 * `definition.version` — the compiler has exactly one supported shape (v1).
 */
export function compileSegmentDefinition(definition: SegmentDefinition): {
  having: string
  params: Record<string, unknown>
} {
  if (definition.version !== 1) {
    throw new Error(
      `Unsupported segment definition version: ${(definition as { version: unknown }).version}`,
    )
  }
  const params: Record<string, unknown> = {}
  let counter = 0

  function compile(node: SegmentCondition | SegmentGroup): string {
    if (isSegmentGroup(node)) {
      const parts = node.conditions.map((child) => compile(child))
      return `(${parts.join(` ${node.combinator} `)})`
    }
    const idx = counter++
    switch (node.type) {
      case 'trait':
        return compileTraitCondition(node, idx, params)
      case 'event_property':
        return compileEventPropertyCondition(node, idx, params)
      case 'behavioral':
        return compileBehavioralCondition(node, idx, params)
    }
  }

  const having = compile(definition.root)
  return { having, params }
}

export interface SegmentCountArgs {
  projectId: string
  definition: SegmentDefinition
  /**
   * Bounded-scan lower bound (ISO string), matching the `scanDays` guardrail
   * documented in scoping decision. Omitted (or a very early date)
   * for `materialize`, which accepts an unbounded scan.
   */
  scanFrom?: string
}

/**
 * Resolves the count of distinct persons matching a segment definition.
 * Row shape: { count: string } — ClickHouse returns count() as a string in
 * JSON; the caller coerces to number (repo convention, see
 * web-analytics.queries.ts/events.router.ts).
 */
export function buildSegmentCount({
  projectId,
  definition,
  scanFrom,
}: SegmentCountArgs): BuiltQuery {
  const { having, params } = compileSegmentDefinition(definition)
  const query_params: Record<string, unknown> = { project_id: projectId, ...params }
  const scanFilter = scanFrom ? ' AND events.timestamp >= {scan_from:DateTime64(3)}' : ''
  if (scanFrom) {
    query_params.scan_from = scanFrom
  }
  const query = `
    SELECT count() AS count FROM (
      SELECT coalesce(nullIf(pdi.person_id, ''), events.distinct_id) AS person_id
      FROM events
      ${PERSON_JOIN}
      WHERE events.project_id = {project_id:String}${scanFilter}
      GROUP BY person_id
      HAVING ${having}
    )
  `
  return { query, query_params }
}

export interface SegmentMembersArgs {
  projectId: string
  definition: SegmentDefinition
  scanFrom?: string
  page?: number
  pageSize?: number
}

/**
 * Resolves person ids matching a segment definition, optionally paginated.
 * Same inner query as buildSegmentCount, with an outer ORDER BY and an
 * optional LIMIT/OFFSET. Used by both `previewMembers` (bounded, paginated
 * sample via `scanFrom` + `page`/`pageSize`) and `materialize` (unbounded
 * full scan): when `page`/`pageSize` are both omitted, the query has no
 * LIMIT/OFFSET clause at all, satisfying materialize's "scan unbounded"
 * requirement — keeps this one query shape instead of two.
 */
export function buildSegmentMembers({
  projectId,
  definition,
  scanFrom,
  page,
  pageSize,
}: SegmentMembersArgs): BuiltQuery {
  const { having, params } = compileSegmentDefinition(definition)
  const query_params: Record<string, unknown> = {
    project_id: projectId,
    ...params,
  }
  const scanFilter = scanFrom ? ' AND events.timestamp >= {scan_from:DateTime64(3)}' : ''
  if (scanFrom) {
    query_params.scan_from = scanFrom
  }
  const paginated = page !== undefined || pageSize !== undefined
  let limitClause = ''
  if (paginated) {
    const resolvedPage = page ?? 1
    const resolvedPageSize = pageSize ?? 50
    const offset = (resolvedPage - 1) * resolvedPageSize
    query_params.pageSize = resolvedPageSize
    query_params.offset = offset
    limitClause = 'LIMIT {pageSize:UInt32} OFFSET {offset:UInt32}'
  }
  const query = `
    SELECT person_id FROM (
      SELECT coalesce(nullIf(pdi.person_id, ''), events.distinct_id) AS person_id
      FROM events
      ${PERSON_JOIN}
      WHERE events.project_id = {project_id:String}${scanFilter}
      GROUP BY person_id
      HAVING ${having}
    )
    ORDER BY person_id
    ${limitClause}
  `
  return { query, query_params }
}

// ---------------------------------------------------------------------------
// 18. Experiments — per-variant metric builders
// ---------------------------------------------------------------------------
//
// An Experiment reuses the multivariate-flag exposure mechanism: `flag_events`
// (the same sink `buildFlagUsageByResponse` reads) records one row per
// `$feature_flag_called`, `response` holding the assigned variant key. Every
// metric builder below gates on a person's FIRST exposure to the flag (min
// timestamp, resolved to person via PERSON_JOIN exactly like the segments
// section) — only events strictly AFTER that anchor count toward the metric,
// so pre-exposure activity never leaks into post-exposure conversion numbers.
//
// Same discipline as the rest of this file: every value is a bound
// `query_params` entry, never string-interpolated. `EXPOSURES_SUBQUERY` is a
// fixed SQL fragment (not a user value) embedded the same way `PERSON_JOIN`
// already is throughout this file.
//
// Cost note: every builder scans `events`/`flag_events` for the
// full experiment window `[from, to]`, with no scan cap — same accepted
// posture as segment preview (a bounded, human-chosen run window,
// unlike segments' potentially-unbounded lookback).

/** Alias for `FunnelStepFilter` used by `ExperimentMetric`'s funnel shape. */
export type FunnelStepCondition = FunnelStepFilter

export type ExperimentMetric =
  | {
      type: 'funnel'
      steps: { event: string; properties?: FunnelStepCondition[] }[]
      window: number
    }
  | { type: 'mean'; event: string; property: string }
  | { type: 'ratio'; numeratorEvent: string; denominatorEvent: string }
  | { type: 'retention'; returnEvent: string; days: number }

export interface ExperimentBaseArgs {
  projectId: string
  /** The experiment's linked flag key (flag_events.flag_key). Bound, never interpolated. */
  flagKey: string
  /** ISO-8601 UTC string, inclusive lower bound of the experiment run window. */
  from: string
  /** ISO-8601 UTC string, inclusive upper bound of the experiment run window. */
  to: string
}

/**
 * Per-(variant, person) first-exposure timestamp, resolved to person via
 * PERSON_JOIN exactly like the rest of this file (`FROM flag_events AS
 * events` so the hardcoded `events.project_id`/`events.distinct_id`
 * references in PERSON_JOIN resolve correctly against flag_events' columns).
 * Embedded as a derived table by every builder below — each embedding is an
 * independent, locally-scoped subquery, so reusing the `pdi` alias from
 * PERSON_JOIN multiple times in one outer query is safe (no cross-scope
 * collision).
 *
 * Bound params introduced: project_id, flag_key, from, to (all shared with
 * the embedding builder's own params, so callers just spread the same four
 * base params — no per-embedding param renaming needed).
 */
const EXPOSURES_SUBQUERY = `
      SELECT
        response,
        coalesce(nullIf(pdi.person_id, ''), events.distinct_id) AS person_id,
        min(events.timestamp) AS first_exposure
      FROM flag_events AS events
      ${PERSON_JOIN}
      WHERE events.project_id = {project_id:String}
        AND events.flag_key = {flag_key:String}
        AND events.timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}
      GROUP BY response, person_id
`

/** Shared param object for the four base ExperimentBaseArgs fields. */
function experimentBaseParams({
  projectId,
  flagKey,
  from,
  to,
}: ExperimentBaseArgs): Record<string, unknown> {
  return { project_id: projectId, flag_key: flagKey, from, to }
}

/**
 * Per-variant exposed-person count + earliest exposure timestamp across the
 * run window. This is both a standalone summary (feeds the exposures column
 * of the results view) and the documented anchor every other builder in this
 * section gates on via `EXPOSURES_SUBQUERY`.
 * Row shape: { response: string, exposed: string, firstExposure: string } —
 * `exposed` is `uniqExact()`, a string in JSON; the caller coerces to number.
 */
export function buildExperimentExposures(args: ExperimentBaseArgs): BuiltQuery {
  const query = `
    SELECT response, uniqExact(person_id) AS exposed, min(first_exposure) AS firstExposure
    FROM (${EXPOSURES_SUBQUERY})
    GROUP BY response
    ORDER BY response
  `
  return { query, query_params: experimentBaseParams(args) }
}

export interface ExperimentFunnelArgs extends ExperimentBaseArgs {
  /** Ordered steps (event + AND-ed property filters), 2..8 steps — same shape/limits as buildFunnel. */
  steps: FunnelStep[]
  /** Conversion window in seconds, anchored at each person's first exposure (not a fixed range start). */
  window: number
}

/**
 * `windowFunnel` per variant, identical step-condition compilation to
 * `buildFunnel` (reuses `funnelStepCondition`), but scoped to events at or
 * after each person's first flag exposure instead of the funnel's usual fixed
 * range start — so the conversion window measures time-since-exposure, not
 * time-since-`from`.
 * Row shape: { response: string, level: number, reached: string } — same
 * exact-bucket-per-level contract as `buildFunnel`; callers do the same
 * suffix-sum per variant to get "reached >= step i".
 */
export function buildExperimentFunnelByVariant({
  projectId,
  flagKey,
  from,
  to,
  steps,
  window,
}: ExperimentFunnelArgs): BuiltQuery {
  if (steps.length < 2 || steps.length > 8) {
    throw new Error(`Funnel requires 2..8 steps, got ${steps.length}`)
  }
  const query_params = experimentBaseParams({ projectId, flagKey, from, to })
  query_params.window = window
  const stepConditions: string[] = []
  const stepParams: string[] = []
  steps.forEach((step, i) => {
    stepConditions.push(funnelStepCondition(step, i, query_params))
    stepParams.push(`{s${i}:String}`)
  })

  const query = `
    SELECT response, level, count() AS reached
    FROM (
      SELECT ex.response AS response, ex.person_id AS person_id,
        windowFunnel({window:UInt32})(toDateTime(events.timestamp), ${stepConditions.join(', ')}) AS level
      FROM events
      ${PERSON_JOIN}
      INNER JOIN (${EXPOSURES_SUBQUERY}) ex
        ON ex.person_id = coalesce(nullIf(pdi.person_id, ''), events.distinct_id)
      WHERE events.project_id = {project_id:String}
        AND events.timestamp > ex.first_exposure
        AND events.timestamp <= {to:DateTime64(3)}
        AND event IN (${stepParams.join(', ')})
      GROUP BY response, person_id
    )
    WHERE level > 0
    GROUP BY response, level
    ORDER BY response, level
  `
  return { query, query_params }
}

export interface ExperimentMeanArgs extends ExperimentBaseArgs {
  /** The metric event whose numeric property is averaged/summed per exposed person. */
  event: string
  /** Property key, read via JSONExtractFloat. */
  property: string
}

/**
 * Per-variant avg/sum of a numeric event property, computed per exposed
 * person over events strictly after their first flag exposure. Each person's
 * per-event property values are summed first (inner `GROUP BY response,
 * person_id`), then the outer query reports the mean/sum of THOSE per-person
 * totals per variant.
 * Row shape: { response: string, exposed: string, mean: string, total: string }.
 * `exposed` here counts only persons with >= 1 qualifying post-exposure event
 * for `event` — `buildExperimentExposures` remains the source of truth for
 * the full exposed-person count (some exposed persons may never fire the
 * metric event at all).
 */
export function buildExperimentMeanByVariant({
  projectId,
  flagKey,
  from,
  to,
  event,
  property,
}: ExperimentMeanArgs): BuiltQuery {
  const query_params = experimentBaseParams({ projectId, flagKey, from, to })
  query_params.metric_event = event
  query_params.property = property
  const query = `
    SELECT response,
      uniqExact(person_id) AS exposed,
      avg(user_value) AS mean,
      sum(user_value) AS total
    FROM (
      SELECT ex.response AS response, ex.person_id AS person_id,
        sum(JSONExtractFloat(events.properties, {property:String})) AS user_value
      FROM events
      ${PERSON_JOIN}
      INNER JOIN (${EXPOSURES_SUBQUERY}) ex
        ON ex.person_id = coalesce(nullIf(pdi.person_id, ''), events.distinct_id)
      WHERE events.project_id = {project_id:String}
        AND events.event = {metric_event:String}
        AND events.timestamp > ex.first_exposure
        AND events.timestamp <= {to:DateTime64(3)}
      GROUP BY response, person_id
    )
    GROUP BY response
    ORDER BY response
  `
  return { query, query_params }
}

export interface ExperimentRatioArgs extends ExperimentBaseArgs {
  numeratorEvent: string
  denominatorEvent: string
}

/**
 * Per-variant `count(event = numeratorEvent) / count(event =
 * denominatorEvent)` over events strictly after each person's first
 * exposure. Row shape: { response: string, numerator: string, denominator:
 * string } — the caller divides to get the ratio (division stays in JS to
 * avoid a divide-by-zero surprise inside SQL).
 */
export function buildExperimentRatioByVariant({
  projectId,
  flagKey,
  from,
  to,
  numeratorEvent,
  denominatorEvent,
}: ExperimentRatioArgs): BuiltQuery {
  const query_params = experimentBaseParams({ projectId, flagKey, from, to })
  query_params.numerator_event = numeratorEvent
  query_params.denominator_event = denominatorEvent
  const query = `
    SELECT response,
      countIf(events.event = {numerator_event:String}) AS numerator,
      countIf(events.event = {denominator_event:String}) AS denominator
    FROM events
    ${PERSON_JOIN}
    INNER JOIN (${EXPOSURES_SUBQUERY}) ex
      ON ex.person_id = coalesce(nullIf(pdi.person_id, ''), events.distinct_id)
    WHERE events.project_id = {project_id:String}
      AND events.timestamp > ex.first_exposure
      AND events.timestamp <= {to:DateTime64(3)}
      AND events.event IN ({numerator_event:String}, {denominator_event:String})
    GROUP BY response
    ORDER BY response
  `
  return { query, query_params }
}

export interface ExperimentRetentionArgs extends ExperimentBaseArgs {
  /** The return event that must fire again after the retention window. */
  returnEvent: string
  /** Retention window in days — a person "retains" if returnEvent fires >= this many days after first exposure. */
  days: number
}

/**
 * Per-variant fraction of exposed persons who fire `returnEvent` again at
 * least `days` days after their first flag exposure. Mirrors the
 * behavioral-condition lookback pattern from the segments section's
 * `compileBehavioralCondition`, but anchored per-person at first exposure
 * (`+ toIntervalDay(days)`) instead of a fixed "now() - days" window.
 * Row shape: { response: string, exposed: string, retained: string } — the
 * caller divides `retained / exposed` to get the retention rate.
 */
export function buildExperimentRetentionByVariant({
  projectId,
  flagKey,
  from,
  to,
  returnEvent,
  days,
}: ExperimentRetentionArgs): BuiltQuery {
  const query_params = experimentBaseParams({ projectId, flagKey, from, to })
  query_params.return_event = returnEvent
  query_params.days = days
  const query = `
    SELECT ex.response AS response,
      uniqExact(ex.person_id) AS exposed,
      uniqExactIf(ex.person_id, ret.person_id != '') AS retained
    FROM (${EXPOSURES_SUBQUERY}) ex
    LEFT JOIN (
      SELECT
        coalesce(nullIf(pdi.person_id, ''), events.distinct_id) AS person_id,
        events.timestamp AS timestamp
      FROM events
      ${PERSON_JOIN}
      WHERE events.project_id = {project_id:String}
        AND events.event = {return_event:String}
    ) ret
      ON ret.person_id = ex.person_id
      AND ret.timestamp >= ex.first_exposure + toIntervalDay({days:UInt32})
      AND ret.timestamp <= {to:DateTime64(3)}
    GROUP BY response
    ORDER BY response
  `
  return { query, query_params }
}

// ---------------------------------------------------------------------------
// SQL Explorer schema introspection (addon)
// ---------------------------------------------------------------------------

/**
 * Lists columns (name + type) for the given tables in `database`, via
 * `system.columns`. Server-only: `database`/`tables` must never come from
 * user-supplied SQL — they're bound params here purely to avoid string
 * interpolation, not because the values are untrusted input.
 */
export function buildSchemaColumns({
  database,
  tables,
}: {
  database: string
  tables: readonly string[]
}): BuiltQuery {
  return {
    query: `
      SELECT table, name, type
      FROM system.columns
      WHERE database = {database:String} AND table IN {tables:Array(String)}
      ORDER BY table, position
    `,
    query_params: { database, tables: [...tables] },
  }
}

// ---------------------------------------------------------------------------
// 18. Survey results
// ---------------------------------------------------------------------------
//
// Data source: the dedicated `survey_events` sink (migration 012), populated by
// a materialized view off `$survey_shown` / `$survey_dismissed` / `$survey_sent`
// inserts. Unlike the `events` RMT, `survey_events` has real `survey_id` /
// `interaction` / `question_id` / `response` columns and a sort key that INCLUDES
// `survey_id` — so per-survey counts are EXACT (they don't collapse). All user
// input (project_id, survey_id, question_id, segment_id) is ALWAYS a bound param
// — never interpolated. The ONE non-value identifier that varies the SQL is
// `scoreType`, resolved through a hardcoded allowlist (like buildBreakdown's
// dimension), never interpolated.
//
// IMPORTANT — like the flag_events builders, these do NOT use FINAL
// (survey_events is a plain MergeTree) and dedup at-least-once redeliveries via
// uniqExact(uuid). There is no `event` filter — survey_events contains ONLY
// survey-interaction rows by construction; `interaction` distinguishes
// shown/dismissed/sent.

/** CSAT/CES/NPS presets computed over a rating question's numeric `response`. */
export type SurveyScoreType = 'csat' | 'ces' | 'nps'

/**
 * Shared WHERE fragment for survey_events: tenant + survey + time window. All
 * bound. `from`/`to` are CH-normalized DateTime strings (caller runs them
 * through `toChRange` first), matching the flag_events builders' convention.
 */
const SURVEY_PROJECT_SURVEY_RANGE =
  'project_id = {project_id:String} AND survey_id = {survey_id:String} AND timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}'

/** Shared param object for the project + survey + range triplet. */
function surveyParams(
  projectId: string,
  surveyId: string,
  from: string,
  to: string,
): Record<string, unknown> {
  return { project_id: projectId, survey_id: surveyId, from, to }
}

export interface SurveyResponseRateArgs {
  projectId: string
  surveyId: string
  /** CH-normalized DateTime string (inclusive lower bound). */
  from: string
  /** CH-normalized DateTime string (inclusive upper bound). */
  to: string
}

/**
 * Response rate for one survey = uniq(sent events) / uniq(shown events), deduped
 * on `uuid` so an at-least-once redelivery of the same `$survey_shown` /
 * `$survey_sent` never double-counts. Counts events (not distinct users) to stay
 * consistent with the trend, score, and question breakdown, which all operate on
 * deduped response events — a user shown twice who answered twice is shown=2,
 * responded=2. Guards division-by-zero (0 shown -> 0). Row shape:
 * { shown: string, responded: string, rate: string } — CH returns aggregates as
 * strings in JSON; the caller coerces to number.
 */
export function buildSurveyResponseRate({
  projectId,
  surveyId,
  from,
  to,
}: SurveyResponseRateArgs): BuiltQuery {
  const query = `
    SELECT
      uniqExactIf(uuid, interaction = 'shown') AS shown,
      uniqExactIf(uuid, interaction = 'sent') AS responded,
      if(shown = 0, 0, responded / shown) AS rate
    FROM survey_events
    WHERE ${SURVEY_PROJECT_SURVEY_RANGE}
  `
  return { query, query_params: surveyParams(projectId, surveyId, from, to) }
}

export interface SurveyScoreArgs {
  projectId: string
  surveyId: string
  /** The rating question whose numeric responses are scored. Bound param. */
  questionId: string
  scoreType: SurveyScoreType
  from: string
  to: string
}

/**
 * Inner subquery: one numeric response per `$survey_sent` uuid for a question,
 * NULL-dropped. `any(response)` collapses at-least-once redeliveries (same uuid,
 * same response) to one row before casting; the outer query filters `v IS NOT
 * NULL` so non-numeric / empty responses don't pollute the aggregate.
 */
const SURVEY_NUMERIC_RESPONSES = `
      SELECT toFloat64OrNull(any(response)) AS v
      FROM survey_events
      WHERE ${SURVEY_PROJECT_SURVEY_RANGE}
        AND interaction = 'sent'
        AND question_id = {question_id:String}
      GROUP BY uuid`

/** SELECT body for each score preset, resolved through an allowlist (never interpolated). */
const SURVEY_SCORE_SELECT: Record<SurveyScoreType, string> = {
  // CSAT (1-5 preset): top-box = responses at the top of the scale (4-5).
  // score = %top-box; `average` returned alongside so callers can show mean too.
  csat: `
      responses,
      average,
      topBox,
      if(responses = 0, 0, topBox / responses) AS score`,
  // CES: score is simply the average effort rating.
  ces: `
      responses,
      average,
      average AS score`,
  // NPS (0-10 preset): score = %promoters (>=9) - %detractors (<=6), in -100..100.
  nps: `
      responses,
      promoters,
      passives,
      detractors,
      if(responses = 0, 0, (promoters - detractors) / responses * 100) AS score`,
}

/** Inner aggregate columns each preset's SELECT references (over the NULL-dropped `v`). */
const SURVEY_SCORE_AGG: Record<SurveyScoreType, string> = {
  csat: `
      count() AS responses,
      avg(v) AS average,
      countIf(v >= 4) AS topBox`,
  ces: `
      count() AS responses,
      avg(v) AS average`,
  nps: `
      count() AS responses,
      countIf(v >= 9) AS promoters,
      countIf(v >= 7 AND v <= 8) AS passives,
      countIf(v <= 6) AS detractors`,
}

/**
 * CSAT / CES / NPS score for one rating question, over its `$survey_sent`
 * numeric responses. `scoreType` selects the aggregation via a hardcoded
 * allowlist — an unknown value throws before any SQL is built (buildBreakdown
 * pattern). Row shape depends on `scoreType` but always carries `responses` and
 * `score` (CH returns them as strings in JSON; the caller coerces to number).
 */
export function buildSurveyScore({
  projectId,
  surveyId,
  questionId,
  scoreType,
  from,
  to,
}: SurveyScoreArgs): BuiltQuery {
  const selectBody = SURVEY_SCORE_SELECT[scoreType]
  const aggBody = SURVEY_SCORE_AGG[scoreType]
  if (!selectBody || !aggBody) {
    throw new Error(`Invalid survey score type: ${scoreType}`)
  }
  const query = `
    SELECT${selectBody}
    FROM (
      SELECT${aggBody}
      FROM (${SURVEY_NUMERIC_RESPONSES}
      )
      WHERE v IS NOT NULL
    )
  `
  return {
    query,
    query_params: { ...surveyParams(projectId, surveyId, from, to), question_id: questionId },
  }
}

export interface SurveyQuestionBreakdownArgs {
  projectId: string
  surveyId: string
  questionId: string
  from: string
  to: string
}

/**
 * Distribution of `$survey_sent` responses for one question — the count and
 * distinct-user count of each distinct `response` value (choice / rating
 * distribution). uniqExact(uuid) dedups redeliveries; empty responses excluded.
 * Row shape: { value: string, count: string, users: string }.
 */
export function buildSurveyQuestionBreakdown({
  projectId,
  surveyId,
  questionId,
  from,
  to,
}: SurveyQuestionBreakdownArgs): BuiltQuery {
  const query = `
    SELECT response AS value, uniqExact(uuid) AS count, uniqExact(distinct_id) AS users
    FROM survey_events
    WHERE ${SURVEY_PROJECT_SURVEY_RANGE}
      AND interaction = 'sent'
      AND question_id = {question_id:String}
      AND response != ''
    GROUP BY value
    ORDER BY count DESC
  `
  return {
    query,
    query_params: { ...surveyParams(projectId, surveyId, from, to), question_id: questionId },
  }
}

export interface SurveyTrendArgs {
  projectId: string
  surveyId: string
  interval: TrendInterval
  from: string
  to: string
}

/**
 * Time series (bucketed by hour or day) of one survey's `shown` vs `sent`
 * interactions — feeds the response-over-time chart. uniqExact(uuid) dedups
 * redeliveries within a bucket.
 * Row shape: { bucket: string, shown: string, sent: string }.
 */
export function buildSurveyTrend({
  projectId,
  surveyId,
  interval,
  from,
  to,
}: SurveyTrendArgs): BuiltQuery {
  const bucketFn = interval === 'hour' ? 'toStartOfHour' : 'toStartOfDay'
  const query = `
    SELECT
      ${bucketFn}(timestamp) AS bucket,
      uniqExactIf(uuid, interaction = 'shown') AS shown,
      uniqExactIf(uuid, interaction = 'sent') AS sent
    FROM survey_events
    WHERE ${SURVEY_PROJECT_SURVEY_RANGE}
    GROUP BY bucket
    ORDER BY bucket
  `
  return { query, query_params: surveyParams(projectId, surveyId, from, to) }
}

export interface SurveySegmentBreakdownArgs {
  projectId: string
  surveyId: string
  /** The segment whose membership splits the response-rate breakdown. Bound param. */
  segmentId: string
  from: string
  to: string
}

/**
 * Latest-snapshot member person_ids for one segment. `segment_members` keeps
 * every snapshot; `argMax(snapshot_id, computed_at)` picks the current one so
 * stale snapshots don't leak into membership. Both ids are bound params.
 */
const SURVEY_SEGMENT_MEMBERS_SUBQUERY = `(
        SELECT person_id FROM segment_members
        WHERE project_id = {project_id:String} AND segment_id = {segment_id:String}
          AND snapshot_id = (
            SELECT argMax(snapshot_id, computed_at) FROM segment_members
            WHERE project_id = {project_id:String} AND segment_id = {segment_id:String}
          )
      )`

/**
 * Response rate broken down by membership in one segment: `member` vs
 * `non_member`. Each survey_events row's distinct_id is resolved to its current
 * person (same argMax(person_id, created_at) resolution as PERSON_JOIN), then
 * tested against the segment's latest-snapshot members. `segmentId` is a bound
 * param, never interpolated (mirrors buildBreakdown's safe-dimension posture,
 * but for a segment rather than a column). Guards division-by-zero per group.
 * Row shape: { member: 'member' | 'non_member', shown: string, responded: string, rate: string }.
 */
export function buildSurveySegmentBreakdown({
  projectId,
  surveyId,
  segmentId,
  from,
  to,
}: SurveySegmentBreakdownArgs): BuiltQuery {
  const query = `
    SELECT
      member,
      uniqExactIf(distinct_id, interaction = 'shown') AS shown,
      uniqExactIf(distinct_id, interaction = 'sent') AS responded,
      if(shown = 0, 0, responded / shown) AS rate
    FROM (
      SELECT
        se.distinct_id AS distinct_id,
        se.interaction AS interaction,
        if(
          coalesce(nullIf(pdi.person_id, ''), se.distinct_id) IN ${SURVEY_SEGMENT_MEMBERS_SUBQUERY},
          'member',
          'non_member'
        ) AS member
      FROM survey_events se
      LEFT JOIN (
        SELECT project_id, distinct_id, argMax(person_id, created_at) AS person_id
        FROM person_distinct_ids
        GROUP BY project_id, distinct_id
      ) pdi ON pdi.project_id = se.project_id AND pdi.distinct_id = se.distinct_id
      WHERE se.project_id = {project_id:String}
        AND se.survey_id = {survey_id:String}
        AND se.timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}
    )
    GROUP BY member
    ORDER BY member
  `
  return {
    query,
    query_params: { ...surveyParams(projectId, surveyId, from, to), segment_id: segmentId },
  }
}

export interface SurveyOpenResponsesArgs {
  projectId: string
  surveyId: string
  /** The open-text question whose raw answers are listed. Bound param. */
  questionId: string
  from: string
  to: string
  /** Page size (bound `UInt32`). The caller passes `limit + 1` to derive `hasMore`. */
  limit: number
  /** Rows to skip for pagination (bound `UInt32`). */
  offset: number
}

/**
 * Raw (ungrouped) `$survey_sent` answers to one open-text question, newest
 * first, paginated. Unlike buildSurveyQuestionBreakdown (which bins by value),
 * free-text answers are unique, so each submission is its own row. `GROUP BY
 * uuid` collapses at-least-once redeliveries while keeping distinct submissions
 * separate; empty responses excluded. `limit`/`offset` are bound params.
 * Row shape: { response: string, distinct_id: string, timestamp: string }.
 */
export function buildSurveyOpenResponses({
  projectId,
  surveyId,
  questionId,
  from,
  to,
  limit,
  offset,
}: SurveyOpenResponsesArgs): BuiltQuery {
  const query = `
    SELECT
      any(response) AS resp,
      any(distinct_id) AS did,
      max(timestamp) AS ts
    FROM survey_events
    WHERE ${SURVEY_PROJECT_SURVEY_RANGE}
      AND interaction = 'sent'
      AND question_id = {question_id:String}
      AND response != ''
    GROUP BY uuid
    ORDER BY ts DESC
    LIMIT {limit:UInt32} OFFSET {offset:UInt32}
  `
  return {
    query,
    query_params: {
      ...surveyParams(projectId, surveyId, from, to),
      question_id: questionId,
      limit,
      offset,
    },
  }
}

export interface SurveyRespondentArgs {
  projectId: string
  surveyId: string
  /** The respondent whose full submission is fetched for the drill-down. Bound param. */
  distinctId: string
  from: string
  to: string
}

/**
 * Every answered question for one respondent in a survey — feeds the drill-down
 * Sheet on the results page. `argMax(response, timestamp)` keeps the latest
 * answer per question if a user re-answered; empty responses excluded.
 * Row shape: { question_id: string, response: string, timestamp: string }.
 */
export function buildSurveyRespondent({
  projectId,
  surveyId,
  distinctId,
  from,
  to,
}: SurveyRespondentArgs): BuiltQuery {
  const query = `
    SELECT
      question_id AS qid,
      argMax(response, timestamp) AS resp,
      max(timestamp) AS ts
    FROM survey_events
    WHERE ${SURVEY_PROJECT_SURVEY_RANGE}
      AND interaction = 'sent'
      AND distinct_id = {distinct_id:String}
      AND response != ''
    GROUP BY question_id
    ORDER BY ts ASC
  `
  return {
    query,
    query_params: { ...surveyParams(projectId, surveyId, from, to), distinct_id: distinctId },
  }
}

// ---------------------------------------------------------------------------
// 19. Support results
// ---------------------------------------------------------------------------
//
// Data source: the dedicated `support_events` sink (migration 013), populated by
// a materialized view off `$support_shown` / `$support_opened` /
// `$support_deflected` / `$support_ticket_created` / `$support_ticket_resolved` /
// `$support_csat` inserts. Unlike the `events` RMT, `support_events` has real
// `form_id` / `interaction` / `category` / `score` columns and a sort key that
// INCLUDES `form_id` — so per-form counts are EXACT (they don't collapse).
//
// All user input (project_id, form_id) is ALWAYS a bound param — never
// interpolated. The ONE non-value identifier that varies the SQL is the trend
// `interval`, resolved to a hardcoded bucket function (same posture as
// buildSurveyTrend).
//
// IMPORTANT — like the survey/flag builders these do NOT use FINAL
// (support_events is a plain MergeTree) and dedup at-least-once redeliveries via
// uniqExact(uuid). There is no `event` filter — support_events contains ONLY
// support-interaction rows by construction; `interaction` distinguishes them.
//
// NOTE: open-ticket counts and first-reply medians deliberately do NOT live here.
// They are ticket-STATE reads (mutable status/assignee/firstReplyAt) and come
// from Postgres; ClickHouse only holds the append-only telemetry.

/**
 * Shared WHERE fragment for support_events: tenant + form + time window. All
 * bound. `from`/`to` are CH-normalized DateTime strings (caller runs them
 * through `toChRange` first), matching the survey/flag builders' convention.
 */
const SUPPORT_PROJECT_FORM_RANGE =
  'project_id = {project_id:String} AND form_id = {form_id:String} AND timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}'

/** Shared param object for the project + form + range triplet. */
function supportParams(
  projectId: string,
  formId: string,
  from: string,
  to: string,
): Record<string, unknown> {
  return { project_id: projectId, form_id: formId, from, to }
}

export interface SupportFormRangeArgs {
  projectId: string
  formId: string
  /** CH-normalized DateTime string (inclusive lower bound). */
  from: string
  /** CH-normalized DateTime string (inclusive upper bound). */
  to: string
}

/**
 * Deflection rate for one support form = uniq(deflected) / uniq(opened), deduped
 * on `uuid` so an at-least-once redelivery never double-counts. "Deflected"
 * means the user got their answer from the widget and never filed a ticket, so
 * the denominator is widget OPENS (not impressions) — a user who never opened
 * the widget was never a candidate for deflection. Counts events (not distinct
 * users) to stay consistent with the trend and category breakdown. Guards
 * division-by-zero (0 opened -> 0). Row shape:
 * { opened: string, deflected: string, ticketed: string, rate: string } — CH
 * returns aggregates as strings in JSON; the caller coerces to number.
 */
export function buildSupportDeflectionRate({
  projectId,
  formId,
  from,
  to,
}: SupportFormRangeArgs): BuiltQuery {
  const query = `
    SELECT
      uniqExactIf(uuid, interaction = 'opened') AS opened,
      uniqExactIf(uuid, interaction = 'deflected') AS deflected,
      uniqExactIf(uuid, interaction = 'ticket_created') AS ticketed,
      if(opened = 0, 0, deflected / opened) AS rate
    FROM support_events
    WHERE ${SUPPORT_PROJECT_FORM_RANGE}
  `
  return { query, query_params: supportParams(projectId, formId, from, to) }
}

export interface SupportVolumeTrendArgs extends SupportFormRangeArgs {
  interval: TrendInterval
}

/**
 * Time series (bucketed by hour or day) of one form's funnel — shown, opened,
 * deflected, tickets created and tickets resolved — feeding the volume-over-time
 * chart on the inbox Analytics tab. uniqExact(uuid) dedups redeliveries within a
 * bucket. Row shape:
 * { bucket: string, shown: string, opened: string, deflected: string,
 *   created: string, resolved: string }.
 */
export function buildSupportVolumeTrend({
  projectId,
  formId,
  interval,
  from,
  to,
}: SupportVolumeTrendArgs): BuiltQuery {
  const bucketFn = interval === 'hour' ? 'toStartOfHour' : 'toStartOfDay'
  const query = `
    SELECT
      ${bucketFn}(timestamp) AS bucket,
      uniqExactIf(uuid, interaction = 'shown') AS shown,
      uniqExactIf(uuid, interaction = 'opened') AS opened,
      uniqExactIf(uuid, interaction = 'deflected') AS deflected,
      uniqExactIf(uuid, interaction = 'ticket_created') AS created,
      uniqExactIf(uuid, interaction = 'ticket_resolved') AS resolved
    FROM support_events
    WHERE ${SUPPORT_PROJECT_FORM_RANGE}
    GROUP BY bucket
    ORDER BY bucket
  `
  return { query, query_params: supportParams(projectId, formId, from, to) }
}

/**
 * Ticket volume split by the form's category field — which topics actually
 * generate tickets. Only `ticket_created` rows count (a `shown` impression has no
 * category yet); uniqExact(uuid) dedups redeliveries and uniqExact(distinct_id)
 * gives the distinct-user count per category. Empty categories excluded so an
 * unset field doesn't render as a blank bar.
 * Row shape: { value: string, count: string, users: string }.
 */
export function buildSupportVolumeByCategory({
  projectId,
  formId,
  from,
  to,
}: SupportFormRangeArgs): BuiltQuery {
  const query = `
    SELECT category AS value, uniqExact(uuid) AS count, uniqExact(distinct_id) AS users
    FROM support_events
    WHERE ${SUPPORT_PROJECT_FORM_RANGE}
      AND interaction = 'ticket_created'
      AND category != ''
    GROUP BY value
    ORDER BY count DESC
  `
  return { query, query_params: supportParams(projectId, formId, from, to) }
}

/**
 * CSAT for one support form over its `$support_csat` ratings (1-5 preset).
 * `any(score)` collapses at-least-once redeliveries (same uuid, same score) to
 * one row before aggregating, and NULL scores are dropped so a malformed
 * `$support_score` never drags the average down. Top-box = 4-5, matching
 * buildSurveyScore's CSAT preset, so the two products' CSAT numbers are directly
 * comparable. Guards division-by-zero (0 responses -> 0). Row shape:
 * { responses: string, average: string, topBox: string, score: string }.
 */
export function buildSupportCsat({
  projectId,
  formId,
  from,
  to,
}: SupportFormRangeArgs): BuiltQuery {
  const query = `
    SELECT
      responses,
      average,
      topBox,
      if(responses = 0, 0, topBox / responses) AS score
    FROM (
      SELECT
        count() AS responses,
        avg(v) AS average,
        countIf(v >= 4) AS topBox
      FROM (
        SELECT any(score) AS v
        FROM support_events
        WHERE ${SUPPORT_PROJECT_FORM_RANGE}
          AND interaction = 'csat'
        GROUP BY uuid
      )
      WHERE v IS NOT NULL
    )
  `
  return { query, query_params: supportParams(projectId, formId, from, to) }
}
