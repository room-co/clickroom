import { expect, test } from '../fixtures'
import { loginViaApi } from '../helpers/auth'
import { e2eEnv } from '../helpers/env'

/** Per-run-unique suffix, same convention as the rest of the harness (see
 * `helpers/capture.ts`'s `uniqueSuffix` / `event-pipeline.spec.ts`'s
 * `uniqueIds`) — segment names double as the assertion target in this file
 * (visible/not-visible in a list), so they must never collide across runs. */
function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

interface CreateSegmentArgs {
  accessToken: string
  projectId: string
  name: string
}

/**
 * Create a segment via the real `segments.create` tRPC mutation directly
 * (no browser), bypassing the SegmentBuilderPage UI entirely — this file's
 * scenarios (tenancy isolation, permission gating) are about who can *see*
 * and *act on* a segment, not about condition-building mechanics, which
 * `user-segments.spec.ts` already covers end-to-end through the
 * real builder UI. Same plain (non-batched, non-superjson) calling
 * convention as `loginViaApi`/`overage-policy.spec.ts`'s `setOveragePolicy`:
 * raw input object, no `{json: ...}` envelope, auth via `Authorization:
 * Bearer <accessToken>`.
 *
 * The definition carries one valid trait condition (`plan exact 'pro'`) so
 * downstream preview/materialize UI has something non-degenerate to render
 * (an empty `conditions: []` array is schema-valid but would make the
 * builder's "idle" preview state indistinguishable from a load failure).
 */
async function createSegmentViaApi({
  accessToken,
  projectId,
  name,
}: CreateSegmentArgs): Promise<{ id: string }> {
  const res = await fetch(`${e2eEnv.apiUrl}/trpc/segments.create`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      projectId,
      name,
      definition: {
        version: 1,
        root: {
          combinator: 'AND',
          conditions: [{ type: 'trait', key: 'plan', operator: 'exact', value: 'pro' }],
        },
      },
    }),
  })
  const payload = await res.json().catch(() => undefined)
  if (!res.ok || !payload?.result?.data?.id) {
    throw new Error(
      `createSegmentViaApi(${name}) failed (${res.status}): ${JSON.stringify(payload)}`,
    )
  }
  return { id: payload.result.data.id as string }
}

test.describe('user segments — tenancy + permission boundaries', () => {
  test('cross-tenant isolation: an e2e-org segment is invisible from e2e-limited', async ({
    authedPage,
    limitedAuthedPage,
    projectId,
  }) => {
    const segmentName = `e2e-seg-tenancy-${uniqueSuffix()}`
    const { accessToken } = await loginViaApi(e2eEnv.org.userEmail, e2eEnv.org.userPassword)
    const { id: segmentId } = await createSegmentViaApi({
      accessToken,
      projectId,
      name: segmentName,
    })

    // 1. Sanity check: the owning org's own session sees it in the list.
    await authedPage.goto('/segments')
    await expect(authedPage.getByText(segmentName)).toBeVisible()

    // 2. `e2e-limited` org's list must never show it — `segments.list` is
    // scoped by `scopedForProject` off the caller's own `projectId`
    // (limitedAuthedPage's session/localStorage carries `limitedProjectId`,
    // not the `e2e` project's id), so the query never even looks at the
    // `e2e` project's rows.
    await limitedAuthedPage.goto('/segments')
    // Let the list settle (loading skeleton -> empty state or rows) before
    // asserting absence, mirroring schema-and-limits.spec.ts's pattern of
    // anchoring on a stable post-load marker rather than a fixed sleep.
    await expect(
      limitedAuthedPage.getByText('No segments yet').or(limitedAuthedPage.locator('table')),
    ).toBeVisible()
    await expect(limitedAuthedPage.getByText(segmentName)).not.toBeVisible()

    // 3. Direct navigation to the `e2e`-org segment's edit URL from the
    // `e2e-limited` session must never leak the other tenant's data:
    // `segments.get` throws NOT_FOUND (scoped off the caller's own
    // projectId), so the builder never hydrates the form with the real
    // name/conditions — it stays on its empty "new segment" draft shape
    // instead of leaking `segmentName` into the DOM. SegmentBuilderPage has
    // no dedicated not-found UI for this case; it just renders the ordinary
    // empty-draft form once the query settles. That settling takes longer
    // than the default 5s expect timeout here: `segments.get` doesn't opt
    // out of react-query's default retry (3 attempts with exponential
    // backoff, ~7s total) the way e.g. InvitePage/FlagDetailPage's
    // known-terminal 404 lookups do, so the page sits on its loading
    // skeleton (no `#segment-name` in the DOM yet) through several retries
    // before the query gives up and the empty form renders. Give the
    // locator a generous timeout to span that retry window rather than
    // asserting on a loading-state DOM.
    await limitedAuthedPage.goto(`/segments/${segmentId}/edit`)
    await expect(limitedAuthedPage.locator('#segment-name')).toHaveValue('', { timeout: 15_000 })
    await expect(limitedAuthedPage.getByText(segmentName)).not.toBeVisible()
  })

  test('permission gate: viewer role can view + preview but cannot create/materialize', async ({
    authedPage,
    viewerAuthedPage,
    projectId,
  }) => {
    const segmentName = `e2e-seg-permgate-${uniqueSuffix()}`
    const { accessToken } = await loginViaApi(e2eEnv.org.userEmail, e2eEnv.org.userPassword)
    const { id: segmentId } = await createSegmentViaApi({
      accessToken,
      projectId,
      name: segmentName,
    })

    // Sanity check: the admin-ish session that created it can see it too
    // (rules out a fixture/project-id mismatch producing a false negative
    // below).
    await authedPage.goto('/segments')
    await expect(authedPage.getByText(segmentName)).toBeVisible()

    // 1. List view: viewer (projects:read only) can see the segment, but the
    // "New segment" action is absent from the DOM entirely (SegmentsPage
    // gates it on `useAuth().can('projects:manage')`), not just disabled.
    await viewerAuthedPage.goto('/segments')
    await expect(viewerAuthedPage.getByText(segmentName)).toBeVisible()
    await expect(viewerAuthedPage.getByRole('button', { name: 'New segment' })).not.toBeVisible()

    // 2. Builder/edit view: viewer can open the segment (get + previewCount
    // both require only projects:read) and see the live preview resolve,
    // but "Save changes" / "Materialize now" are both present-but-disabled
    // (SegmentBuilderPage guards both on `!canManageProjects`), and the
    // read-only banner is shown.
    await viewerAuthedPage.goto(`/segments/${segmentId}/edit`)
    await expect(viewerAuthedPage.locator('#segment-name')).toHaveValue(segmentName)
    await expect(
      viewerAuthedPage.getByText("You don't have permission to edit segments."),
    ).toBeVisible()

    // Preview resolves (not stuck in an error state) — projects:read is
    // sufficient for `previewCount`. `previewState === 'error'` renders this
    // exact alert title; its absence plus the section not being stuck on the
    // idle placeholder proves the query didn't 403.
    await expect(viewerAuthedPage.getByText('Failed to preview segment')).not.toBeVisible()
    await expect(
      viewerAuthedPage.getByText('Add at least one condition with a value to preview.'),
    ).not.toBeVisible()

    await expect(viewerAuthedPage.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    await expect(viewerAuthedPage.getByRole('button', { name: 'Materialize now' })).toBeDisabled()
  })
})
