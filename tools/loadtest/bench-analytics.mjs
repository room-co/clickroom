#!/usr/bin/env node
// AC-3 analytics-perf harness: seed ~1M events for ONE project directly into
// ClickHouse, then benchmark the `topEvents` + `trend` query builders and record
// their p95 latency. AC-3 passes when p95 < 1000ms over ~1M rows.
//
// Seeding goes straight to ClickHouse over HTTP (JSONEachRow) — NOT through
// capture-rs — because AC-3 measures QUERY latency over a large table, and the
// hot-path rate limiter (500/s) would make a 1M-row seed take ~30 min. Pure
// Node.js ESM, zero npm deps (Node 22+), matching pump.mjs / run.sh conventions.
//
//   node tools/loadtest/bench-analytics.mjs --rows 1000000 --iterations 30
//   node tools/loadtest/bench-analytics.mjs --rows 1000000 --keep   # don't clean up
//   node tools/loadtest/bench-analytics.mjs --cleanup                # only delete seed
//
// The SQL below MIRRORS packages/clickhouse buildTopEvents / buildTrend exactly
// (same FINAL, GROUP BY, bucketing) so the benchmark reflects the real path.

// ---------------------------------------------------------------------------
// CLI + CH connection
// ---------------------------------------------------------------------------

const parseArgs = (argv) => {
  const out = {
    host: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    db: process.env.CLICKHOUSE_DATABASE ?? 'clickroom',
    user: process.env.CLICKHOUSE_USER ?? 'clickroom',
    pass: process.env.CLICKHOUSE_PASSWORD ?? 'clickroom',
    // Dedicated bench tenant — kept off every real project so seed/cleanup is safe.
    project: '01BENCHAC3PROJECT0000000000',
    rows: 1_000_000,
    iterations: 30,
    batch: 50_000,
    keep: false,
    cleanup: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--keep') {
      out.keep = true
      continue
    }
    if (a === '--cleanup') {
      out.cleanup = true
      continue
    }
    if (a === '--host') {
      out.host = argv[++i]
      continue
    }
    if (a === '--project') {
      out.project = argv[++i]
      continue
    }
    if (a === '--rows') {
      out.rows = Number(argv[++i])
      continue
    }
    if (a === '--iterations') {
      out.iterations = Number(argv[++i])
      continue
    }
    if (a === '--batch') {
      out.batch = Number(argv[++i])
    }
  }
  return out
}

const opts = parseArgs(process.argv.slice(2))
const auth = `Basic ${Buffer.from(`${opts.user}:${opts.pass}`).toString('base64')}`
const chUrl = `${opts.host}/?database=${encodeURIComponent(opts.db)}`

// POST a raw SQL statement; returns response text.
const chExec = async (sql, params = {}) => {
  const qs = new URLSearchParams({ database: opts.db })
  for (const [k, v] of Object.entries(params)) qs.set(`param_${k}`, String(v))
  const res = await fetch(`${opts.host}/?${qs.toString()}`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'text/plain' },
    body: sql,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`CH ${res.status}: ${text.slice(0, 300)}`)
  return text
}

// POST rows as JSONEachRow into events.
const chInsert = async (ndjson) => {
  const res = await fetch(
    `${chUrl}&query=${encodeURIComponent('INSERT INTO events FORMAT JSONEachRow')}`,
    {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/x-ndjson' },
      body: ndjson,
    },
  )
  if (!res.ok) throw new Error(`CH insert ${res.status}: ${(await res.text()).slice(0, 300)}`)
}

// ---------------------------------------------------------------------------
// Synthetic row generation (spread across the last 7 days)
// ---------------------------------------------------------------------------

const EVENTS = [
  '$pageview',
  '$autocapture',
  'product_viewed',
  'signup_started',
  'signup_completed',
  'subscription_purchased',
  'feature_used',
  'button_click',
  'error_shown',
  '$identify',
]
const PATHS = ['/', '/pricing', '/dashboard', '/docs', '/signup', '/checkout']
const CLICKS = [
  'a:href="/pricing";text="View pricing"',
  'button:text="Start free trial"',
  'a:href="/docs";text="Read docs"',
  'button:text="Upgrade to Pro"',
]
const rnd = () => Math.random()
const pick = (a) => a[(rnd() * a.length) | 0]

// UUIDv4-ish (bench data only — not security-sensitive).
const uuid = () => {
  const h = '0123456789abcdef'
  let s = ''
  for (let i = 0; i < 32; i++) s += h[(rnd() * 16) | 0]
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

const WEEK_MS = 7 * 864e5
const START = Date.now() - WEEK_MS

// Format epoch ms → 'YYYY-MM-DD HH:mm:ss.SSS' (CH DateTime64, UTC, no trailing Z).
const chTs = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '')

const buildRow = () => {
  const event = pick(EVENTS)
  const path = pick(PATHS)
  const ts = chTs(START + rnd() * WEEK_MS)
  const isClick = event === '$autocapture'
  return JSON.stringify({
    uuid: uuid(),
    project_id: opts.project,
    event,
    distinct_id: `user_${(rnd() * 50_000) | 0}`,
    timestamp: ts,
    properties: JSON.stringify({ $current_url: `https://app.acme.co${path}` }),
    elements_chain: isClick ? pick(CLICKS) : '',
  })
}

// ---------------------------------------------------------------------------
// Query SQL — mirrors buildTopEvents / buildTrend (FINAL + GROUP BY + bucket).
// ---------------------------------------------------------------------------

const RANGE_FROM = chTs(START)
const RANGE_TO = chTs(Date.now())

const topEventsSql = `
  SELECT event, count() AS count
  FROM events FINAL
  WHERE project_id = {project_id:String}
    AND timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}
  GROUP BY event ORDER BY count DESC LIMIT 20`

const trendSql = `
  SELECT toStartOfDay(timestamp) AS bucket, count() AS count
  FROM events FINAL
  WHERE project_id = {project_id:String}
    AND timestamp BETWEEN {from:DateTime64(3)} AND {to:DateTime64(3)}
    AND event = {event:String}
  GROUP BY bucket ORDER BY bucket`

const params = { project_id: opts.project, from: RANGE_FROM, to: RANGE_TO }

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const deleteSeed = async () => {
  process.stdout.write(`  cleaning bench project ${opts.project}… `)
  await chExec('ALTER TABLE events DELETE WHERE project_id = {project_id:String}', {
    project_id: opts.project,
  })
  console.log('done (mutation queued)')
}

const seed = async () => {
  console.log(`▶ seeding ${opts.rows.toLocaleString()} rows into project ${opts.project}`)
  const existing = Number(
    (
      await chExec('SELECT count() FROM events WHERE project_id = {project_id:String}', {
        project_id: opts.project,
      })
    ).trim(),
  )
  if (existing >= opts.rows) {
    console.log(`  already has ${existing.toLocaleString()} rows — skipping seed`)
    return
  }
  const t0 = Date.now()
  let written = 0
  while (written < opts.rows) {
    const n = Math.min(opts.batch, opts.rows - written)
    const lines = new Array(n)
    for (let i = 0; i < n; i++) lines[i] = buildRow()
    await chInsert(lines.join('\n'))
    written += n
    process.stdout.write(`\r  inserted ${written.toLocaleString()}/${opts.rows.toLocaleString()}`)
  }
  const secs = (Date.now() - t0) / 1000
  console.log(
    `\n  seeded in ${secs.toFixed(1)}s (${Math.round(written / secs).toLocaleString()} rows/s)`,
  )
}

const p95 = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]
}

const benchOne = async (label, sql, extraParams = {}) => {
  const times = []
  // warm-up (fills CH mark/uncompressed caches — measure steady state)
  await chExec(sql, { ...params, ...extraParams })
  for (let i = 0; i < opts.iterations; i++) {
    const t = Date.now()
    await chExec(sql, { ...params, ...extraParams })
    times.push(Date.now() - t)
  }
  const min = Math.min(...times)
  const max = Math.max(...times)
  const avg = times.reduce((a, b) => a + b, 0) / times.length
  const p = p95(times)
  const pass = p < 1000
  console.log(
    `  ${label.padEnd(12)} p95=${p}ms  (min=${min} avg=${avg.toFixed(0)} max=${max})  ` +
      `${pass ? '✅ <1s' : '❌ >=1s'}`,
  )
  return { label, p95: p, pass }
}

const main = async () => {
  if (opts.cleanup) return void (await deleteSeed())

  await seed()

  const total = Number(
    (
      await chExec('SELECT count() FROM events WHERE project_id = {project_id:String}', {
        project_id: opts.project,
      })
    ).trim(),
  )
  console.log(
    `\n▶ benchmarking over ${total.toLocaleString()} rows, ${opts.iterations} iterations each\n`,
  )

  const results = []
  results.push(await benchOne('topEvents', topEventsSql))
  results.push(await benchOne('trend', trendSql, { event: '$pageview' }))

  const allPass = results.every((r) => r.pass)
  console.log(
    `\n${allPass ? '✅ AC-3 PASS' : '❌ AC-3 FAIL'} — topEvents/trend p95 < 1s over ~1M rows`,
  )

  if (!opts.keep) {
    console.log()
    await deleteSeed()
  } else {
    console.log(`\n  --keep set: bench rows left in place (project ${opts.project}).`)
    console.log(`  Run with --cleanup to remove them.`)
  }
  process.exit(allPass ? 0 : 1)
}

main().catch((err) => {
  console.error('\nbench failed:', err.message)
  process.exit(1)
})
