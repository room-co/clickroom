import type { Locator, Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import { loginViaApi } from '../helpers/auth'
import { postCapture, waitForTaxonomyEvent } from '../helpers/capture'
import { getProjectIdBySlug, prisma } from '../helpers/db'
import { e2eEnv } from '../helpers/env'

/**
 * Golden spec covering experiment CRUD, the auto-created linked
 * multivariate FeatureFlag, draft-only variant editing, and the
 * launch/stop/delete lifecycle. Results computation and
 * tenancy/permission boundaries are separate sibling spec files.
 *
 * Runs as one `serial` lifecycle against a SINGLE experiment (create -> edit
 * -> launch -> stop -> delete), rather than a fresh experiment per test like
 * `user-segments.spec.ts` — launch/stop/delete are inherently sequential
 * state transitions on one entity, so splitting them across independent
 * experiments would just duplicate the create step without adding coverage.
 *
 * Two per-run-unique event names are seeded directly via `postCapture` (not
 * `seedExperimentPopulation`, which is the heavier real-bucketing
 * fixture for the results spec) purely so the builder's primary funnel
 * metric has two real, taxonomy-visible events to pick from its
 * `EventCombobox` — no exposure/conversion volume is needed for CRUD
 * coverage.
 */

let projectId: string
let stepEventA: string
let stepEventB: string
let experimentName: string
let experimentId: string

test.describe('experiments — CRUD, auto-created flag, launch/stop/delete lifecycle', () => {
  // Serial: launch/stop/delete are sequential transitions on the SAME
  // experiment created in the first test.
  test.describe.configure({ mode: 'serial', timeout: 90_000 })

  test.beforeAll(async () => {
    test.setTimeout(90_000)
    projectId = await getProjectIdBySlug(e2eEnv.org.orgSlug, e2eEnv.org.projectName)

    const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    stepEventA = `exp-crud-a-${runSuffix}`
    stepEventB = `exp-crud-b-${runSuffix}`
    const distinctId = `e2e-expcrud-${runSuffix}`

    const res = await postCapture(e2eEnv.org.writeKey, [
      { event: stepEventA, distinct_id: distinctId, properties: {} },
      { event: stepEventB, distinct_id: distinctId, properties: {} },
    ])
    if (res.status !== 202) {
      throw new Error(
        `beforeAll: seeding funnel events failed (${res.status}): ${JSON.stringify(res.body)}`,
      )
    }

    // Same taxonomy-cache-visibility wait as user-segments.spec.ts's
    // beforeAll — the builder's EventCombobox only offers events already
    // present in the (Redis-cached, up to 60s stale) taxonomy snapshot.
    const { accessToken } = await loginViaApi(e2eEnv.org.userEmail, e2eEnv.org.userPassword)
    await Promise.all([
      waitForTaxonomyEvent({ projectId, accessToken, eventName: stepEventA }),
      waitForTaxonomyEvent({ projectId, accessToken, eventName: stepEventB }),
    ])
  })

  // ── Builder page helpers ──────────────────────────────────────────────

  function experimentRow(page: Page, name: string) {
    return page.getByRole('row', { name: new RegExp(name) })
  }

  /** Each funnel step row is `div.rounded-lg.border.border-border.bg-background/40.p-3`
   * in ExperimentBuilderPage.tsx's `FunnelMetricFields` — scoping to it (rather
   * than the EventCombobox trigger's shared "Select event" accessible name)
   * survives re-selection order, since a picked step's trigger label changes
   * from "Select event" to the chosen event's name. */
  function metricStepRow(page: Page, index: number): Locator {
    return page.locator('div.rounded-lg.border.border-border.bg-background\\/40.p-3').nth(index)
  }

  /** Scopes to the specific popover opened by `trigger`, rather than
   * searching the whole page. Multiple `EventCombobox` instances can be
   * mounted (and their popovers left in the DOM mid-close-animation) at
   * once — e.g. two funnel step rows, or primary+secondary metric event
   * pickers — so a page-wide `getByPlaceholder('Search events...')` can
   * match more than one. Radix's `Popover.Trigger` sets
   * `aria-controls={contentId}` matching the opened `Popover.Content`'s
   * `id`, which is the precise trigger->popover link to key off. */
  async function popoverForTrigger(trigger: Locator): Promise<Locator> {
    const page = trigger.page()
    const controlsId = await trigger.getAttribute('aria-controls')
    if (!controlsId) {
      throw new Error('popoverForTrigger: trigger is missing aria-controls after opening popover')
    }
    return page.locator(`[id="${controlsId}"]`)
  }

  async function pickStepEvent(row: Locator, eventName: string) {
    const trigger = row.getByRole('button', { name: 'Select event' })
    await trigger.click()
    const popover = await popoverForTrigger(trigger)
    await popover.getByPlaceholder('Search events...').fill(eventName)
    await popover.getByRole('option', { name: eventName, exact: true }).click()
  }

  function statusBadge(page: Page): Locator {
    return page.locator('[data-slot="badge"]').first()
  }

  async function waitForStatusBadge(page: Page, status: string) {
    await expect.poll(() => statusBadge(page).textContent(), { timeout: 20_000 }).toBe(status)
  }

  function extractExperimentId(url: string): string {
    const match = url.match(/\/experiments\/([^/]+)\/edit/)
    if (!match)
      throw new Error(`extractExperimentId: could not parse experiment id from URL: ${url}`)
    return match[1]
  }

  function uniqueName(label: string): string {
    return `e2e-exp-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }

  interface FlagVariant {
    key: string
    rollout_percentage: number
  }
  interface FlagFiltersShape {
    multivariate?: { variants: FlagVariant[] }
  }

  async function getExperimentAndFlag(id: string) {
    const experiment = await prisma.experiment.findUniqueOrThrow({ where: { id } })
    const flag = await prisma.featureFlag.findUniqueOrThrow({
      where: { id: experiment.featureFlagId },
    })
    return { experiment, flag }
  }

  // ── Scenario 1: create — auto-created flag matches variants ────────────

  test('create — experiment via UI creates a linked multivariate FeatureFlag matching variants', async ({
    authedPage: page,
  }) => {
    experimentName = uniqueName('crud')
    await page.goto('/experiments/new')
    await page.locator('#experiment-name').fill(experimentName)
    await page.locator('#experiment-hypothesis').fill('Changing the flow increases conversion.')

    // Default variants (control/test 50/50, emptyVariants() in
    // ExperimentBuilderPage.tsx) and default metric type (funnel, 2 empty
    // steps) are pre-filled — only the two funnel steps' events need picking.
    await pickStepEvent(metricStepRow(page, 0), stepEventA)
    await pickStepEvent(metricStepRow(page, 1), stepEventB)

    await page.getByRole('button', { name: 'Create experiment' }).click()
    await page.waitForURL('/experiments')
    await expect(experimentRow(page, experimentName)).toBeVisible()

    await experimentRow(page, experimentName).click()
    await page.waitForURL(/\/experiments\/[^/]+\/edit/)
    experimentId = extractExperimentId(page.url())

    const { experiment, flag } = await getExperimentAndFlag(experimentId)
    expect(flag.active).toBe(false)

    const filters = flag.filters as FlagFiltersShape
    const flagVariants = filters.multivariate?.variants ?? []
    const expVariants = experiment.variants as unknown as {
      key: string
      rolloutPercentage: number
    }[]

    expect(flagVariants.map((v) => v.key).sort()).toEqual(expVariants.map((v) => v.key).sort())
    for (const v of expVariants) {
      const match = flagVariants.find((f) => f.key === v.key)
      expect(match?.rollout_percentage).toBe(v.rolloutPercentage)
    }
  })

  // ── Scenario 2: edit while draft ────────────────────────────────────────

  test('edit while draft — metric/hypothesis edits succeed via the UI', async ({
    authedPage: page,
  }) => {
    await page.goto(`/experiments/${experimentId}/edit`)
    await expect(page.locator('#experiment-name')).toHaveValue(experimentName)
    // Variant editor is unlocked pre-launch.
    await expect(page.getByRole('button', { name: 'Add variant' })).toBeVisible()

    const updatedHypothesis = 'Updated hypothesis — the new flow wins.'
    await page.locator('#experiment-hypothesis').fill(updatedHypothesis)
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page).toHaveURL('/experiments')

    await page.goto(`/experiments/${experimentId}/edit`)
    await expect(page.locator('#experiment-hypothesis')).toHaveValue(updatedHypothesis)

    const experiment = await prisma.experiment.findUniqueOrThrow({ where: { id: experimentId } })
    expect(experiment.hypothesis).toBe(updatedHypothesis)
  })

  // ── Scenario 3: launch ───────────────────────────────────────────────────

  test('launch — status flips to running, startedAt set, linked flag becomes active, variants lock', async ({
    authedPage: page,
  }) => {
    await page.goto(`/experiments/${experimentId}/edit`)
    await page.getByRole('button', { name: 'Launch' }).click()

    await waitForStatusBadge(page, 'running')

    await expect
      .poll(
        async () => {
          const experiment = await prisma.experiment.findUniqueOrThrow({
            where: { id: experimentId },
          })
          return experiment.status
        },
        { timeout: 20_000 },
      )
      .toBe('running')

    const { experiment, flag } = await getExperimentAndFlag(experimentId)
    expect(experiment.startedAt).not.toBeNull()
    expect(flag.active).toBe(true)

    // Variant editing is now locked (variantsLocked = isEdit && status !== 'draft').
    await expect(
      page.getByText('Variants can only be edited while the experiment is in draft.'),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add variant' })).not.toBeVisible()
    await expect(page.getByPlaceholder('variant key').first()).toBeDisabled()

    // Attempting a variant edit is rejected server-side too, not just hidden
    // client-side — direct `update` call with a `variants` patch on a
    // non-draft experiment must fail (experiments.router.ts's BAD_REQUEST
    // guard) even if the client-side lock were bypassed.
    const { accessToken } = await loginViaApi(e2eEnv.org.userEmail, e2eEnv.org.userPassword)
    const res = await fetch(`${e2eEnv.apiUrl}/trpc/experiments.update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        projectId,
        id: experimentId,
        patch: {
          variants: [
            { key: 'control', rolloutPercentage: 10 },
            { key: 'test', rolloutPercentage: 90 },
          ],
        },
      }),
    })
    expect(res.status).toBe(400)
  })

  // ── Scenario 4: stop ─────────────────────────────────────────────────────

  test('stop — status flips to complete, endedAt set', async ({ authedPage: page }) => {
    await page.goto(`/experiments/${experimentId}/edit`)
    await page.getByRole('button', { name: 'Stop' }).click()

    await waitForStatusBadge(page, 'complete')

    await expect
      .poll(
        async () => {
          const experiment = await prisma.experiment.findUniqueOrThrow({
            where: { id: experimentId },
          })
          return experiment.status
        },
        { timeout: 20_000 },
      )
      .toBe('complete')

    const experiment = await prisma.experiment.findUniqueOrThrow({ where: { id: experimentId } })
    expect(experiment.endedAt).not.toBeNull()
  })

  // ── Scenario 5: delete ───────────────────────────────────────────────────

  test('delete — soft-deletes the experiment, removed from list, linked flag untouched', async ({
    authedPage: page,
  }) => {
    const before = await prisma.experiment.findUniqueOrThrow({ where: { id: experimentId } })
    const flagId = before.featureFlagId
    const flagBefore = await prisma.featureFlag.findUniqueOrThrow({ where: { id: flagId } })

    await page.goto('/experiments')
    await expect(experimentRow(page, experimentName)).toBeVisible()

    await experimentRow(page, experimentName)
      .getByRole('button', { name: 'Delete experiment' })
      .click()

    // ConfirmDialog has no ARIA role of its own — scope to its panel to
    // disambiguate from the row's own trash-icon button, which shares the
    // same accessible name (same collision pattern as SegmentsPage's dialog).
    const dialog = page.locator('div.relative.w-full.max-w-sm')
    await dialog.getByRole('button', { name: 'Delete experiment' }).click()

    await expect(experimentRow(page, experimentName)).not.toBeVisible()

    const after = await prisma.experiment.findUniqueOrThrow({ where: { id: experimentId } })
    expect(after.deletedAt).not.toBeNull()

    // Flag lifecycle stays independent of the experiment's soft-delete.
    const flagAfter = await prisma.featureFlag.findUniqueOrThrow({ where: { id: flagId } })
    expect(flagAfter.deletedAt).toBeNull()
    expect(flagAfter.active).toBe(flagBefore.active)
  })
})
