// The parts of `support.webhooks` that a stubbed Prisma
// client CANNOT check.
//
// `packages/trpc-router`'s suite runs against in-memory tables with no SQL
// engine behind them, so four surfaces are only shape-asserted there:
//
//   - `affectedForms`  — Postgres jsonb `@>` containment (the stub approximates
//                        it in JS; Prisma's `array_contains` lowering is the
//                        thing actually under test).
//   - `health`         — `row_number()` windowing + `FILTER` + `percentile_disc`.
//   - `stats`          — `FILTER` aggregates and the `from`/`to` bind casts.
//   - `reEnableAndReplay` — `make_interval(secs => rn - 1)`, i.e. whether the
//                        backlog really comes back out in `createdAt` order.
//   - `volume`         — `generate_series` over `date_trunc('hour', …)`, i.e.
//                        whether an EMPTY hour really arrives as a zero bar.
//   - `deliveries`' free-text search — Postgres `ILIKE` behind Prisma's
//                        `contains: { mode: 'insensitive' }`, plus the relation
//                        filters (`attempts_: { some }`, `ticket: { is }`) the
//                        stub can only approximate.
//
// This file runs all four against the live isolated test database, which is
// what `apps/api` owns the harness for. Webhook rows are written with Prisma
// directly rather than through `webhooks.create`: nothing here decrypts
// `secret`, so going through the encryption envelope would only add an
// `AI_ENCRYPTION_KEY` dependency to a test about SQL.
import { prisma } from '@clickroom/db'
import { appRouter } from '@clickroom/trpc-router'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authService, callAs, cleanupOrg, cleanupUser, makeCtx } from './helpers.js'

const suffix = Date.now().toString(36)

let userId: string
let orgId: string
let projectId: string
let planId: string | null = null

const DEFINITION = {
  version: 1 as const,
  channel: 'contact' as const,
  fields: [{ type: 'email' as const, id: 'email', label: 'Email', required: true }],
  sources: [],
  appearance: { layout: 'launcher' as const, position: 'bottom_right' as const },
  tracking: { identity: true, formAnalytics: true, recentEvents: true, sessionReplay: false },
  routing: { destinations: [], autoReply: false },
  triggers: { showLauncher: true, autoOpen: false },
}

function caller() {
  return appRouter.createCaller(
    makeCtx({ tokenPayload: { sub: userId, sessionId: 'test', orgId } }),
  )
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  return callAs({ userId, orgId, orgRole: 'org_admin' }, fn)
}

/** `support` is entitlement-gated (`feature:support`), which is on from `pro` up. */
async function entitleOrgOnPro(): Promise<void> {
  const existing = await prisma.plan.findUnique({ where: { key: 'pro' } })
  const plan =
    existing ??
    (await prisma.plan.create({
      data: {
        id: `support-pro-${suffix}`,
        key: 'pro',
        name: 'Support Test Pro Plan',
        maxSeats: 25,
        maxFlags: 100,
        maxEventsPerMonth: 1_000_000n,
        maxFlagCallsPerMonth: 5_000_000n,
        allowsOverage: true,
      },
    }))
  // Only tear down a plan this suite created — a seeded `pro` is shared.
  if (!existing) planId = plan.id
  await prisma.org.update({ where: { id: orgId }, data: { planId: plan.id } })
}

async function seedWebhook(id: string, active = true): Promise<string> {
  await prisma.supportWebhook.create({
    data: {
      id: `${id}-${suffix}`,
      projectId,
      url: `https://example.invalid/${id}`,
      name: id,
      secret: 'not-decrypted-by-anything-under-test',
      events: [],
      active,
    },
  })
  return `${id}-${suffix}`
}

let deliverySeq = 0

async function seedDelivery(opts: {
  webhookId: string
  status: 'pending' | 'delivered' | 'failed'
  createdAt: Date
  isTest?: boolean
  event?: string
  ticketId?: string
  lastStatusCode?: number | null
  /** One attempt row per entry; the LAST one is the latency `health`/`stats` read. */
  latencies?: number[]
  /** Body of the LAST attempt — what `deliveries`' free-text search reads. */
  responseBody?: string
  /** Stamped by the retention job when the bodies are NULLed. */
  bodiesPurgedAt?: Date
}): Promise<string> {
  deliverySeq += 1
  const id = `dlv-${suffix}-${deliverySeq.toString().padStart(3, '0')}`
  await prisma.supportWebhookDelivery.create({
    data: {
      id,
      webhookId: opts.webhookId,
      event: opts.event ?? 'ticket.created',
      ticketId: opts.ticketId ?? null,
      payload: {},
      status: opts.status,
      attempts: opts.latencies?.length ?? 0,
      lastStatusCode:
        opts.lastStatusCode === undefined
          ? opts.status === 'delivered'
            ? 200
            : opts.status === 'failed'
              ? 500
              : null
          : opts.lastStatusCode,
      nextAttemptAt: opts.createdAt,
      isTest: opts.isTest ?? false,
      createdAt: opts.createdAt,
    },
  })
  const latencies = opts.latencies ?? []
  for (const [i, latencyMs] of latencies.entries()) {
    const last = i === latencies.length - 1
    await prisma.supportWebhookAttempt.create({
      data: {
        id: `${id}-a${i + 1}`,
        deliveryId: id,
        webhookId: opts.webhookId,
        attempt: i + 1,
        startedAt: opts.createdAt,
        latencyMs,
        responseCode: opts.status === 'delivered' ? 200 : 500,
        outcome: opts.status === 'delivered' ? 'delivered' : 'retryable_http',
        responseBody: last ? (opts.responseBody ?? null) : null,
        bodiesPurgedAt: last ? (opts.bodiesPurgedAt ?? null) : null,
      },
    })
  }
  return id
}

beforeAll(async () => {
  const s = await authService.signup({
    email: `support-webhooks-${suffix}@test.invalid`,
    password: 'password123',
    orgName: `Support Webhooks Org ${suffix}`,
  })
  userId = s.user.id
  orgId = s.org?.id as string
  const project = await prisma.project.findFirstOrThrow({ where: { orgId } })
  projectId = project.id
  await entitleOrgOnPro()
})

afterAll(async () => {
  // Support rows are outside `cleanupOrg`'s reach and SupportForm -> FeatureFlag
  // is a FK, so they have to go first or the org teardown deadlocks on it.
  const webhookIds = (
    await prisma.supportWebhook.findMany({ where: { projectId }, select: { id: true } })
  ).map((w) => w.id)
  await prisma.supportWebhookAttempt.deleteMany({ where: { webhookId: { in: webhookIds } } })
  await prisma.supportWebhookDelivery.deleteMany({ where: { webhookId: { in: webhookIds } } })
  await prisma.supportWebhook.deleteMany({ where: { projectId } })
  await prisma.supportTicketMessage.deleteMany({ where: { ticket: { projectId } } })
  await prisma.supportTicket.deleteMany({ where: { projectId } })
  await prisma.supportForm.deleteMany({ where: { projectId } })
  await cleanupOrg(orgId)
  await cleanupUser(userId)
  if (planId) await prisma.plan.deleteMany({ where: { id: planId } })
  await prisma.$disconnect()
})

// ---------------------------------------------------------------------------
// `affectedForms` — real jsonb containment.
// ---------------------------------------------------------------------------
describe('support.webhooks.affectedForms against live jsonb @>', () => {
  let target: string
  let other: string

  beforeAll(async () => {
    target = await seedWebhook('wh-target')
    other = await seedWebhook('wh-other')

    // Created through the router so the definitions are the real, validated,
    // stored-by-Prisma shape — `routing.destinations` is a jsonb array of
    // objects nested two levels down, which is the whole point of the `path`.
    const create = (name: string, destinations: Array<{ webhookId: string }>) =>
      run(() =>
        caller().support.create({
          projectId,
          name,
          definition: { ...DEFINITION, routing: { destinations, autoReply: false } },
        }),
      )

    await create('Contact us', [{ webhookId: target }])
    await create('Bug report', [{ webhookId: other }])
    await create('Feedback', [])
    await create('Sales', [{ webhookId: other }, { webhookId: target }])

    // A destination carrying keys the current `.strict()` ref schema does not
    // allow. `@>` is PARTIAL containment, so a future additive field on
    // `supportWebhookRefSchema` must not make existing rows stop matching —
    // this is the assertion the in-memory stub cannot make honestly.
    const extra = await create('Escalations', [])
    await prisma.supportForm.update({
      where: { id: extra.id },
      data: {
        definition: {
          ...DEFINITION,
          routing: {
            destinations: [{ webhookId: target, label: 'primary', enabled: true }],
            autoReply: false,
          },
        },
      },
    })

    // A near-miss id. `@>` compares whole jsonb strings, never prefixes.
    const nearMiss = await create('Near miss', [])
    await prisma.supportForm.update({
      where: { id: nearMiss.id },
      data: {
        definition: {
          ...DEFINITION,
          routing: { destinations: [{ webhookId: `${target}-suffix` }], autoReply: false },
        },
      },
    })

    // The id appearing somewhere OTHER than `routing.destinations` must not
    // count — that is what pinning `path` buys.
    const decoy = await create('Decoy', [])
    await prisma.supportForm.update({
      where: { id: decoy.id },
      data: {
        definition: {
          ...DEFINITION,
          routing: { destinations: [], autoReply: false },
          triggers: { showLauncher: true, autoOpen: false, urlMatch: target },
        },
      },
    })

    const archived = await create('Archived', [{ webhookId: target }])
    await run(() => caller().support.delete({ projectId, id: archived.id }))
  })

  it('names every form whose routing contains this webhook, and only those', async () => {
    const rows = await run(() => caller().support.webhooks.affectedForms({ projectId, id: target }))
    expect(rows.map((r) => r.name)).toEqual(['Contact us', 'Sales', 'Escalations'])
  })

  it('matches a destination that carries extra keys (containment, not equality)', async () => {
    const rows = await run(() => caller().support.webhooks.affectedForms({ projectId, id: target }))
    expect(rows.some((r) => r.name === 'Escalations')).toBe(true)
  })

  it('does not match a longer id that merely starts with this one', async () => {
    const rows = await run(() => caller().support.webhooks.affectedForms({ projectId, id: target }))
    expect(rows.some((r) => r.name === 'Near miss')).toBe(false)
  })

  it('does not match the id appearing outside routing.destinations', async () => {
    const rows = await run(() => caller().support.webhooks.affectedForms({ projectId, id: target }))
    expect(rows.some((r) => r.name === 'Decoy')).toBe(false)
  })

  it('excludes soft-deleted forms', async () => {
    const rows = await run(() => caller().support.webhooks.affectedForms({ projectId, id: target }))
    expect(rows.some((r) => r.name === 'Archived')).toBe(false)
  })

  it('returns nothing for a webhook no form routes to', async () => {
    const unused = await seedWebhook('wh-unused')
    const rows = await run(() => caller().support.webhooks.affectedForms({ projectId, id: unused }))
    expect(rows).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// `health` — row_number() window, FILTER count, percentile_disc.
// ---------------------------------------------------------------------------
describe('support.webhooks.health raw SQL', () => {
  let hook: string
  const base = new Date('2026-03-01T00:00:00.000Z')
  const at = (minutes: number) => new Date(base.getTime() + minutes * 60_000)

  beforeAll(async () => {
    hook = await seedWebhook('wh-health')
    // 25 deliveries. The OLDEST five are failures, so a rollup that forgets
    // `rn <= 20` reports 5 failures ('degraded') instead of 0 ('healthy').
    for (let i = 0; i < 25; i += 1) {
      await seedDelivery({
        webhookId: hook,
        status: i < 5 ? 'failed' : 'delivered',
        createdAt: at(i),
        latencies: [100 + i],
      })
    }
  })

  it('considers only the last 20 deliveries, so an aged failure streak ages out', async () => {
    const rows = await run(() => caller().support.webhooks.health({ projectId }))
    const row = rows.find((r) => r.webhookId === hook)
    expect(row).toBeDefined()
    expect(row?.considered).toBe(20)
    expect(row?.failures).toBe(0)
    expect(row?.health).toBe('healthy')
    expect(row?.lastDeliveryAt?.toISOString()).toBe(at(24).toISOString())
  })

  it('reads p95 off the LAST attempt of each delivery, not the first', async () => {
    const retried = await seedWebhook('wh-health-retry')
    // A delivery that failed fast and then succeeded slowly. The latency the
    // customer actually saw is 9000; reading `attempt = 1` would say 5.
    await seedDelivery({
      webhookId: retried,
      status: 'delivered',
      createdAt: at(0),
      latencies: [5, 9_000],
    })
    const rows = await run(() => caller().support.webhooks.health({ projectId }))
    const row = rows.find((r) => r.webhookId === retried)
    // percentile_disc returns a value that is actually IN the set, never an
    // interpolation between the two attempts.
    expect(row?.considered).toBe(1)
    expect(row?.p95LatencyMs).toBe(9_000)
    // Still `healthy`: <= 1 failure wins BEFORE the latency clause, so one slow
    // delivery does not by itself degrade an endpoint.
    expect(row?.health).toBe('healthy')
  })

  it('degrades a slow endpoint once it also has failures', async () => {
    const slow = await seedWebhook('wh-health-slow')
    for (let i = 0; i < 4; i += 1) {
      await seedDelivery({
        webhookId: slow,
        status: i < 2 ? 'failed' : 'delivered',
        createdAt: at(i),
        latencies: [3_001],
      })
    }
    const rows = await run(() => caller().support.webhooks.health({ projectId }))
    const row = rows.find((r) => r.webhookId === slow)
    expect(row).toMatchObject({
      considered: 4,
      failures: 2,
      p95LatencyMs: 3_001,
      health: 'degraded',
    })
  })

  it('excludes test deliveries, so Send test cannot drag a live endpoint down', async () => {
    const quiet = await seedWebhook('wh-testonly')
    for (let i = 0; i < 10; i += 1) {
      await seedDelivery({
        webhookId: quiet,
        status: 'failed',
        createdAt: at(i),
        isTest: true,
        latencies: [50],
      })
    }
    const rows = await run(() => caller().support.webhooks.health({ projectId }))
    // No row at all — every delivery it has is a test, and the caller renders a
    // missing entry as `idle`.
    expect(rows.some((r) => r.webhookId === quiet)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// `stats` — FILTER aggregates over a user-chosen window.
// ---------------------------------------------------------------------------
describe('support.webhooks.stats raw SQL', () => {
  let hook: string
  const inWindow = new Date('2026-03-10T12:00:00.000Z')
  const outOfWindow = new Date('2026-02-01T12:00:00.000Z')

  beforeAll(async () => {
    hook = await seedWebhook('wh-stats')
    await seedDelivery({
      webhookId: hook,
      status: 'delivered',
      createdAt: inWindow,
      latencies: [10],
    })
    await seedDelivery({
      webhookId: hook,
      status: 'delivered',
      createdAt: inWindow,
      latencies: [4_000],
    })
    await seedDelivery({ webhookId: hook, status: 'failed', createdAt: inWindow, latencies: [700] })
    // Never terminal — must stay out of the success-rate denominator entirely.
    await seedDelivery({ webhookId: hook, status: 'pending', createdAt: inWindow })
    // Outside the window, and a test: neither may be counted.
    await seedDelivery({
      webhookId: hook,
      status: 'failed',
      createdAt: outOfWindow,
      latencies: [1],
    })
    await seedDelivery({
      webhookId: hook,
      status: 'failed',
      createdAt: inWindow,
      isTest: true,
      latencies: [1],
    })
  })

  it('counts only terminal, non-test deliveries inside the window', async () => {
    const stats = await run(() =>
      caller().support.webhooks.stats({
        projectId,
        webhookId: hook,
        from: '2026-03-01T00:00:00.000Z',
        to: '2026-03-31T00:00:00.000Z',
      }),
    )
    expect(stats.failed).toBe(1)
    expect(stats.successRate).toBeCloseTo(2 / 3, 6)
    expect(stats.p95LatencyMs).toBe(4_000)
    // The window is entirely in the past, so the "(24h)" card is 0 — and it is
    // deliberately NOT scoped by from/to, which is what makes that true.
    expect(stats.delivered24h).toBe(0)
  })

  it('an unbounded call sees the out-of-window row too', async () => {
    const stats = await run(() => caller().support.webhooks.stats({ projectId, webhookId: hook }))
    expect(stats.failed).toBe(2)
    expect(stats.successRate).toBeCloseTo(0.5, 6)
  })

  it('reports 0 rather than NaN when nothing is terminal yet', async () => {
    const fresh = await seedWebhook('wh-stats-fresh')
    await seedDelivery({ webhookId: fresh, status: 'pending', createdAt: inWindow })
    const stats = await run(() => caller().support.webhooks.stats({ projectId, webhookId: fresh }))
    expect(stats).toMatchObject({ delivered24h: 0, failed: 0, successRate: 0, p95LatencyMs: null })
  })
})

// ---------------------------------------------------------------------------
// `reEnableAndReplay` — the stagger, executed by Postgres.
// ---------------------------------------------------------------------------
describe('support.webhooks.reEnableAndReplay stagger', () => {
  it('spreads the pending backlog one second apart in createdAt order', async () => {
    const hook = await seedWebhook('wh-replay', false)
    await prisma.supportWebhook.update({
      where: { id: hook },
      data: { autoDisabledAt: new Date(), consecutiveFailures: 20 },
    })

    // Seeded newest-first so a stagger keyed off insertion order (or off `id`)
    // comes out backwards and this test fails.
    const order = ['2026-04-04', '2026-04-01', '2026-04-03', '2026-04-02']
    const ids: string[] = []
    for (const day of order) {
      ids.push(
        await seedDelivery({
          webhookId: hook,
          status: 'pending',
          createdAt: new Date(`${day}T00:00:00.000Z`),
        }),
      )
    }
    // A terminal row must not be dragged back into the queue.
    const failed = await seedDelivery({
      webhookId: hook,
      status: 'failed',
      createdAt: new Date('2026-04-05T00:00:00.000Z'),
      latencies: [10],
    })
    const failedBefore = await prisma.supportWebhookDelivery.findUniqueOrThrow({
      where: { id: failed },
    })

    const res = await run(() =>
      caller().support.webhooks.reEnableAndReplay({ projectId, id: hook }),
    )
    expect(res).toMatchObject({ id: hook, active: true, replayed: 4 })

    const webhook = await prisma.supportWebhook.findUniqueOrThrow({ where: { id: hook } })
    expect(webhook.active).toBe(true)
    expect(webhook.autoDisabledAt).toBeNull()
    expect(webhook.consecutiveFailures).toBe(0)

    const rows = await prisma.supportWebhookDelivery.findMany({
      where: { id: { in: ids } },
      orderBy: { nextAttemptAt: 'asc' },
    })
    // Draining order must be creation order, not the order they were written.
    expect(rows.map((r) => r.createdAt.toISOString().slice(0, 10))).toEqual([
      '2026-04-01',
      '2026-04-02',
      '2026-04-03',
      '2026-04-04',
    ])
    // ...and exactly one second apart, so the worker's `ORDER BY nextAttemptAt`
    // has something to order by instead of a four-way `now()` tie.
    const gaps = rows
      .slice(1)
      .map((r, i) => r.nextAttemptAt.getTime() - rows[i].nextAttemptAt.getTime())
    expect(gaps).toEqual([1_000, 1_000, 1_000])
    expect(rows.every((r) => r.attempts === 0)).toBe(true)

    const failedAfter = await prisma.supportWebhookDelivery.findUniqueOrThrow({
      where: { id: failed },
    })
    expect(failedAfter.status).toBe('failed')
    expect(failedAfter.nextAttemptAt.getTime()).toBe(failedBefore.nextAttemptAt.getTime())
  })
})

// ---------------------------------------------------------------------------
// `volume` — generate_series buckets. The one thing a stub cannot show is that
// an hour with NO deliveries still comes back as a row.
// ---------------------------------------------------------------------------
describe('support.webhooks.volume hourly buckets', () => {
  let hook: string
  /** Top of the hour, N hours ago — the default window is `now()`-relative. */
  const hoursAgo = (n: number) => {
    const d = new Date()
    d.setUTCMinutes(30, 0, 0)
    return new Date(d.getTime() - n * 3_600_000)
  }

  beforeAll(async () => {
    hook = await seedWebhook('wh-volume')
    await seedDelivery({ webhookId: hook, status: 'delivered', createdAt: hoursAgo(3) })
    await seedDelivery({ webhookId: hook, status: 'delivered', createdAt: hoursAgo(3) })
    await seedDelivery({ webhookId: hook, status: 'failed', createdAt: hoursAgo(3) })
    // Never terminal — neither a delivered nor a failed segment.
    await seedDelivery({ webhookId: hook, status: 'pending', createdAt: hoursAgo(3) })
    // A Send test burst must not paint an incident window that never happened.
    await seedDelivery({ webhookId: hook, status: 'failed', createdAt: hoursAgo(2), isTest: true })
  })

  it('returns 24 contiguous buckets by default, including the empty hours', async () => {
    const buckets = await run(() =>
      caller().support.webhooks.volume({ projectId, webhookId: hook }),
    )
    // The chart draws 24 bars unconditionally: an hour missing from this array
    // would shift every bar after it.
    expect(buckets).toHaveLength(24)
    const gaps = buckets
      .slice(1)
      .map((b, i) => b.hourStart.getTime() - buckets[i].hourStart.getTime())
    expect(new Set(gaps)).toEqual(new Set([3_600_000]))
    // Every bucket is on an hour boundary.
    expect(buckets.every((b) => b.hourStart.getUTCMinutes() === 0)).toBe(true)
    expect(buckets.some((b) => b.delivered === 0 && b.failed === 0)).toBe(true)
  })

  it('stacks delivered and failed in the right hour and excludes tests and pendings', async () => {
    const buckets = await run(() =>
      caller().support.webhooks.volume({ projectId, webhookId: hook }),
    )
    const hour = (n: number) => {
      const at = hoursAgo(n)
      at.setUTCMinutes(0, 0, 0)
      return buckets.find((b) => b.hourStart.getTime() === at.getTime())
    }
    expect(hour(3)).toMatchObject({ delivered: 2, failed: 1 })
    // The only delivery two hours ago is a test.
    expect(hour(2)).toMatchObject({ delivered: 0, failed: 0 })
  })

  it('honours an explicit window and clamps a window wider than the chart can draw', async () => {
    const to = new Date()
    const narrow = await run(() =>
      caller().support.webhooks.volume({
        projectId,
        webhookId: hook,
        from: new Date(to.getTime() - 3 * 3_600_000).toISOString(),
        to: to.toISOString(),
      }),
    )
    expect(narrow).toHaveLength(4)

    // A pasted URL carrying a year-wide range must not ask Postgres for 8760
    // rows; the series is clamped to VOLUME_MAX_BUCKETS (168).
    const wide = await run(() =>
      caller().support.webhooks.volume({
        projectId,
        webhookId: hook,
        from: new Date(to.getTime() - 365 * 24 * 3_600_000).toISOString(),
        to: to.toISOString(),
      }),
    )
    expect(wide).toHaveLength(168)
  })

  it('404s for a webhook in another project', async () => {
    await expect(
      run(() => caller().support.webhooks.volume({ projectId, webhookId: 'wh-nope' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

// ---------------------------------------------------------------------------
// `deliveries` free-text search — real ILIKE and real relation filters.
// ---------------------------------------------------------------------------
describe('support.webhooks.deliveries search against live Postgres', () => {
  let hook: string
  let ticketId: string
  const at = new Date('2026-05-01T00:00:00.000Z')

  beforeAll(async () => {
    hook = await seedWebhook('wh-search')
    const form = await run(() =>
      caller().support.create({
        projectId,
        name: `Search form ${suffix}`,
        definition: DEFINITION,
      }),
    )
    ticketId = `tkt-${suffix}`
    await prisma.supportTicket.create({
      data: {
        id: ticketId,
        formId: form.id,
        projectId,
        number: 4823,
        distinctId: 'anon-1',
        status: 'open',
        priority: 'normal',
        category: 'general',
        subject: 'Checkout is broken',
        token: `tok-${suffix}`,
        fields: {},
        context: {},
      },
    })

    await seedDelivery({
      webhookId: hook,
      status: 'failed',
      createdAt: at,
      ticketId,
      latencies: [120],
      responseBody: '{"error":"Signature MISMATCH"}',
    })
    await seedDelivery({
      webhookId: hook,
      status: 'delivered',
      createdAt: at,
      latencies: [80],
      responseBody: '{"ok":true}',
    })
    // 30 days old: the retention job nulled the body and stamped the marker.
    // It CANNOT match a body search however well it once would have.
    await seedDelivery({
      webhookId: hook,
      status: 'failed',
      createdAt: at,
      latencies: [95],
      responseBody: undefined,
      bodiesPurgedAt: at,
    })
  })

  const search = (term: string) =>
    run(() => caller().support.webhooks.deliveries({ projectId, webhookId: hook, search: term }))

  it('matches a response body case-insensitively, by substring', async () => {
    const res = await search('signature mismatch')
    expect(res.items).toHaveLength(1)
    expect(res.items[0].lastStatusCode).toBe(500)
    // Prisma's `mode: 'insensitive'` really is lowering to ILIKE — an exact-case
    // match must not be the only thing that works.
    expect((await search('MISMATCH')).items).toHaveLength(1)
    expect((await search('mismatch')).items).toHaveLength(1)
  })

  it('matches the ticket id exactly and the ticket number with or without #', async () => {
    expect((await search(ticketId)).items).toHaveLength(1)
    expect((await search('4823')).items).toHaveLength(1)
    expect((await search('#4823')).items).toHaveLength(1)
    // Ids are exact — a prefix is not a match.
    expect((await search(ticketId.slice(0, 8))).items).toHaveLength(0)
  })

  it('cannot match a purged body, and says how many rows are in that state', async () => {
    const res = await search('signature')
    expect(res.items).toHaveLength(1)
    // One delivery in this view has had its bodies purged, so the page can say
    // the search is not exhaustive rather than implying a clean "no results".
    expect(res.search).toMatchObject({ term: 'signature', purgedDeliveries: 1, retentionDays: 30 })
    expect(res.counts.all).toBe(1)
  })

  it('exports the same filtered set as CSV, not just the page', async () => {
    const res = await run(() =>
      caller().support.webhooks.exportCsv({ projectId, webhookId: hook, search: 'mismatch' }),
    )
    expect(res.rowCount).toBe(1)
    expect(res.capped).toBe(false)
    expect(res.csv).toContain('4823')
    expect(res.csv).toContain('Checkout is broken')
    // Bodies are deliberately NOT columns — the export is the index of a
    // failure window, not a second copy of the PII the retention job purges.
    expect(res.csv).not.toContain('MISMATCH')
  })
})
