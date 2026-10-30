import { test as base } from '@playwright/test'
import { injectAuth, loginViaApi } from '../helpers/auth'
import { getProjectIdBySlug } from '../helpers/db'
import { e2eEnv } from '../helpers/env'

export interface E2eFixtures {
  /** Resolved project id for the `e2e` / `E2E` org (see helpers/env.ts). */
  projectId: string
  /** Write key for the `e2e` project — fixed test vector, see helpers/env.ts. */
  writeKey: string
  /** Read key for the `e2e` project — fixed test vector, see helpers/env.ts. */
  readKey: string
  /** Resolved project id for the `e2e-limited` / `E2E-LIMITED` org (maxEventsPerMonthOverride=2). */
  limitedProjectId: string
  /** Write key for the `e2e-limited` project — fixed test vector, see helpers/env.ts. */
  limitedWriteKey: string
  /**
   * Resolved project id for the `e2e-overage` / `E2E-OVERAGE` org
   * (maxEventsPerMonthOverride=2) — dedicated to `overage-policy.spec.ts`, kept
   * isolated from `e2e-limited` so its live `overagePolicy` mutation can never
   * race `schema-and-limits.spec.ts`'s quota test. See `helpers/env.ts`.
   */
  overageProjectId: string
  /** Write key for the `e2e-overage` project — fixed test vector, see helpers/env.ts. */
  overageWriteKey: string
  /**
   * A `Page` already authenticated as the seeded `e2e` user: a fresh browser
   * context has `ckrm_token`/`ckrm_project_id` injected into localStorage
   * before any navigation, then navigates to `/` and waits for the
   * authenticated app shell to render before yielding.
   */
  authedPage: import('@playwright/test').Page
  /**
   * A `Page` authenticated as the seeded `e2e-limited` org's own user (not the
   * default `e2e` org user, which isn't a member of `e2e-limited`) — lets specs
   * view that org's UI (e.g. the billing/usage tab) without faking auth.
   */
  limitedAuthedPage: import('@playwright/test').Page
  /**
   * A `Page` authenticated as the `e2e` org's read-only `viewer`-role user
   * (`OrgRole.viewer` — `projects:read` only, see
   * `packages/auth/src/permissions.ts`). prep fixture: lets a
   * permission-gate spec assert list/preview work but create/materialize
   * don't, without faking a role.
   */
  viewerAuthedPage: import('@playwright/test').Page
}

export const test = base.extend<E2eFixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires object destructuring even when unused.
  projectId: async ({}, use) => {
    const projectId = await getProjectIdBySlug(e2eEnv.org.orgSlug, e2eEnv.org.projectName)
    await use(projectId)
  },

  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires object destructuring even when unused.
  writeKey: async ({}, use) => {
    await use(e2eEnv.org.writeKey)
  },

  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires object destructuring even when unused.
  readKey: async ({}, use) => {
    await use(e2eEnv.org.readKey)
  },

  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires object destructuring even when unused.
  limitedProjectId: async ({}, use) => {
    const projectId = await getProjectIdBySlug(
      e2eEnv.limitedOrg.orgSlug,
      e2eEnv.limitedOrg.projectName,
    )
    await use(projectId)
  },

  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires object destructuring even when unused.
  limitedWriteKey: async ({}, use) => {
    await use(e2eEnv.limitedOrg.writeKey)
  },

  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires object destructuring even when unused.
  overageProjectId: async ({}, use) => {
    const projectId = await getProjectIdBySlug(
      e2eEnv.overageOrg.orgSlug,
      e2eEnv.overageOrg.projectName,
    )
    await use(projectId)
  },

  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires object destructuring even when unused.
  overageWriteKey: async ({}, use) => {
    await use(e2eEnv.overageOrg.writeKey)
  },

  authedPage: async ({ browser, projectId }, use) => {
    const { accessToken } = await loginViaApi(e2eEnv.org.userEmail, e2eEnv.org.userPassword)

    const context = await browser.newContext()
    await injectAuth(context, { token: accessToken, projectId })

    const page = await context.newPage()
    await page.goto('/')
    // The nav-rail "Dashboard" link only renders once RequireAuth resolves to
    // the authed app shell (apps/web/src/components/AppShell.tsx) — a stable
    // marker that beats waiting on network idle or a specific data fetch.
    await page.getByRole('link', { name: 'Dashboard' }).waitFor()

    await use(page)
    await context.close()
  },

  limitedAuthedPage: async ({ browser, limitedProjectId }, use) => {
    const { accessToken } = await loginViaApi(
      e2eEnv.limitedOrg.userEmail,
      e2eEnv.limitedOrg.userPassword,
    )

    const context = await browser.newContext()
    await injectAuth(context, { token: accessToken, projectId: limitedProjectId })

    const page = await context.newPage()
    await page.goto('/')
    await page.getByRole('link', { name: 'Dashboard' }).waitFor()

    await use(page)
    await context.close()
  },

  viewerAuthedPage: async ({ browser, projectId }, use) => {
    const { accessToken } = await loginViaApi(
      e2eEnv.viewerUser.userEmail,
      e2eEnv.viewerUser.userPassword,
    )

    const context = await browser.newContext()
    // Same `e2e`-org project as `authedPage` — the viewer user is a second
    // membership on the same org, not a different org.
    await injectAuth(context, { token: accessToken, projectId })

    const page = await context.newPage()
    await page.goto('/')
    await page.getByRole('link', { name: 'Dashboard' }).waitFor()

    await use(page)
    await context.close()
  },
})

export { expect } from '@playwright/test'
