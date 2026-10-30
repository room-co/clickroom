// k6 load script for feature-flag evaluation (`POST /v1/flags` on capture-rs).
//
// Drives `POST /v1/flags` at a target RPS for a fixed DURATION using k6's
// constant-arrival-rate executor (throughput decoupled from latency). Two things
// are asserted on EVERY request, so the whole run fails if either breaks:
//
//   1. DETERMINISM — setup() first captures each pool distinct_id's evaluation
//      ONCE (the ground truth for that id). Every load request re-evaluates a
//      pool id and must return byte-identical enabled/variant/payload. Because the
//      pool is small and each id is hit thousands of times under concurrency, any
//      cache race, cross-request bleed, or nondeterministic bucketing shows up as
//      a failed `deterministic` check. (Correctness/parity vs the SDK is already
//      proven by the shared flag-vectors.json fixture; this proves STABILITY at load.)
//   2. LATENCY — http_req_duration p95 must stay under P95_MAX ms.
//
// Each pool id carries FIXED person_properties (deterministic plan/country) so the
// property-targeted flag is exercised too, and the baseline stays valid across the run.
//
// Tunables (env):
//   FLAGS_URL   capture base URL              (default http://localhost:3001)
//   TOKEN       write key                     (required)
//   RPS         target requests/s             (default 3000)
//   DURATION    test duration, k6 syntax      (default 2m)
//   POOL        distinct_id pool size         (default 2000)
//   P95_MAX     max acceptable p95 ms         (default 25)
//   PRE_VUS     preallocated VUs              (default 100)
//   MAX_VUS     max VUs                       (default 1000)
//   SUMMARY_OUT path to write summary JSON    (optional)

import { check } from 'k6'
import http from 'k6/http'
import { Counter, Trend } from 'k6/metrics'

const FLAGS_URL = __ENV.FLAGS_URL || 'http://localhost:3001'
const TOKEN = __ENV.TOKEN
const RPS = Number(__ENV.RPS || 3000)
const DURATION = __ENV.DURATION || '2m'
const POOL = Number(__ENV.POOL || 2000)
const P95_MAX = Number(__ENV.P95_MAX || 25)
const PRE_VUS = Number(__ENV.PRE_VUS || 100)
const MAX_VUS = Number(__ENV.MAX_VUS || 1000)

const params = {
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  timeout: '30s',
}

// Deterministic per-id person properties — same in setup() and load so the
// property-targeted flag evaluates identically both times.
// Order-stable serialization: goja's JSON.stringify does NOT preserve object key
// order, so comparing whole-object JSON strings yields false mismatches. Sort keys.
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  const keys = Object.keys(v).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
}

// Synthetic placeholder org_ids, shaped like the CUID-style ids real projects use.
// Never real customer/tenant data — purely structural variety so a minority of
// pool ids carry an org_id property (exercising org_id-targeted rules, wherever
// they exist) while most don't. Inert against any project that doesn't target
// these exact (fake) values.
const SAMPLE_ORG_IDS = ['bench_org_0000000001', 'bench_org_0000000002']
// Synthetic placeholder emails for the minority of ids that carry an `email`
// property distinct from the generic `user_${i}@example.com` pattern — never
// real customer data.
const SAMPLE_EMAILS = ['bench.one@example.com', 'bench.two@example.com', 'bench.three@example.com']

function propsFor(i) {
  const props = { plan: i % 3 === 0 ? 'pro' : 'free', country: 'US' }
  // Mostly generic synthesized email; a minority of ids cycle through a fixed
  // small set of alternate addresses to exercise email-targeted rules, wherever
  // they exist.
  props.email =
    i % 7 === 0 ? SAMPLE_EMAILS[(i / 7) % SAMPLE_EMAILS.length] : `user_${i}@example.com`
  // org_id mostly omitted; a minority of ids carry one of two fixed org_ids to
  // exercise org_id-targeted rules, wherever they exist.
  if (i % 11 === 0) props.org_id = SAMPLE_ORG_IDS[0]
  else if (i % 13 === 0) props.org_id = SAMPLE_ORG_IDS[1]
  return props
}
function idFor(i) {
  return `lt_user_${i}`
}

export const options = {
  scenarios: {
    flags: {
      executor: 'constant-arrival-rate',
      rate: RPS,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: PRE_VUS,
      maxVUs: MAX_VUS,
    },
  },
  thresholds: {
    checks: ['rate==1.0'], // every request 200 AND deterministic
    http_req_failed: ['rate==0.0'],
    http_req_duration: [`p(95)<${P95_MAX}`],
  },
}

const nondeterministic = new Counter('nondeterministic')
const evalLatency = new Trend('flag_eval_latency', true)

// setup()'s return value isn't passed to handleSummary() by k6, so stash the
// generic distribution telemetry here (fine for local/CI runs; not distributed).
let flagDist = null

// setup(): capture the ground-truth evaluation for every pool id, once.
export function setup() {
  if (!TOKEN) throw new Error('TOKEN (write key) is required')
  const baseline = {}
  // Generic per-flag-key distribution telemetry (informational) — works for any
  // project's flag set, discovered dynamically from whatever keys come back.
  const flagStats = {}
  for (let i = 0; i < POOL; i++) {
    const body = JSON.stringify({ distinct_id: idFor(i), person_properties: propsFor(i) })
    const res = http.post(`${FLAGS_URL}/v1/flags`, body, params)
    if (res.status !== 200) throw new Error(`setup /v1/flags status ${res.status}: ${res.body}`)
    const flags = JSON.parse(res.body).flags
    baseline[i] = flags
    for (const key of Object.keys(flags)) {
      const f = flags[key]
      if (!flagStats[key]) flagStats[key] = { enabledCount: 0, variantDist: {} }
      const stats = flagStats[key]
      if (f?.enabled) stats.enabledCount++
      if (f?.variant != null) stats.variantDist[f.variant] = (stats.variantDist[f.variant] || 0) + 1
    }
  }
  flagDist = { pool: POOL, flagStats }
  return { baseline, dist: flagDist }
}

export default function (data) {
  // Spread ids across the pool; each id is revisited many times over the run.
  const i = (__VU * 1000003 + __ITER) % POOL
  const body = JSON.stringify({ distinct_id: idFor(i), person_properties: propsFor(i) })
  const res = http.post(`${FLAGS_URL}/v1/flags`, body, params)
  evalLatency.add(res.timings.duration)

  const ok200 = check(res, { 'status is 200': (r) => r.status === 200 })
  if (!ok200) return

  // Determinism: response must equal the id's ground truth from setup, for EVERY flag.
  const expected = data.baseline[i]
  let flags
  try {
    flags = JSON.parse(res.body).flags
  } catch (_) {
    nondeterministic.add(1)
    check(null, { deterministic: () => false })
    return
  }
  let same = true
  for (const key in expected) {
    const got = flags[key]
    const exp = expected[key]
    if (
      !got ||
      got.enabled !== exp.enabled ||
      (got.variant ?? null) !== (exp.variant ?? null) ||
      stable(got.payload) !== stable(exp.payload)
    ) {
      same = false
      if (__ENV.DEBUG)
        console.log(`MISMATCH i=${i} key=${key} got=${stable(got)} exp=${stable(exp)}`)
      break
    }
  }
  if (!same) nondeterministic.add(1)
  check(flags, { deterministic: () => same })
}

export function handleSummary(data) {
  const m = data.metrics
  const reqs = m.http_reqs?.values.count || 0
  const rps = m.http_reqs?.values.rate || 0
  const p95 = m.http_req_duration?.values['p(95)'] || 0
  const p99 = m.http_req_duration?.values['p(99)'] || 0
  const nd = m.nondeterministic?.values.count || 0
  const failed = m.http_req_failed?.values.rate || 0

  // Generic per-flag-key distribution table — discovered dynamically from
  // whatever flag keys setup() saw, so this works for any project's flag set.
  const distLines = []
  if (flagDist) {
    const pool = flagDist.pool
    distLines.push(`pool            ${pool}`)
    for (const key of Object.keys(flagDist.flagStats)) {
      const stats = flagDist.flagStats[key]
      const pct = ((stats.enabledCount / pool) * 100).toFixed(1)
      const variants = Object.keys(stats.variantDist)
        .map((v) => `${v}=${stats.variantDist[v]}`)
        .join(', ')
      distLines.push(
        `  ${key}  enabled=${stats.enabledCount} (${pct}%)${variants ? `  variants: ${variants}` : ''}`,
      )
    }
  }

  const line = [
    '',
    '──────── flag-eval load ────────',
    `requests        ${reqs}  (${rps.toFixed(0)} rps)`,
    `p95 / p99       ${p95.toFixed(1)}ms / ${p99.toFixed(1)}ms  (limit ${P95_MAX}ms)`,
    `http_req_failed ${(failed * 100).toFixed(3)}%`,
    `nondeterministic ${nd}  ${nd === 0 ? '✅ deterministic under load' : '❌ NONDETERMINISTIC'}`,
    '──────── flag distribution ────',
    ...distLines,
    '────────────────────────────────',
    '',
  ].join('\n')
  const out = { stdout: line }
  if (__ENV.SUMMARY_OUT) out[__ENV.SUMMARY_OUT] = JSON.stringify(data)
  return out
}
