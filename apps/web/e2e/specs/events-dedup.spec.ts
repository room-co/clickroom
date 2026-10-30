import { randomUUID } from 'node:crypto'
import { expect, test } from '../fixtures'
import { postCapture } from '../helpers/capture'
import { forceMerge, insertEventRow, queryClickHouse, waitForEvent } from '../helpers/clickhouse'

/** Build a unique per-test distinct_id/event pair — see event-pipeline.spec.ts's
 * uniqueIds() for why: `events` is a ReplacingMergeTree and reusing an
 * id/event pair across runs (or within the same day) risks collisions with
 * other e2e data. */
function uniqueIds(prefix: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return {
    distinctId: `e2e-dedup-${suffix}`,
    event: `${prefix}_${suffix}`,
  }
}

async function countRows(projectId: string, distinctId: string, event: string): Promise<number> {
  const rows = await queryClickHouse(
    'SELECT count() as c FROM events WHERE project_id={pid:String} AND distinct_id={did:String} AND event={ev:String}',
    { pid: projectId, did: distinctId, ev: event },
  )
  return Number(rows[0]?.c ?? 0)
}

test.describe('events exact dedup', () => {
  test('distinct events sharing (project, day, event, distinct_id) are not collapsed pre-merge', async ({
    writeKey,
    projectId,
  }) => {
    const { distinctId, event } = uniqueIds('e2e_dedup_nomerge')

    // Two separate postCapture batches -> two distinct uuids minted by
    // capture-rs, same distinct_id/event/day, different properties.
    const res1 = await postCapture(writeKey, [
      { event, distinct_id: distinctId, properties: { attempt: 1 } },
    ])
    expect(res1.status).toBe(202)
    expect(res1.body.accepted).toBe(1)

    const res2 = await postCapture(writeKey, [
      { event, distinct_id: distinctId, properties: { attempt: 2 } },
    ])
    expect(res2.status).toBe(202)
    expect(res2.body.accepted).toBe(1)

    // Wait for both rows to land (waitForEvent polls until count >= 1; we
    // then assert the exact count once ingestion has had time to settle).
    await waitForEvent({ projectId, distinctId, event })
    await expect
      .poll(() => countRows(projectId, distinctId, event), { timeout: 20_000, intervals: [250] })
      .toBe(2)
  })

  test('distinct events remain uncollapsed after a forced background merge', async ({
    writeKey,
    projectId,
  }) => {
    const { distinctId, event } = uniqueIds('e2e_dedup_merge')

    const res1 = await postCapture(writeKey, [
      { event, distinct_id: distinctId, properties: { attempt: 1 } },
    ])
    expect(res1.status).toBe(202)

    const res2 = await postCapture(writeKey, [
      { event, distinct_id: distinctId, properties: { attempt: 2 } },
    ])
    expect(res2.status).toBe(202)

    await waitForEvent({ projectId, distinctId, event })
    await expect
      .poll(() => countRows(projectId, distinctId, event), { timeout: 20_000, intervals: [250] })
      .toBe(2)

    // The actual regression test: force ClickHouse to physically merge parts
    // (mirrors what the background merge scheduler eventually does on its
    // own) and confirm the two genuinely distinct events are still both
    // present — pre-32.A's ORDER BY (missing the uuid hash) would have
    // physically collapsed these into 1 row here.
    await forceMerge({ table: 'events' })

    const count = await countRows(projectId, distinctId, event)
    expect(count).toBe(2)
  })

  test('genuine at-least-once redelivery (same uuid) still collapses to one row after merge', async ({
    projectId,
  }) => {
    const { distinctId, event } = uniqueIds('e2e_dedup_redelivery')
    const uuid = randomUUID()
    const timestamp = new Date().toISOString().replace('T', ' ').replace('Z', '')

    // Insert the SAME uuid twice directly, simulating at-least-once
    // redelivery of the exact same event — capture-rs always mints a fresh
    // uuid per accepted event, so this can only be simulated via a direct
    // ClickHouse insert (see insertEventRow's doc comment).
    await insertEventRow({
      uuid,
      projectId,
      event,
      distinctId,
      timestamp,
      properties: { redelivery: 'first' },
    })
    await insertEventRow({
      uuid,
      projectId,
      event,
      distinctId,
      timestamp,
      properties: { redelivery: 'second' },
    })

    // Before a merge runs, both physical rows may still be present (FINAL
    // isn't used by countRows here) — the pre-merge count is not asserted;
    // only the post-merge, engine-level guarantee is what this scenario
    // exists to prove.
    await forceMerge({ table: 'events' })

    const count = await countRows(projectId, distinctId, event)
    expect(count).toBe(1)
  })
})
