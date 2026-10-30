import type { Page } from '@playwright/test'
import { queryClickHouse } from './clickhouse'
import { e2eEnv } from './env'
import { waitFor } from './waitFor'

export interface CaptureBatchEvent {
  event: string
  distinct_id: string
  timestamp?: string
  properties?: Record<string, unknown>
}

export interface HttpResult<T = unknown> {
  status: number
  body: T
}

async function postJson<T = unknown>(
  path: string,
  key: string,
  body: unknown,
): Promise<HttpResult<T>> {
  const res = await fetch(`${e2eEnv.captureUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  })
  const parsed = (await res.json().catch(() => undefined)) as T
  return { status: res.status, body: parsed }
}

/**
 * POST /v1/capture — batch-ingest events (services/capture/src/capture.rs).
 * Auth: write key as `Authorization: Bearer <writeKey>`. Success is
 * `202 { accepted: N }`; strict schema violations return `400` with per-event
 * errors (see CaptureResponse in services/capture/src/models.rs).
 */
export async function postCapture(
  writeKey: string,
  batch: CaptureBatchEvent[],
): Promise<HttpResult<{ accepted: number; errors?: unknown[] }>> {
  return postJson(`/v1/capture`, writeKey, { batch })
}

export interface EvalFlagsBody {
  distinct_id: string
  person_properties?: Record<string, unknown>
}

/**
 * POST /v1/flags — evaluate all flags for a distinct_id
 * (services/capture/src/flags/endpoint_flags.rs). Auth: write key. Returns
 * `{ flags: { <key>: { enabled, variant, payload } } }`.
 */
export async function evalFlags(
  writeKey: string,
  body: EvalFlagsBody,
  // biome-ignore lint/suspicious/noExplicitAny: flag response shape is evaluated dynamically by specs
): Promise<HttpResult<{ flags: Record<string, any> }>> {
  return postJson(`/v1/flags`, writeKey, body)
}

/**
 * GET /v1/flag-definitions — full flag definition set for a project
 * (services/capture/src/flags/endpoint_defs.rs). Auth: read key. Returns
 * `{ flags: [...], version }`.
 */
export async function flagDefinitions(
  readKey: string,
  // biome-ignore lint/suspicious/noExplicitAny: flag definition shape is evaluated dynamically by specs
): Promise<HttpResult<{ flags: any[]; version: number }>> {
  const res = await fetch(`${e2eEnv.captureUrl}/v1/flag-definitions`, {
    method: 'GET',
    headers: { authorization: `Bearer ${readKey}` },
  })
  const parsed = await res.json().catch(() => undefined)
  return { status: res.status, body: parsed }
}

export interface IdentifyEventArgs {
  distinctId: string
  /** Person-scope traits — becomes the `$identify` event's `$set` payload. */
  set: Record<string, unknown>
  timestamp?: string
}

/**
 * POST /v1/capture a `$identify` event carrying a `$set` person-trait payload.
 * There is no separate identify endpoint — this mirrors what the real sdk-js
 * client does (`packages/sdk-js/src/index.ts`'s `identify()` just emits a
 * `$identify` capture event with `$set`). `services/ingest/src/taxonomy.rs`
 * turns `$set` keys into person-scope PropertyDefinitions, and the segment
 * `trait` condition (`packages/clickhouse/src/queries.ts`'s
 * `compileTraitCondition`) resolves the *latest* `$identify` event's `$set`
 * per person via `argMaxIf(..., events.timestamp, events.event = '$identify')`
 * — so only the most recent identify call per distinct_id matters.
 */
export async function identify(
  writeKey: string,
  { distinctId, set, timestamp }: IdentifyEventArgs,
): Promise<HttpResult<{ accepted: number; errors?: unknown[] }>> {
  return postCapture(writeKey, [
    { event: '$identify', distinct_id: distinctId, timestamp, properties: { $set: set } },
  ])
}

/** Per-run-unique suffix, same convention as `uniqueIds()` in
 * event-pipeline.spec.ts / events-dedup.spec.ts / sql-explorer.spec.ts. */
function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Build `count` per-run-unique distinct_ids for one named sub-group, using the
 * `e2e-seg-<uuid>` convention (task — `<uuid>` here is the same
 * timestamp+random suffix scheme the rest of the harness uses, not a literal
 * RFC4122 UUID. */
function groupIds(runSuffix: string, group: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `e2e-seg-${runSuffix}-${group}-${i}`)
}

export interface SeedSegmentPopulationArgs {
  projectId: string
  writeKey: string
}

/**
 * Expected exact counts for each named sub-population `seedSegmentPopulation`
 * creates, for scenario assertions in `user-segments.spec.ts`.
 * `overlapCount`/`andCount`/`orCount` document the deliberate overlap design
 * between the trait-match and event-property-match populations — see the
 * comment above `seedSegmentPopulation` for why this shape is required by
 * scenarios 4 (AND) and 5 (OR).
 */
export interface SegmentPopulationCounts {
  /** Users with trait `plan = 'pro'` (proUsdOverlap + proOnly). */
  proCount: number
  /** Users with trait `plan = 'free'` (control for the trait condition). */
  freeCount: number
  /** Users with a `checkout_completed` event where `currency = 'usd'` (proUsdOverlap + usdOnly). */
  usdCount: number
  /** Users with a `checkout_completed` event where `currency = 'eur'` (control for the event_property condition). */
  eurCount: number
  /** Users with >=3 `feature_used` events in the last day. */
  behavioralMatchCount: number
  /** Users with exactly 1 `feature_used` event in the last day (control — must NOT match a `>=3` condition). */
  behavioralControlCount: number
  /** Users matching BOTH `plan = 'pro'` AND `currency = 'usd'` — the exact expected count for scenario 4 (AND). */
  andCount: number
  /** Users matching `plan = 'pro'` OR `currency = 'usd'` — the exact expected count for scenario 5 (OR). */
  orCount: number
}

export interface SeedSegmentPopulationResult extends SegmentPopulationCounts {
  /** The actual per-run-unique trait/property VALUES seeded — build segment
   * conditions against these, not hardcoded literals like `'pro'`/`'usd'`.
   * `seedSegmentPopulation` writes per-run-unique values (not just per-run-
   * unique distinct_ids) so that concurrent/repeated runs of this helper
   * across sibling spec files (`user-segments.spec.ts`,
   * `user-segments-materialize.spec.ts`) sharing the same `e2e` org/project
   * never pollute each other's `previewCount`/`previewMembers` scans (those
   * scan the whole project with no per-test-run scoping). */
  values: {
    /** `plan` trait value for the `proUsdOverlap`/`proOnly` populations. */
    planProValue: string
    /** `plan` trait value for the `freeEurControl` population. */
    planFreeValue: string
    /** `checkout_completed.currency` value for `proUsdOverlap`/`usdOnly`. */
    currencyUsdValue: string
    /** `checkout_completed.currency` value for `freeEurControl`. */
    currencyEurValue: string
    /** Per-run-unique event NAME (not just a property/trait value) used for
     * the `behavioralMatch`/`behavioralControl` populations, e.g.
     * `feature_used-<runSuffix>` — see its doc comment on why the behavioral
     * condition needs this even though its sibling trait/event_property
     * conditions only need per-run-unique VALUES. */
    behavioralEventName: string
  }
  /** Every distinct_id this call seeded, grouped by sub-population, for specs
   * that need to assert exact member sets (e.g. scenario 9's `segment_members`
   * check) rather than just counts. */
  ids: {
    /** plan=pro AND checkout currency=usd (the deliberate overlap). */
    proUsdOverlap: string[]
    /** plan=pro only (no checkout event). */
    proOnly: string[]
    /** checkout currency=usd only (never identified — plan trait unset). */
    usdOnly: string[]
    /** plan=free AND checkout currency=eur — doubles as the control group for
     * both the trait (`freeCount`) and event_property (`eurCount`) conditions. */
    freeEurControl: string[]
    /** >=3 `feature_used` events in the last day. */
    behavioralMatch: string[]
    /** exactly 1 `feature_used` event in the last day. */
    behavioralControl: string[]
  }
}

/**
 * Seed a small, deterministic population of real events (via `postCapture`/
 * `identify` — capture -> ingest -> ClickHouse, same as every other e2e spec,
 * not direct ClickHouse inserts) covering all three segment condition types,
 * for `user-segments.spec.ts` to build segments against.
 *
 * ## Overlap design (scenarios 4 "AND" / 5 "OR" earlier
 *
 * The trait condition (`plan = 'pro'`) and the event_property condition
 * (`checkout_completed.currency = 'usd'`) populations deliberately overlap by
 * a strict subset, so AND/OR are mathematically distinguishable from either
 * single-condition count:
 *
 * ```
 *                         plan=pro        plan≠pro (unset)
 *                       +-----------+-----------------------+
 * currency=usd checkout | proUsdOverlap(2) |   usdOnly(1)    |
 * (checkout_completed)  +-----------+-----------------------+
 * no usd checkout       |  proOnly(1)      |        —        |
 *                       +-----------+-----------------------+
 * ```
 *
 * - `proCount`    = proUsdOverlap + proOnly       = 2 + 1 = 3
 * - `usdCount`    = proUsdOverlap + usdOnly        = 2 + 1 = 3
 * - `andCount`    = proUsdOverlap                  = 2       (< min(proCount, usdCount) = 3 — proves AND isn't OR)
 * - `orCount`     = proUsdOverlap + proOnly + usdOnly = 4    (> max(proCount, usdCount) = 3 — proves OR isn't AND)
 *
 * `usdOnly` is deliberately never `identify()`-d (no `$identify` event at
 * all), so its unresolved trait (`argMaxIf` over zero `$identify` rows ->
 * `''`) never accidentally satisfies `plan = 'pro'` OR pollutes `freeCount`.
 *
 * `freeEurControl` is a single population reused as the negative control for
 * *both* the trait condition (`plan = 'free'` != `'pro'`) and the
 * event_property condition (`currency = 'eur'` != `'usd'`) — there is no
 * scenario that needs those two controls to be disjoint sets, so sharing them
 * keeps the total seeded population small.
 *
 * The behavioral population (`feature_used-<runSuffix>` >=3 vs exactly 1) is
 * independent of the trait/event-property groups — no scenario
 * combines behavioral with AND/OR, so no overlap is needed there.
 *
 * The behavioral condition matches by EVENT NAME + count/days only — it has
 * no property/trait value to scope a condition by, unlike trait/event_property
 * (whose pollution risk `values.plan*Value`/`values.currency*Value` already
 * cover). Playwright's `test.beforeAll` is worker-scoped, not file-scoped: with
 * `fullyParallel` and multiple workers this file's `beforeAll` runs once per
 * worker that picks up one of its tests, each with a fresh, independent call
 * to this function. A literal `'feature_used'` event name would be
 * indistinguishable across those parallel calls, so a behavioral condition's
 * live preview would match every worker's `behavioralMatch` population at
 * once (e.g. 5 workers x 3 = 15 instead of the 3 a single worker's own
 * `population` describes) — the exact same class of cross-run pollution as
 * bug 1, just on the event-NAME axis instead of the value axis. Giving the
 * event itself a per-run-unique name (`values.behavioralEventName`) closes
 * that gap the same way per-run-unique values close it for trait/event_property.
 *
 * All events are stamped at real capture time (no backdating — the behavioral condition's `days` window is wall-clock-relative), and every distinct_id uses the per-run-unique `e2e-seg-<uuid>`
 * convention so re-running the suite never double-counts a prior run's rows.
 *
 * Waits (via `waitForEvent`/ClickHouse polling) until every seeded event has
 * landed before resolving, so callers can immediately drive a live preview
 * count without their own extra settle-time poll.
 */
export async function seedSegmentPopulation(
  _page: Page,
  { projectId, writeKey }: SeedSegmentPopulationArgs,
): Promise<SeedSegmentPopulationResult> {
  const runSuffix = uniqueSuffix()
  const now = new Date().toISOString()

  // Per-run-unique VALUES (not just distinct_ids) — see
  // `SeedSegmentPopulationResult.values`'s doc comment for why: previewCount/
  // previewMembers scan the whole e2e project with no per-test-run scoping,
  // so literal values like `'pro'`/`'usd'` would stack across sibling spec
  // files and Playwright retries seeding into the same DB.
  const values = {
    planProValue: `pro-${runSuffix}`,
    planFreeValue: `free-${runSuffix}`,
    currencyUsdValue: `usd-${runSuffix}`,
    currencyEurValue: `eur-${runSuffix}`,
    // Per-run-unique event NAME, not a property value — see the doc comment
    // above on why the behavioral population needs this axis too.
    behavioralEventName: `feature_used-${runSuffix}`,
  }

  const ids = {
    proUsdOverlap: groupIds(runSuffix, 'pro-usd', 2),
    proOnly: groupIds(runSuffix, 'pro-only', 1),
    usdOnly: groupIds(runSuffix, 'usd-only', 1),
    freeEurControl: groupIds(runSuffix, 'free-eur', 2),
    behavioralMatch: groupIds(runSuffix, 'behav-match', 3),
    behavioralControl: groupIds(runSuffix, 'behav-control', 2),
  }

  const batch: CaptureBatchEvent[] = []

  for (const distinctId of ids.proUsdOverlap) {
    batch.push({
      event: '$identify',
      distinct_id: distinctId,
      timestamp: now,
      properties: { $set: { plan: values.planProValue } },
    })
    batch.push({
      event: 'checkout_completed',
      distinct_id: distinctId,
      timestamp: now,
      properties: { currency: values.currencyUsdValue },
    })
  }
  for (const distinctId of ids.proOnly) {
    batch.push({
      event: '$identify',
      distinct_id: distinctId,
      timestamp: now,
      properties: { $set: { plan: values.planProValue } },
    })
  }
  for (const distinctId of ids.usdOnly) {
    batch.push({
      event: 'checkout_completed',
      distinct_id: distinctId,
      timestamp: now,
      properties: { currency: values.currencyUsdValue },
    })
  }
  for (const distinctId of ids.freeEurControl) {
    batch.push({
      event: '$identify',
      distinct_id: distinctId,
      timestamp: now,
      properties: { $set: { plan: values.planFreeValue } },
    })
    batch.push({
      event: 'checkout_completed',
      distinct_id: distinctId,
      timestamp: now,
      properties: { currency: values.currencyEurValue },
    })
  }
  for (const distinctId of ids.behavioralMatch) {
    for (let i = 0; i < 3; i++) {
      batch.push({
        event: values.behavioralEventName,
        distinct_id: distinctId,
        timestamp: now,
        properties: { n: i },
      })
    }
  }
  for (const distinctId of ids.behavioralControl) {
    batch.push({
      event: values.behavioralEventName,
      distinct_id: distinctId,
      timestamp: now,
      properties: { n: 0 },
    })
  }

  // MAX_BATCH in services/capture/src/capture.rs is 100 — this fixture's ~21
  // events comfortably fits in one /v1/capture call.
  const res = await postCapture(writeKey, batch)
  if (res.status !== 202) {
    throw new Error(
      `seedSegmentPopulation: postCapture failed (${res.status}): ${JSON.stringify(res.body)}`,
    )
  }

  // Wait for every distinct (event, distinct_id) pair to land before
  // resolving — segment preview counts are wrong (undercount) if a caller
  // queries before ingest has fully caught up. Widen the timeout, not the
  // interval (matches waitForEvent's own convention) since identify +
  // checkout + 3x feature_used per behavioral user is more write volume than
  // the harness's other single-event specs.
  const waits: Promise<unknown>[] = []
  for (const distinctId of [...ids.proUsdOverlap, ...ids.proOnly]) {
    waits.push(waitForEventLanded({ projectId, distinctId, event: '$identify' }))
  }
  for (const distinctId of ids.freeEurControl) {
    waits.push(waitForEventLanded({ projectId, distinctId, event: '$identify' }))
  }
  for (const distinctId of [...ids.proUsdOverlap, ...ids.usdOnly]) {
    waits.push(waitForEventLanded({ projectId, distinctId, event: 'checkout_completed' }))
  }
  for (const distinctId of ids.freeEurControl) {
    waits.push(waitForEventLanded({ projectId, distinctId, event: 'checkout_completed' }))
  }
  for (const distinctId of ids.behavioralMatch) {
    waits.push(
      waitForEventLanded({
        projectId,
        distinctId,
        event: values.behavioralEventName,
        minCount: 3,
      }),
    )
  }
  for (const distinctId of ids.behavioralControl) {
    waits.push(
      waitForEventLanded({
        projectId,
        distinctId,
        event: values.behavioralEventName,
        minCount: 1,
      }),
    )
  }
  await Promise.all(waits)

  return {
    ...ids,
    values,
    proCount: ids.proUsdOverlap.length + ids.proOnly.length,
    freeCount: ids.freeEurControl.length,
    usdCount: ids.proUsdOverlap.length + ids.usdOnly.length,
    eurCount: ids.freeEurControl.length,
    behavioralMatchCount: ids.behavioralMatch.length,
    behavioralControlCount: ids.behavioralControl.length,
    andCount: ids.proUsdOverlap.length,
    orCount: ids.proUsdOverlap.length + ids.proOnly.length + ids.usdOnly.length,
    ids,
  }
}

interface WaitForEventLandedArgs {
  projectId: string
  distinctId: string
  event: string
  /** Minimum row count required before resolving. Default 1. */
  minCount?: number
}

/**
 * Poll ClickHouse (up to 20s, matching `waitForEvent`'s budget in
 * `helpers/clickhouse.ts`) until at least `minCount` rows exist for
 * (project_id, distinct_id, event) — `waitForEvent` only asserts `>= 1`, but
 * the behavioral population needs to confirm all 3 `feature_used` rows for a
 * "match" user have landed, not just the first.
 */
async function waitForEventLanded({
  projectId,
  distinctId,
  event,
  minCount = 1,
}: WaitForEventLandedArgs): Promise<number> {
  return waitFor(
    async () => {
      const rows = await queryClickHouse(
        'SELECT count() as c FROM events FINAL WHERE project_id={pid:String} AND distinct_id={did:String} AND event={ev:String}',
        { pid: projectId, did: distinctId, ev: event },
      )
      const count = Number(rows[0]?.c ?? 0)
      return count >= minCount ? count : false
    },
    { timeoutMs: 20_000, intervalMs: 250 },
  )
}

export interface SeedExperimentPopulationArgs {
  projectId: string
  writeKey: string
  /** Key of an already-created multivariate `FeatureFlag` — the same key the
   * `Experiment`'s `featureFlagId` points at (auto-created
   * flag). The flag should already be active (`launch`) so `/v1/flags`
   * actually returns a variant instead of `enabled: false`. */
  flagKey: string
  /**
   * Total per-run-unique users to bucket through the real `/v1/flags` eval
   * path before grouping by REAL assigned variant. Default 120: for the
   * common 2-variant `control`/`test` 50/50 default (37.6) this settles to
   * roughly ~60/variant once real SHA1 hash-bucketing evens out — inside the
   * "few dozen to a hundred per variant" range e2e "Decisions"
   * section calls for, large enough that the 20%-vs-80% conversion-rate gap
   * this helper seeds (see `outcomeFor`) produces a clear, non-noisy
   * `probabilityToBeBest` separation, small enough to keep this seed step's
   * `/v1/flags` + `/v1/capture` round-trips bounded. Raise it for >2-variant
   * experiments so every arm still clears a few dozen exposures.
   */
  userCount?: number
}

export interface ExperimentVariantOutcome {
  variant: string
  distinctIds: string[]
  exposedCount: number
  /** Exact count of `distinctIds` (a deterministic prefix slice, not a random
   * draw) that fired `funnelConvertedEvent` — see `outcomeFor` for the
   * per-variant rate. */
  convertedCount: number
  /** Every exposed user in this variant emits the SAME numeric `meanProperty`
   * value on `meanEvent`, so the per-variant mean is exactly this constant
   * (not a statistical estimate) — see `outcomeFor`. */
  meanValue: number
}

export interface SeedExperimentPopulationResult {
  runSuffix: string
  /** Fired once per exposed user, 100% of the time — the funnel's first step. */
  funnelStepEvent: string
  /** Fired only for each variant's deterministic conversion slice (first
   * `convertedCount` of that variant's `distinctIds`) — the funnel's
   * second/final step. */
  funnelConvertedEvent: string
  /** Fired once per exposed user, carrying `meanProperty` — feeds a `mean`
   * metric. */
  meanEvent: string
  meanProperty: string
  /** Per-variant outcome, keyed by the REAL variant key `/v1/flags` assigned
   * each user to (never assumed up front — see `seedExperimentPopulation`'s
   * doc comment). */
  variants: Record<string, ExperimentVariantOutcome>
}

/**
 * Deterministic conversion-rate / mean-value assignment per REAL variant key.
 * `experiments.router.ts`'s `create` defaults variants to `control`/`test`
 * unless the caller overrides them, so this only
 * special-cases the literal `'control'` key as the deliberately
 * low-performing baseline; every OTHER variant key (however many arms a
 * caller's experiment has) gets the same boosted rate/value. That produces an
 * unambiguous directional result (every non-control arm beats control) for
 * the default 2-variant shape e2e scope targets; a >2-variant
 * experiment would need a richer per-arm assignment to distinguish arms from
 * each other, which is out of scope here (see "Deferred: >2-variant
 * UI polish").
 */
function outcomeFor(variant: string): { conversionRate: number; meanValue: number } {
  return variant === 'control'
    ? { conversionRate: 0.2, meanValue: 10 }
    : { conversionRate: 0.8, meanValue: 50 }
}

interface WaitForExposuresLandedArgs {
  projectId: string
  runSuffix: string
  flagKey: string
  expectedCount: number
}

/**
 * Poll ClickHouse for the total count of `$feature_flag_called` rows this
 * run's seeded population produced, as ONE aggregate query rather than one
 * `waitForEventLanded` poll per seeded distinct_id (which at `userCount`=120
 * would mean 120 concurrent polling loops hammering ClickHouse). Scopes by
 * `startsWith(distinct_id, 'e2e-exp-<runSuffix>-')` so concurrent/repeated
 * runs against the same `flagKey` never cross-count.
 */
async function waitForExposuresLanded({
  projectId,
  runSuffix,
  flagKey,
  expectedCount,
}: WaitForExposuresLandedArgs): Promise<number> {
  return waitFor(
    async () => {
      const rows = await queryClickHouse(
        `SELECT count() as c FROM events FINAL
         WHERE project_id={pid:String}
           AND event='$feature_flag_called'
           AND JSONExtractString(properties, '$feature_flag')={fk:String}
           AND startsWith(distinct_id, {prefix:String})`,
        { pid: projectId, fk: flagKey, prefix: `e2e-exp-${runSuffix}-` },
      )
      const count = Number(rows[0]?.c ?? 0)
      return count >= expectedCount ? count : false
    },
    // Wider budget than waitForEventLanded's 20s — this waits on the full
    // seeded population (up to ~userCount rows), not a single user's events.
    { timeoutMs: 30_000, intervalMs: 500 },
  )
}

/**
 * Seed a real, exposure-through-conversion experiment population for
 * an already-created (and ideally launched) multivariate `FeatureFlag`, for
 * `experiments-results.spec.ts` to drive `ExperimentResultsPage`
 * against.
 *
 * Per e2e "Decisions": this drives REAL bucketing (`/v1/flags`,
 * the same deterministic SHA1 hash-bucketing the client SDK and Rust capture
 * evaluator use) rather than assuming a 50/50 split, and seeds
 * exposure/conversion/mean events via real `postCapture` calls (capture ->
 * ingest -> ClickHouse -> `flag_events`/`events`), not direct ClickHouse
 * inserts — proving the full pipeline the way `seedSegmentPopulation` does
 * for segments.
 *
 * For each of `userCount` per-run-unique `e2e-exp-<runSuffix>-<i>` users:
 * 1. Evaluate `/v1/flags` for `flagKey` to learn their REAL assigned variant.
 * 2. Emit the exposure event (`$feature_flag_called`,
 *    `$feature_flag`=flagKey, `$feature_flag_response`=variant).
 * 3. Emit `funnelStepEvent` (100% of exposed users — funnel step 1) and,
 *    for a deterministic per-variant slice sized by `outcomeFor`'s
 *    conversion rate (control 20%, every other variant 80%),
 *    `funnelConvertedEvent` (funnel step 2) — so a funnel primary metric
 *    shows control converting at a strictly lower rate than every other arm.
 * 4. Emit `meanEvent` carrying `meanProperty` = a per-variant constant
 *    (control 10, every other variant 50) for every exposed user, so a mean
 *    metric's per-variant average is exact and control is strictly lower.
 *
 * Resolves once every seeded exposure event is confirmed landed in
 * ClickHouse (aggregate poll, not fixed sleep — see
 * `waitForExposuresLanded`). Callers still need their own poll for the
 * downstream funnel/mean rows and the `results` computation itself (per
 * "poll for results, not fixed sleep" decision) since those
 * involve `windowFunnel`/aggregate queries on top of raw ingest lag.
 */
export async function seedExperimentPopulation(
  _page: Page,
  { projectId, writeKey, flagKey, userCount = 120 }: SeedExperimentPopulationArgs,
): Promise<SeedExperimentPopulationResult> {
  const runSuffix = uniqueSuffix()
  const funnelStepEvent = `exp-step-${runSuffix}`
  const funnelConvertedEvent = `exp-converted-${runSuffix}`
  const meanEvent = `exp-mean-${runSuffix}`
  const meanProperty = 'value'

  const distinctIds = Array.from({ length: userCount }, (_, i) => `e2e-exp-${runSuffix}-${i}`)

  // ── Real bucketing ──────────────────────────────────────────────────────
  // Chunked with limited concurrency so this doesn't fire `userCount`
  // simultaneous requests at the capture service at once.
  const byVariant = new Map<string, string[]>()
  const evalChunkSize = 20
  for (let i = 0; i < distinctIds.length; i += evalChunkSize) {
    const chunk = distinctIds.slice(i, i + evalChunkSize)
    const results = await Promise.all(
      chunk.map((distinctId) => evalFlags(writeKey, { distinct_id: distinctId })),
    )
    results.forEach((res, idx) => {
      const distinctId = chunk[idx]
      const variant = res.body.flags[flagKey]?.variant
      if (typeof variant !== 'string' || variant.length === 0) {
        throw new Error(
          `seedExperimentPopulation: /v1/flags returned no variant for "${flagKey}" ` +
            `(distinct_id=${distinctId}, status=${res.status}, body=${JSON.stringify(res.body)}) ` +
            `— is the flag multivariate and active/launched?`,
        )
      }
      const list = byVariant.get(variant) ?? []
      list.push(distinctId)
      byVariant.set(variant, list)
    })
  }

  // ── Emit exposure + funnel + mean events per REAL assigned variant ─────
  const now = new Date().toISOString()
  const batch: CaptureBatchEvent[] = []
  const variants: Record<string, ExperimentVariantOutcome> = {}

  for (const [variant, ids] of byVariant) {
    const { conversionRate, meanValue } = outcomeFor(variant)
    // Deterministic prefix slice (not a random draw) so convertedCount is
    // exact-assertable, same posture as seedSegmentPopulation's fixed groups.
    const convertedCount = Math.round(ids.length * conversionRate)

    ids.forEach((distinctId, idx) => {
      batch.push({
        event: '$feature_flag_called',
        distinct_id: distinctId,
        timestamp: now,
        properties: { $feature_flag: flagKey, $feature_flag_response: variant },
      })
      batch.push({
        event: funnelStepEvent,
        distinct_id: distinctId,
        timestamp: now,
        properties: {},
      })
      if (idx < convertedCount) {
        batch.push({
          event: funnelConvertedEvent,
          distinct_id: distinctId,
          timestamp: now,
          properties: {},
        })
      }
      batch.push({
        event: meanEvent,
        distinct_id: distinctId,
        timestamp: now,
        properties: { [meanProperty]: meanValue },
      })
    })

    variants[variant] = {
      variant,
      distinctIds: ids,
      exposedCount: ids.length,
      convertedCount,
      meanValue,
    }
  }

  // MAX_BATCH in services/capture/src/capture.rs is 100 — at userCount=120
  // this easily exceeds one batch (4 events/user in the worst case), so
  // chunk the /v1/capture calls.
  const captureChunkSize = 90
  for (let i = 0; i < batch.length; i += captureChunkSize) {
    const chunk = batch.slice(i, i + captureChunkSize)
    const res = await postCapture(writeKey, chunk)
    if (res.status !== 202) {
      throw new Error(
        `seedExperimentPopulation: postCapture failed (${res.status}): ${JSON.stringify(res.body)}`,
      )
    }
  }

  await waitForExposuresLanded({ projectId, runSuffix, flagKey, expectedCount: distinctIds.length })

  return { runSuffix, funnelStepEvent, funnelConvertedEvent, meanEvent, meanProperty, variants }
}

export interface WaitForTaxonomyEventArgs {
  projectId: string
  /** Session access token (see `loginViaApi` in `helpers/auth.ts`) — the
   * `taxonomy.events.list` tRPC procedure requires `projects:read`, not a
   * capture write/read key. */
  accessToken: string
  eventName: string
}

/**
 * Poll `taxonomy.events.list` (apps/api's `taxonomy.router.ts`) until
 * `eventName` shows up as a known event, or throw once the budget is
 * exhausted.
 *
 * The `EventCombobox` in `SegmentBuilderPage.tsx` only offers events already
 * present in the taxonomy snapshot — and that snapshot is Redis-cached
 * server-side for `CACHE_TTL_SECONDS = 60` (`taxonomy.router.ts`), separate
 * from (and much longer than) ClickHouse ingest latency. A freshly-seeded
 * event can take up to that ~60s before it becomes pickable in the UI, even
 * though it already landed in ClickHouse. Call this once after seeding
 * (before any test opens the event combobox) instead of retrying the
 * combobox interaction itself — reopening/retyping into the popover doesn't
 * force a cache refresh, since `useEventNames`'s query lives in the page
 * component, not the popover.
 */
export async function waitForTaxonomyEvent({
  projectId,
  accessToken,
  eventName,
}: WaitForTaxonomyEventArgs): Promise<void> {
  await waitFor(
    async () => {
      const input = encodeURIComponent(JSON.stringify({ projectId }))
      const res = await fetch(`${e2eEnv.apiUrl}/trpc/taxonomy.events.list?input=${input}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) return false
      const body = (await res.json().catch(() => undefined)) as
        | { result?: { data?: { name: string }[] } }
        | undefined
      const events = body?.result?.data ?? []
      return events.some((e) => e.name === eventName)
    },
    // Budget covers the 60s server-side cache TTL plus ingest/discovery
    // margin, not just typical ClickHouse propagation lag.
    { timeoutMs: 70_000, intervalMs: 2_000 },
  )
}
