import { expect, test } from '../fixtures'
import { postCapture } from '../helpers/capture'
import { waitForEvent } from '../helpers/clickhouse'

/**
 * Build a unique per-test distinct_id/event pair so count-based assertions
 * never depend on the whole `events` table's row count — see
 * event-pipeline.spec.ts's identical helper/rationale (ReplacingMergeTree,
 * cross-run leftovers).
 */
function uniqueIds(prefix: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return {
    distinctId: `e2e-${suffix}`,
    event: `${prefix}_${suffix}`,
  }
}

/**
 * Replace the full contents of the SqlExplorerPage.tsx CodeMirror editor.
 * There's no data-testid on the editor; `.cm-content` is CodeMirror 6's own
 * stable content-editable root class. `ControlOrMeta` is Playwright's
 * cross-platform modifier alias (Ctrl on Linux/Windows, Cmd on macOS) —
 * needed here because CodeMirror's built-in "select all" binding is `Mod-a`.
 */
async function setSql(page: import('@playwright/test').Page, sql: string) {
  const editor = page.locator('.cm-content')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type(sql)
}

async function runQuery(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Run', exact: true }).click()
}

test.describe('SQL explorer', () => {
  test('runs a query and is scoped to the caller project (tenant isolation)', async ({
    authedPage: page,
    writeKey,
    projectId,
    limitedAuthedPage: otherPage,
  }) => {
    const own = uniqueIds('e2e_sql_own')

    // Only write through the primary `e2e` org's key here — `e2e-limited` has
    // maxEventsPerMonthOverride=2 (see .env.e2e / seed.e2e.ts) and is shared
    // with schema-and-limits.spec.ts's own over-limit assertions running in
    // the same parallel suite, so posting more events through it here would
    // race that spec's quota budget. The isolation check only needs to prove
    // the *other* org's project can't see this project's row — it doesn't
    // need to write its own data to do that.
    const ownRes = await postCapture(writeKey, [{ event: own.event, distinct_id: own.distinctId }])
    expect(ownRes.status).toBe(202)

    await waitForEvent({ projectId, distinctId: own.distinctId, event: own.event })

    await page.goto('/sql')
    // Query without any project_id predicate — services/query's AST rewrite
    // must inject the caller's project_id regardless, so this only ever
    // counts this project's own row for its own unique event name.
    await setSql(page, `SELECT count() AS c FROM events WHERE event = '${own.event}'`)
    await runQuery(page)

    const ownCell = page.locator('table tbody td').first()
    await expect(ownCell).toHaveText('1')

    // The same query text, run from the *other* org's authed page, must see
    // 0 rows for this project's event — proving the rewrite scopes to the
    // requesting project, not just "some" project.
    await otherPage.goto('/sql')
    await setSql(otherPage, `SELECT count() AS c FROM events WHERE event = '${own.event}'`)
    await runQuery(otherPage)
    const otherCell = otherPage.locator('table tbody td').first()
    await expect(otherCell).toHaveText('0')
  })

  test('rejects a non-SELECT statement with an inline error banner', async ({
    authedPage: page,
  }) => {
    await page.goto('/sql')
    await setSql(page, 'DROP TABLE events')
    await runQuery(page)

    await expect(page.getByText('Query failed')).toBeVisible()
    await expect(page.getByText(/only SELECT\/WITH queries are allowed/)).toBeVisible()
  })

  test('save -> list -> reload -> rerun a saved query', async ({ authedPage: page }) => {
    const { event } = uniqueIds('e2e_sql_saved')
    const queryName = `e2e-saved-${Date.now()}`
    const sql = `SELECT '${event}' AS marker, count() AS c FROM events WHERE event = '${event}'`

    await page.goto('/sql')
    await setSql(page, sql)
    await runQuery(page)
    await expect(page.locator('table tbody tr').first()).toBeVisible()

    // Header "Save" opens the SaveQueryDialog — scope to the dialog so this
    // doesn't collide with the header's own "Save" button by accessible name.
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const saveDialog = page.getByRole('dialog')
    await saveDialog.getByPlaceholder('Query name').fill(queryName)
    await saveDialog.getByRole('button', { name: 'Save' }).click()
    await expect(saveDialog).toBeHidden()

    // Listed in the saved-query rail.
    const savedButton = page.getByRole('button', { name: queryName, exact: true })
    await expect(savedButton).toBeVisible()

    // Reload the page — list/editor state resets — then reload the saved
    // query and rerun it, proving it round-tripped through Postgres.
    await page.reload()
    await page.getByRole('button', { name: queryName, exact: true }).click()
    await runQuery(page)

    const firstRow = page.locator('table tbody tr').first()
    await expect(firstRow).toContainText(event)
  })

  test('deletes a saved query', async ({ authedPage: page }) => {
    const queryName = `e2e-delete-${Date.now()}`

    await page.goto('/sql')
    await setSql(page, 'SELECT 1 AS one')
    await runQuery(page)

    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const saveDialog = page.getByRole('dialog')
    await saveDialog.getByPlaceholder('Query name').fill(queryName)
    await saveDialog.getByRole('button', { name: 'Save' }).click()
    await expect(saveDialog).toBeHidden()

    // SavedQueryList renders each row as `<div className="group ...">` — scope
    // to `.group` specifically rather than a bare `div`, since an unscoped
    // `div` filter also matches ancestor wrapper divs (the whole list
    // container) that contain every row's delete button as a descendant.
    const savedRow = page
      .locator('div.group')
      .filter({ has: page.getByRole('button', { name: queryName, exact: true }) })
    await savedRow.getByTitle('Delete saved query').click()

    await expect(page.getByRole('button', { name: queryName, exact: true })).toHaveCount(0)
  })

  test('saves and restores a visualization on a saved query', async ({ authedPage: page }) => {
    const queryName = `e2e-viz-query-${Date.now()}`
    const vizName = `e2e-viz-${Date.now()}`

    await page.goto('/sql')
    // A GROUP BY over a fixed small set of literals so results (and the
    // chart) are deterministic regardless of what other e2e data exists.
    await setSql(page, "SELECT arrayJoin(['a', 'b', 'c']) AS bucket, 1 AS value")
    await runQuery(page)
    await expect(page.locator('table tbody tr').first()).toBeVisible()

    // Save the query first — a visualization is a child of a saved query and
    // "Save visualization" stays disabled until currentSavedQueryId is set.
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const saveDialog = page.getByRole('dialog')
    await saveDialog.getByPlaceholder('Query name').fill(queryName)
    await saveDialog.getByRole('button', { name: 'Save' }).click()
    await expect(saveDialog).toBeHidden()

    await page.getByRole('tab', { name: 'Visualization' }).click()

    // Change the chart type away from the auto-seeded default ("Line") so
    // restoring it later actually proves persistence, not just recomputed
    // defaults landing on the same value. Scope to the Visualization
    // tabpanel — the PageHeader's data-source picker is also a Radix Select
    // (role "combobox") and renders earlier in the DOM, so an unscoped
    // `getByRole('combobox').first()` matches the wrong control.
    const chartTypeSelect = page.getByRole('tabpanel').getByRole('combobox').first()
    await chartTypeSelect.click()
    await page.getByRole('option', { name: 'Bar' }).click()
    await expect(chartTypeSelect).toContainText('Bar')

    await page.getByRole('button', { name: 'Save visualization' }).click()
    const saveVizDialog = page.getByRole('dialog')
    await saveVizDialog.getByPlaceholder('Visualization name').fill(vizName)
    await saveVizDialog.getByRole('button', { name: 'Save' }).click()
    await expect(saveVizDialog).toBeHidden()

    // Reload, reload the saved query, rerun it, then restore the saved
    // visualization from the sidebar list.
    await page.reload()
    await page.getByRole('button', { name: queryName, exact: true }).click()
    await runQuery(page)

    const savedVizButton = page.getByRole('button', { name: vizName, exact: true })
    await expect(savedVizButton).toBeVisible()
    await savedVizButton.click()

    // Clicking a saved visualization switches to the Visualization tab and
    // hydrates its config — assert the chart type restored as "Bar".
    await expect(page.getByRole('tabpanel').getByRole('combobox').first()).toContainText('Bar')
  })

  test('deletes a visualization', async ({ authedPage: page }) => {
    const queryName = `e2e-viz-delete-query-${Date.now()}`
    const vizName = `e2e-viz-delete-${Date.now()}`

    await page.goto('/sql')
    await setSql(page, "SELECT arrayJoin(['a', 'b']) AS bucket, 1 AS value")
    await runQuery(page)

    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const saveDialog = page.getByRole('dialog')
    await saveDialog.getByPlaceholder('Query name').fill(queryName)
    await saveDialog.getByRole('button', { name: 'Save' }).click()
    await expect(saveDialog).toBeHidden()

    await page.getByRole('tab', { name: 'Visualization' }).click()
    await page.getByRole('button', { name: 'Save visualization' }).click()
    const saveVizDialog = page.getByRole('dialog')
    await saveVizDialog.getByPlaceholder('Visualization name').fill(vizName)
    await saveVizDialog.getByRole('button', { name: 'Save' }).click()
    await expect(saveVizDialog).toBeHidden()

    const savedVizButton = page.getByRole('button', { name: vizName, exact: true })
    await expect(savedVizButton).toBeVisible()

    // SavedVisualizationList rows are also `<div className="group ...">` —
    // same rationale as the saved-query row scoping above.
    const savedVizRow = page
      .locator('div.group')
      .filter({ has: page.getByRole('button', { name: vizName, exact: true }) })
    await savedVizRow.getByTitle('Delete visualization').click()

    await expect(page.getByRole('button', { name: vizName, exact: true })).toHaveCount(0)
  })
})
