import type { Locator, Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import { loginViaApi } from '../helpers/auth'
import {
  type SeedSegmentPopulationResult,
  seedSegmentPopulation,
  waitForTaxonomyEvent,
} from '../helpers/capture'
import { getProjectIdBySlug } from '../helpers/db'
import { e2eEnv } from '../helpers/env'

/**
 * Golden spec covering scenarios 1-8: segment CRUD, all three
 * condition types in isolation, AND/OR combination, empty-match handling,
 * edit, and delete. Scenarios 9-12 (materialize snapshot, staleness,
 * tenancy, permission gate) are separate sibling spec files.
 *
 * The population is seeded once per file (not per test) via `beforeAll` —
 * `seedSegmentPopulation` is per-run-unique (its own `e2e-seg-<uuid>`
 * convention), so every test in this file can safely share the same
 * `population` without cross-test pollution, and re-running the suite never
 * double-counts a prior run's rows. `projectId`/`writeKey` are resolved
 * directly (not via the `authedPage`/`projectId` fixtures, which are
 * test-scoped, not available in `beforeAll`) since they're fixed values for
 * the `e2e` org regardless of which test consumes them.
 */

let population: SeedSegmentPopulationResult
let projectId: string

test.describe('user segments — CRUD, condition types, live preview', () => {
  // Bump the suite (and hook) timeout budget above Playwright's 30s default:
  // seeding ~21 events across 6 sub-populations, plus segment preview reads
  // that must survive both capture->ClickHouse ingest lag AND
  // identity-merge lag (person_distinct_ids, written after the batch insert
  // needs more headroom than a single-event spec. Also
  // covers `waitForTaxonomyEvent`'s up-to-70s budget (taxonomy.router.ts's
  // 60s Redis snapshot cache TTL) in `beforeAll` below.
  //
  // `describe.configure({ timeout })` only raises the budget for tests, not
  // hooks — `beforeAll`/`afterAll` keep Playwright's 30s hook default
  // regardless, so `test.setTimeout()` inside the hook body (below) is also
  // required to actually cover `waitForTaxonomyEvent`'s worst case.
  test.describe.configure({ timeout: 120_000 })

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    projectId = await getProjectIdBySlug(e2eEnv.org.orgSlug, e2eEnv.org.projectName)
    population = await seedSegmentPopulation(null as unknown as Page, {
      projectId,
      writeKey: e2eEnv.org.writeKey,
    })

    // The event-property/AND/OR/behavioral scenarios pick their event from
    // the builder's EventCombobox (SegmentBuilderPage.tsx's `EventCombobox`,
    // fed by `useEventNames` -> `taxonomy.events.list`). That endpoint is
    // Redis-cached server-side for up to 60s independently of ClickHouse
    // ingest latency, so a freshly-seeded event can be invisible to the
    // combobox well after `seedSegmentPopulation` has already confirmed it
    // landed in ClickHouse. Wait for both here, once, so no individual test
    // needs to retry the combobox interaction itself.
    const { accessToken } = await loginViaApi(e2eEnv.org.userEmail, e2eEnv.org.userPassword)
    await Promise.all([
      waitForTaxonomyEvent({ projectId, accessToken, eventName: 'checkout_completed' }),
      waitForTaxonomyEvent({
        projectId,
        accessToken,
        eventName: population.values.behavioralEventName,
      }),
    ])
  })

  // ── Builder page helpers ──────────────────────────────────────────────

  /** Each condition row is a direct child of the single `space-y-2` wrapper
   * in SegmentBuilderPage.tsx — there's no other `space-y-2` container on the
   * page, so this is a stable (if structural) way to scope per-row locators
   * without relying on test ids the page doesn't have. */
  function conditionRow(page: Page, index: number): Locator {
    return page.locator('div.space-y-2 > div').nth(index)
  }

  async function addCondition(page: Page) {
    await page.getByRole('button', { name: 'Add condition' }).click()
  }

  async function setConditionType(row: Locator, label: 'Trait' | 'Event property' | 'Behavioral') {
    const page = row.page()
    // The condition-type Select is always the first combobox rendered in a
    // row (ConditionRow.tsx renders it before any type-specific fields).
    await row.getByRole('combobox').first().click()
    await page.getByRole('option', { name: label, exact: true }).click()
  }

  /** Trait/event-property key field: renders as a Radix `Select` once the
   * project's taxonomy has known keys (likely true here, since seeding
   * already identified `plan`/`currency`), or a plain text input otherwise
   * (TraitFields/EventPropertyFields in SegmentBuilderPage.tsx). Handle both
   * so the spec doesn't depend on taxonomy cache timing.
   *
   * Can't match the Select trigger with `getByRole('combobox', { name })`:
   * ARIA's `combobox` role isn't in the "name from content" role list, so a
   * shadcn/Radix `SelectTrigger` with only visible text (no `aria-label`)
   * exposes an EMPTY accessible name to the a11y tree even though
   * `textContent` shows the placeholder/value — `getByRole` name matching
   * silently returns zero matches. Match on visible text instead, scoped to
   * `button[role="combobox"]` (both the type-select and operator-select in
   * the same row also carry that role, so anchor the text match to the exact
   * placeholder to avoid colliding with e.g. "Trait"/"Event property").
   *
   * Separately, the taxonomy query backing the Select can resolve *after*
   * the initial render (plain input first, swapped for a Select once
   * `useTraitProperties`/`useEventProperties` returns), so a single snapshot
   * check races that swap: it can commit to the plain-input branch, then the
   * input unmounts mid-interaction once the Select arrives, hanging the
   * `.fill()` forever. Wrap the whole detect-and-act sequence in `toPass` so
   * a mid-flight swap just retries from a fresh snapshot instead of hanging
   * on a stale locator. */
  async function setKeyField(row: Locator, key: string, placeholder: 'trait' | 'property') {
    const page = row.page()
    await expect(async () => {
      const select = row
        .locator('button[role="combobox"]')
        .filter({ hasText: new RegExp(`^${placeholder}$`) })
      if ((await select.count()) > 0) {
        await select.click({ timeout: 5_000 })
        await page.getByRole('option', { name: key, exact: true }).click({ timeout: 5_000 })
      } else {
        await row.getByPlaceholder(placeholder).fill(key, { timeout: 5_000 })
      }
    }).toPass({ timeout: 25_000, intervals: [250, 500, 1_000] })
  }

  async function setValueField(row: Locator, value: string) {
    const input = row.getByPlaceholder('value')
    await input.fill('')
    await input.fill(value)
  }

  /** The event picker (EventCombobox in SegmentBuilderPage.tsx) is a
   * Command/Popover combobox, not a Radix Select — trigger is a plain
   * button, options render with role="option" (cmdk's default a11y
   * behavior). `triggerPlaceholder` disambiguates event_property's "any
   * event" vs behavioral's "Select event". */
  async function pickEvent(row: Locator, triggerPlaceholder: string, eventName: string) {
    const page = row.page()
    await row.getByRole('button', { name: triggerPlaceholder }).click()
    await page.getByPlaceholder('Search events...').fill(eventName)
    await page.getByRole('option', { name: eventName, exact: true }).click()
  }

  async function setBehavioralFields(row: Locator, count: number, days: number) {
    const inputs = row.locator('input[type="number"]')
    await inputs.nth(0).fill(String(count))
    await inputs.nth(1).fill(String(days))
  }

  async function setCombinator(page: Page, combinator: 'AND' | 'OR') {
    await page.getByRole('button', { name: combinator, exact: true }).click()
  }

  /** Scopes to SegmentPreview's card specifically — it uses `rounded-xl p-5`
   * while the Snapshot card below it (also `rounded-xl`) uses `p-4`, so this
   * distinguishes the two without a test id. */
  function previewCard(page: Page): Locator {
    return page.locator('div.rounded-xl.p-5')
  }

  /** Parses the live "≈ N users (last D days)" text, or `null` if the
   * preview is in its empty/idle/error state (no "≈" count rendered). */
  async function readPreviewCount(page: Page): Promise<number | null> {
    const text =
      (await previewCard(page)
        .textContent()
        .catch(() => null)) ?? ''
    const match = text.match(/≈\s*([\d,]+)/)
    if (!match) return null
    return Number(match[1].replace(/,/g, ''))
  }

  /** Poll budget widened (not shortened interval), matching the
   * warning that trait/event-property preview resolution can lag behind
   * plain event-visibility because it also depends on identity-merge having
   * completed, not just the raw event landing in ClickHouse. */
  async function waitForPreviewCount(page: Page, expected: number) {
    await expect
      .poll(() => readPreviewCount(page), { timeout: 45_000, intervals: [500, 1_000] })
      .toBe(expected)
  }

  async function waitForPreviewEmpty(page: Page) {
    await expect
      .poll(
        async () =>
          (await previewCard(page)
            .textContent()
            .catch(() => '')) ?? '',
        { timeout: 45_000, intervals: [500, 1_000] },
      )
      .toContain('No users match this segment')
  }

  function segmentRow(page: Page, name: string) {
    return page.getByRole('row', { name: new RegExp(name) })
  }

  // ── Members table (SegmentMembersTable) helpers ────────────────────────

  /** SegmentMembersTable's own root wrapper — the only `rounded-xl
   * overflow-hidden` card on the page (SegmentPreview's card uses
   * `rounded-xl p-5`, the Snapshot card uses `rounded-xl p-4`), so this
   * cleanly scopes to it without a test id. */
  function membersCard(page: Page): Locator {
    return page.locator('div.rounded-xl.overflow-hidden')
  }

  function memberRows(page: Page): Locator {
    return membersCard(page).locator('tbody tr')
  }

  /** Same lag characteristics as `waitForPreviewCount` (shares the same
   * debounced definition/query timing), so the same widened poll budget. */
  async function waitForMembersRowCount(page: Page, expected: number) {
    await expect
      .poll(() => memberRows(page).count(), { timeout: 45_000, intervals: [500, 1_000] })
      .toBe(expected)
  }

  function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  // ── Direct API helper for scenario 8's soft-delete assertion ──────────

  /** Plain (non-batched) tRPC GET call for `segments.get`, mirroring
   * `loginViaApi`/`setOveragePolicy`'s calling convention (no superjson
   * envelope) — used to assert the deleted segment id is genuinely
   * unreachable (`NOT_FOUND` -> HTTP 404) via the API directly, not just
   * absent from the list UI. */
  async function getSegmentDirect(id: string): Promise<{ status: number; body: unknown }> {
    const { accessToken } = await loginViaApi(e2eEnv.org.userEmail, e2eEnv.org.userPassword)
    const input = encodeURIComponent(JSON.stringify({ projectId, id }))
    const res = await fetch(`${e2eEnv.apiUrl}/trpc/segments.get?input=${input}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    const body = await res.json().catch(() => undefined)
    return { status: res.status, body }
  }

  function extractSegmentId(url: string): string {
    const match = url.match(/\/segments\/([^/]+)\/edit/)
    if (!match) throw new Error(`extractSegmentId: could not parse segment id from URL: ${url}`)
    return match[1]
  }

  function uniqueName(label: string): string {
    return `e2e-seg-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }

  // ── Scenario 1: trait condition ────────────────────────────────────────

  test('create — trait condition (plan exact pro)', async ({ authedPage: page }) => {
    const name = uniqueName('trait-pro')
    await page.goto('/segments/new')
    await page.locator('#segment-name').fill(name)

    const row = conditionRow(page, 0)
    // Default condition is already type 'trait' with operator 'exact'
    // (emptyCondition('trait') in SegmentBuilderPage.tsx) — no type/operator
    // interaction needed.
    await setKeyField(row, 'plan', 'trait')
    await setValueField(row, population.values.planProValue)

    await waitForPreviewCount(page, population.proCount)

    await page.getByRole('button', { name: 'Create segment' }).click()
    await page.waitForURL('/segments')
    await expect(segmentRow(page, name)).toBeVisible()
  })

  // ── Members table (SegmentMembersTable) ──────────────────────
  // Reuses the same trait condition (plan=pro) as scenario 1 above — its
  // resolved proCount (3) is small enough to double as the pagination
  // boundary case (see comment below) without a dedicated large seed.

  test('members table — row count matches preview, pagination boundaries, row click navigates to user profile', async ({
    authedPage: page,
  }) => {
    const name = uniqueName('members')
    await page.goto('/segments/new')
    await page.locator('#segment-name').fill(name)

    const row = conditionRow(page, 0)
    await setKeyField(row, 'plan', 'trait')
    await setValueField(row, population.values.planProValue)

    await waitForPreviewCount(page, population.proCount)
    await waitForMembersRowCount(page, population.proCount)

    // Pagination boundary: with only proCount (3) rows — far under
    // MEMBERS_PAGE_SIZE (50) in SegmentBuilderPage.tsx — this is page 1 with
    // no next page, so Prev must be disabled (page === 1) and Next must be
    // disabled (rows.length < 50). A true "click Next, land on page 2"
    // scenario needs a 50+-member seed, which none of this file's existing
    // sub-populations reach (they're single/low-double digits by design —
    // see seedSegmentPopulation's overlap-count comment) — out of scope for
    // this addition.
    await expect(membersCard(page).getByRole('button', { name: 'Previous' })).toBeDisabled()
    await expect(membersCard(page).getByRole('button', { name: 'Next' })).toBeDisabled()

    const firstRow = memberRows(page).first()
    const personId = (await firstRow.textContent())?.trim() ?? ''
    expect(personId.length).toBeGreaterThan(0)

    await firstRow.click()
    await page.waitForURL(new RegExp(`/users/${escapeRegExp(encodeURIComponent(personId))}$`))
  })

  // ── Scenario 2: event property condition ───────────────────────────────

  test('create — event property condition (currency exact usd)', async ({ authedPage: page }) => {
    const name = uniqueName('event-prop-usd')
    await page.goto('/segments/new')
    await page.locator('#segment-name').fill(name)

    const row = conditionRow(page, 0)
    await setConditionType(row, 'Event property')
    await pickEvent(row, 'any event', 'checkout_completed')
    await setKeyField(row, 'currency', 'property')
    await setValueField(row, population.values.currencyUsdValue)

    await waitForPreviewCount(page, population.usdCount)
  })

  // ── Scenario 3: behavioral condition ───────────────────────────────────

  test('create — behavioral condition (feature_used >=3 in last 1 day)', async ({
    authedPage: page,
  }) => {
    const name = uniqueName('behavioral')
    await page.goto('/segments/new')
    await page.locator('#segment-name').fill(name)

    const row = conditionRow(page, 0)
    await setConditionType(row, 'Behavioral')
    await pickEvent(row, 'Select event', population.values.behavioralEventName)
    await setBehavioralFields(row, 3, 1)

    // Exact count proves the control group (1 occurrence each) is excluded —
    // if it leaked in, the count would be behavioralMatchCount +
    // behavioralControlCount instead.
    await waitForPreviewCount(page, population.behavioralMatchCount)
  })

  // ── Scenario 4: AND combination ────────────────────────────────────────

  test('AND combination (plan=pro AND currency=usd)', async ({ authedPage: page }) => {
    const name = uniqueName('and')
    await page.goto('/segments/new')
    await page.locator('#segment-name').fill(name)

    const row0 = conditionRow(page, 0)
    await setKeyField(row0, 'plan', 'trait')
    await setValueField(row0, population.values.planProValue)

    await addCondition(page)
    const row1 = conditionRow(page, 1)
    await setConditionType(row1, 'Event property')
    await pickEvent(row1, 'any event', 'checkout_completed')
    await setKeyField(row1, 'currency', 'property')
    await setValueField(row1, population.values.currencyUsdValue)

    // Combinator defaults to AND — no toggle needed.
    await waitForPreviewCount(page, population.andCount)

    const count = await readPreviewCount(page)
    expect(count).not.toBeNull()
    expect(count as number).toBeLessThan(population.proCount)
    expect(count as number).toBeLessThan(population.usdCount)
  })

  // ── Scenario 5: OR combination ─────────────────────────────────────────

  test('OR combination (plan=pro OR currency=usd)', async ({ authedPage: page }) => {
    const name = uniqueName('or')
    await page.goto('/segments/new')
    await page.locator('#segment-name').fill(name)

    const row0 = conditionRow(page, 0)
    await setKeyField(row0, 'plan', 'trait')
    await setValueField(row0, population.values.planProValue)

    await addCondition(page)
    const row1 = conditionRow(page, 1)
    await setConditionType(row1, 'Event property')
    await pickEvent(row1, 'any event', 'checkout_completed')
    await setKeyField(row1, 'currency', 'property')
    await setValueField(row1, population.values.currencyUsdValue)

    await setCombinator(page, 'OR')

    await waitForPreviewCount(page, population.orCount)

    const count = await readPreviewCount(page)
    expect(count).not.toBeNull()
    expect(count as number).toBeGreaterThan(population.proCount)
    expect(count as number).toBeGreaterThan(population.usdCount)
  })

  // ── Scenario 6: empty match ─────────────────────────────────────────────

  test('empty match renders 0/empty state, not an error or stuck spinner', async ({
    authedPage: page,
  }) => {
    const name = uniqueName('empty')
    await page.goto('/segments/new')
    await page.locator('#segment-name').fill(name)

    const row = conditionRow(page, 0)
    await setKeyField(row, 'plan', 'trait')
    await setValueField(row, 'nonexistent-plan')

    await waitForPreviewEmpty(page)

    // Not stuck loading and not an error alert.
    await expect(page.getByText('Failed to preview segment')).not.toBeVisible()

    // Members table (SegmentMembersTable) mirrors the same zero-match
    // condition — assert its own TableEmpty state settles too, not a stuck
    // TableLoading skeleton or a TableError.
    await expect(membersCard(page).getByText('No users match this segment.')).toBeVisible({
      timeout: 45_000,
    })
    await expect(membersCard(page).getByText('Something went wrong')).not.toBeVisible()
    await expect(memberRows(page)).toHaveCount(0)
  })

  // ── Scenario 7: edit ────────────────────────────────────────────────────

  test('edit — change a condition value, preview updates, save, persists after reload', async ({
    authedPage: page,
  }) => {
    const name = uniqueName('edit')
    await page.goto('/segments/new')
    await page.locator('#segment-name').fill(name)

    const createRow = conditionRow(page, 0)
    await setKeyField(createRow, 'plan', 'trait')
    await setValueField(createRow, population.values.planProValue)
    await waitForPreviewCount(page, population.proCount)

    await page.getByRole('button', { name: 'Create segment' }).click()
    await page.waitForURL('/segments')

    await segmentRow(page, name).click()
    await page.waitForURL(/\/segments\/[^/]+\/edit/)

    const editRow = conditionRow(page, 0)
    await expect(editRow.getByPlaceholder('value')).toHaveValue(population.values.planProValue)

    await setValueField(editRow, population.values.planFreeValue)
    // Preview must reflect the new definition BEFORE saving.
    await waitForPreviewCount(page, population.freeCount)

    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page).toHaveURL('/segments')

    await segmentRow(page, name).click()
    await page.waitForURL(/\/segments\/[^/]+\/edit/)
    await expect(conditionRow(page, 0).getByPlaceholder('value')).toHaveValue(
      population.values.planFreeValue,
    )

    // Reload to confirm the change was actually persisted server-side, not
    // just held in local component state.
    await page.reload()
    await expect(conditionRow(page, 0).getByPlaceholder('value')).toHaveValue(
      population.values.planFreeValue,
    )
  })

  // ── Scenario 8: delete ──────────────────────────────────────────────────

  test('delete — removed from list, direct get returns not-found', async ({ authedPage: page }) => {
    const name = uniqueName('delete')
    await page.goto('/segments/new')
    await page.locator('#segment-name').fill(name)

    const row = conditionRow(page, 0)
    await setKeyField(row, 'plan', 'trait')
    await setValueField(row, population.values.planProValue)
    await waitForPreviewCount(page, population.proCount)

    await page.getByRole('button', { name: 'Create segment' }).click()
    await page.waitForURL('/segments')
    await expect(segmentRow(page, name)).toBeVisible()

    // Resolve the segment id via the edit URL before deleting it.
    await segmentRow(page, name).click()
    await page.waitForURL(/\/segments\/[^/]+\/edit/)
    const id = extractSegmentId(page.url())

    await page.goto('/segments')
    await expect(segmentRow(page, name)).toBeVisible()

    await segmentRow(page, name).getByRole('button', { name: 'Delete segment' }).click()

    // ConfirmDialog (SegmentsPage.tsx) has no ARIA role of its own — scope to
    // its panel (`div.relative.w-full.max-w-sm`) to disambiguate its
    // same-labelled "Delete segment" button from the row's own trash-icon
    // button, which shares that accessible name (from its `title` attr).
    const dialog = page.locator('div.relative.w-full.max-w-sm')
    await dialog.getByRole('button', { name: 'Delete segment' }).click()

    await expect(segmentRow(page, name)).not.toBeVisible()

    const direct = await getSegmentDirect(id)
    expect(direct.status).toBe(404)
  })
})
