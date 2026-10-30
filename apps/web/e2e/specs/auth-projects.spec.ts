import { expect, test } from '../fixtures'
import { signupFreshUser } from '../helpers/auth'

test.describe('auth + projects', () => {
  test('signup creates an authenticated session', async ({ page }) => {
    // Drives the real signup UI (SignupPage.tsx) — waits for navigation to
    // `/` on success, which only happens after `setToken` + `navigate('/')`.
    await signupFreshUser(page)

    // AppShell (apps/web/src/components/AppShell.tsx) only renders the nav
    // rail once RequireAuth resolves — "Dashboard" is a stable authed marker.
    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible()

    // Supplementary check: the auth token this session relies on is actually
    // persisted in localStorage (apps/web/src/lib/auth.ts's `ckrm_token`).
    const token = await page.evaluate(() => window.localStorage.getItem('ckrm_token'))
    expect(token).toBeTruthy()
  })

  test('project lifecycle: create, rename, delete', async ({ authedPage: page }) => {
    const projectName = `E2E Project ${Date.now()}`
    const renamedName = `${projectName}-renamed`

    await page.goto('/projects')

    // ── Create ──────────────────────────────────────────────────────────────
    await page.getByRole('button', { name: 'New project' }).click()
    await page.locator('#project-name').fill(projectName)
    await page.getByRole('button', { name: 'Create project' }).click()

    // The create panel only closes (onSaved -> setPanel(null)) after the
    // mutation resolves and the list is invalidated, so wait on the row.
    const row = page.getByRole('row', { name: new RegExp(projectName) })
    await expect(row).toBeVisible()

    // ── Rename ──────────────────────────────────────────────────────────────
    // The edit slide-over (ProjectPanel) renders synchronously off local
    // component state, but the panel's own mount/fade can lag a frame behind
    // the click, so the value assertion carries its own retry budget.
    await row.getByTitle('Edit project').click()
    await expect(page.locator('#project-name')).toHaveValue(projectName, { timeout: 5_000 })

    await page.locator('#project-name').fill(renamedName)
    await page.getByRole('button', { name: 'Save changes' }).click()

    const renamedRow = page.getByRole('row', { name: new RegExp(renamedName) })
    await expect(renamedRow).toBeVisible()

    // ── Delete ──────────────────────────────────────────────────────────────
    await renamedRow.getByTitle('Delete project').click()
    const confirmButton = page.getByRole('button', { name: 'Delete forever' })
    await expect(confirmButton).toBeVisible({ timeout: 5_000 })
    await confirmButton.click()

    await expect(page.getByRole('row', { name: new RegExp(renamedName) })).toHaveCount(0)
  })
})
