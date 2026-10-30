import { expect, test } from '../fixtures'
import { evalFlags, flagDefinitions } from '../helpers/capture'
import { deleteFeatureFlagByKey } from '../helpers/db'

test.describe('feature flags', () => {
  test('create, toggle, and evaluate a boolean flag', async ({
    authedPage: page,
    writeKey,
    readKey,
    projectId,
  }) => {
    const flagKey = `e2e-flag-${Date.now()}`
    const distinctId = 'e2e-flag-user-1'

    // Crash-proof cleanup: the `e2e` org's plan caps flags at 5
    // (packages/db/src/seed.e2e.ts's `free` plan, maxFlags: 5), the quota is
    // counted from `deletedAt: null` FeatureFlag rows (assertUnderQuota in
    // apps/api/src/trpc/routers/flags.router.ts), and this DB persists
    // across local/CI test runs (no reset in global-setup.ts). The test body
    // deletes the flag it creates via the same UI flow other e2e specs use
    // for their own teardown (see sql-explorer.spec.ts's 'deletes a saved
    // query'/'deletes a visualization'), but a Playwright timeout or thrown
    // assertion aborts the test function immediately — any code after the
    // point of failure, including that UI-driven delete, never runs. Left
    // uncleaned, a flag from an interrupted run counts against the quota
    // forever, and enough of those accumulate to permanently break flag
    // creation for every future run of this spec (quota_exceeded on create,
    // so the new row never renders and the test's visibility assertion times
    // out). Wrapping the whole flow in try/finally and unconditionally
    // calling `deleteFeatureFlagByKey` (a direct DB soft-delete, independent
    // of whatever UI state the test left behind, and a no-op if the flag was
    // never created or was already deleted by the UI flow) guarantees this
    // flag stops counting against the quota no matter how the test exits.
    try {
      await page.goto('/flags')

      // ── Create ──────────────────────────────────────────────────────────
      // FlagsPage.tsx renders a "New Flag" button in the PageHeader that
      // opens NewFlagDialog.
      await page.getByRole('button', { name: 'New Flag' }).click()

      // NewFlagDialog.tsx binds a real <label htmlFor="new-flag-key"> to the
      // key input, so getByLabel resolves it directly.
      await page.getByLabel('Key').fill(flagKey)

      // NewFlagDialog.tsx defaults `kind: 'boolean'` and the rollout slider
      // to `useState(0)` (0%). services/capture/src/flags/eval.rs's
      // `evaluate()` only returns `enabled: true` when the flag is `active`
      // AND the deterministic per-distinct_id hash falls within
      // `rollout_percentage` (`hash <= rollout / 100`) — at 0% that's true
      // only for the near-impossible hash of exactly 0, so a flag left at
      // the default rollout would never evaluate to enabled regardless of
      // the active toggle. Push the native range input to its max (100) via
      // the keyboard's "End" key, which the input responds to like a real
      // user drag, so this flag is deterministically ON for every
      // distinct_id once active.
      const rolloutSlider = page.locator('input[type="range"]')
      await rolloutSlider.focus()
      await rolloutSlider.press('End')

      await page.getByRole('button', { name: 'Create flag' }).click()

      // The dialog only calls onCreated (closing it) after the mutation
      // resolves and the list is invalidated, so waiting on the row also
      // confirms creation succeeded.
      const row = page.getByRole('row', { name: new RegExp(flagKey) })
      await expect(row).toBeVisible()

      // NewFlagDialog.tsx's handleCreate always submits `active: true`, so
      // the row's toggle (FlagBits.tsx FlagToggle) should already read "on"
      // as a known post-creation state — assert that rather than assuming a
      // click is needed to reach ON.
      const toggle = row.getByRole('button', { name: /Disable flag|Enable flag/ })
      await expect(toggle).toHaveAttribute('aria-label', 'Disable flag')

      // ── Eval: ON ────────────────────────────────────────────────────────
      // The flag-definitions cache backing /v1/flags is Redis-backed and can
      // lag a beat behind the create/toggle mutation, so retry the assertion
      // rather than asserting once.
      await expect(async () => {
        const { body } = await evalFlags(writeKey, { distinct_id: distinctId })
        expect(body.flags[flagKey]?.enabled).toBe(true)
      }).toPass({ timeout: 10_000 })

      // ── Toggle OFF ──────────────────────────────────────────────────────
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-label', 'Enable flag')

      // ── Eval: OFF ───────────────────────────────────────────────────────
      await expect(async () => {
        const { body } = await evalFlags(writeKey, { distinct_id: distinctId })
        expect(body.flags[flagKey]?.enabled).toBe(false)
      }).toPass({ timeout: 10_000 })

      // ── Optional: flag-definitions listing reflects the last-known state ──
      await expect(async () => {
        const { body } = await flagDefinitions(readKey)
        const def = body.flags.find((f: { key: string }) => f.key === flagKey)
        expect(def?.active).toBe(false)
      }).toPass({ timeout: 10_000 })

      // ── Cleanup (UI flow) ───────────────────────────────────────────────
      // Delete via the same UI flow other e2e specs use for their own
      // teardown (see sql-explorer.spec.ts's 'deletes a saved query'/'deletes
      // a visualization'). The `finally` block below is the durable
      // backstop if this never runs.
      await row.getByRole('button', { name: 'Delete flag' }).click()
      await page.getByRole('button', { name: /Delete forever/ }).click()
      await expect(row).not.toBeVisible()
    } finally {
      await deleteFeatureFlagByKey(projectId, flagKey)
    }
  })
})
