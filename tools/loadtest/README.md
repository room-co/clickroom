# Load test — AC-2 (capture → NATS → ingest → ClickHouse)

Drives `POST /v1/capture` at a target rate for a fixed duration with [k6], then
asserts ClickHouse received **exactly** what capture accepted (zero
accepted-then-lost, spec AC-2). By default existing data is **preserved** (the
check is delta-based); pass `--truncate` to wipe the `events` table before+after.

## Prereqs
- Local infra up (`docker compose up -d` — postgres, clickhouse, nats, redis)
- Postgres seeded (`pnpm --filter @clickroom/db seed`) — needs a Project
- `k6` (`brew install k6`), `cargo`, `psql`, `curl`, `python3`

## Run
```bash
# defaults: 5000 ev/s for 5m (the AC-2 spec load)
tools/loadtest/run.sh

# parameterized — quantity is rate × duration
tools/loadtest/run.sh --rate 10000 --duration 30s     # 300k events
tools/loadtest/run.sh --rate 5000  --duration 5m      # 1.5M events (AC-2)
tools/loadtest/run.sh --rate 2000  --duration 1m --batch 50
```

By default the script **builds + starts** release `capture` + `ingest` (with the
per-project rate limit lifted so it doesn't cap the target rate), runs the test,
then stops them. To drive already-running services instead:

```bash
tools/loadtest/run.sh --rate 5000 --duration 1m --no-manage
```

## Flags / env
| flag | default | meaning |
|------|---------|---------|
| `--rate N` | 5000 | target events/second |
| `--duration D` | 5m | k6 duration (`30s`, `5m`, …) |
| `--batch N` | 100 | events per POST (≤100, capture contract) |
| `--no-manage` | off | use running services, don't start/stop |
| `--truncate` | off | TRUNCATE `events` before+after the run (default: **preserve** existing data) |

The AC-2 assertion is **delta-based** (final count minus a baseline snapshot), so it
is exact whether the table starts empty or not — load rows are added to whatever is
already there and, by default, **kept**. Pass `--truncate` only when you want a clean
table on both sides (e.g. a dedicated bench project).

Connection overrides via env: `CAPTURE_URL`, `CLICKHOUSE_URL/USER/PASSWORD/DATABASE`,
`NATS_URL`, `REDIS_URL`, `DATABASE_URL`, `TOKEN`. A dedicated write key
(`ckw_live_loadtest`) is upserted idempotently on each run.

## Output
```
  accepted=1500000  ch_delta=1500000  lost=0
  dlq_messages=0
  ✅ AC-2 PASS — zero accepted-then-lost
```
Exit 0 = PASS (`lost<=0`), exit 1 = FAIL. Managed services log to
`/tmp/loadtest-{capture,ingest}.log`.

[k6]: https://k6.io

## Load test — flag evaluation (`POST /v1/flags`, determinism + p95)

`flags-run.sh` + `flags-load.js` stress capture-rs flag evaluation and assert it
stays **deterministic under concurrency**. It seeds a dedicated throwaway bench
project (3 flags: boolean %, multivariate, property-targeted) + a write/read key
+ the Redis def cache, then drives `POST /v1/flags` at a target RPS with k6.

Determinism is checked on **every** request: k6's `setup()` captures each pool
distinct_id's evaluation once (the ground truth), then every load request
re-evaluates a pool id and must return byte-identical `enabled`/`variant`/`payload`.
Since the pool is small and each id is hit thousands of times across VUs, any cache
race, cross-request bleed, or nondeterministic bucketing surfaces as a
`nondeterministic` count > 0 and fails the run. (Correctness/parity vs the SDK is
already proven by `flag-vectors.json`; this proves **stability at load**.) The run
also fails if `http_req_duration` p95 exceeds the limit or any request is non-200.

```bash
# defaults: 3000 rps for 2m, pool 2000, p95 <= 25ms, against running capture
tools/loadtest/flags-run.sh

tools/loadtest/flags-run.sh --rps 8000 --duration 60s --pool 5000
tools/loadtest/flags-run.sh --rps 1500 --duration 30s --p95 15
tools/loadtest/flags-run.sh --manage            # start+stop its own release capture
```

| flag | default | meaning |
|------|---------|---------|
| `--rps N` | 3000 | target requests/second |
| `--duration D` | 2m | k6 duration |
| `--pool N` | 2000 | distinct_id pool size (determinism space) |
| `--p95 MS` | 25 | max acceptable p95 latency (ms) |
| `--manage` | off | build+start a fresh release capture on :3001, stop after (default: use running) |

Env overrides: `FLAGS_URL`, `DATABASE_URL` (pg, default `:5433`), `REDIS_URL`
(default `:6380`), `TOKEN`/`READ_TOKEN`. Seed/teardown is `flags-seed.mjs`
(`setup`/`teardown`) — pure Node, always runs teardown on exit so no bench state
leaks. Add `DEBUG=1` to `k6 run` to log the first mismatches.

```
──────── flag-eval load ────────
requests        484009  (7822 rps)
p95 / p99       0.7ms / 0.0ms  (limit 25ms)
http_req_failed 0.000%
nondeterministic 0  ✅ deterministic under load
```
Exit 0 = PASS (all 200, `nondeterministic=0`, p95 within limit), exit 1 = FAIL.

## Realistic pump (pump.mjs)

`pump.mjs` is a *demo-data* generator, not a correctness/throughput test. It
drives lifelike, sustained traffic into a project so the Dashboard, Events,
Funnels, Users and Breakdown screens fill with believable data. It **never**
truncates or deletes anything.

Pure Node.js ESM, zero npm deps (needs Node 22+ for global `fetch`).

```bash
node tools/loadtest/pump.mjs --key ckw_live_xxx --rate 400 --duration 180

# emit $feature_flag_called exposures so the flag_events MV populates
node tools/loadtest/pump.mjs --key ckw_live_xxx --flags new-checkout-flow --rate 400 --duration 180 --days 30
```

What it produces:
- A stable pool of `--users` distinct ids (mostly `user_<n>`, ~20% anonymous
  `anon_*`), reused across the run with power-law activity so the Users view
  shows repeat visitors with varying event counts.
- Weighted event mix: `$pageview` (~40%, realistic `$current_url` / referrer /
  browser / os / device), `$autocapture` (~30%, with an `elements_chain`
  carrying literal `text="..."` / `href="..."` tokens so the click breakdown
  populates), an ordered funnel (~25%: `product_viewed → signup_started →
  signup_completed → subscription_purchased` with real drop-off), misc custom
  events (~5%), plus occasional `$identify`.
- Timestamps mostly "now" (small fraction within the last few minutes) so the
  live feed and recent-window queries light up.
- With `--flags key1,key2`, ~15% of events become `$feature_flag_called`
  exposures (`$feature_flag` + `$feature_flag_response` ~55% `true`/45% `false`)
  so the ClickHouse `flag_events` materialized view (migration 002) populates
  flag metrics. Omit `--flags` for no flag events (unchanged behavior). Defaults
  to the `FLAG_KEYS` env var (comma-split) when the flag is absent.

Flags: `--key` (required), `--host` (default `http://localhost:3001`),
`--rate` (ev/s, default 400), `--duration` (s, default 180), `--users`
(default 600), `--batch` (≤100, default 50), `--concurrency` (default 16),
`--flags key1,key2` (default `FLAG_KEYS` env or none).

On `429` it backs off (respects `Retry-After`) and retries a bounded number of
times; network/5xx errors are counted and retried. It prints a live progress
line every ~2s and a final summary, and shuts down cleanly on `Ctrl-C`.

Self-test (no network):
```bash
node tools/loadtest/pump.mjs --selftest
```

### Schema-enforcement probe traffic (`--schema-pct`)

Exercises taxonomy schema enforcement (strict/warn) at volume, alongside the normal
mix above. Seed once per project, then run pump with `--schema-pct`:

```bash
node tools/loadtest/schema-seed.mjs setup --key ckw_live_xxx

node tools/loadtest/pump.mjs --key ckw_live_xxx --rate 400 --duration 180 --schema-pct 7
```

`schema-seed.mjs` resolves the project from the write key (same key pump.mjs/
capture-load.js/run.sh already use) and registers two events directly against
Postgres + the `capture:schema:<project_id>` Redis cache (same shape
`apps/api`'s taxonomy router writes) — no tRPC/session auth needed, mirroring
`flags-seed.mjs`'s direct-to-store approach:

- `checkout_completed` — `strict`, requires `order_id: String` + `amount: Numeric`.
- `signup_started` — `warn`, requires `plan: String`. (This event is also emitted
  by the normal funnel mix, always with `plan` present, so baseline funnel traffic
  is unaffected.)

Everything else in the mix (`$pageview`, `$autocapture`, other funnel steps, misc
events) stays `enforcementMode: none` — unchanged baseline for comparison.

`--schema-pct N` (default 7, `0` disables) reserves N% of the target rate for
probe requests, cycling through valid `checkout_completed`/`signup_started`,
strict-invalid `checkout_completed` (missing `order_id` or non-numeric `amount`
— expect `400`), and warn-invalid `signup_started` (missing `plan` — expect
`202`, tagged `schema_valid=0` in ClickHouse). Every probe is sent as its own
solo-event batch — capture-rs rejects a strict violation by rejecting the
*whole batch* it arrived in, so bundling a probe into a normal-traffic batch
would collaterally reject real events in it too.

The summary reports sent/expected/unexpected counts per category, then — if
any warn-invalid probes were sent — queries ClickHouse directly to confirm
they landed tagged `schema_valid=0` (proving the *async* ingest-side tagging
survived the run, not just the synchronous `202`). Pass `--no-ch-verify` to
skip that last step.

```
--- schema-enforcement probes (--schema-pct) ---
✅ valid_checkout           sent=95 expected(202)=95 unexpected=0 errors=0
✅ strict_invalid_checkout  sent=100 expected(400)=100 unexpected=0 errors=0
✅ valid_signup             sent=89 expected(202)=89 unexpected=0 errors=0
✅ warn_invalid_signup      sent=86 expected(202)=86 unexpected=0 errors=0

--- verifying warn-invalid tagging in ClickHouse (schema_valid=0) ---
✅ sent=86 found_in_ch=86 tagged_invalid=86
```

Teardown removes only the two events/schema this script added (never touches
other events/schemas a real project may already have configured):

```bash
node tools/loadtest/schema-seed.mjs teardown --key ckw_live_xxx
```
