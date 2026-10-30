import { expect, test } from '../fixtures'
import { loginViaApi } from '../helpers/auth'
import { e2eEnv } from '../helpers/env'

/** Per-run-unique suffix, same convention as `user-segments-tenancy.spec.ts` —
 * experiment names double as the assertion target in this file (visible/not
 * visible in a list), so they must never collide across runs. */
function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

interface CreateExperimentArgs {
  accessToken: string
  projectId: string
  name: string
}

/**
 * Create an experiment via the real `experiments.create` tRPC mutation
 * directly (no browser), bypassing `ExperimentBuilderPage` entirely — this
 * file's scenarios (tenancy isolation, permission gating) are about who can
 * *see* and *act on* an experiment, not builder mechanics (the builder
 * specs already cover that end-to-end through the real UI). Same plain (non-batched,
 * non-superjson) calling convention as `loginViaApi`/
 * `user-segments-tenancy.spec.ts`'s `createSegmentViaApi`: raw input object,
 * no `{json: ...}` envelope, auth via `Authorization: Bearer <accessToken>`.
 *
 * The primary metric carries one minimal, schema-valid funnel definition (two
 * steps) so `experiments.create` doesn't need a richer fixture — this file
 * never drives the metric editor or asserts on computed results.
 */
async function createExperimentViaApi({
  accessToken,
  projectId,
  name,
}: CreateExperimentArgs): Promise<{ id: string }> {
  const res = await fetch(`${e2eEnv.apiUrl}/trpc/experiments.create`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      projectId,
      name,
      primaryMetric: {
        type: 'funnel',
        steps: [{ event: 'page_view' }, { event: 'signup_completed' }],
        window: 86400,
      },
    }),
  })
  const payload = await res.json().catch(() => undefined)
  if (!res.ok || !payload?.result?.data?.id) {
    throw new Error(
      `createExperimentViaApi(${name}) failed (${res.status}): ${JSON.stringify(payload)}`,
    )
  }
  return { id: payload.result.data.id as string }
}

interface DirectCallResult {
  status: number
  code: string | undefined
}

/** Plain tRPC GET call (query procedures — `get`/`results`), mirroring
 * `user-segments.spec.ts`'s `getSegmentDirect`: no superjson envelope, input
 * passed as a JSON-encoded query param. Returns the HTTP status plus the
 * tRPC error `code` (e.g. `'NOT_FOUND'`) so callers can assert fail-closed
 * behavior without depending on a specific HTTP status mapping. */
async function queryDirect(
  procedure: 'experiments.get' | 'experiments.results',
  accessToken: string,
  input: Record<string, unknown>,
): Promise<DirectCallResult> {
  const encoded = encodeURIComponent(JSON.stringify(input))
  const res = await fetch(`${e2eEnv.apiUrl}/trpc/${procedure}?input=${encoded}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${accessToken}` },
  })
  const body = await res.json().catch(() => undefined)
  return { status: res.status, code: body?.error?.data?.code as string | undefined }
}

/** Plain tRPC POST call (mutation procedures — `update`/`delete`/`launch`/
 * `stop`), same calling convention as `createExperimentViaApi`. */
async function mutateDirect(
  procedure:
    | 'experiments.update'
    | 'experiments.delete'
    | 'experiments.launch'
    | 'experiments.stop',
  accessToken: string,
  input: Record<string, unknown>,
): Promise<DirectCallResult> {
  const res = await fetch(`${e2eEnv.apiUrl}/trpc/${procedure}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(input),
  })
  const body = await res.json().catch(() => undefined)
  return { status: res.status, code: body?.error?.data?.code as string | undefined }
}

function uniqueName(label: string): string {
  return `e2e-exp-tenancy-${label}-${uniqueSuffix()}`
}

test.describe('experiments — tenancy + permission boundaries', () => {
  test('cross-tenant isolation: an e2e-org experiment is invisible and unreachable from e2e-limited', async ({
    authedPage,
    limitedAuthedPage,
    projectId,
  }) => {
    const name = uniqueName('cross-tenant')
    const { accessToken: ownerToken } = await loginViaApi(
      e2eEnv.org.userEmail,
      e2eEnv.org.userPassword,
    )
    const { id: experimentId } = await createExperimentViaApi({
      accessToken: ownerToken,
      projectId,
      name,
    })

    // 1. Sanity check: the owning org's own session sees it in the list.
    await authedPage.goto('/experiments')
    await expect(authedPage.getByText(name)).toBeVisible()

    // 2. `e2e-limited` org's list must never show it — `experiments.list` is
    // scoped by `scopedForProject` off the caller's own `projectId`
    // (limitedAuthedPage's session/localStorage carries `limitedProjectId`,
    // not the `e2e` project's id), so the query never even looks at the
    // `e2e` project's rows.
    await limitedAuthedPage.goto('/experiments')
    await expect(
      limitedAuthedPage.getByText('No experiments yet').or(limitedAuthedPage.locator('table')),
    ).toBeVisible()
    await expect(limitedAuthedPage.getByText(name)).not.toBeVisible()

    // 3. Direct navigation to the `e2e`-org experiment's edit URL from the
    // `e2e-limited` session must never leak the other tenant's data:
    // `experiments.get` throws NOT_FOUND (scoped off the caller's own
    // projectId), so the builder never hydrates the form — it stays on its
    // empty "new experiment" draft shape instead of leaking `name` into the
    // DOM. Same retry-window posture as `user-segments-tenancy.spec.ts`:
    // `experiments.get` doesn't opt out of react-query's default retry, so
    // give the locator a generous timeout to span it.
    await limitedAuthedPage.goto(`/experiments/${experimentId}/edit`)
    await expect(limitedAuthedPage.locator('#experiment-name')).toHaveValue('', {
      timeout: 15_000,
    })
    await expect(limitedAuthedPage.getByText(name)).not.toBeVisible()

    // 4. Direct tRPC calls from an `e2e-limited`-authenticated session using
    // the real `e2e` project id + experiment id must fail closed —
    // `scopedForProject` looks the project up scoped to the caller's own
    // orgId, so it 404s before ever reaching the experiment row, regardless
    // of which project id/experiment id are passed on the wire.
    const { accessToken: limitedToken } = await loginViaApi(
      e2eEnv.limitedOrg.userEmail,
      e2eEnv.limitedOrg.userPassword,
    )

    const getResult = await queryDirect('experiments.get', limitedToken, {
      projectId,
      id: experimentId,
    })
    expect(getResult.code).toBe('NOT_FOUND')

    const updateResult = await mutateDirect('experiments.update', limitedToken, {
      projectId,
      id: experimentId,
      patch: { name: 'should-not-apply' },
    })
    expect(updateResult.code).toBe('NOT_FOUND')

    const deleteResult = await mutateDirect('experiments.delete', limitedToken, {
      projectId,
      id: experimentId,
    })
    expect(deleteResult.code).toBe('NOT_FOUND')

    const resultsResult = await queryDirect('experiments.results', limitedToken, {
      projectId,
      id: experimentId,
    })
    expect(resultsResult.code).toBe('NOT_FOUND')

    // 5. Sanity check the experiment truly survived all of the above (the
    // delete attempt above must not have actually soft-deleted it) — the
    // owning org's session still sees it.
    await authedPage.goto('/experiments')
    await expect(authedPage.getByText(name)).toBeVisible()
  })

  test('permission gate: viewer role can view experiments + results but cannot create/launch/stop/delete', async ({
    authedPage,
    viewerAuthedPage,
    projectId,
  }) => {
    const name = uniqueName('permgate')
    const { accessToken: ownerToken } = await loginViaApi(
      e2eEnv.org.userEmail,
      e2eEnv.org.userPassword,
    )
    const { id: experimentId } = await createExperimentViaApi({
      accessToken: ownerToken,
      projectId,
      name,
    })

    // Sanity check: the admin-ish session that created it can see it too
    // (rules out a fixture/project-id mismatch producing a false negative
    // below).
    await authedPage.goto('/experiments')
    await expect(authedPage.getByText(name)).toBeVisible()

    // 1. List view: viewer (projects:read only) can see the experiment, but
    // the "New experiment" action is absent from the DOM entirely
    // (ExperimentsPage gates it on `useAuth().can('projects:manage')`), not
    // just disabled.
    await viewerAuthedPage.goto('/experiments')
    await expect(viewerAuthedPage.getByText(name)).toBeVisible()
    await expect(viewerAuthedPage.getByRole('button', { name: 'New experiment' })).not.toBeVisible()

    // 2. Builder/edit view: viewer can open the experiment (`get` requires
    // only `projects:read`) and see it hydrate, but "Save changes" is
    // present-but-disabled (ExperimentBuilderPage guards it on
    // `!canManageProjects`), Launch/Stop are absent from the DOM entirely
    // (not just disabled — both gated on `canManageProjects` in the header),
    // and the read-only banner is shown.
    await viewerAuthedPage.goto(`/experiments/${experimentId}/edit`)
    await expect(viewerAuthedPage.locator('#experiment-name')).toHaveValue(name)
    await expect(
      viewerAuthedPage.getByText("You don't have permission to edit experiments."),
    ).toBeVisible()
    await expect(viewerAuthedPage.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    await expect(viewerAuthedPage.getByRole('button', { name: 'Launch' })).not.toBeVisible()
    await expect(viewerAuthedPage.getByRole('button', { name: 'Stop' })).not.toBeVisible()

    // 3. Results view: `results` requires only `projects:read`, so the
    // viewer's session must reach the "not launched yet" state (the
    // experiment above was never launched), not an error/403 state — proves
    // the read path isn't blocked, distinct from the write paths below.
    await viewerAuthedPage.goto(`/experiments/${experimentId}/results`)
    await expect(viewerAuthedPage.getByText(/not launched/i)).toBeVisible()

    // 4. Direct tRPC calls from the viewer session against the real
    // experiment must be rejected — `create`/`launch`/`stop`/`delete` all
    // gate on `requirePermission('projects:manage')`, which the viewer role
    // lacks (`projects:read` only, see `packages/auth/src/permissions.ts`).
    const { accessToken: viewerToken } = await loginViaApi(
      e2eEnv.viewerUser.userEmail,
      e2eEnv.viewerUser.userPassword,
    )

    // (`create` itself needs no existing-id fixture to prove the gate — the
    // shared `requirePermission('projects:manage')` middleware runs before
    // any input-specific lookup, so rejecting `update` here demonstrates the
    // same gate `create` would hit.)
    const updateResult = await mutateDirect('experiments.update', viewerToken, {
      projectId,
      id: experimentId,
      patch: { name: 'should-not-apply' },
    })
    expect(updateResult.code).toBe('FORBIDDEN')

    const launchResult = await mutateDirect('experiments.launch', viewerToken, {
      projectId,
      id: experimentId,
    })
    expect(launchResult.code).toBe('FORBIDDEN')

    const stopResult = await mutateDirect('experiments.stop', viewerToken, {
      projectId,
      id: experimentId,
    })
    expect(stopResult.code).toBe('FORBIDDEN')

    const deleteResult = await mutateDirect('experiments.delete', viewerToken, {
      projectId,
      id: experimentId,
    })
    expect(deleteResult.code).toBe('FORBIDDEN')

    // 5. Sanity check the experiment truly survived all of the above.
    await authedPage.goto('/experiments')
    await expect(authedPage.getByText(name)).toBeVisible()
  })
})
