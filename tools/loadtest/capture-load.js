// k6 load script for the capture → NATS → ingest → ClickHouse pipeline (AC-2).
//
// Drives `POST /v1/capture` at a target EVENTS/s for a fixed DURATION using k6's
// constant-arrival-rate executor, so throughput is decoupled from response
// latency. Each iteration posts one batch of BATCH events; the target iteration
// rate is EVENTS_PER_SEC / BATCH. The number of events capture durably accepted
// (sum of the `202 {"accepted":N}` bodies) is exported as the `accepted_events`
// counter — run.sh reconciles it against the ClickHouse row delta.
//
// Tunables (env):
//   EVENTS_PER_SEC  target events/s               (default 5000)
//   DURATION        test duration, k6 syntax      (default 5m)
//   BATCH           events per POST (<=100)        (default 100)
//   CAPTURE_URL     capture base URL              (default http://localhost:3001)
//   TOKEN           write key                     (required)
//   PRE_VUS         preallocated VUs              (default 200)
//   MAX_VUS         max VUs                       (default 2000)
//   SUMMARY_OUT     path to write summary JSON    (optional)

import { check } from 'k6'
import http from 'k6/http'
import { Counter } from 'k6/metrics'

const EVENTS_PER_SEC = Number(__ENV.EVENTS_PER_SEC || 5000)
const DURATION = __ENV.DURATION || '5m'
const BATCH = Number(__ENV.BATCH || 100)
const CAPTURE_URL = __ENV.CAPTURE_URL || 'http://localhost:3001'
const TOKEN = __ENV.TOKEN
const PRE_VUS = Number(__ENV.PRE_VUS || 200)
const MAX_VUS = Number(__ENV.MAX_VUS || 2000)

// Iteration rate = events/s divided across each batch. Min 1 to stay valid.
const ITER_RATE = Math.max(1, Math.round(EVENTS_PER_SEC / BATCH))

export const options = {
  scenarios: {
    capture: {
      executor: 'constant-arrival-rate',
      rate: ITER_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: PRE_VUS,
      maxVUs: MAX_VUS,
    },
  },
  // Fail the run if any request is non-202 or the pipeline errors.
  thresholds: {
    checks: ['rate==1.0'],
    http_req_failed: ['rate==0.0'],
  },
}

const acceptedEvents = new Counter('accepted_events')
const sentBatches = new Counter('sent_batches')

const params = {
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
  timeout: '30s',
}

export default function () {
  // Unique distinct_ids per event so ReplacingMergeTree never collapses distinct
  // events (that would mask loss). __VU/__ITER guarantee uniqueness across VUs.
  const base = `${__VU}_${__ITER}`
  const batch = new Array(BATCH)
  for (let j = 0; j < BATCH; j++) {
    batch[j] = { event: 'ac2_load', distinct_id: `u${base}_${j}`, properties: { vu: __VU, j } }
  }
  const res = http.post(`${CAPTURE_URL}/v1/capture`, JSON.stringify({ batch }), params)
  const ok = check(res, { 'status is 202': (r) => r.status === 202 })
  if (ok) {
    sentBatches.add(1)
    try {
      acceptedEvents.add(JSON.parse(res.body).accepted)
    } catch (_) {
      // Body not JSON despite 202 — count as batch size fallback.
      acceptedEvents.add(BATCH)
    }
  }
}

export function handleSummary(data) {
  const out = {}
  if (__ENV.SUMMARY_OUT) out[__ENV.SUMMARY_OUT] = JSON.stringify(data)
  // Also echo a one-line recap to stdout.
  const acc = data.metrics.accepted_events?.values.count || 0
  out.stdout = `\naccepted_events=${acc}\n`
  return out
}
