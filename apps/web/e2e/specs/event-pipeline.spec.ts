import { expect, test } from '../fixtures'
import { postCapture } from '../helpers/capture'
import { waitForEvent } from '../helpers/clickhouse'

/** Build a unique per-test distinct_id/event pair so assertions never depend on
 * exact row counts across the whole `events` table — `events` is a
 * ReplacingMergeTree and background merges/dedup + leftover rows from other
 * e2e runs make any count other than "at least the row(s) this test wrote"
 * flaky. */
function uniqueIds(prefix: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return {
    distinctId: `e2e-${suffix}`,
    event: `${prefix}_${suffix}`,
  }
}

test.describe('event pipeline', () => {
  test('capture -> ClickHouse', async ({ writeKey, projectId }) => {
    const { distinctId, event } = uniqueIds('e2e_pageview')

    const res = await postCapture(writeKey, [
      { event, distinct_id: distinctId, properties: { source: 'e2e-test' } },
    ])

    expect(res.status).toBe(202)
    expect(res.body.accepted).toBe(1)

    // waitForEvent already polls internally (up to ~10s) until the row lands
    // in ClickHouse (events is a ReplacingMergeTree — query uses FINAL), so
    // awaiting it directly is sufficient without an extra expect.poll wrapper.
    const count = await waitForEvent({ projectId, distinctId, event })
    expect(count).toBeGreaterThanOrEqual(1)
  })

  test('capture -> UI', async ({ authedPage: page, writeKey, projectId }) => {
    const { distinctId, event } = uniqueIds('e2e_ui_pageview')

    const res = await postCapture(writeKey, [
      { event, distinct_id: distinctId, properties: { source: 'e2e-test' } },
    ])
    expect(res.status).toBe(202)
    expect(res.body.accepted).toBe(1)

    const count = await waitForEvent({ projectId, distinctId, event })
    expect(count).toBeGreaterThanOrEqual(1)

    // EventsPage.tsx: free-text search filters server-side by event/user/URL
    // (debounced 300ms) — filter down to this test's unique event name so the
    // assertion doesn't depend on how much other e2e data has accumulated in
    // the project, and isn't affected by the default 7d range / pagination.
    await page.goto('/events')
    await page.getByPlaceholder('Filter by event, user, or URL...').fill(event)

    const row = page.getByRole('row', { name: new RegExp(event) })
    await expect(row).toBeVisible()
    await expect(row).toContainText(distinctId)
  })
})
