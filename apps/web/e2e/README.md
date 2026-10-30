# apps/web e2e (Playwright)

Playwright suite that drives the real SPA against the real API + Rust ingest pipeline, on an
isolated stack that **coexists** with a running dev stack (same shared postgres/clickhouse/nats/
redis containers, separate logical databases/streams/ports).

## Dev vs e2e

| | dev | e2e |
|---|---|---|
| api (NestJS/tRPC) | `3000` | `3100` |
| capture (Rust) | `3001` | `3101` |
| web (Vite) | `5180` | `5273` |
| ingest (Rust) | — (no port) | — (no port) |
| Postgres DB | `clickroom` | `clickroom_e2e` |
| ClickHouse DB | `clickroom` | `clickroom_e2e` |
| NATS stream | `EVENTS` | `EVENTS_E2E` |
| NATS subject prefix | `events.raw` | `e2e.events.raw` |
| ingest durable consumer | `INGEST_DURABLE_NAME` (default) | `ingest-e2e` |
| Redis | shared, key-scoped by org/project/hash | same, distinct e2e org/project ids |

## Isolation model

The async capture path is `capture → NATS JetStream → ingest durable consumer → ClickHouse`. On
shared infra, e2e must not collide with dev traffic or vice versa:

- **Postgres:** isolated `clickroom_e2e` database, own `DATABASE_URL`, migrated with
  `prisma migrate deploy`.
- **ClickHouse:** isolated `clickroom_e2e` database via `CLICKHOUSE_DATABASE`
  (`services/ingest/src/config.rs`; `packages/clickhouse/src/migrate.ts` does
  `CREATE DATABASE IF NOT EXISTS`).
- **NATS:** stream name and subject prefix are env-driven (previously hardcoded consts) so e2e
  gets its own stream/subject namespace:
  - `CAPTURE_STREAM_NAME` (default `EVENTS`), `CAPTURE_SUBJECT_PREFIX` (default `events.raw`) —
    `services/capture/src/{config.rs,bootstrap.rs,nats.rs}`.
  - `INGEST_STREAM_NAME` (default `EVENTS`), `INGEST_SUBJECT_FILTER` (default `events.raw.>`) —
    `services/ingest/src/{config.rs,main.rs,consumer.rs}`.
  - `INGEST_DLQ_STREAM_NAME` (default current hardcoded DLQ stream name) — `services/ingest/src/bootstrap.rs`.
    This closes a latent mismatch where the DLQ stream's subjects were built from the wrong prefix;
    fixed alongside this env-ification.
  - `INGEST_DURABLE_NAME` / `INGEST_DLQ_SUBJECT_PREFIX` were already env-configurable.
  - `.env.e2e` sets `EVENTS_E2E` / `e2e.events.raw` / `ingest-e2e` / `e2e.events.dlq` so dev's
    ingest consumer never sees e2e messages and vice versa — no competing-consumer split, no
    cross-writes.
- **Redis:** no code change needed. Keys are org/project/hash-scoped
  (`capture:key:<hash>`, `capture:schema:<project_id>`, flag/usage caches); unique e2e org/project
  ids and distinct API-key hashes isolate them from dev automatically.
- **Web dev-server proxy:** `apps/web/vite.config.ts` reads `VITE_API_PROXY_TARGET` (default
  `http://localhost:3000`) for the `/trpc` and `/flags/stream` proxies, so the e2e Playwright
  `webServer` can point it at `http://localhost:3100` without touching the file.

## Workflow

```bash
# optional: keep the dev stack running alongside e2e
make infra:up && make up

# bring up the isolated e2e stack (api :3100, capture :3101, its own PG/CH DBs, EVENTS_E2E stream)
pnpm e2e:up            # == make up:e2e

# run the suite (starts the e2e vite dev server on :5273 via playwright webServer)
pnpm test:e2e
pnpm test:e2e:headed   # headed, for local debugging
pnpm test:e2e:ui       # Playwright UI mode

# tear down
pnpm e2e:down           # == make down:e2e
pnpm e2e:down -- --wipe # also drops the clickroom_e2e PG + CH databases
```

Seeding is idempotent (`packages/db/src/seed.e2e.ts`, `pnpm --filter @clickroom/db seed:e2e`) and
uses **deterministic API keys upserted by keyHash** — the fixed plaintext test keys work
immediately without a fresh seed run. Three orgs are seeded: `e2e` (user `e2e@clickroom.dev`) for
the golden-path specs, `e2e-limited` (user `e2e-limited@clickroom.dev`,
`maxEventsPerMonthOverride: 2`) for the usage-limit spec, and `e2e-overage` (user
`e2e-overage@clickroom.dev`, `maxEventsPerMonthOverride: 2`) dedicated to `overage-policy.spec.ts`'s
live `overagePolicy` mutation — kept separate from `e2e-limited` so that mutation can never race
`schema-and-limits.spec.ts`'s quota test, which shares `e2e-limited` and assumes it stays on the
seeded 'block' default (Playwright runs different spec files concurrently by default,
`fullyParallel: true`, so cross-file mutable state on the same org is a real race, not just a
theoretical one).

## Golden spec groups

| Group | Spec file(s) | Covers |
|---|---|---|
| 1. Auth + projects | `auth-projects.spec.ts` | signup/session; project create/rename/delete |
| 2. Event pipeline | `event-pipeline.spec.ts` | capture → NATS → ClickHouse → UI |
| 3. Feature flags | `feature-flags.spec.ts` | create/toggle/evaluate, Redis cache-rebuild lag |
| 4. Schema + limits | `schema-and-limits.spec.ts` | strict-schema rejection; over-limit 402 + usage badge |
| 5. User segments | `user-segments.spec.ts`, `user-segments-materialize.spec.ts`, `user-segments-tenancy.spec.ts` | trait/event-property/behavioral conditions, AND/OR, empty-match, edit/delete, materialize snapshot (asserted directly against ClickHouse `segment_members`), snapshot staleness, cross-tenant isolation, permission gate |
| 6. Experiments | `experiments.spec.ts`, `experiments-results.spec.ts`, `experiments-tenancy.spec.ts` | CRUD + auto-created multivariate flag, draft-only variant editing, launch/stop lifecycle, soft-delete (5 scenarios); per-variant funnel + mean results computed from seeded exposures/conversions, directional `probabilityToBeBest` correctness (ratio/retention deferred to unit tests only, not covered here); cross-tenant `NOT_FOUND` isolation + `viewerAuthedPage` permission gate (2 scenarios) |

Additional non-golden-path specs also live under `specs/`: `events-dedup.spec.ts`,
`overage-policy.spec.ts`, `sql-explorer.spec.ts`.

`apps/web/e2e/helpers/capture.ts` gained `seedExperimentPopulation(page, {projectId, writeKey,
flagKey})` for group 6 — buckets per-run-unique users through the real `/v1/flags` evaluation for
an existing experiment's flag, then emits variant-appropriate exposure + funnel-step/mean events so
each variant has an exact, distinguishable outcome for the results spec's directional assertions.

## Adding a new spec

- Import the test/expect helpers from `../fixtures` (`apps/web/e2e/fixtures/index.ts`), **not**
  directly from `@playwright/test` — the fixtures wire up `authedPage`, `limitedAuthedPage`,
  `projectId`, `limitedProjectId`, `writeKey`, `readKey`, `limitedWriteKey` so specs don't
  hand-roll login/id-resolution.
- Use a **unique id per test** (uuid-suffixed `distinct_id` and/or event name) for anything that
  writes to ClickHouse. The `events` table is a `ReplacingMergeTree` keyed on
  `(project_id, toDate(timestamp), event, cityHash64(distinct_id))` — reusing an id/event pair
  across runs (or within the same day) can collapse rows and produce false negatives. Assert
  `count() >= 1`, never exact equality, and query with `FINAL`.
- Poll instead of sleeping: `helpers/waitFor.ts`'s `waitFor()` for ClickHouse-backed assertions
  (`helpers/clickhouse.ts`'s `waitForEvent`), `expect.poll`/`.toPass()` for UI assertions that
  depend on Redis cache rebuilds (e.g. flag toggle → eval).
- Place the spec under `apps/web/e2e/specs/*.spec.ts`; it's picked up automatically by
  `playwright.config.ts` (`testDir: './e2e/specs'`).

## Troubleshooting

- **Stuck ports / "address already in use" on 3100/3101/5273:** `scripts/e2e-up.sh` kills these
  ports before starting, but if a prior run was killed uncleanly check `apps/web/.e2e/*.pid`
  (also referenced from repo-root `.e2e/`) for stale pids and `kill` them, or just re-run
  `pnpm e2e:down` before `pnpm e2e:up`.
- **ClickHouse poll timeout in `waitForEvent`:** capture acks the NATS publish synchronously but
  the ingest→ClickHouse insert is async (batched, `INGEST_BATCH_MAX_SIZE=1` /
  `INGEST_BATCH_MAX_WAIT_MS=50` in `.env.e2e` keeps this fast). If the poll still times out, check
  `apps/web/.e2e/ingest.log` (or wherever `scripts/e2e-up.sh` wrote it) for consumer errors, and
  confirm `nats stream ls` shows both `EVENTS` and `EVENTS_E2E` with the `ingest-e2e` durable
  attached only to the latter. Widen the poll budget before shortening the interval — this is a
  genuinely async pipeline, not a fixed-latency one.
- **Flag toggle not reflected in eval / Redis cache-rebuild lag:** flag eval reads a Redis-cached
  definition blob that's rebuilt on mutation; there's a small propagation window. Specs wrap the
  post-toggle eval assertion in `expect.poll(...)` rather than asserting immediately — if you hit
  this in a new spec, do the same rather than adding a fixed `sleep`.
- **This suite has not yet been run against live infra in this repo.** Every piece has been
  verified individually — TypeScript typecheck, biome lint, and `playwright test --list`
  confirming all 13 spec files / 39 tests (including user-segments group across 3
  sibling files and experiments group across 3 sibling files) are discovered and
  type-check — but `make up:e2e && pnpm test:e2e` has not actually been executed end-to-end
  against a live Postgres/ClickHouse/NATS/Redis stack. Treat the first real run as the true
  acceptance test, and expect to iterate on timing budgets (poll intervals/timeouts) once real
  network/DB latency is observed instead of assumed. The user-segments specs additionally rely on
  structural DOM selectors (no test ids on `SegmentBuilderPage`/`SegmentsPage` yet) and on
  `pnpm --filter @clickroom/db seed:e2e` having been run so the `viewerAuthedPage` fixture's seeded
  viewer membership exists — both are residual risks to watch on the first live run, and now also
  apply to the experiments builder/results pages (same lack-of-test-ids gap) and the experiments
  group's statistical-split sensitivity (seeds enough users per variant for real flag
  bucketing to settle close to its target split).
