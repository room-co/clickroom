import { e2eEnv } from './env'
import { waitFor } from './waitFor'

/**
 * Raw HTTP query against the e2e ClickHouse database. Mirrors
 * `services/ingest/src/clickhouse.rs`'s `query_rows`: POST to `{url}/` with
 * HTTP basic auth, a `database` query param, SQL body using ClickHouse
 * `{name:Type}` bound-parameter placeholders, and each placeholder's value
 * passed as a `param_<name>` query param. Response format is
 * `FORMAT JSONEachRow` — newline-delimited JSON objects, one per row.
 */
export async function queryClickHouse(
  sql: string,
  params: Record<string, string> = {},
  // biome-ignore lint/suspicious/noExplicitAny: rows are arbitrary ClickHouse result shapes
): Promise<any[]> {
  const query = new URLSearchParams({ database: e2eEnv.clickhouse.database })
  for (const [key, value] of Object.entries(params)) {
    query.set(`param_${key}`, value)
  }

  const auth = Buffer.from(`${e2eEnv.clickhouse.user}:${e2eEnv.clickhouse.password}`).toString(
    'base64',
  )

  const res = await fetch(`${e2eEnv.clickhouse.url}/?${query.toString()}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
    // Without an explicit FORMAT clause, ClickHouse's HTTP interface defaults
    // to TabSeparated (e.g. a bare "1\n" for `SELECT count() as c`) — and
    // `JSON.parse("1")` succeeds (it's valid JSON), silently producing a rows
    // array of raw scalars instead of row objects, so callers' `.c` field
    // accesses always resolve to `undefined`. Force JSONEachRow here so every
    // caller gets row objects, matching this function's documented contract.
    body: `${sql} FORMAT JSONEachRow`,
  })

  const text = await res.text()
  if (!res.ok) {
    throw new Error(`ClickHouse query failed (${res.status}): ${text}`)
  }

  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

export interface ForceMergeArgs {
  table: string
  /** Defaults to the e2e ClickHouse database (`e2eEnv.clickhouse.database`). */
  database?: string
}

/**
 * Force ClickHouse to physically collapse a `ReplacingMergeTree` table's parts
 * right now, instead of waiting on the background merge scheduler. Used by
 * Dedup regression coverage to prove correctness holds *after* a real
 * merge has run, not just at query time via `FINAL` .
 */
export async function forceMerge({ table, database }: ForceMergeArgs): Promise<void> {
  const db = database ?? e2eEnv.clickhouse.database
  await queryClickHouse(`OPTIMIZE TABLE ${db}.${table} FINAL`)
}

export interface InsertEventRowArgs {
  uuid: string
  projectId: string
  event: string
  distinctId: string
  timestamp: string
  properties?: Record<string, unknown>
}

/**
 * Directly insert a raw row into `events`, bypassing capture-rs entirely.
 * capture-rs always mints a fresh `uuid` per accepted event, so it can't
 * simulate genuine at-least-once redelivery (the same `uuid` arriving twice).
 * This helper exists solely for that scenario — see the dedup scenario, which
 * inserts two rows sharing a `uuid` and asserts `ReplacingMergeTree` still
 * collapses them to one after a forced merge.
 */
export async function insertEventRow({
  uuid,
  projectId,
  event,
  distinctId,
  timestamp,
  properties,
}: InsertEventRowArgs): Promise<void> {
  const row = {
    uuid,
    project_id: projectId,
    event,
    distinct_id: distinctId,
    timestamp,
    properties: JSON.stringify(properties ?? {}),
    elements_chain: '',
  }

  const query = new URLSearchParams({ database: e2eEnv.clickhouse.database })
  const auth = Buffer.from(`${e2eEnv.clickhouse.user}:${e2eEnv.clickhouse.password}`).toString(
    'base64',
  )

  const res = await fetch(`${e2eEnv.clickhouse.url}/?${query.toString()}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
    body: `INSERT INTO events (uuid,project_id,event,distinct_id,timestamp,properties,elements_chain) FORMAT JSONEachRow\n${JSON.stringify(row)}`,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`ClickHouse insert failed (${res.status}): ${text}`)
  }
}

export interface WaitForEventArgs {
  projectId: string
  distinctId: string
  event: string
}

/**
 * Poll (up to ~10s) until at least one matching row has landed in
 * ClickHouse's `events` table for (project_id, distinct_id, event), returning
 * the observed count. Uses `FINAL` because `events` is a
 * `ReplacingMergeTree(created_at)` (packages/clickhouse/migrations/001_events.sql)
 * and background merges/dedup aren't guaranteed to have run yet.
 */
export async function waitForEvent({
  projectId,
  distinctId,
  event,
}: WaitForEventArgs): Promise<number> {
  return waitFor(
    async () => {
      const rows = await queryClickHouse(
        'SELECT count() as c FROM events FINAL WHERE project_id={pid:String} AND distinct_id={did:String} AND event={ev:String}',
        { pid: projectId, did: distinctId, ev: event },
      )
      const count = Number(rows[0]?.c ?? 0)
      return count >= 1 ? count : false
    },
    // 20s, not 10s: under a full 7-worker parallel run the single-threaded
    // ingest dev binary + shared ClickHouse container both see real
    // contention, and events have been observed landing 10-20s after capture
    // accepts them — widen the budget, not the poll
    // interval.
    { timeoutMs: 20_000, intervalMs: 250 },
  )
}
