import { expect, test } from '../fixtures'
import { loginViaApi } from '../helpers/auth'
import { postCapture } from '../helpers/capture'
import { queryClickHouse, waitForEvent } from '../helpers/clickhouse'
import { e2eEnv } from '../helpers/env'

/** Build a unique event name per attempt so ClickHouse's ReplacingMergeTree
 * dedup (see schema-and-limits.spec.ts's quota test for the full rationale)
 * never collapses distinct capture calls into one row. */
function uniqueEventName(prefix: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}_${suffix}`
}

/**
 * Toggle the `e2e-overage` org's overage policy via the real
 * `usage.setOveragePolicy` tRPC mutation (apps/api/src/trpc/routers/
 * usage.router.ts) — same plain (non-batched, non-superjson) calling
 * convention as `loginViaApi` (helpers/auth.ts): raw input object, no
 * `{json: ...}` envelope, auth via `Authorization: Bearer <accessToken>`.
 *
 * This org is dedicated to this spec file (not shared with `e2e-limited`) —
 * see `packages/db/src/seed.e2e.ts`'s module doc comment for why: this file's
 * live 'block' <-> 'allow' mutation must never race
 * `schema-and-limits.spec.ts`'s quota test, which assumes `e2e-limited` stays
 * on its seeded 'block' default, and Playwright runs different spec files
 * concurrently by default (`fullyParallel: true`).
 */
async function setOveragePolicy(policy: 'block' | 'allow'): Promise<void> {
  const { accessToken } = await loginViaApi(
    e2eEnv.overageOrg.userEmail,
    e2eEnv.overageOrg.userPassword,
  )
  const res = await fetch(`${e2eEnv.apiUrl}/trpc/usage.setOveragePolicy`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ policy }),
  })
  if (!res.ok) {
    throw new Error(`setOveragePolicy(${policy}) failed (${res.status}): ${await res.text()}`)
  }
}

/**
 * Org-scoped overage policy ('block', the seeded default, vs
 * 'allow') gating what happens once a monthly metric goes over its limit.
 * Both tests below mutate the dedicated `e2e-overage` org's policy (see
 * `packages/db/src/seed.e2e.ts` / `helpers/env.ts`'s `overageOrg`) — a
 * separate org from `e2e-limited`, precisely so this live mutation can never
 * race `schema-and-limits.spec.ts`'s quota test, which shares `e2e-limited`
 * and assumes it stays on the seeded 'block' default without resetting it.
 * This file still forces its own two tests to run serially against each
 * other (never interleaved under parallel workers, since Playwright's
 * `fullyParallel` would otherwise happily run them concurrently in separate
 * workers) and restores 'block' in `afterAll`, which Playwright always runs
 * for a describe block regardless of earlier failures within it, so a stray
 * 'allow' never lingers on `e2e-overage` for a later run.
 */
test.describe('overage policy', () => {
  test.describe.configure({ mode: 'serial' })

  test.afterAll(async () => {
    await setOveragePolicy('block')
  })

  test('block: capture discards over-limit events, they never land in ClickHouse', async ({
    overageWriteKey,
    overageProjectId,
  }) => {
    // Explicit, not just relying on seed state — this test runs first in the
    // serial describe, but be defensive in case ordering ever changes.
    await setOveragePolicy('block')

    // `e2e-overage` org has maxEventsPerMonthOverride=2 (helpers/env.ts); the
    // Redis counter may already be at/past that from a previous run this
    // calendar month, so probe until a 402 appears instead of assuming a
    // fresh counter (same pattern as schema-and-limits.spec.ts).
    const maxAttempts = 5
    let rejected: { status: number; body: unknown } | undefined
    let rejectedDistinctId: string | undefined

    for (let i = 0; i < maxAttempts; i++) {
      const distinctId = `e2e-overage-block-${i}-${Date.now()}`
      const res = await postCapture(overageWriteKey, [
        { event: uniqueEventName('e2e_overage_block_probe'), distinct_id: distinctId },
      ])
      if (res.status === 402) {
        rejected = res
        rejectedDistinctId = distinctId
        break
      }
      expect(res.status).toBe(202)
      expect(res.body.accepted).toBe(1)
    }

    expect(
      rejected,
      `expected a 402 quota-exceeded response within ${maxAttempts} capture calls against the overage org's override under 'block' policy`,
    ).toBeDefined()
    expect(rejected?.body).toEqual({ error: 'quota exceeded' })

    // Can't prove true absence with 100% certainty — only that the row
    // didn't show up within a bounded window. A short wait is enough here:
    // services/capture/src/quota.rs rejects (and short-circuits) BEFORE
    // publishing to NATS, so a blocked event never enters the ingest
    // pipeline at all — there's nothing in flight to wait out the way
    // waitForEvent's 20s budget accounts for (that's for events that WERE
    // accepted and are just slow to land).
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    const rows = await queryClickHouse(
      'SELECT count() as c FROM events FINAL WHERE project_id={pid:String} AND distinct_id={did:String}',
      { pid: overageProjectId, did: rejectedDistinctId as string },
    )
    expect(Number(rows[0]?.c ?? 0)).toBe(0)
  })

  test('allow: capture keeps accepting over-limit events and they land in ClickHouse', async ({
    overageWriteKey,
    overageProjectId,
  }) => {
    await setOveragePolicy('allow')

    // maxEventsPerMonthOverride=2 (helpers/env.ts) — drive well past it
    // (limit + 3) with a unique distinct_id/event per attempt so every
    // single response can be asserted `202`, proving the gate is genuinely
    // bypassed rather than the probe just coincidentally staying under it.
    const limit = 2
    const attempts = limit + 3
    const captured: Array<{ distinctId: string; event: string }> = []

    for (let i = 0; i < attempts; i++) {
      const distinctId = `e2e-overage-allow-${i}-${Date.now()}`
      const event = uniqueEventName('e2e_overage_allow_probe')
      const res = await postCapture(overageWriteKey, [{ event, distinct_id: distinctId }])
      expect(res.status).toBe(202)
      expect(res.body.accepted).toBe(1)
      captured.push({ distinctId, event })
    }

    // The last attempt is the most over-limit one — confirm it actually made
    // it through ingest to ClickHouse, not just accepted at the HTTP
    // boundary (proving overage is genuinely ingested, not silently dropped
    // downstream).
    const last = captured[captured.length - 1]
    const count = await waitForEvent({
      projectId: overageProjectId,
      distinctId: last.distinctId,
      event: last.event,
    })
    expect(count).toBeGreaterThanOrEqual(1)
  })
})
