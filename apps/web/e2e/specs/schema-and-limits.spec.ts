import { expect, test } from '../fixtures'
import { postCapture } from '../helpers/capture'

/** Build a unique event name per test run so it never collides with a
 * previous e2e run's leftover `EventDefinition` row (see event-pipeline.spec.ts
 * for the same rationale around unique ids). */
function uniqueEventName(prefix: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}_${suffix}`
}

test.describe('schema enforcement + usage limits', () => {
  test('strict schema rejects a batch missing a required property', async ({
    authedPage: page,
    writeKey,
  }) => {
    const eventName = uniqueEventName('e2e_strict_event')

    // 1. Declare the event via the Data Management > Schema tab: strict
    // enforcement + one required string property.
    await page.goto('/data-management?tab=schema')
    await page.getByRole('button', { name: 'Add event' }).click()

    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Event name').fill(eventName)

    // AddEventDialog.tsx: Radix Select's `combobox` role isn't a
    // "name from contents" role, so its accessible name isn't "None" even
    // though that's the visible text — there's exactly one combobox in the
    // dialog at this point (the properties editor's per-row type select
    // doesn't exist until "Add property" is clicked below), so select on
    // role alone.
    await dialog.getByRole('combobox').click()
    await page.getByRole('option', { name: 'Strict' }).click()

    // PropertyRowsEditor.tsx: add one row, name it, leave type at the default
    // "String", and mark it required.
    await dialog.getByRole('button', { name: 'Add property' }).click()
    await dialog.getByPlaceholder('property_name').fill('required_prop')
    await dialog.getByLabel('Required').check()

    await dialog.getByRole('button', { name: 'Create event' }).click()
    await expect(dialog).toBeHidden()

    // 2. Missing the required property -> whole batch rejected 400, with the
    // `MissingRequired`-shaped violation from contracts/capture-api.md.
    //
    // services/capture/src/schema.rs fronts the Redis `capture:schema:<id>`
    // read with a 5s process-local cache (documented, intentional — "a few
    // seconds of staleness is an acceptable trade"). Under parallel e2e load
    // that cache may already be warm with the pre-creation (empty/unenforced)
    // state, so the very next capture call can still see mode "none" for a
    // few seconds after the schema write. Retry until the cache catches up.
    let missing: { status: number; body: Record<string, unknown> } | undefined
    await expect(async () => {
      missing = await postCapture(writeKey, [
        { event: eventName, distinct_id: 'e2e-schema-user', properties: {} },
      ])
      expect(missing.status).toBe(400)
    }).toPass({ timeout: 10_000 })
    expect(missing?.body.accepted).toBe(0)
    expect(missing?.body.errors).toBeDefined()
    const [violation] = missing?.body.errors as Array<{
      index: number
      event: string
      violations: Array<{ kind: string; property: string }>
    }>
    expect(violation.event).toBe(eventName)
    expect(violation.violations).toContainEqual(
      expect.objectContaining({ kind: 'missing_required', property: 'required_prop' }),
    )

    // 3. Same event, required property present -> accepted.
    const ok = await postCapture(writeKey, [
      {
        event: eventName,
        distinct_id: 'e2e-schema-user',
        properties: { required_prop: 'ok' },
      },
    ])
    expect(ok.status).toBe(202)
    expect(ok.body.accepted).toBe(1)
  })

  test('monthly event quota gates capture once the limited org is over its override', async ({
    limitedWriteKey,
    limitedAuthedPage: page,
  }) => {
    // `e2e-limited` org is seeded with `maxEventsPerMonthOverride: 2`
    // (packages/db/src/seed.e2e.ts / apps/web/e2e/helpers/env.ts) and the e2e
    // stack runs with `QUOTA_ENFORCE=true` (.env.e2e). services/capture/src/
    // quota.rs allows requests while `current <= limit` and rejects with
    // `402 { error: "quota exceeded" }` (services/capture/src/error.rs)
    // once `current > limit` — counting always happens regardless of the
    // enforce flag, so the Redis counter for this org may already be at or
    // past the limit from a previous e2e run in the same calendar month.
    // Rather than assume a fresh counter, post one-event batches until a
    // rejection is observed (bounded so a broken gate fails fast instead of
    // hanging) and assert its exact shape.
    const maxAttempts = 5
    let rejected: { status: number; body: unknown } | undefined

    for (let i = 0; i < maxAttempts; i++) {
      // Unique distinct_id/event per attempt (not a fixed pair) — `events` is
      // a ReplacingMergeTree ordered by (project_id, day, event,
      // cityHash64(distinct_id)) (packages/clickhouse/migrations/001_events.sql),
      // so `FINAL`-based counting (buildOrgEventUsage, used by the usage
      // summary this test asserts on below) collapses same-day rows sharing
      // that exact tuple into one, regardless of how many were actually
      // accepted — a fixed pair across attempts would make `eventsThisMonth`
      // permanently under-report and never trip `overLimit` (see
      // event-pipeline.spec.ts's `uniqueIds` for the same rationale).
      const res = await postCapture(limitedWriteKey, [
        {
          event: uniqueEventName('e2e_limit_probe'),
          distinct_id: `e2e-limit-user-${i}-${Date.now()}`,
        },
      ])
      if (res.status === 402) {
        rejected = res
        break
      }
      expect(res.status).toBe(202)
      expect(res.body.accepted).toBe(1)
    }

    expect(
      rejected,
      `expected a 402 quota-exceeded response within ${maxAttempts} capture calls against the limited org's override of 2 events/month`,
    ).toBeDefined()
    expect(rejected?.body).toEqual({ error: 'quota exceeded' })

    // UI-level assertion: the `e2e-limited` org has its own seeded user
    // (packages/db/src/seed.e2e.ts) — use it via `limitedAuthedPage` rather
    // than the default `e2e` org user (which isn't a member of `e2e-limited`
    // and can't view its billing tab). UsageSummaryPanel lives under
    // Settings > Billing (apps/web/src/pages/SettingsPage.tsx); the tab is
    // client-side React state, not a URL param, so click into it.
    await page.goto('/settings')
    await page.getByRole('button', { name: 'Billing' }).click()
    // UsageSummaryPanel's usage.summary query does a live Postgres + 2
    // ClickHouse aggregation queries — under parallel-worker load this can
    // take longer than the default 5s assertion timeout (same class of
    // contention as the ClickHouse poll in event-pipeline.spec.ts), so wait
    // generously and anchor on the panel having loaded at all first.
    await expect(page.getByText('Events / mo')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Over limit')).toBeVisible({ timeout: 15_000 })
  })
})
