import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import { getProjectIdBySlug } from '../helpers/db'
import { e2eEnv } from '../helpers/env'
import {
  deleteSeededSurvey,
  type SeededSurvey,
  seedActiveSurvey,
  waitForSurveyShown,
} from '../helpers/surveys'

/**
 * Real-browser survey exposure smoke. Proves the core PER-SURVEY
 * exposure contract: with several ACTIVE surveys live for one project, each is
 * delivered and de-duped independently, keyed by its own
 * `localStorage['ckrm_survey_seen_<surveyId>']` record.
 *
 * ── Harness (why not the demo file / apps/web) ──────────────────────────────
 * The SDK demo (`packages/sdk-js/demo/index.html`) lives in a different package
 * and isn't served by Playwright's webServer (apps/web's vite on :5273), and the
 * app itself never boots the customer SDK. So this spec ROUTE-FULFILLS a tiny
 * standalone page on a synthetic origin, inlining the built IIFE bundle
 * (`packages/sdk-js/dist/clickroom.js`) and calling `clickroom.init(writeKey,
 * { surveys: true })` pointed at the e2e capture service — the same wiring the
 * demo harness now uses. Run `pnpm --filter @clickroom/sdk-js build` first so
 * the inlined bundle is current. Capture's CORS mirrors the request origin
 * (services/capture/src/main.rs), so the synthetic origin is accepted.
 *
 * ── Trigger model ───────────────────────────────────────────────────────────
 * All three surveys are triggered by the same custom event `incident_declared`
 * (mirrors the demo's default). Two are `frequency: 'once'`, one `'always'`.
 *
 * ── Deviation from a naive "dismiss one → only the other stays eligible" ─────
 * The SDK records a display at SHOW time (`captureShown` writes `lastShownAt`),
 * and `once` means shown-once, NOT dismissed-once (see
 * packages/sdk-js/src/survey.ts `frequencyAllows`). So once BOTH `once` surveys
 * render in round 1, BOTH are suppressed on reload — dismissing one changes
 * nothing about the other's eligibility. The genuine per-survey guarantee we
 * assert is therefore: each `once` survey is independently suppressed by its own
 * seen key after its first display, while the `always` survey re-appears. That
 * is the real exposure contract; a spec asserting the dismissed-once-only
 * variant would be red against the actual SDK.
 */

const HARNESS_ORIGIN = 'http://ckrm-survey-e2e.test'
const HARNESS_URL = `${HARNESS_ORIGIN}/survey-harness`
const TRIGGER_EVENT = 'incident_declared'

// Distinct first-question prompts so we can tell each survey's popover apart
// across the open shadow roots (Playwright's text locators pierce them).
const PROMPT_A = 'How was incident response A?'
const PROMPT_B = 'How was incident response B?'
const PROMPT_C = 'Rate the dashboard C'

const dirname = path.dirname(fileURLToPath(import.meta.url))
// apps/web/e2e/specs -> repo root -> packages/sdk-js/dist/clickroom.js
const SDK_BUNDLE_PATH = path.resolve(dirname, '../../../../packages/sdk-js/dist/clickroom.js')

/** A `rating` survey definition triggered by `incident_declared`. */
function surveyDefinition(prompt: string, frequency: 'once' | 'always') {
  return {
    version: 1 as const,
    questions: [{ type: 'rating', id: 'q1', question: prompt, scale: 5, display: 'number' }],
    appearance: { position: 'bottom_right' },
    triggers: { events: [TRIGGER_EVENT], frequency },
  }
}

/** Build the harness HTML with the built SDK inlined and survey delivery on. */
function harnessHtml(bundle: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>survey exposure harness</title></head>
  <body>
    <h1>survey exposure harness</h1>
    <script>${bundle}</script>
    <script>
      clickroom.init(${JSON.stringify(e2eEnv.surveysOrg.writeKey)}, {
        api_host: ${JSON.stringify(e2eEnv.captureUrl)},
        autocapture: false,
        capture_pageview: false,
        surveys: true,
      })
      // Test hooks: fire the trigger + read observable public signals only.
      // Survey readiness is read off the SDK's own localStorage cache
      // (\`ckrm_surveys\` -> { signature, surveys }, written in survey.ts), not
      // the internal SurveyClient — keep the probe on public persistence.
      window.__fireTrigger = () => clickroom.capture(${JSON.stringify(TRIGGER_EVENT)})
      window.__surveysLoaded = () => {
        try {
          return JSON.parse(localStorage.getItem('ckrm_surveys') || '{}').surveys?.length ?? 0
        } catch {
          return 0
        }
      }
      window.__flagOn = (key) => clickroom.isFeatureEnabled(key)
    </script>
  </body>
</html>`
}

/** Serve the harness on the synthetic origin; everything else (capture calls)
 *  passes through untouched. */
async function mountHarness(page: Page, bundle: string): Promise<void> {
  await page.route(`${HARNESS_URL}**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: harnessHtml(bundle),
    }),
  )
}

/** Wait until the SDK has loaded all flags AND fetched the survey config, so a
 *  fired trigger evaluates against a warm client (both are async on init). */
async function waitForSdkReady(page: Page, flagKeys: string[], surveyCount: number): Promise<void> {
  await page.waitForFunction(
    // biome-ignore lint/suspicious/noExplicitAny: `window.clickroom` global isn't typed in the e2e project.
    () => typeof (window as any).clickroom !== 'undefined',
  )
  await page.waitForFunction(
    ({ keys, count }) =>
      // biome-ignore lint/suspicious/noExplicitAny: window test hooks are untyped in-page.
      keys.every((k: string) => (window as any).__flagOn(k)) &&
      // biome-ignore lint/suspicious/noExplicitAny: window test hooks are untyped in-page.
      (window as any).__surveysLoaded() >= count,
    { keys: flagKeys, count: surveyCount },
    { timeout: 20_000 },
  )
}

/** The visible `.ckrm-popover` dialog (inside a `[data-clickroom-survey]` shadow
 *  host) whose prompt is `prompt`. Anchored on the popover, not the host: the
 *  host is a zero-size wrapper (all its shadow content is `position: fixed`), so
 *  `toBeVisible()` on the host reads `hidden` even while the popover is on screen.
 *  Playwright's locators pierce the open shadow root. */
function popoverFor(page: Page, prompt: string) {
  return page.locator('.ckrm-popover').filter({ has: page.getByText(prompt) })
}

test.describe('surveys — per-survey exposure in a real browser', () => {
  // Serial: one shared trio of seeded surveys driven through a two-round
  // (show → reload → re-show) lifecycle.
  test.describe.configure({ mode: 'serial', timeout: 90_000 })

  let bundle: string
  let surveyA: SeededSurvey
  let surveyB: SeededSurvey
  let surveyC: SeededSurvey
  let projectId: string

  test.beforeAll(async () => {
    // Seed + assert against the `e2e-surveys` org (on the `pro` plan) — NOT the
    // shared `e2e` fixture project (on `free`, where the surveys entitlement gate
    // would 403 `surveys.create`). See helpers/env.ts + seed.e2e.ts.
    projectId = await getProjectIdBySlug(e2eEnv.surveysOrg.orgSlug, e2eEnv.surveysOrg.projectName)
    bundle = readFileSync(SDK_BUNDLE_PATH, 'utf8')

    // Two `once` surveys + one `always`, all event-triggered by the same event.
    surveyA = await seedActiveSurvey({
      projectId,
      name: `E2E Survey A once ${Date.now()}`,
      definition: surveyDefinition(PROMPT_A, 'once'),
    })
    surveyB = await seedActiveSurvey({
      projectId,
      name: `E2E Survey B once ${Date.now()}`,
      definition: surveyDefinition(PROMPT_B, 'once'),
    })
    surveyC = await seedActiveSurvey({
      projectId,
      name: `E2E Survey C always ${Date.now()}`,
      definition: surveyDefinition(PROMPT_C, 'always'),
    })
  })

  test.afterAll(async () => {
    // Unconditional cleanup so the seeded flags stop counting against the
    // `e2e-surveys` org's maxFlags quota and capture stops serving them.
    for (const s of [surveyA, surveyB, surveyC]) {
      if (s) await deleteSeededSurvey({ projectId, surveyId: s.surveyId })
    }
  })

  test('all active surveys render (per-survey exposure) and de-dup independently', async ({
    browser,
  }) => {
    // Fresh context: empty localStorage (no leftover `ckrm_survey_seen_*` /
    // `ckrm_surveys` from a prior run) so frequency gating starts clean.
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      await mountHarness(page, bundle)
      const flagKeys = [surveyA.flagKey, surveyB.flagKey, surveyC.flagKey]

      // ── Round 1: trigger → all three eligible surveys mount ───────────────
      await page.goto(HARNESS_URL)
      await waitForSdkReady(page, flagKeys, 3)
      await page.evaluate(() => (window as unknown as { __fireTrigger(): void }).__fireTrigger())

      // Both `once` popovers render as distinct shadow hosts, plus the `always`.
      await expect(popoverFor(page, PROMPT_A)).toBeVisible()
      await expect(popoverFor(page, PROMPT_B)).toBeVisible()
      await expect(popoverFor(page, PROMPT_C)).toBeVisible()
      const onceHosts = page
        .locator('[data-clickroom-survey]')
        .filter({ has: page.getByText(/How was incident response/) })
      await expect(onceHosts).toHaveCount(2)

      // Exactly one `$survey_shown` per survey reaches capture -> ClickHouse,
      // keyed by `$survey_id`.
      expect(
        await waitForSurveyShown({ projectId, surveyId: surveyA.surveyId }),
      ).toBeGreaterThanOrEqual(1)
      expect(
        await waitForSurveyShown({ projectId, surveyId: surveyB.surveyId }),
      ).toBeGreaterThanOrEqual(1)
      expect(
        await waitForSurveyShown({ projectId, surveyId: surveyC.surveyId }),
      ).toBeGreaterThanOrEqual(1)

      // Each survey wrote its OWN per-survey seen record — the heart of
      // per-survey exposure.
      const seenKeys = await page.evaluate(() =>
        Object.keys(window.localStorage).filter((k) => k.startsWith('ckrm_survey_seen_')),
      )
      expect(seenKeys).toContain(`ckrm_survey_seen_${surveyA.surveyId}`)
      expect(seenKeys).toContain(`ckrm_survey_seen_${surveyB.surveyId}`)
      expect(seenKeys).toContain(`ckrm_survey_seen_${surveyC.surveyId}`)

      // ── Dismiss survey A's popover (close button, scoped to A's host) ──────
      // All three popovers are `position: fixed; bottom_right`, so they overlap
      // at the same coordinates — a real coordinate click (even `force`) would
      // land on whichever popover is stacked on top, not necessarily A's. Dispatch
      // the click straight to A's own close button so the dismiss is unambiguous.
      await popoverFor(page, PROMPT_A)
        .getByRole('button', { name: 'Close survey' })
        .dispatchEvent('click')
      await expect(popoverFor(page, PROMPT_A)).toHaveCount(0)

      // ── Round 2: reload (localStorage seen records persist) + re-trigger ───
      await page.reload()
      await waitForSdkReady(page, flagKeys, 3)
      await page.evaluate(() => (window as unknown as { __fireTrigger(): void }).__fireTrigger())

      // The `always` survey re-appears; NEITHER `once` survey does — each is
      // suppressed by its own seen key (per-survey de-dup). Assert the always
      // popover first so the once-absence checks aren't racing an unrendered DOM.
      await expect(popoverFor(page, PROMPT_C)).toBeVisible()
      await expect(popoverFor(page, PROMPT_A)).toHaveCount(0)
      await expect(popoverFor(page, PROMPT_B)).toHaveCount(0)
    } finally {
      await context.close()
    }
  })
})
