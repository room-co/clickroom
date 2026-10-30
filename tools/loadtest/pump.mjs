#!/usr/bin/env node
// Realistic sustained event load generator for the clickroom analytics pipeline.
// Drives lifelike traffic into capture-rs so Dashboard, Events, Funnels, Users and Breakdown
// screens fill with believable data. NOT a max-throughput correctness test — it
// never truncates or deletes anything. Pure Node.js ESM, zero npm deps (Node 22+).
//
//   node tools/loadtest/pump.mjs --key ckw_live_xxx --rate 400 --duration 180 [--days 30]
//   node tools/loadtest/pump.mjs --key ckw_live_xxx --flags new-checkout-flow,pricing-v2 --rate 400 --duration 180
//   node tools/loadtest/pump.mjs --selftest
//
// Replay a realistic multi-tenant SaaS tracking plan (incident-management
// style events) instead of the generic mix above — one write key = one
// clickroom project = a whole workspace, so the tenant "org" concept becomes just an
// `org_id` property on events. `--orgs N` builds N simulated orgs (each with
// its own small user pool + pool of ~10-30 "live" incident/alarm/etc ids
// reused across events); omit `--saas` or pass `--orgs 0` for unchanged
// default behavior:
//
//   node tools/loadtest/pump.mjs --key ckw_live_xxx --saas --orgs 150 --days 30 --rate 100 --duration 300
//
// Schema-enforcement probe traffic (proves strict/warn taxonomy enforcement holds
// up under concurrent volume, alongside the normal mix above):
//
//   node tools/loadtest/schema-seed.mjs setup --key ckw_live_xxx   # once, before the run
//   node tools/loadtest/pump.mjs --key ckw_live_xxx --rate 400 --duration 180 --schema-pct 7
//
// `--schema-pct` (default 7, 0 disables) reserves that percentage of the target
// rate for dedicated schema-probe requests, cycling through: fully valid
// `checkout_completed`/`signup_started`, strict-invalid `checkout_completed`
// (missing `order_id` or non-numeric `amount` — expect 400), and warn-invalid
// `signup_started` (missing `plan` — expect 202 but tagged schema_valid=0 in
// ClickHouse). Each probe is sent as its OWN single-event batch, never mixed
// into a normal-traffic batch: capture-rs rejects a strict violation by
// rejecting the WHOLE batch it arrived in, so bundling a deliberately-invalid
// probe alongside real pageview/autocapture events would collaterally reject
// those too and corrupt the "realistic" trend/funnel data this tool exists to
// produce. Solo batches keep each probe's request outcome cleanly attributable
// to its own category for the pass/fail counters below.
//
// Experiment simulation (--experiment-flag-key) — compresses a 15-simulated-day
// A/B test into a handful of paced checkpoints against a REAL
// experiment/flag, so you can watch ExperimentResultsPage.tsx evolve without
// waiting real days. Real bucketing (POST /v1/flags, not an assumed split),
// real "now" timestamps (never --days/SPREAD_DAYS — backdating would silently
// drop events outside the experiment's [startedAt, now()] query window). Fully
// separate code path from --rate/--duration/--saas/--flags/--schema-pct/--days,
// all of which are ignored in this mode:
//
//   node tools/loadtest/pump.mjs --key ckw_live_xxx \
//     --experiment-flag-key checkout-redesign-test --experiment-metric funnel \
//     --experiment-funnel-events checkout_started,checkout_completed \
//     --experiment-checkpoint-pause
//
//   node tools/loadtest/pump.mjs --key ckw_live_xxx \
//     --experiment-flag-key pricing-page-v2 --experiment-metric mean \
//     --experiment-mean-event revenue_captured --experiment-mean-property amount \
//     --experiment-control-mean 20 --experiment-test-mean 35 \
//     --experiment-checkpoint-delay-ms 1500

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const parseArgs = (argv) => {
  const out = {
    key: null,
    host: 'http://localhost:3001',
    rate: 400,
    duration: 180,
    users: 600,
    batch: 50,
    concurrency: 16,
    days: 0,
    flags: (process.env.FLAG_KEYS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // % of the target rate reserved for schema-enforcement probe traffic
    // (see header comment). 0 disables the whole feature (unchanged behavior).
    schemaPct: Number(process.env.SCHEMA_PCT ?? 7),
    // Skip the post-run ClickHouse check that warn-invalid probes actually
    // landed tagged schema_valid=0 (still prints the request-level pass/fail
    // counts either way — this only skips the extra async-tagging proof).
    noChVerify: false,
    // --saas: replace the generic pageview/autocapture/funnel mix with a
    // replay of a multi-tenant SaaS tracking plan.
    // --orgs N: how many simulated orgs to spread that traffic
    // across (0 = disabled — unchanged default behavior either way).
    saas: false,
    orgs: 0,
    selftest: false,
    // --experiment-flag-key: enables the experiment-simulation mode (see header
    // comment). null keeps this feature fully inert — unchanged default behavior.
    experimentFlagKey: null,
    experimentMetric: null,
    experimentFunnelEvents: [],
    experimentMeanEvent: null,
    experimentMeanProperty: null,
    experimentControlRate: 0.2,
    experimentTestRate: 0.55,
    experimentControlMean: 20,
    experimentTestMean: 35,
    experimentDays: 15,
    experimentUsersPerDay: 40,
    experimentCheckpointPause: false,
    experimentCheckpointDelayMs: 4000,
    experimentRunId: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--selftest') {
      out.selftest = true
      continue
    }
    if (a === '--key') {
      out.key = argv[++i]
      continue
    }
    if (a === '--host') {
      out.host = argv[++i]
      continue
    }
    if (a === '--rate') {
      out.rate = Number(argv[++i])
      continue
    }
    if (a === '--duration') {
      out.duration = Number(argv[++i])
      continue
    }
    if (a === '--users') {
      out.users = Number(argv[++i])
      continue
    }
    if (a === '--batch') {
      out.batch = Math.min(100, Number(argv[++i]))
      continue
    }
    if (a === '--concurrency') {
      out.concurrency = Number(argv[++i])
      continue
    }
    if (a === '--days') {
      out.days = Number(argv[++i])
      continue
    }
    if (a === '--flags') {
      out.flags = String(argv[++i] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    }
    if (a === '--schema-pct') {
      out.schemaPct = Number(argv[++i])
      continue
    }
    if (a === '--no-ch-verify') {
      out.noChVerify = true
    }
    if (a === '--saas') {
      out.saas = true
      continue
    }
    if (a === '--orgs') {
      out.orgs = Number(argv[++i])
    }
    if (a === '--experiment-flag-key') {
      out.experimentFlagKey = argv[++i]
      continue
    }
    if (a === '--experiment-metric') {
      out.experimentMetric = argv[++i]
      continue
    }
    if (a === '--experiment-funnel-events') {
      out.experimentFunnelEvents = String(argv[++i] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      continue
    }
    if (a === '--experiment-mean-event') {
      out.experimentMeanEvent = argv[++i]
      continue
    }
    if (a === '--experiment-mean-property') {
      out.experimentMeanProperty = argv[++i]
      continue
    }
    if (a === '--experiment-control-rate') {
      out.experimentControlRate = Number(argv[++i])
      continue
    }
    if (a === '--experiment-test-rate') {
      out.experimentTestRate = Number(argv[++i])
      continue
    }
    if (a === '--experiment-control-mean') {
      out.experimentControlMean = Number(argv[++i])
      continue
    }
    if (a === '--experiment-test-mean') {
      out.experimentTestMean = Number(argv[++i])
      continue
    }
    if (a === '--experiment-days') {
      out.experimentDays = Number(argv[++i])
      continue
    }
    if (a === '--experiment-users-per-day') {
      out.experimentUsersPerDay = Number(argv[++i])
      continue
    }
    if (a === '--experiment-checkpoint-pause') {
      out.experimentCheckpointPause = true
      continue
    }
    if (a === '--experiment-checkpoint-delay-ms') {
      out.experimentCheckpointDelayMs = Number(argv[++i])
      continue
    }
    if (a === '--experiment-run-id') {
      out.experimentRunId = argv[++i]
    }
  }
  return out
}

// Spread window (days) for event timestamps — set from --days in main().
// 0 keeps the default "mostly now" behavior. >0 spreads uniformly over the
// last N days so each (event, user, day) is a distinct ReplacingMergeTree key,
// multiplying the number of retained rows (and filling the trend chart).
let SPREAD_DAYS = 0
const DAY_MS = 24 * 60 * 60 * 1000

// Feature flag keys for $feature_flag_called exposure events — set from --flags
// in main(). Empty keeps the flag branch out of the event mix (no behavior change).
let FLAG_KEYS = []

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const rnd = () => Math.random()
const pick = (arr) => arr[(rnd() * arr.length) | 0]
const chance = (p) => rnd() < p
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const uid = () => Math.random().toString(36).slice(2, 10)

// Weighted pick: entries = [[value, weight], ...]
const weightedPick = (entries) => {
  let total = 0
  for (const [, w] of entries) total += w
  let r = rnd() * total
  for (const [v, w] of entries) {
    r -= w
    if (r <= 0) return v
  }
  return entries[entries.length - 1][0]
}

// ---------------------------------------------------------------------------
// Realistic reference data
// ---------------------------------------------------------------------------

const HOST = 'app.acme.co'
const PATHS = [
  '/',
  '/pricing',
  '/dashboard',
  '/settings',
  '/docs',
  '/blog/scaling-analytics',
  '/signup',
  '/checkout',
]
const urlFor = (path) => `https://${HOST}${path}`

const REFERRERS = [
  'https://www.google.com/',
  '$direct',
  'https://t.co/',
  'https://news.ycombinator.com/',
  'https://www.bing.com/',
]
const BROWSERS = ['Chrome', 'Safari', 'Firefox', 'Edge']
const OSES = ['Mac OS X', 'Windows', 'iOS', 'Android', 'Linux']
const DEVICE_TYPES = ['Desktop', 'Mobile', 'Tablet']

// Clickable elements for $autocapture. elements_chain carries literal
// text="..." and href="..." tokens so ClickHouse regex
//   text="([^"]*)"  /  href="([^"]*)"
// populate the click-breakdown columns.
const CLICK_ELEMENTS = [
  'a:href="/pricing";text="View pricing"|nav:nth-child="1"',
  'button:text="Start free trial"|div:nth-child="2"',
  'button:text="Add to cart"|div:nth-child="3"',
  'a:href="/docs";text="Read docs"|footer:nth-child="1"',
  'button:text="Upgrade to Pro"|div:nth-child="2"',
  'a:href="/signup";text="Get started"|header:nth-child="1"',
  'button:text="Subscribe"|form:nth-child="1"',
  'a:href="/dashboard";text="Go to dashboard"|nav:nth-child="2"',
]

const _PLANS = ['free', 'pro', 'team']
const AMOUNTS = { free: 0, pro: 29, team: 99 }
const FEATURES = ['search', 'export', 'invite', 'filter']

// Ordered funnel journey. Drop-off distribution below tunes the conversion curve.
const FUNNEL_STEPS = [
  'product_viewed',
  'signup_started',
  'signup_completed',
  'subscription_purchased',
]

// ---------------------------------------------------------------------------
// User pool — stable ids reused across the run. Power-law activity weights so a
// few users are very active and most are light. A fraction are anonymous.
// ---------------------------------------------------------------------------

const buildUsers = (n) => {
  const users = []
  for (let i = 0; i < n; i++) {
    const anon = chance(0.2)
    const id = anon ? `anon_${uid()}` : `user_${i}`
    // Stable session per user for this run. Feeds $session_id → ClickHouse
    // materialized session_id, which buildTopPages requires (HAVING sessions > 0).
    const session = `sid_${uid()}`
    // Power-law-ish weight: most ~1, a long tail of heavy users.
    const weight = rnd() ** 3 * 40 + 1
    users.push({
      id,
      anon,
      session,
      weight,
      browser: pick(BROWSERS),
      os: pick(OSES),
      device: pick(DEVICE_TYPES),
      plan: weightedPick([
        ['free', 6],
        ['pro', 3],
        ['team', 1],
      ]),
      identified: false,
      // Per-user furthest funnel step for this run (index into FUNNEL_STEPS, or -1).
      // Weighted so counts drop each step: ~100% → ~55% → ~35% → ~12%.
      furthest: weightedPick([
        [-1, 25],
        [0, 20],
        [1, 20],
        [2, 23],
        [3, 12],
      ]),
    })
  }
  return users
}

// Cumulative-weight sampler over the user pool (respects activity weight).
const makeUserSampler = (users) => {
  const cum = []
  let total = 0
  for (const u of users) {
    total += u.weight
    cum.push(total)
  }
  return () => {
    const r = rnd() * total
    // linear scan is fine at these pool sizes
    for (let i = 0; i < cum.length; i++) if (r <= cum[i]) return users[i]
    return users[users.length - 1]
  }
}

// ---------------------------------------------------------------------------
// Event construction
// ---------------------------------------------------------------------------

// Timestamp: mostly "now", small fraction pushed a few minutes into the past
// for trend spread. Never far in the past.
const tsFor = () => {
  if (SPREAD_DAYS > 0) {
    // Uniform over the last N days. Math.floor (not |0) — N days in ms overflows int32.
    const backMs = Math.floor(rnd() * SPREAD_DAYS * DAY_MS)
    return new Date(Date.now() - backMs).toISOString()
  }
  if (chance(0.15)) {
    const backMs = (rnd() * 8 * 60 * 1000) | 0 // up to ~8 min ago
    return new Date(Date.now() - backMs).toISOString()
  }
  return new Date().toISOString()
}

const baseCtx = (u, path) => ({
  $current_url: urlFor(path),
  $session_id: u.session,
  $host: HOST,
  $pathname: path,
  $browser: u.browser,
  $os: u.os,
  $device_type: u.device,
})

const pageviewEvent = (u) => {
  const path = pick(PATHS)
  return {
    event: '$pageview',
    distinct_id: u.id,
    timestamp: tsFor(),
    properties: {
      ...baseCtx(u, path),
      $referrer: pick(REFERRERS),
    },
  }
}

const autocaptureEvent = (u) => {
  const path = pick(PATHS)
  const chain = pick(CLICK_ELEMENTS)
  const eventType = weightedPick([
    ['click', 8],
    ['submit', 1],
    ['change', 1],
  ])
  return {
    event: '$autocapture',
    distinct_id: u.id,
    timestamp: tsFor(),
    elements_chain: chain,
    properties: {
      ...baseCtx(u, path),
      $event_type: eventType,
    },
  }
}

const identifyEvent = (u) => ({
  event: '$identify',
  distinct_id: u.id,
  timestamp: tsFor(),
  properties: {
    $set: {
      plan: u.plan,
      email: `${u.id}@example.com`,
    },
  },
})

const miscEvent = (u) => {
  const kind = weightedPick([
    ['feature_used', 5],
    ['button_click', 3],
    ['error_shown', 2],
  ])
  const path = pick(PATHS)
  const properties = { ...baseCtx(u, path) }
  if (kind === 'feature_used') properties.feature = pick(FEATURES)
  if (kind === 'error_shown') properties.error_code = pick(['E_TIMEOUT', 'E_AUTH', 'E_RATE'])
  return { event: kind, distinct_id: u.id, timestamp: tsFor(), properties }
}

// $feature_flag_called exposure — feeds the flag_events MV (migration 002),
// which reads $feature_flag / $feature_flag_response from properties.
const flagCallEvent = (u) => {
  const key = pick(FLAG_KEYS)
  const resp = weightedPick([
    ['true', 55],
    ['false', 45],
  ])
  return {
    event: '$feature_flag_called',
    distinct_id: u.id,
    timestamp: tsFor(),
    properties: {
      ...baseCtx(u, pick(PATHS)),
      $feature_flag: key,
      $feature_flag_response: resp,
    },
  }
}

// Funnel: emit this user's ordered steps up to their furthest reached step.
// Timestamps increase slightly per step so the journey reads chronologically.
const funnelEvents = (u) => {
  const out = []
  if (u.furthest < 0) return out
  // Anchor point: uniform over the last SPREAD_DAYS days (same formula as
  // tsFor()), or real "now" when spread is disabled. Never |0 for the spread
  // offset — N days in ms overflows int32.
  const anchor =
    SPREAD_DAYS > 0 ? Date.now() - Math.floor(rnd() * SPREAD_DAYS * DAY_MS) : Date.now()
  const base = anchor - ((rnd() * 4 * 60 * 1000) | 0)
  const path = u.furthest >= 3 ? '/checkout' : u.furthest >= 1 ? '/signup' : '/pricing'
  for (let step = 0; step <= u.furthest; step++) {
    const name = FUNNEL_STEPS[step]
    const properties = {
      ...baseCtx(u, path),
      plan: u.plan,
    }
    if (name === 'subscription_purchased') properties.amount = AMOUNTS[u.plan] || 29
    out.push({
      event: name,
      distinct_id: u.id,
      timestamp: new Date(base + step * 1500).toISOString(),
      properties,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Schema-enforcement probe events (--schema-pct) — see header comment.
// Event names/required properties MUST match tools/loadtest/schema-seed.mjs's
// SCHEMA_DEFS, which is what actually registers the enforcement in Postgres +
// the capture:schema:<project_id> Redis cache.
// ---------------------------------------------------------------------------

const SCHEMA_CHECKOUT_EVENT = 'checkout_completed'
const SCHEMA_SIGNUP_EVENT = 'signup_started'

// Probes get their OWN synthetic distinct_id per event (not the shared,
// reused user pool id). `signup_started` is also emitted by the normal
// funnel mix for real pool users (with `plan` always present there) — reusing
// a pool id here would make a probe's ClickHouse row indistinguishable from
// that unrelated funnel traffic, corrupting the post-run tagging check below.
// `u` is still sampled for realistic property context (plan/browser/os/etc).
const probeDistinctId = (tag) => `sch_${tag}_${uid()}`

const validCheckoutEvent = (u) => ({
  event: SCHEMA_CHECKOUT_EVENT,
  distinct_id: probeDistinctId('vc'),
  timestamp: tsFor(),
  properties: {
    ...baseCtx(u, '/checkout'),
    order_id: `ord_${uid()}`,
    amount: AMOUNTS[u.plan] || 29,
  },
})

// Strict-invalid: either drops the required `order_id` or sends `amount` as a
// non-numeric string — either violates the strict schema and the WHOLE batch
// (just this one event) must come back 400.
const strictInvalidCheckoutEvent = (u) => {
  const properties = {
    ...baseCtx(u, '/checkout'),
    order_id: `ord_${uid()}`,
    amount: AMOUNTS[u.plan] || 29,
  }
  if (chance(0.5)) delete properties.order_id
  else properties.amount = 'not-a-number'
  return {
    event: SCHEMA_CHECKOUT_EVENT,
    distinct_id: probeDistinctId('ic'),
    timestamp: tsFor(),
    properties,
  }
}

const validSignupProbeEvent = (u) => ({
  event: SCHEMA_SIGNUP_EVENT,
  distinct_id: probeDistinctId('vs'),
  timestamp: tsFor(),
  properties: { ...baseCtx(u, '/signup'), plan: u.plan },
})

// Warn-invalid: drops the required `plan`. Still 202 (warn mode never rejects
// synchronously) but should land in ClickHouse tagged schema_valid=0 — that
// async tagging is what the post-run ClickHouse check verifies.
const warnInvalidSignupEvent = (u) => ({
  event: SCHEMA_SIGNUP_EVENT,
  distinct_id: probeDistinctId('wi'),
  timestamp: tsFor(),
  properties: { ...baseCtx(u, '/signup') },
})

// ---------------------------------------------------------------------------
// SaaS tracking-plan replay (--saas / --orgs N) — replays a realistic
// multi-tenant tracking plan (incident-management style events) instead of
// the generic mix above. One write key = one clickroom project = a whole
// workspace, so the tenant "org" concept becomes just an `org_id` property on events, not a separate
// clickroom project. Fully inert unless --saas is passed with --orgs > 0 —
// buildEvents() falls back to the existing mix whenever no org/user sampler
// is supplied, so default behavior is unchanged.
// ---------------------------------------------------------------------------

const ULID_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ulid = () => {
  let s = ''
  for (let i = 0; i < 26; i++) s += ULID_CHARS[(rnd() * ULID_CHARS.length) | 0]
  return s
}
const idPool = (min, span) => Array.from({ length: min + ((rnd() * span) | 0) }, () => ulid())

const INCIDENT_TYPES = ['Outage', 'Security Incident', 'Retroactive', 'Degradation', 'Data Loss']
const INCIDENT_ROLES = ['Incident Commander', 'Comms Lead', 'Scribe', 'Ops Lead']
const SEVERITIES = ['sev1', 'sev2', 'sev3', 'sev4']
const INCIDENT_STATUSES = ['Open', 'Investigating', 'Fixing', 'Monitoring', 'Closed', 'Canceled']
const ACTION_PRIORITIES = ['low', 'medium', 'high', 'critical']
const NOTIFICATION_CHANNELS = ['sms', 'voice', 'email', 'slack', 'push_eps', 'teams_call']

// Two distinct values from an ordered set (for from/to transition props) —
// avoids the (rare but pointless) "from === to" case.
const distinctPair = (set) => {
  const from = pick(set)
  let to = pick(set)
  if (to === from) to = set[(set.indexOf(from) + 1) % set.length]
  return [from, to]
}

// Build a pool of simulated saas orgs. Each gets its own small user pool
// (~5-10 distinct_ids) and its own pool of ~10-30 "live" entity ids
// (incidents/alarms/etc) that events reference repeatedly across the run —
// real traffic touches the same incident many times over its lifecycle
// rather than minting a fresh random id per event.
const buildSaasOrgs = (n) => {
  const orgs = []
  for (let i = 0; i < n; i++) {
    const id = `saas-org-${String(i + 1).padStart(3, '0')}`
    const name = `Org ${i + 1}`
    const users = Array.from({ length: 5 + ((rnd() * 6) | 0) }, (_, j) => ({
      id: `${id}-user-${j}`,
      weight: rnd() ** 2 * 10 + 1,
    }))
    orgs.push({
      id,
      name,
      // Light power-law skew: a few large orgs, many small ones.
      weight: rnd() ** 3 * 20 + 1,
      users,
      sampleUser: makeUserSampler(users),
      incidentIds: idPool(10, 21),
      alarmIds: idPool(10, 16),
      policyIds: idPool(2, 4),
      scheduleIds: idPool(2, 4),
      actionItemIds: idPool(10, 21),
      postmortemIds: idPool(3, 8),
      teamIds: idPool(2, 5),
      serviceIds: idPool(3, 8),
    })
  }
  return orgs
}

const makeOrgSampler = (orgs) => {
  const cum = []
  let total = 0
  for (const o of orgs) {
    total += o.weight
    cum.push(total)
  }
  return () => {
    const r = rnd() * total
    for (let i = 0; i < cum.length; i++) if (r <= cum[i]) return orgs[i]
    return orgs[orgs.length - 1]
  }
}

// Picks an org (weighted), then a user within that org (weighted). Returns a
// closure of the shape buildEvents()/buildSaasEvents() expect: () => { org, user }.
const sampleOrgUserFactory = (orgs) => {
  const sampleOrg = makeOrgSampler(orgs)
  return () => {
    const org = sampleOrg()
    const user = org.sampleUser()
    return { org, user }
  }
}

// Every saas event carries these two globals in addition to its own props.
const saasGlobals = (org) => ({ schema_version: 1, org_id: org.id })

const saasEvent = (org, user, name, extra) => ({
  event: name,
  distinct_id: user.id,
  timestamp: tsFor(),
  properties: { ...saasGlobals(org), ...extra },
})

const saasPageviewEvent = (org, user) => {
  const properties = { ...saasGlobals(org) }
  if (chance(0.7)) properties.$current_url = urlFor(pick(PATHS))
  return { event: '$pageview', distinct_id: user.id, timestamp: tsFor(), properties }
}

// Note: org_id is intentionally duplicated here (also present via
// saasGlobals) — matches real saas identify calls, which send org_id as
// an ordinary user property alongside the global one.
const saasIdentifyEvent = (org, user) => ({
  event: '$identify',
  distinct_id: user.id,
  timestamp: tsFor(),
  properties: {
    ...saasGlobals(org),
    email: `${user.id}@example.com`,
    name: `User ${user.id.split('-').pop()}`,
    org_id: org.id,
    org_name: org.name,
  },
})

const SAAS_BUILDERS = {
  incident_declared: (org, user) =>
    saasEvent(org, user, 'incident_declared', {
      type: pick(INCIDENT_TYPES),
      id: pick(org.incidentIds),
    }),
  incident_role_assigned: (org, user) =>
    saasEvent(org, user, 'incident_role_assigned', {
      incident_id: pick(org.incidentIds),
      role: pick(INCIDENT_ROLES),
    }),
  incident_severity_changed: (org, user) => {
    const [from, to] = distinctPair(SEVERITIES)
    return saasEvent(org, user, 'incident_severity_changed', {
      incident_id: pick(org.incidentIds),
      from,
      to,
    })
  },
  incident_status_update_posted: (org, user) =>
    saasEvent(org, user, 'incident_status_update_posted', {
      incident_id: pick(org.incidentIds),
      has_message: chance(0.7),
    }),
  incident_status_transitioned: (org, user) => {
    const [from, to] = distinctPair(INCIDENT_STATUSES)
    return saasEvent(org, user, 'incident_status_transitioned', {
      incident_id: pick(org.incidentIds),
      from,
      to,
    })
  },
  incident_closed: (org, user) =>
    saasEvent(org, user, 'incident_closed', {
      incident_id: pick(org.incidentIds),
      severity: pick(SEVERITIES),
    }),
  incident_canceled: (org, user) =>
    saasEvent(org, user, 'incident_canceled', { incident_id: pick(org.incidentIds) }),
  alarm_acknowledged: (org, user) =>
    saasEvent(org, user, 'alarm_acknowledged', { alarm_id: pick(org.alarmIds) }),
  alarm_resolved: (org, user) =>
    saasEvent(org, user, 'alarm_resolved', { alarm_id: pick(org.alarmIds) }),
  alarm_linked_to_incident: (org, user) =>
    saasEvent(org, user, 'alarm_linked_to_incident', {
      alarm_id: pick(org.alarmIds),
      incident_id: pick(org.incidentIds),
    }),
  escalation_policy_saved: (org, user) =>
    saasEvent(org, user, 'escalation_policy_saved', {
      policy_id: pick(org.policyIds),
      level_count: 1 + ((rnd() * 5) | 0), // 1-5
    }),
  oncall_schedule_saved: (org, user) =>
    saasEvent(org, user, 'oncall_schedule_saved', { schedule_id: pick(org.scheduleIds) }),
  action_item_created: (org, user) =>
    saasEvent(org, user, 'action_item_created', {
      incident_id: pick(org.incidentIds),
      priority: pick(ACTION_PRIORITIES),
    }),
  action_item_completed: (org, user) =>
    saasEvent(org, user, 'action_item_completed', {
      action_item_id: pick(org.actionItemIds),
    }),
  postmortem_created: (org, user) =>
    saasEvent(org, user, 'postmortem_created', {
      incident_id: pick(org.incidentIds),
      from_template: chance(0.6),
    }),
  postmortem_published: (org, user) =>
    saasEvent(org, user, 'postmortem_published', { postmortem_id: pick(org.postmortemIds) }),
  signup_completed: (org, user) => saasEvent(org, user, 'signup_completed', {}),
  team_saved: (org, user) => saasEvent(org, user, 'team_saved', { team_id: pick(org.teamIds) }),
  service_saved: (org, user) =>
    saasEvent(org, user, 'service_saved', { service_id: pick(org.serviceIds) }),
  notification_rule_saved: (org, user) =>
    saasEvent(org, user, 'notification_rule_saved', { channel: pick(NOTIFICATION_CHANNELS) }),
  custom_field_updated: (org, user) =>
    saasEvent(org, user, 'custom_field_updated', {
      incident_id: pick(org.incidentIds),
      field_count: 1 + ((rnd() * 4) | 0), // 1-4
    }),
  $pageview: saasPageviewEvent,
  $identify: saasIdentifyEvent,
}

// Weighted mix approximating real-world frequency: pageviews and incident
// status-update noise dominate; postmortem/team/service saves are rarer.
// ~30% $pageview / ~2% $identify per the tracking-plan spec; the rest split
// across the 21 named saas events.
const SAAS_MIX = [
  ['$pageview', 30],
  ['$identify', 2],
  ['incident_status_update_posted', 10],
  ['incident_status_transitioned', 8],
  ['alarm_acknowledged', 6],
  ['alarm_resolved', 5],
  ['action_item_created', 5],
  ['incident_declared', 4],
  ['incident_role_assigned', 4],
  ['alarm_linked_to_incident', 4],
  ['action_item_completed', 4],
  ['incident_severity_changed', 3],
  ['incident_closed', 3],
  ['postmortem_created', 2],
  ['notification_rule_saved', 2],
  ['custom_field_updated', 2],
  ['incident_canceled', 1],
  ['escalation_policy_saved', 1],
  ['oncall_schedule_saved', 1],
  ['postmortem_published', 1],
  ['team_saved', 1],
  ['service_saved', 1],
  ['signup_completed', 0.5],
]

// sampleOrgUser: closure from sampleOrgUserFactory() — () => { org, user }.
const buildSaasEvents = (sampleOrgUser) => {
  const { org, user } = sampleOrgUser()
  const name = weightedPick(SAAS_MIX)
  return [SAAS_BUILDERS[name](org, user)]
}

// Build one event (or a short funnel burst) for a sampled user.
// Returns an array so funnel journeys can emit multiple ordered events.
// `sampleOrgUser`, when supplied (--saas with --orgs > 0), dispatches into
// the saas tracking-plan replay instead — omitting it (the default) keeps
// today's generic pageview/autocapture/funnel mix fully unchanged.
const buildEvents = (sampleUser, sampleOrgUser) => {
  if (sampleOrgUser) return buildSaasEvents(sampleOrgUser)
  const u = sampleUser()
  const mix = [
    ['pageview', 40],
    ['autocapture', 30],
    ['funnel', 25],
    ['misc', 5],
  ]
  if (FLAG_KEYS.length > 0) mix.push(['flag', 15])
  const kind = weightedPick(mix)

  if (kind === 'pageview') return [pageviewEvent(u)]
  if (kind === 'autocapture') return [autocaptureEvent(u)]
  if (kind === 'flag') return [flagCallEvent(u)]
  if (kind === 'misc') {
    // Occasionally identify a user so the Users view has identified people.
    if (!u.identified && chance(0.15)) {
      u.identified = true
      return [identifyEvent(u)]
    }
    return [miscEvent(u)]
  }
  // funnel
  const evs = funnelEvents(u)
  return evs.length ? evs : [pageviewEvent(u)]
}

// ---------------------------------------------------------------------------
// HTTP send with 429 / error handling and bounded retries
// ---------------------------------------------------------------------------

const postBatch = async (opts, batch, stats) => {
  const url = `${opts.host}/v1/capture?token=${encodeURIComponent(opts.key)}`
  const body = JSON.stringify({ batch })
  const maxAttempts = 4
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      if (res.status === 202) {
        let accepted = batch.length
        try {
          const json = await res.json()
          if (json && typeof json.accepted === 'number') accepted = json.accepted
        } catch {
          /* keep default */
        }
        stats.batches++
        stats.accepted += accepted
        return
      }
      if (res.status === 429) {
        stats.rateLimited++
        const ra = Number(res.headers.get('retry-after'))
        const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 250
        await sleep(waitMs)
        continue
      }
      // Other status = error. Small retry.
      stats.errors++
      await sleep(150)
    } catch {
      // network / 5xx-thrown / abort — never crash
      stats.errors++
      await sleep(150)
    }
  }
  // Exhausted retries; already counted. Drop batch (never delete/truncate anything).
}

// Solo-batch send for a schema probe: one event, one POST, so the response
// status is unambiguously attributable to that single event. Tracks expected
// vs actual status per category — a mismatch under load is exactly the
// correctness bug this probe traffic exists to catch (e.g. a strict violation
// that slips through as 202, or a clean event wrongly rejected).
const EXPECTED_STATUS = {
  valid_checkout: 202,
  strict_invalid_checkout: 400,
  valid_signup: 202,
  warn_invalid_signup: 202,
}

const postSchemaProbe = async (opts, event, category, schemaStats, warnInvalidIds) => {
  const url = `${opts.host}/v1/capture?token=${encodeURIComponent(opts.key)}`
  const body = JSON.stringify({ batch: [event] })
  const s = schemaStats[category]
  s.sent++
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    const expected = EXPECTED_STATUS[category]
    if (res.status === expected) s.asExpected++
    else {
      s.unexpected++
      s.unexpectedStatuses.add(res.status)
    }
    // Track ids for the post-run ClickHouse tagging check (bounded so a long
    // run doesn't grow this unbounded — a few hundred samples is plenty).
    if (category === 'warn_invalid_signup' && warnInvalidIds.length < 500) {
      warnInvalidIds.push(event.distinct_id)
    }
  } catch {
    s.errors = (s.errors || 0) + 1
  }
}

// ---------------------------------------------------------------------------
// Experiment simulation (--experiment-flag-key) — see header comment.
// Real bucketing via /v1/flags + real "now" timestamps, compressed into paced
// day-checkpoints. Fully separate from the tick-based --rate/--duration
// scheduler above; --saas/--flags/--schema-pct/--days are ignored here.
// ---------------------------------------------------------------------------

const validateExperimentOpts = (opts) => {
  if (opts.experimentMetric !== 'funnel' && opts.experimentMetric !== 'mean') {
    console.error('error: --experiment-metric funnel|mean is required with --experiment-flag-key')
    process.exit(1)
  }
  if (opts.experimentMetric === 'funnel' && opts.experimentFunnelEvents.length === 0) {
    console.error(
      'error: --experiment-funnel-events a,b,c is required when --experiment-metric funnel',
    )
    process.exit(1)
  }
  if (
    opts.experimentMetric === 'mean' &&
    (!opts.experimentMeanEvent || !opts.experimentMeanProperty)
  ) {
    console.error(
      'error: --experiment-mean-event and --experiment-mean-property are required when --experiment-metric mean',
    )
    process.exit(1)
  }
  for (const [name, val] of [
    ['--experiment-control-rate', opts.experimentControlRate],
    ['--experiment-test-rate', opts.experimentTestRate],
  ]) {
    if (!(val >= 0 && val <= 1)) {
      console.error(`error: ${name} must be between 0 and 1 (got ${val})`)
      process.exit(1)
    }
  }
}

// Real flag-eval — reads back whichever variant capture-rs actually assigned,
// mirroring apps/web/e2e/helpers/capture.ts's seedExperimentPopulation (don't
// assume the configured rollout split).
const evalFlag = async (opts, distinctId) => {
  const url = `${opts.host}/v1/flags`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ distinct_id: distinctId }),
  })
  const body = await res.json()
  const variant = body?.flags?.[opts.experimentFlagKey]?.variant
  if (typeof variant !== 'string' || !variant) {
    throw new Error(
      `no variant for "${opts.experimentFlagKey}" — is the flag multivariate + active?`,
    )
  }
  return variant
}

// Chunked flag eval (chunk size 20, matching seedExperimentPopulation) so a
// day's user population never fires more than `chunkSize` simultaneous
// /v1/flags requests. Returns Map<variant, string[]> of distinct ids.
const evalInChunks = async (opts, distinctIds, chunkSize = 20) => {
  const byVariant = new Map()
  for (let i = 0; i < distinctIds.length; i += chunkSize) {
    const chunk = distinctIds.slice(i, i + chunkSize)
    const variants = await Promise.all(chunk.map((id) => evalFlag(opts, id)))
    for (let j = 0; j < chunk.length; j++) {
      const variant = variants[j]
      if (!byVariant.has(variant)) byVariant.set(variant, [])
      byVariant.get(variant).push(chunk[j])
    }
  }
  return byVariant
}

// Pure builder — same $feature_flag_called shape as flagCallEvent (pump.mjs
// ~371-387), but $feature_flag_response is the REAL assigned variant, and
// timestamp is always real "now" (never tsFor()/SPREAD_DAYS — backdated
// timestamps would fall outside the experiment's [startedAt, now()] query
// window and silently vanish from results task-a spec).
const exposureEvent = (distinctId, flagKey, variant) => ({
  event: '$feature_flag_called',
  distinct_id: distinctId,
  timestamp: new Date().toISOString(),
  properties: {
    $feature_flag: flagKey,
    $feature_flag_response: variant,
  },
})

// Per-variant outcome events for the configured primary metric. Returns
// { events, converted, value } so the caller can update cumulative stats.
const buildOutcomeEvents = (opts, variant, distinctId) => {
  const now = Date.now()
  if (opts.experimentMetric === 'funnel') {
    const rate = variant === 'control' ? opts.experimentControlRate : opts.experimentTestRate
    const converted = Math.random() < rate
    const steps = converted ? opts.experimentFunnelEvents : opts.experimentFunnelEvents.slice(0, 1)
    const events = steps.map((name, idx) => ({
      event: name,
      distinct_id: distinctId,
      timestamp: new Date(now + idx * 3000).toISOString(),
      properties: {},
    }))
    return { events, converted, value: undefined }
  }
  // mean
  const mean = variant === 'control' ? opts.experimentControlMean : opts.experimentTestMean
  const value = mean * (0.8 + Math.random() * 0.4)
  const events = [
    {
      event: opts.experimentMeanEvent,
      distinct_id: distinctId,
      timestamp: new Date(now).toISOString(),
      properties: { [opts.experimentMeanProperty]: value },
    },
  ]
  return { events, converted: undefined, value }
}

const printDayBanner = (day, totalDays, cumulative) => {
  console.log(`\n=== experiment day ${day}/${totalDays} ===`)
  for (const [variant, c] of Object.entries(cumulative)) {
    if (c.exposed === 0) continue
    const detail =
      c.converted !== undefined
        ? `converted=${c.converted} (${((c.converted / c.exposed) * 100).toFixed(1)}%)`
        : `mean=${(c.sum / c.exposed).toFixed(2)}`
    console.log(`  ${variant.padEnd(10)} exposed=${c.exposed} ${detail}`)
  }
}

const printFinalSummary = (cumulative) => {
  console.log('\n=== experiment simulation final summary ===')
  for (const [variant, c] of Object.entries(cumulative)) {
    const detail =
      c.converted !== undefined
        ? `converted=${c.converted} (${c.exposed ? ((c.converted / c.exposed) * 100).toFixed(1) : '0.0'}%)`
        : `mean=${(c.exposed ? c.sum / c.exposed : 0).toFixed(2)}`
    console.log(`  ${variant.padEnd(10)} exposed=${c.exposed} ${detail}`)
  }
  console.log(
    '\nOpen the ExperimentResultsPage and reload — no auto-poll is wired, see verification below.',
  )
}

const waitForEnter = () =>
  new Promise((resolve) => {
    process.stdin.resume()
    process.stdin.once('data', () => {
      process.stdin.pause()
      resolve()
    })
  })

const runExperimentSimulation = async (opts) => {
  validateExperimentOpts(opts)
  const runId = opts.experimentRunId || uid()
  const stats = { batches: 0, sent: 0, accepted: 0, rateLimited: 0, errors: 0 }
  const cumulative = {}

  for (let day = 1; day <= opts.experimentDays; day++) {
    const dayIds = Array.from(
      { length: opts.experimentUsersPerDay },
      (_, i) => `pump-exp-${runId}-d${day}-${i}`,
    )

    const byVariant = await evalInChunks(opts, dayIds, 20)

    const dayBatch = []
    for (const [variant, ids] of byVariant) {
      if (!cumulative[variant]) cumulative[variant] = { exposed: 0, converted: 0, sum: 0 }
      const c = cumulative[variant]
      // Track whether this metric produces conversions or means, so
      // print*() can pick the right display (mean metric never increments
      // `converted`, so leave it undefined until the first funnel result).
      if (opts.experimentMetric === 'funnel' && c.converted === undefined) c.converted = 0
      for (const distinctId of ids) {
        dayBatch.push(exposureEvent(distinctId, opts.experimentFlagKey, variant))
        const outcome = buildOutcomeEvents(opts, variant, distinctId)
        dayBatch.push(...outcome.events)
        c.exposed++
        if (outcome.converted) c.converted = (c.converted || 0) + 1
        if (outcome.value != null) c.sum += outcome.value
      }
    }

    // Respect the existing 100-event /v1/capture cap — chunk the day's batch.
    for (let i = 0; i < dayBatch.length; i += 100) {
      stats.sent += Math.min(100, dayBatch.length - i)
      await postBatch(opts, dayBatch.slice(i, i + 100), stats)
    }

    printDayBanner(day, opts.experimentDays, cumulative)
    if (opts.experimentCheckpointPause) {
      console.log('  (press Enter to advance to the next simulated day)')
      await waitForEnter()
    } else {
      await sleep(opts.experimentCheckpointDelayMs)
    }
  }

  printFinalSummary(cumulative)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// ClickHouse verification — confirms warn-mode violations sent during the run
// actually landed tagged schema_valid=0 (proves the ASYNC ingest-side tagging
// survived the volume run, not just the synchronous 202 capture response).
// Best-effort: any failure here is reported but never fails the pump run.
// ---------------------------------------------------------------------------

const chConfig = () => ({
  url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  db: process.env.CLICKHOUSE_DATABASE ?? 'clickroom',
  user: process.env.CLICKHOUSE_USER ?? 'clickroom',
  pass: process.env.CLICKHOUSE_PASSWORD ?? 'clickroom',
})

const verifyWarnTagging = async (ids) => {
  if (ids.length === 0) return null
  const ch = chConfig()
  const auth = `Basic ${Buffer.from(`${ch.user}:${ch.pass}`).toString('base64')}`
  // Give the async ingest batcher (default INGEST_BATCH_MAX_WAIT_MS=500) time
  // to flush before querying.
  await sleep(3000)
  const idList = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(',')
  const sql =
    `SELECT count() AS total, countIf(schema_valid = 0) AS invalid ` +
    `FROM events WHERE event = 'signup_started' AND distinct_id IN (${idList})`
  const qs = new URLSearchParams({ database: ch.db, query: `${sql} FORMAT JSONEachRow` })
  const res = await fetch(`${ch.url}/?${qs.toString()}`, {
    method: 'GET',
    headers: { authorization: auth },
  })
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const text = (await res.text()).trim()
  if (!text) return { total: 0, invalid: 0, sent: ids.length }
  const row = JSON.parse(text.split('\n')[0])
  return { total: Number(row.total), invalid: Number(row.invalid), sent: ids.length }
}

// ---------------------------------------------------------------------------
// Scheduler — steady token-style pacing with bounded in-flight concurrency
// ---------------------------------------------------------------------------

const run = async (opts) => {
  const users = buildUsers(opts.users)
  const sampleUser = makeUserSampler(users)
  const seenIds = new Set()
  const seenOrgs = new Set()

  // --saas + --orgs N: build the org/user pool once and hand buildEvents()
  // a sampler closure. null whenever disabled — buildEvents() then falls back
  // to the existing generic mix, unchanged.
  const saasOrgs = opts.saas && opts.orgs > 0 ? buildSaasOrgs(opts.orgs) : null
  const sampleOrgUser = saasOrgs ? sampleOrgUserFactory(saasOrgs) : null

  const stats = { batches: 0, sent: 0, accepted: 0, rateLimited: 0, errors: 0 }
  const startedAt = Date.now()
  const endAt = startedAt + opts.duration * 1000

  // Schema-probe traffic (--schema-pct). Disabled entirely when schemaPct <= 0.
  const schemaStats = {
    valid_checkout: { sent: 0, asExpected: 0, unexpected: 0, unexpectedStatuses: new Set() },
    strict_invalid_checkout: {
      sent: 0,
      asExpected: 0,
      unexpected: 0,
      unexpectedStatuses: new Set(),
    },
    valid_signup: { sent: 0, asExpected: 0, unexpected: 0, unexpectedStatuses: new Set() },
    warn_invalid_signup: { sent: 0, asExpected: 0, unexpected: 0, unexpectedStatuses: new Set() },
  }
  const warnInvalidIds = []
  let schemaInFlight = 0

  let inFlight = 0
  let stopping = false

  const effRate = () => stats.accepted / Math.max(0.001, (Date.now() - startedAt) / 1000)

  const summary = (final) => {
    const wall = (Date.now() - startedAt) / 1000
    if (final) {
      console.log('\n=== pump summary ===')
      console.log(`wall time      : ${wall.toFixed(1)}s`)
      console.log(`target rate    : ${opts.rate} ev/s`)
      console.log(`effective rate : ${(stats.accepted / Math.max(0.001, wall)).toFixed(1)} ev/s`)
      console.log(`events sent    : ${stats.sent}`)
      console.log(`events accepted: ${stats.accepted}`)
      console.log(`batches        : ${stats.batches}`)
      console.log(`429 rate-limited: ${stats.rateLimited}`)
      console.log(`errors         : ${stats.errors}`)
      console.log(`distinct users : ${seenIds.size}`)
      if (opts.saas) console.log(`distinct orgs  : ${seenOrgs.size}`)
      if (opts.schemaPct > 0) {
        console.log('\n--- schema-enforcement probes (--schema-pct) ---')
        for (const [category, s] of Object.entries(schemaStats)) {
          const expected = EXPECTED_STATUS[category]
          const flag = s.unexpected > 0 || (s.errors || 0) > 0 ? '❌' : '✅'
          console.log(
            `${flag} ${category.padEnd(24)} sent=${s.sent} expected(${expected})=${s.asExpected} ` +
              `unexpected=${s.unexpected}${s.unexpectedStatuses.size ? ` [${[...s.unexpectedStatuses].join(',')}]` : ''} ` +
              `errors=${s.errors || 0}`,
          )
        }
      }
    } else {
      console.log(
        `[t+${wall.toFixed(0)}s] eff=${effRate().toFixed(0)}/${opts.rate} ev/s ` +
          `batches=${stats.batches} accepted=${stats.accepted} ` +
          `429=${stats.rateLimited} err=${stats.errors} inflight=${inFlight}`,
      )
    }
  }

  // Progress line every ~2s.
  const progressTimer = setInterval(() => summary(false), 2000)

  // SIGINT: print summary and exit cleanly.
  const onSig = () => {
    stopping = true
    clearInterval(progressTimer)
    clearInterval(tickTimer)
    clearInterval(schemaTickTimer)
    summary(true)
    process.exit(0)
  }
  process.on('SIGINT', onSig)

  // Steady tick: every TICK_MS emit ~rate*TICK_MS/1000 events, split into batches.
  const TICK_MS = 200
  const perTick = Math.max(1, Math.round(opts.rate * (TICK_MS / 1000)))

  // Schema-probe tick: separate, lower-rate schedule reserving schemaPct% of
  // the target rate, cycling evenly through the four probe categories. Runs
  // concurrently with the main tick (interleaved in time) but always as its
  // own solo-event batch — see header comment for why.
  const schemaRate = opts.rate * (Math.max(0, opts.schemaPct) / 100)
  const schemaPerTick = Math.max(0, Math.round(schemaRate * (TICK_MS / 1000)))
  const SCHEMA_BUILDERS = [
    ['valid_checkout', validCheckoutEvent],
    ['strict_invalid_checkout', strictInvalidCheckoutEvent],
    ['valid_signup', validSignupProbeEvent],
    ['warn_invalid_signup', warnInvalidSignupEvent],
  ]
  const schemaTick = () => {
    if (stopping || opts.schemaPct <= 0) return
    if (Date.now() >= endAt) return
    if (schemaInFlight >= opts.concurrency) return
    for (let i = 0; i < schemaPerTick; i++) {
      const [category, build] = pick(SCHEMA_BUILDERS)
      const u = sampleUser()
      const event = build(u)
      seenIds.add(event.distinct_id)
      schemaInFlight++
      postSchemaProbe(opts, event, category, schemaStats, warnInvalidIds).finally(() => {
        schemaInFlight--
      })
    }
  }

  const dispatch = (batch) => {
    inFlight++
    stats.sent += batch.length
    for (const e of batch) {
      seenIds.add(e.distinct_id)
      if (e.properties && typeof e.properties.org_id === 'string') seenOrgs.add(e.properties.org_id)
    }
    postBatch(opts, batch, stats).finally(() => {
      inFlight--
    })
  }

  const tick = () => {
    if (stopping) return
    if (Date.now() >= endAt) return // stop is handled by the outer loop
    // Respect concurrency: skip issuing if saturated (rate self-corrects next tick).
    if (inFlight >= opts.concurrency) return

    let remaining = perTick
    const budget = opts.concurrency - inFlight
    let issued = 0
    while (remaining > 0 && issued < budget) {
      const target = Math.min(opts.batch, remaining)
      const batch = []
      while (batch.length < target) {
        const evs = buildEvents(sampleUser, sampleOrgUser)
        for (const e of evs) {
          if (batch.length >= opts.batch) break
          batch.push(e)
        }
      }
      remaining -= batch.length
      dispatch(batch)
      issued++
    }
  }

  const tickTimer = setInterval(tick, TICK_MS)
  const schemaTickTimer = setInterval(schemaTick, TICK_MS)

  // Wait until duration elapses.
  while (Date.now() < endAt && !stopping) await sleep(100)

  clearInterval(tickTimer)
  clearInterval(schemaTickTimer)
  clearInterval(progressTimer)

  // Drain in-flight requests.
  const drainUntil = Date.now() + 10000
  while ((inFlight > 0 || schemaInFlight > 0) && Date.now() < drainUntil) await sleep(100)

  process.removeListener('SIGINT', onSig)
  summary(true)

  if (opts.schemaPct > 0 && !opts.noChVerify && warnInvalidIds.length > 0) {
    console.log('\n--- verifying warn-invalid tagging in ClickHouse (schema_valid=0) ---')
    try {
      const result = await verifyWarnTagging(warnInvalidIds)
      if (result) {
        const pass = result.invalid === result.sent && result.total === result.sent
        console.log(
          `${pass ? '✅' : '❌'} sent=${result.sent} found_in_ch=${result.total} tagged_invalid=${result.invalid}`,
        )
        if (!pass) {
          console.log(
            '  (a shortfall can also mean ingest has not flushed yet for a run this short — ' +
              're-run the check manually after a few more seconds if unsure)',
          )
        }
      }
    } catch (e) {
      console.log(`⚠️  ClickHouse verification skipped/failed: ${e.message}`)
    }
  }

  process.exit(0)
}

// ---------------------------------------------------------------------------
// Self-test — builds ~200 events and asserts invariants. No network.
// ---------------------------------------------------------------------------

const selftest = () => {
  const assert = (cond, msg) => {
    if (!cond) {
      console.error(`SELFTEST FAIL: ${msg}`)
      process.exit(1)
    }
  }

  const users = buildUsers(300)
  const sampleUser = makeUserSampler(users)

  const events = []
  while (events.length < 200) {
    for (const e of buildEvents(sampleUser)) events.push(e)
  }

  // 1) Every event has non-empty event + distinct_id.
  for (const e of events) {
    assert(typeof e.event === 'string' && e.event.length > 0, 'event name non-empty')
    assert(typeof e.distinct_id === 'string' && e.distinct_id.length > 0, 'distinct_id non-empty')
  }

  // 2) Autocapture events carry text=" and href=" tokens in elements_chain.
  const autos = events.filter((e) => e.event === '$autocapture')
  for (const e of autos) {
    assert(typeof e.elements_chain === 'string', 'autocapture has elements_chain')
    assert(/text="([^"]*)"/.test(e.elements_chain), 'elements_chain has text="..."')
  }
  // At least some autocapture chains carry an href token (element set mixes buttons/links).
  assert(
    CLICK_ELEMENTS.every((c) => /text="([^"]*)"/.test(c)),
    'all click elements have text token',
  )
  assert(
    CLICK_ELEMENTS.some((c) => /href="([^"]*)"/.test(c)),
    'some click elements have href token',
  )

  // 3) Funnel step counts monotonically non-increasing across the ordered journey.
  const funnelUsers = buildUsers(2000)
  const stepUsers = FUNNEL_STEPS.map(() => new Set())
  for (const u of funnelUsers) {
    for (const ev of funnelEvents(u)) {
      const idx = FUNNEL_STEPS.indexOf(ev.event)
      if (idx >= 0) stepUsers[idx].add(u.id)
    }
  }
  const counts = stepUsers.map((s) => s.size)
  for (let i = 1; i < counts.length; i++) {
    assert(
      counts[i] <= counts[i - 1],
      `funnel non-increasing at step ${i} (${counts.join(' -> ')})`,
    )
  }

  // 4) Batch size never exceeds 100 (simulate batch assembly at max batch).
  const opts = { batch: 100 }
  for (let n = 0; n < 50; n++) {
    const batch = []
    while (batch.length < opts.batch) {
      for (const e of buildEvents(sampleUser)) {
        if (batch.length >= opts.batch) break
        batch.push(e)
      }
    }
    assert(batch.length <= 100, `batch <= 100 (got ${batch.length})`)
  }

  // 5) Schema-probe builders shape out correctly (valid have required props;
  // invalid variants actually violate what they're supposed to).
  const probeUser = sampleUser()
  const validCheckout = validCheckoutEvent(probeUser)
  assert(
    typeof validCheckout.properties.order_id === 'string' &&
      typeof validCheckout.properties.amount === 'number',
    'valid checkout has order_id (string) + amount (number)',
  )
  for (let n = 0; n < 20; n++) {
    const bad = strictInvalidCheckoutEvent(probeUser)
    const missingOrderId = !('order_id' in bad.properties)
    const badAmount = typeof bad.properties.amount !== 'number'
    assert(missingOrderId || badAmount, 'strict-invalid checkout violates order_id or amount')
  }
  const validSignup = validSignupProbeEvent(probeUser)
  assert(typeof validSignup.properties.plan === 'string', 'valid signup probe has plan')
  const warnInvalidSignup = warnInvalidSignupEvent(probeUser)
  assert(!('plan' in warnInvalidSignup.properties), 'warn-invalid signup omits plan')

  // 6) Saas replay (--saas/--orgs) invariants — no network.
  const saasOrgs = buildSaasOrgs(5)
  assert(saasOrgs.length === 5, 'saas org pool built (5)')
  for (const org of saasOrgs) {
    assert(
      org.incidentIds.length >= 10 && org.incidentIds.length <= 30,
      'org live-incident pool sized 10-30',
    )
    assert(org.users.length >= 5 && org.users.length <= 10, 'org user pool sized 5-10')
  }
  const sampleOrgUser = sampleOrgUserFactory(saasOrgs)
  const saasEvents = []
  for (let n = 0; n < 500; n++) {
    for (const e of buildSaasEvents(sampleOrgUser)) saasEvents.push(e)
  }
  for (const e of saasEvents) {
    assert(e.properties.schema_version === 1, 'saas event has schema_version:1')
    assert(
      typeof e.properties.org_id === 'string' && e.properties.org_id.length > 0,
      'saas event has org_id',
    )
  }
  // incident_id-bearing events (role/severity/status/close/etc) reference the
  // org's bounded live-incident pool — reused ids, not a fresh one per event.
  const orgById = new Map(saasOrgs.map((o) => [o.id, o]))
  const incidentIdEvents = saasEvents.filter((e) => typeof e.properties.incident_id === 'string')
  assert(incidentIdEvents.length > 0, 'some saas events reference incident_id')
  for (const e of incidentIdEvents) {
    const org = orgById.get(e.properties.org_id)
    assert(
      org.incidentIds.includes(e.properties.incident_id),
      'incident_id drawn from org live-incident pool (reused)',
    )
  }
  // buildEvents() dispatches into the saas path when sampleOrgUser is
  // supplied, and batch assembly still respects the 100-event cap.
  for (let n = 0; n < 20; n++) {
    const batch = []
    while (batch.length < 100) {
      for (const e of buildEvents(sampleUser, sampleOrgUser)) {
        if (batch.length >= 100) break
        batch.push(e)
      }
    }
    assert(batch.length <= 100, `saas-dispatched batch <= 100 (got ${batch.length})`)
    assert(
      batch.every((e) => typeof e.properties.org_id === 'string'),
      'saas-dispatched batch events all carry org_id',
    )
  }
  // Omitting sampleOrgUser must reproduce today's generic mix exactly.
  const genericEvents = buildEvents(sampleUser)
  assert(
    genericEvents.every((e) => !('org_id' in e.properties)),
    'buildEvents() without sampleOrgUser stays on the generic mix (no org_id)',
  )

  // 7) Experiment simulation (--experiment-flag-key) pure-builder invariants —
  // no network. exposureEvent always carries the $feature_flag(_response)
  // properties; buildOutcomeEvents never emits funnel steps past the roll
  // outcome; the mean metric always emits exactly one numeric-valued event.
  const exposure = exposureEvent('pump-exp-test-d1-0', 'checkout-redesign-test', 'test')
  assert(
    exposure.properties.$feature_flag === 'checkout-redesign-test',
    'exposureEvent sets $feature_flag',
  )
  assert(
    exposure.properties.$feature_flag_response === 'test',
    'exposureEvent sets $feature_flag_response to the real variant',
  )

  const funnelSteps = ['checkout_started', 'checkout_completed']
  const funnelOptsConverted = {
    experimentMetric: 'funnel',
    experimentFunnelEvents: funnelSteps,
    experimentControlRate: 1,
    experimentTestRate: 1,
  }
  const convertedOutcome = buildOutcomeEvents(funnelOptsConverted, 'control', 'u1')
  assert(convertedOutcome.converted === true, 'forced-converted rolls converted=true')
  assert(
    convertedOutcome.events.length === funnelSteps.length &&
      convertedOutcome.events.every((e, i) => e.event === funnelSteps[i]),
    'forced-converted emits every funnel step in order',
  )

  const funnelOptsNotConverted = {
    experimentMetric: 'funnel',
    experimentFunnelEvents: funnelSteps,
    experimentControlRate: 0,
    experimentTestRate: 0,
  }
  const notConvertedOutcome = buildOutcomeEvents(funnelOptsNotConverted, 'control', 'u2')
  assert(notConvertedOutcome.converted === false, 'forced-not-converted rolls converted=false')
  assert(
    notConvertedOutcome.events.length === 1 &&
      notConvertedOutcome.events[0].event === funnelSteps[0],
    'forced-not-converted emits only the first funnel step',
  )

  const meanOpts = {
    experimentMetric: 'mean',
    experimentMeanEvent: 'revenue_captured',
    experimentMeanProperty: 'amount',
    experimentControlMean: 20,
    experimentTestMean: 35,
  }
  const meanOutcome = buildOutcomeEvents(meanOpts, 'test', 'u3')
  assert(meanOutcome.events.length === 1, 'mean metric emits exactly one event')
  assert(
    meanOutcome.events[0].event === 'revenue_captured',
    'mean metric event uses the configured event name',
  )
  assert(
    typeof meanOutcome.events[0].properties.amount === 'number',
    'mean metric event carries a numeric value on the configured property',
  )
  assert(typeof meanOutcome.value === 'number', 'buildOutcomeEvents returns numeric value for mean')

  console.log('SELFTEST PASS')
  console.log(`  events built     : ${events.length}`)
  console.log(`  autocapture      : ${autos.length} (all with text=" token)`)
  console.log(`  funnel counts    : ${counts.join(' -> ')} (non-increasing)`)
  console.log('  batch size       : <= 100 verified')
  console.log('  schema probes    : valid/strict-invalid/warn-invalid shapes verified')
  console.log(
    `  saas replay    : ${saasEvents.length} events, org_id+schema_version verified, ` +
      'incident_id reuse verified, batch cap verified',
  )
  console.log(
    '  experiment sim   : exposureEvent + buildOutcomeEvents (funnel/mean) invariants verified',
  )
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const main = () => {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.selftest) return selftest()
  if (!opts.key) {
    console.error('error: --key <writeKey> is required')
    console.error(
      'usage: node tools/loadtest/pump.mjs --key ckw_live_xxx --rate 400 --duration 180',
    )
    process.exit(1)
  }
  SPREAD_DAYS = Number.isFinite(opts.days) && opts.days > 0 ? opts.days : 0
  FLAG_KEYS = Array.isArray(opts.flags) ? opts.flags : []

  if (opts.experimentFlagKey) {
    console.log(
      `pump: experiment simulation host=${opts.host} flag=${opts.experimentFlagKey} ` +
        `metric=${opts.experimentMetric} days=${opts.experimentDays} ` +
        `users/day=${opts.experimentUsersPerDay}`,
    )
    runExperimentSimulation(opts)
    return
  }

  console.log(
    `pump: host=${opts.host} rate=${opts.rate}/s duration=${opts.duration}s ` +
      `users=${opts.users} batch=${opts.batch} concurrency=${opts.concurrency} ` +
      `spread=${SPREAD_DAYS ? `${SPREAD_DAYS}d` : 'now'} ` +
      `flags=${FLAG_KEYS.length ? FLAG_KEYS.join(',') : 'none'} ` +
      `schema-pct=${opts.schemaPct}${
        opts.schemaPct > 0
          ? ` (run schema-seed.mjs setup --key ${opts.key} first if you have not)`
          : ''
      } ` +
      `saas=${opts.saas ? `on (orgs=${opts.orgs})` : 'off'}`,
  )
  run(opts)
}

main()
