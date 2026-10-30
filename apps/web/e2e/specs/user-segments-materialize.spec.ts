import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import { identify, seedSegmentPopulation } from '../helpers/capture'
import { queryClickHouse, waitForEvent } from '../helpers/clickhouse'

/**
 * Golden spec: materialize snapshot (scenarios 9 + 10).
 *
 * Sibling file to `user-segments.spec.ts` (scenarios 1-8) — this file only covers materialize + staleness
 * display so the base CRUD/condition-type spec doesn't grow unbounded. Do not
 * add scenarios 1-8/11-12 here.
 */

/** Per-run-unique suffix, same convention as `uniqueIds()` in
 * event-pipeline.spec.ts / `seedSegmentPopulation`'s `runSuffix`. */
function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * `TraitFields` (SegmentBuilderPage.tsx) renders the trait-key picker as a
 * plain text `input[placeholder="trait"]` when the project's person-trait
 * taxonomy is still empty, or as a shadcn `Select` (Radix `combobox`) once
 * `useTraitProperties` has at least one option — which branch renders depends
 * on whether some earlier test/run already caused the taxonomy indexer
 * (`services/ingest/src/taxonomy.rs`) to observe a `plan` trait. Handle both
 * so this spec isn't coupled to that race. When the input is absent, the
 * trait-key `Select` is combobox index 1 (index 0 is the always-present
 * condition-type `Select`) — this test only ever has one condition row, so
 * there's no ambiguity with a second row's comboboxes.
 */
async function fillTraitKey(page: Page, key: string): Promise<void> {
  const input = page.getByPlaceholder('trait')
  if ((await input.count()) > 0) {
    await input.fill(key)
    return
  }
  const trigger = page.getByRole('combobox').nth(1)
  await trigger.click()
  await page.getByRole('option', { name: key, exact: true }).click()
}

/** Reads the live preview count (`SegmentPreview`'s "≈ {N} users" line) as a
 * number, polling because the count only settles ~300ms after the last edit
 * (debounced) plus however long the `previewCount` query takes to resolve. */
async function pollPreviewCount(page: Page, expected: number, timeoutMs = 20_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const text = await page
          .getByText(/≈\s*[\d,]+/)
          .textContent()
          .catch(() => null)
        const match = text?.match(/[\d,]+/)
        return match ? Number(match[0].replace(/,/g, '')) : null
      },
      { timeout: timeoutMs },
    )
    .toBe(expected)
}

test.describe('user segments — materialize snapshot', () => {
  test('materializes an exact member set, then surfaces staleness on reload', async ({
    authedPage: page,
    writeKey,
    projectId,
  }) => {
    const suffix = uniqueSuffix()
    const segmentName = `e2e-seg-materialize-${suffix}`

    const population = await seedSegmentPopulation(page, { projectId, writeKey })
    // proUsdOverlap + proOnly are the exact `plan = 'pro'` member set (task
    // the overlap design — see capture.ts's ASCII table).
    const expectedMemberIds = [...population.ids.proUsdOverlap, ...population.ids.proOnly].sort()
    expect(expectedMemberIds).toHaveLength(population.proCount)

    // ── Scenario 9: build + save a trait segment, then materialize it ──────
    await page.goto('/segments/new')

    await page.getByLabel('Segment name').fill(segmentName)

    // The builder starts with one empty `trait` condition row already
    // present (emptyCondition('trait')) with operator defaulted to 'exact'
    // ("equals") — matching "plan exact 'pro'" out of the box, so only the
    // key and value need filling in.
    await fillTraitKey(page, 'plan')
    await page.getByPlaceholder('value').fill(population.values.planProValue)

    await pollPreviewCount(page, population.proCount)

    await page.getByRole('button', { name: 'Create segment' }).click()
    await expect(page).toHaveURL(/\/segments$/)

    const row = page.getByRole('row', { name: new RegExp(segmentName) })
    await expect(row).toBeVisible()
    await row.click()
    await expect(page).toHaveURL(/\/segments\/[^/]+\/edit$/)
    const segmentId = page.url().match(/\/segments\/([^/]+)\/edit$/)?.[1]
    if (!segmentId) throw new Error('Could not resolve segment id from URL after navigating in.')

    // Live preview should settle back to the same exact count once the saved
    // definition rehydrates.
    await pollPreviewCount(page, population.proCount)

    await page.getByRole('button', { name: 'Materialize now' }).click()
    const snapshotText = page.getByText(/\d+ members$/)
    await expect(snapshotText).toBeVisible({ timeout: 20_000 })
    const materializedCountBeforeReload = Number(
      (await snapshotText.textContent())?.match(/\d+/)?.[0] ?? Number.NaN,
    )
    expect(materializedCountBeforeReload).toBe(population.proCount)

    // The materialize mutation writes directly to ClickHouse's
    // `segment_members` (segments.router.ts's `materialize` procedure) — read
    // it back straight from ClickHouse, not just via the API/UI, and assert
    // the exact member *set* (not just a count) to catch off-by-one /
    // wrong-id-column bugs the count alone wouldn't surface.
    //
    // `person_id` shape: `buildSegmentMembers` (packages/clickhouse/src/queries.ts)
    // resolves `coalesce(nullIf(pdi.person_id, ''), events.distinct_id)` via
    // `PERSON_JOIN` against `person_distinct_ids`. `seedSegmentPopulation`'s
    // `identify()` calls never send `properties.$anon_distinct_id`, so
    // `services/ingest/src/identity.rs`'s `Identity::resolve` skips every one
    // of them (it only merges identify events that carry a distinct
    // `$anon_distinct_id`) — no `person_distinct_ids` row is ever written for
    // these users, `pdi.person_id` is always NULL/'' for them, and the
    // coalesce falls back to `events.distinct_id`. So for this population,
    // `person_id` in `segment_members` is exactly the `distinct_id` used at
    // capture time — the raw seeded ids are the right comparison, no extra
    // person-id resolution needed.
    const rows = await queryClickHouse(
      'SELECT person_id FROM segment_members WHERE project_id={pid:String} AND segment_id={sid:String} ORDER BY person_id',
      { pid: projectId, sid: segmentId },
    )
    const materializedIds = (rows as { person_id: string }[]).map((r) => r.person_id).sort()
    expect(materializedIds).toEqual(expectedMemberIds)

    // ── Scenario 10: staleness display ──────────────────────────────────────
    // Grow the live population by one more `plan = 'pro'` match, then confirm
    // the live dynamic count and the already-materialized snapshot's count
    // now visibly diverge, instead of the UI silently keeping them in sync.
    const extraDistinctId = `e2e-seg-${suffix}-extra-pro`
    const identifyRes = await identify(writeKey, {
      distinctId: extraDistinctId,
      set: { plan: population.values.planProValue },
    })
    expect(identifyRes.status).toBe(202)
    await waitForEvent({ projectId, distinctId: extraDistinctId, event: '$identify' })

    // SegmentBuilderPage now seeds its Snapshot panel from
    // `segments.latestSnapshot` on mount (in addition to the plain `useState`
    // set as the direct result of clicking "Materialize now" in the current
    // session), so after `page.reload()` the persisted snapshot count from
    // Postgres is still shown — even though the live dynamic count has since
    // diverged from it. Assert both are visible side-by-side and disagree,
    // proving the snapshot correctly stays stale rather than silently
    // re-syncing to the grown population.
    await page.reload()
    await pollPreviewCount(page, population.proCount + 1)
    expect(population.proCount + 1).toBeGreaterThan(materializedCountBeforeReload)

    const snapshotTextAfterReload = page.getByText(/\d+ members$/)
    await expect(snapshotTextAfterReload).toBeVisible({ timeout: 20_000 })
    const materializedCountAfterReload = Number(
      (await snapshotTextAfterReload.textContent())?.match(/\d+/)?.[0] ?? Number.NaN,
    )
    expect(materializedCountAfterReload).toBe(materializedCountBeforeReload)
    expect(materializedCountAfterReload).toBeLessThan(population.proCount + 1)
  })
})
