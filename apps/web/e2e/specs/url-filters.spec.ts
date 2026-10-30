import { expect, test } from '../fixtures'

/**
 * URL-persisted filters: the date range and scalar filters (search, event
 * type, sort, page) live in the query string so a page is shareable and
 * survives reload. Backed by `useUrlDateRange` (date range) and
 * `lib/url-params.ts` (scalars).
 *
 * Every assertion here is deliberately DATA-INDEPENDENT — the e2e dataset may
 * be empty or huge, and these specs run in the shared parallel suite. So we
 * assert on the URL and on control state (input values, sort value, the footer
 * "Page N" label which is read straight from the URL), never on row counts.
 */
test.describe('URL-persisted filters', () => {
  test('dashboard date pills round-trip through the URL (14d default omitted)', async ({
    authedPage: page,
  }) => {
    await page.goto('/')
    // 14d is the Dashboard default (see DashboardPage's useUrlDateRange call),
    // and the default selection is omitted from the URL — the bare page URL
    // stays param-free.
    await expect(page).not.toHaveURL(/[?&]range=/)

    // The preset pills are <button>s whose accessible name is the short label
    // ("24h"/"7d"/"14d"/"30d") — exact match so "7d" can't collide with a
    // longer label. Picking a non-default preset writes `?range=`.
    await page.getByRole('button', { name: '7d', exact: true }).click()
    await expect(page).toHaveURL(/[?&]range=7d/)

    // Picking the page default (14d) again deletes the param — back to bare.
    await page.getByRole('button', { name: '14d', exact: true }).click()
    await expect(page).not.toHaveURL(/[?&]range=/)
  })

  test('dashboard hydrates a custom range from the URL on load', async ({ authedPage: page }) => {
    // Land directly on a shared custom-range link — proves the URL hydrates
    // custom state on load (not just that a click writes it). The Custom pill
    // renders its formatted label (`MMM d – MMM d`) when the custom selection
    // is active, so "Jun 1 – Jun 10" is the visible proof the dates parsed.
    await page.goto('/?range=custom&from=2026-06-01&to=2026-06-10')
    await expect(page.getByRole('button', { name: /Jun 1.*Jun 10/ })).toBeVisible()
  })

  test('events search debounces into the URL and clears back out', async ({ authedPage: page }) => {
    await page.goto('/events')
    // Typing writes `?q=` after a 300ms debounce — toHaveURL auto-retries up to
    // the expect timeout, so no explicit wait for the debounce is needed.
    await page.getByPlaceholder('Filter by event, user, or URL...').fill('abc')
    await expect(page).toHaveURL(/[?&]q=abc/)

    // Clearing the box deletes the param again (empty === default).
    await page.getByPlaceholder('Filter by event, user, or URL...').fill('')
    await expect(page).not.toHaveURL(/[?&]q=/)
  })

  test('events preserves a shared ?page=N link instead of resetting to page 1', async ({
    authedPage: page,
  }) => {
    // The highest-value assertion: a page-reset effect fires on filter change,
    // but is guarded by a firstRun ref so a shared `?page=2` link lands on
    // page 2 rather than snapping back to 1 on mount. `page` is read from the
    // URL, so "Page 2" holds regardless of whether any rows exist.
    await page.goto('/events?q=incidents&page=2')
    await expect(page.getByPlaceholder('Filter by event, user, or URL...')).toHaveValue('incidents')
    // Footer reads "<n> events · Page 2".
    await expect(page.getByText(/·\s*Page 2/)).toBeVisible()
  })

  test('users preserves a shared ?page=N link', async ({ authedPage: page }) => {
    await page.goto('/users?page=2')
    // Footer reads "<n> users · Page 2". `page` is read straight from the URL
    // (Users resets to page 1 only on an explicit search-apply, never on mount),
    // so the shared link lands on page 2 regardless of row count.
    await expect(page.getByText(/·\s*Page 2/)).toBeVisible()
  })

  test('users hydrates the sort select from the URL', async ({ authedPage: page }) => {
    await page.goto('/users?sort=events')
    // The sort control is the page's only native <select> — scope by the `select`
    // tag rather than role "combobox" (shadcn Select triggers, e.g. the shell's
    // project switcher, also expose role "combobox" and would break strict mode).
    // `?sort=events` maps to the "Sort: Most events" option (value "events");
    // assert the value so it's independent of the visible label text.
    await expect(page.locator('select')).toHaveValue('events')
  })
})
