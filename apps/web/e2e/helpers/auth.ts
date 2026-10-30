import type { BrowserContext, Page } from '@playwright/test'
import { e2eEnv } from './env'

/**
 * Log in via the API directly (no UI), returning the access token.
 *
 * Shape: a plain (non-batched) tRPC v11 HTTP POST to `/trpc/auth.login`.
 * `apps/api` has no superjson/data transformer configured, and its input is
 * NOT wrapped in a `{"json": ...}` envelope for non-batch calls (verified
 * live against a running e2e API — a `{"json": {...}}`-wrapped body fails
 * zod validation with `email`/`password` reported as `undefined`, since the
 * server reads the raw body as the input directly):
 *   request:  POST /trpc/auth.login  body: {"email":…, "password":…}
 *   response: {"result": {"data": {"accessToken":…, "user":…, "org":…}}}
 */
export async function loginViaApi(
  email: string,
  password: string,
): Promise<{ accessToken: string }> {
  const res = await fetch(`${e2eEnv.apiUrl}/trpc/auth.login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })

  const payload = await res.json().catch(() => undefined)
  if (!res.ok || !payload?.result?.data?.accessToken) {
    throw new Error(`loginViaApi failed (${res.status}) for ${email}: ${JSON.stringify(payload)}`)
  }

  return { accessToken: payload.result.data.accessToken as string }
}

export interface InjectAuthArgs {
  token: string
  projectId: string
}

/**
 * Seed localStorage with a valid access token + active project id before any
 * page navigation in this browser context, so pages load already
 * authenticated. Matches the keys `apps/web/src/lib/auth.ts` (`ckrm_token`)
 * and `apps/web/src/lib/use-project.ts` (`ckrm_project_id`) read from.
 *
 * `addInitScript` runs on every subsequent navigation/page in this context,
 * including the very first `about:blank` — by the time a spec navigates to
 * `baseURL`, localStorage for that origin is already populated.
 */
export async function injectAuth(
  context: BrowserContext,
  { token, projectId }: InjectAuthArgs,
): Promise<void> {
  await context.addInitScript(
    ({ token, projectId }) => {
      window.localStorage.setItem('ckrm_token', token)
      window.localStorage.setItem('ckrm_project_id', projectId)
    },
    { token, projectId },
  )
}

/**
 * Drive the real signup UI (apps/web/src/pages/SignupPage.tsx) to create a
 * fresh org + user, returning the generated email/password for later
 * assertions. Each call gets a unique email so specs can run signup
 * repeatedly without colliding on the `User.email` unique constraint.
 */
export async function signupFreshUser(page: Page): Promise<{ email: string; password: string }> {
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@clickroom.dev`
  const password = 'e2e-fresh-user-pw-2026'
  const workspace = `E2E Fresh ${Date.now()}`

  await page.goto('/signup')
  await page.locator('#signup-name').fill('E2E Fresh User')
  await page.locator('#signup-email').fill(email)
  await page.locator('#signup-workspace').fill(workspace)
  await page.locator('#signup-password').fill(password)
  await page.getByRole('button', { name: 'Agree to terms' }).click()
  await page.getByRole('button', { name: 'Create free account' }).click()
  await page.waitForURL('/')

  return { email, password }
}
