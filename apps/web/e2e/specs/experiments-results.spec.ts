import { expect, test } from '../fixtures'
import { loginViaApi } from '../helpers/auth'
import { seedExperimentPopulation } from '../helpers/capture'
import { prisma } from '../helpers/db'
import { e2eEnv } from '../helpers/env'

/**
 * Golden spec: results computation per metric type.
 *
 * Sibling file to `experiments.spec.ts` (CRUD/lifecycle) and
 * `experiments-tenancy.spec.ts` — this file only covers the
 * `results` procedure's per-metric-type Bayesian output, driven end to end
 * (capture -> ingest -> ClickHouse -> `results` -> `ExperimentResultsPage`).
 *
 * ── Why creation goes through `experiments.create`/`update` directly, not
 * the builder UI ──
 * `ExperimentBuilderPage`'s funnel/mean event pickers are a closed
 * `EventCombobox` (options come from the taxonomy snapshot only — no
 * freeform entry), but `seedExperimentPopulation` mints fresh, per-run-unique
 * event names (`exp-step-<runSuffix>`, etc.) that don't exist in taxonomy
 * until *after* it seeds them, and it needs the experiment's already-created
 * flag key to bucket against. That's a genuine chicken/egg: the real event
 * names aren't known until after the experiment (and its linked flag) already
 * exist. `experiments.spec.ts` sidesteps this by pre-seeding two
 * fixed event names via `postCapture` *before* creating the experiment, so
 * the builder's combobox has something to pick — appropriate there since that
 * file is about builder/CRUD mechanics. This file is purely about the
 * `results` procedure's math and the results page's rendering of it, so it
 * creates the experiment with a throwaway placeholder metric via
 * `experiments.create` (real router, no UI), launches it via
 * `experiments.launch` (so `startedAt` predates every seeded event —
 * `results` gates its ClickHouse query window on `experiment.startedAt`),
 * seeds real bucketed traffic via `seedExperimentPopulation`, then repoints
 * `primaryMetric` at the real seeded event names via `experiments.update`
 * (metric edits are allowed regardless of `status`, only `variants` edits are
 * draft-gated — see experiments.router.ts's `update`). Only the *results*
 * page itself is driven through the real browser UI.
 *
 * ── Ratio/retention gap ──
 * Per the stated scope ("ratio/retention if time allows within this
 * task's scope, otherwise unit-tested only per 37.11 and noted as a gap
 * here"): this file covers funnel + mean only. Ratio/retention builders and
 * their Beta-Binomial/Gamma-Poisson wiring are covered by
 * `packages/clickhouse/src/queries.test.ts` and
 * `apps/api/src/trpc/routers/experiments.stats.test.ts` (unit level), not
 * exercised live here — deferred, not an oversight, per the task's explicit
 * permission to scope this down.
 */

test.describe.configure({ timeout: 180_000 })

function uniqueName(label: string): string {
  return `e2e-exp-results-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

type ApiMetric =
  | { type: 'funnel'; steps: { event: string }[]; window: number }
  | { type: 'mean'; event: string; property: string }

interface CreateExperimentArgs {
  accessToken: string
  projectId: string
  name: string
  primaryMetric: ApiMetric
}

/**
 * Create an experiment via the real `experiments.create` tRPC mutation
 * directly (no browser) — see the file doc comment for why this bypasses the
 * builder UI. Default variants (`control`/`test` 50/50) are left unspecified
 * so the linked flag matches `seedExperimentPopulation`'s `outcomeFor`
 * assumption (only `'control'` is treated as the low-performing baseline).
 */
async function createExperimentViaApi({
  accessToken,
  projectId,
  name,
  primaryMetric,
}: CreateExperimentArgs): Promise<{ id: string; featureFlagId: string }> {
  const res = await fetch(`${e2eEnv.apiUrl}/trpc/experiments.create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ projectId, name, primaryMetric }),
  })
  const payload = await res.json().catch(() => undefined)
  if (!res.ok || !payload?.result?.data?.id) {
    throw new Error(
      `createExperimentViaApi(${name}) failed (${res.status}): ${JSON.stringify(payload)}`,
    )
  }
  return {
    id: payload.result.data.id as string,
    featureFlagId: payload.result.data.featureFlagId as string,
  }
}

interface LaunchExperimentArgs {
  accessToken: string
  projectId: string
  id: string
}

/** Launch via the real `experiments.launch` mutation — sets `startedAt` and
 * activates the linked flag, both required before `seedExperimentPopulation`
 * can bucket real traffic through `/v1/flags` and before that traffic's
 * timestamps fall inside `results`' `[startedAt, now()]` query window. */
async function launchExperimentViaApi({
  accessToken,
  projectId,
  id,
}: LaunchExperimentArgs): Promise<void> {
  const res = await fetch(`${e2eEnv.apiUrl}/trpc/experiments.launch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ projectId, id }),
  })
  if (!res.ok) {
    const payload = await res.json().catch(() => undefined)
    throw new Error(
      `launchExperimentViaApi(${id}) failed (${res.status}): ${JSON.stringify(payload)}`,
    )
  }
}

interface UpdatePrimaryMetricArgs {
  accessToken: string
  projectId: string
  id: string
  primaryMetric: ApiMetric
}

/** Repoint `primaryMetric` at the real seeded event names via the real
 * `experiments.update` mutation — metric edits are unconditional (only
 * `variants` edits are draft-gated), so this works fine post-launch. */
async function updatePrimaryMetricViaApi({
  accessToken,
  projectId,
  id,
  primaryMetric,
}: UpdatePrimaryMetricArgs): Promise<void> {
  const res = await fetch(`${e2eEnv.apiUrl}/trpc/experiments.update`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ projectId, id, patch: { primaryMetric } }),
  })
  if (!res.ok) {
    const payload = await res.json().catch(() => undefined)
    throw new Error(
      `updatePrimaryMetricViaApi(${id}) failed (${res.status}): ${JSON.stringify(payload)}`,
    )
  }
}

interface CardReadout {
  probabilityToBeBest: number
  upliftText: string
  hasCredibleInterval: boolean
}

/**
 * Read one `VariantCard`'s (ExperimentResultsPage.tsx) rendered numbers for
 * `variantKey` within the section whose `<section>` contains `sectionText`
 * ("Primary metric" — this spec never adds secondary metrics). Returns `null`
 * if the card (or any of the three fields this spec asserts on) isn't
 * present yet, so callers can treat that as "not ready" during polling.
 */
async function readVariantCard(
  page: import('@playwright/test').Page,
  sectionText: string,
  variantKey: string,
): Promise<CardReadout | null> {
  const section = page.locator('section', { hasText: sectionText }).first()
  const card = section
    .locator('div.rounded-xl.border')
    .filter({ has: page.getByText(variantKey, { exact: true }) })
    .first()
  // `locator.count()` never auto-waits — it's a synchronous snapshot of the
  // DOM at call time, so checking it immediately after `page.reload()` races
  // the app's post-load async data fetch (RequireAuth's session check +
  // trpc's projects.list/experiments.get/experiments.results) and reliably
  // loses: the card hasn't rendered yet, `count()` returns 0 instantly, and
  // there's no further wait within this single poll attempt for it to
  // appear. `waitFor` gives each attempt a real (bounded, short) window for
  // the card to attach before giving up as "not ready yet" — still safe to
  // poll again on the next reload if the metric genuinely isn't ready.
  try {
    await card.waitFor({ state: 'attached', timeout: 3_000 })
  } catch {
    return null
  }

  // `innerText()` returns text as actually RENDERED, which means it honors
  // CSS `text-transform` — and the "Chance to win"/"vs. control" labels
  // (ExperimentResultsPage.tsx's `VariantCard`) carry Tailwind's `uppercase`
  // class, so the browser renders (and `innerText()` returns) "CHANCE TO
  // WIN"/"VS. CONTROL", not the literal-case JSX source text. Case-sensitive
  // regexes here would never match, always return `null`, and make every
  // poll attempt look like "not ready yet" even once the card has fully
  // rendered correct data — hence the `i` flag.
  const text = await card.innerText()
  const probMatch = text.match(/Chance to win[^\d]*?([\d.]+)%/i)
  const upliftMatch = text.match(/vs\. control[\s\S]{0,20}?(—|[+-][\d.]+%)/i)
  const hasCredibleInterval = /95% CI:/i.test(text)
  if (!probMatch || !upliftMatch || !hasCredibleInterval) return null

  return {
    probabilityToBeBest: Number(probMatch[1]),
    upliftText: upliftMatch[1] as string,
    hasCredibleInterval,
  }
}

interface DirectionalResult {
  control: CardReadout
  winner: CardReadout
}

/**
 * Poll (reload + re-read; "poll for results, not fixed sleep"
 * decision) `ExperimentResultsPage` until both `controlKey`'s and
 * `winnerKey`'s cards render full numbers AND `winnerKey`'s
 * `probabilityToBeBest` clears `controlKey`'s — directional correctness only,
 * matching stated scope (exact-float assertions belong to
 * `experiments.stats.test.ts`, 37.11). Budget widened well past ingest lag to
 * also cover the live `windowFunnel`/aggregate computation `results` runs on
 * every call (no snapshot/cache).
 */
async function pollDirectionalWinner(
  page: import('@playwright/test').Page,
  sectionText: string,
  controlKey: string,
  winnerKey: string,
  // Generous on purpose, not a slow-by-design assertion: the underlying
  // results computation is a live ClickHouse query with no snapshot/cache
  // so a cold first run pays for query-plan/JIT warmup plus
  // `fullyParallel: true` worker contention on top of the actual compute
  // time. Observed cold-start runs finish well past the old 90s budget with
  // an already-converged, correct winner sitting in the DOM — i.e. the
  // timeout was firing before rendering caught up, not because the
  // computation was wrong or hung. Widen here rather than "fixing" this back
  // down if it looks slow in isolation.
  timeoutMs = 150_000,
): Promise<DirectionalResult> {
  let latest: DirectionalResult | null = null

  await expect
    .poll(
      async () => {
        await page.reload()
        // Short-circuit: don't spend a second `readVariantCard` wait budget
        // on `winnerKey` when `controlKey` isn't even rendered yet — halves
        // the wall-clock cost of an early "not ready" iteration.
        const control = await readVariantCard(page, sectionText, controlKey)
        if (!control) return false
        const winner = await readVariantCard(page, sectionText, winnerKey)
        if (!winner) return false
        latest = { control, winner }
        return winner.probabilityToBeBest > control.probabilityToBeBest
      },
      { timeout: timeoutMs, intervals: [5_000] },
    )
    .toBe(true)

  if (!latest) throw new Error('pollDirectionalWinner: never captured a valid readout')
  return latest
}

test.describe('experiments — results computation per metric type', () => {
  test('funnel primary metric — the higher-converting seeded variant shows a higher probabilityToBeBest than control', async ({
    authedPage: page,
    projectId,
    writeKey,
  }) => {
    const { accessToken } = await loginViaApi(e2eEnv.org.userEmail, e2eEnv.org.userPassword)
    const name = uniqueName('funnel')

    // Placeholder metric — real event names aren't known until the flag
    // exists and seedExperimentPopulation mints them (see file doc comment).
    const { id, featureFlagId } = await createExperimentViaApi({
      accessToken,
      projectId,
      name,
      primaryMetric: { type: 'mean', event: 'placeholder', property: 'value' },
    })
    await launchExperimentViaApi({ accessToken, projectId, id })

    const flag = await prisma.featureFlag.findUniqueOrThrow({ where: { id: featureFlagId } })
    const population = await seedExperimentPopulation(page, {
      projectId,
      writeKey,
      flagKey: flag.key,
    })

    expect(population.variants.control, 'control variant got no exposed traffic').toBeTruthy()
    expect(population.variants.test, 'test variant got no exposed traffic').toBeTruthy()
    // Seeded per seedExperimentPopulation's outcomeFor: control converts at
    // 20%, every other variant (here, 'test') at 80%.
    expect(population.variants.test.convertedCount).toBeGreaterThan(
      population.variants.control.convertedCount,
    )

    await updatePrimaryMetricViaApi({
      accessToken,
      projectId,
      id,
      primaryMetric: {
        type: 'funnel',
        steps: [{ event: population.funnelStepEvent }, { event: population.funnelConvertedEvent }],
        window: 3_600,
      },
    })

    await page.goto(`/experiments/${id}/results`)
    const { control, winner } = await pollDirectionalWinner(
      page,
      'Primary metric',
      'control',
      'test',
    )

    expect(winner.probabilityToBeBest).toBeGreaterThan(control.probabilityToBeBest)
    expect(control.hasCredibleInterval).toBe(true)
    expect(winner.hasCredibleInterval).toBe(true)
    expect(control.upliftText).toBe('—')
    expect(winner.upliftText).not.toBe('—')
    expect(winner.upliftText).toMatch(/^\+[\d.]+%$/)
  })

  test('mean primary metric — the higher-mean seeded variant shows a higher probabilityToBeBest than control', async ({
    authedPage: page,
    projectId,
    writeKey,
  }) => {
    const { accessToken } = await loginViaApi(e2eEnv.org.userEmail, e2eEnv.org.userPassword)
    const name = uniqueName('mean')

    const { id, featureFlagId } = await createExperimentViaApi({
      accessToken,
      projectId,
      name,
      primaryMetric: { type: 'mean', event: 'placeholder', property: 'value' },
    })
    await launchExperimentViaApi({ accessToken, projectId, id })

    const flag = await prisma.featureFlag.findUniqueOrThrow({ where: { id: featureFlagId } })
    const population = await seedExperimentPopulation(page, {
      projectId,
      writeKey,
      flagKey: flag.key,
    })

    expect(population.variants.control).toBeTruthy()
    expect(population.variants.test).toBeTruthy()
    // Seeded per outcomeFor: control's meanValue is 10, every other variant's
    // (here, 'test') is 50.
    expect(population.variants.test.meanValue).toBeGreaterThan(
      population.variants.control.meanValue,
    )

    await updatePrimaryMetricViaApi({
      accessToken,
      projectId,
      id,
      primaryMetric: {
        type: 'mean',
        event: population.meanEvent,
        property: population.meanProperty,
      },
    })

    await page.goto(`/experiments/${id}/results`)
    const { control, winner } = await pollDirectionalWinner(
      page,
      'Primary metric',
      'control',
      'test',
    )

    expect(winner.probabilityToBeBest).toBeGreaterThan(control.probabilityToBeBest)
    expect(control.hasCredibleInterval).toBe(true)
    expect(winner.hasCredibleInterval).toBe(true)
    expect(control.upliftText).toBe('—')
    expect(winner.upliftText).not.toBe('—')
    expect(winner.upliftText).toMatch(/^\+[\d.]+%$/)
  })
})
