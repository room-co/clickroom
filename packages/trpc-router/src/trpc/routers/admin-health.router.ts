import { buildOrgEventUsage, buildOrgFlagCallUsage, clickhouse } from '@clickroom/clickhouse'
import { effectiveLimits, prisma } from '@clickroom/db'
import { adminProcedure, router } from '../trpc.js'

// Read-only operator health dashboard: every signal here
// is read through state that already exists in the repo (ClickHouse itself,
// its own migration tracker, Postgres) — no new observability, no new
// metrics pipeline, no Datadog/Grafana integration (/. Every field
// degrades to a status/null rather than throwing, so one dead dependency
// (e.g. ClickHouse down) doesn't blank the whole page — the point of a
// health screen is to show exactly what's broken.

export interface ClickHouseHealth {
  reachable: boolean
  /** Round-trip latency of the reachability probe, ms. `null` when unreachable. */
  latencyMs: number | null
  error: string | null
}

export interface AppliedMigration {
  name: string
  appliedAt: string
}

export interface QuotaBreach {
  orgId: string
  orgName: string
  metric: 'events' | 'flagCalls'
  used: number
  limit: number
}

export interface AdminHealthSummary {
  clickhouse: ClickHouseHealth
  /** `null` when the migrations query itself failed (e.g. ClickHouse unreachable) rather than an empty repo. */
  appliedMigrations: AppliedMigration[] | null
  /**
   * Ingest consumer lag/backlog. There is no existing readable signal for this from
   * Node/TS today — `services/ingest` (Rust/Axum) exposes no lag metric to Postgres,
   * ClickHouse, or NATS management API that this router can read without standing up
   * new instrumentation, which is explicitly out of scope for this phase (/.
   * Stubbed `status: 'unknown'` rather than fabricated.
   */
  ingestBacklog: { status: 'unknown'; note: string }
  /**
   * NATS connectivity. Same caveat as ingestBacklog: no existing NATS client or health
   * check is reachable from apps/api / this Node/TS router — capture/ingest's NATS
   * client lives only inside the Rust services. Stubbed rather than building new
   * instrumentation.
   */
  nats: { status: 'unknown'; note: string }
  failedWebhookDeliveries: number
  orgsOverQuota: QuotaBreach[]
}

/** `SELECT 1`-equivalent reachability probe against the shared ClickHouse client. */
async function checkClickHouse(): Promise<ClickHouseHealth> {
  const start = Date.now()
  try {
    await clickhouse.query({ query: 'SELECT 1', format: 'JSONEachRow' })
    return { reachable: true, latencyMs: Date.now() - start, error: null }
  } catch (err) {
    return {
      reachable: false,
      latencyMs: null,
      error: err instanceof Error ? err.message : 'unknown error',
    }
  }
}

/**
 * Most-recently-applied migrations from `schema_migrations` (the tracking table
 * `packages/clickhouse/src/migrate.ts` writes to — see `recordMigrationApplied`).
 * Returns `null` (not `[]`) on query failure so the caller can distinguish "no
 * migrations recorded" from "couldn't ask" (e.g. ClickHouse unreachable, or the
 * tracking table doesn't exist yet on a never-migrated database).
 */
async function listAppliedMigrations(limit = 50): Promise<AppliedMigration[] | null> {
  try {
    const rs = await clickhouse.query({
      query: `SELECT name, applied_at FROM schema_migrations ORDER BY applied_at DESC LIMIT {limit:UInt32}`,
      query_params: { limit },
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ name: string; applied_at: string }>()
    return rows.map((r) => ({ name: r.name, appliedAt: r.applied_at }))
  } catch {
    return null
  }
}

/** Count of `SupportWebhookDelivery` rows currently `status: 'failed'` (delivery tracking). Excludes `isTest` sends, matching the schema's own note that test pings stay out of the health rollup. */
async function countFailedWebhookDeliveries(): Promise<number> {
  return prisma.supportWebhookDelivery.count({ where: { status: 'failed', isTest: false } })
}

/** [monthStart, monthEnd) for the current UTC calendar month — mirrors usage.router.ts's `currentUtcMonthRange`. */
function currentUtcMonthRange(now = new Date()): { monthStart: Date; monthEnd: Date } {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return { monthStart, monthEnd }
}

async function chCount(builtQuery: ReturnType<typeof buildOrgEventUsage>): Promise<number> {
  const rs = await clickhouse.query({ ...builtQuery, format: 'JSONEachRow' })
  const rows = await rs.json<{ count: string }>()
  return Number(rows[0]?.count ?? 0)
}

/**
 * Every org whose current-month event OR flag-call volume is at/over its
 * effective quota (`effectiveLimits` — override-or-plan, same resolution the
 * tenant-facing usage router and capture-rs's hot-path gate both use). Reuses
 * `admin.usage`'s per-org volume pattern (`usage.router.ts`): per-org
 * project-id fan-out into `buildOrgEventUsage`/`buildOrgFlagCallUsage`.
 * Orgs with no projects (zero usage) and orgs with no plan and no overrides
 * (`effectiveLimits` fails closed to 0 limits) are skipped — a 0/0 org is not
 * a breach worth surfacing on a health screen.
 */
async function findOrgsOverQuota(): Promise<QuotaBreach[]> {
  const orgs = await prisma.org.findMany({
    select: {
      id: true,
      name: true,
      maxSeatsOverride: true,
      maxFlagsOverride: true,
      maxEventsPerMonthOverride: true,
      maxFlagCallsPerMonthOverride: true,
      overagePolicy: true,
      plan: {
        select: {
          maxSeats: true,
          maxFlags: true,
          maxEventsPerMonth: true,
          maxFlagCallsPerMonth: true,
        },
      },
      projects: { select: { id: true } },
    },
  })

  const { monthStart, monthEnd } = currentUtcMonthRange()

  const breaches = await Promise.all(
    orgs.map(async (org): Promise<QuotaBreach[]> => {
      const projectIds = org.projects.map((p) => p.id)
      if (projectIds.length === 0) return []

      const limits = effectiveLimits(org, org.plan)
      const maxEventsPerMonth = Number(limits.maxEventsPerMonth)
      const maxFlagCallsPerMonth = Number(limits.maxFlagCallsPerMonth)
      if (maxEventsPerMonth <= 0 && maxFlagCallsPerMonth <= 0) return []

      const [eventsUsed, flagCallsUsed] = await Promise.all([
        chCount(buildOrgEventUsage({ projectIds, monthStart, monthEnd })),
        chCount(buildOrgFlagCallUsage({ projectIds, monthStart, monthEnd })),
      ])

      const orgBreaches: QuotaBreach[] = []
      if (maxEventsPerMonth > 0 && eventsUsed >= maxEventsPerMonth) {
        orgBreaches.push({
          orgId: org.id,
          orgName: org.name,
          metric: 'events',
          used: eventsUsed,
          limit: maxEventsPerMonth,
        })
      }
      if (maxFlagCallsPerMonth > 0 && flagCallsUsed >= maxFlagCallsPerMonth) {
        orgBreaches.push({
          orgId: org.id,
          orgName: org.name,
          metric: 'flagCalls',
          used: flagCallsUsed,
          limit: maxFlagCallsPerMonth,
        })
      }
      return orgBreaches
    }),
  )

  return breaches.flat()
}

export const adminHealthRouter = router({
  summary: adminProcedure.query(async (): Promise<AdminHealthSummary> => {
    const [chHealth, appliedMigrations, failedWebhookDeliveries, orgsOverQuota] = await Promise.all(
      [
        checkClickHouse(),
        listAppliedMigrations(),
        countFailedWebhookDeliveries(),
        findOrgsOverQuota(),
      ],
    )

    return {
      clickhouse: chHealth,
      appliedMigrations,
      ingestBacklog: {
        status: 'unknown',
        note: 'No readable lag/backlog signal exists from services/ingest (Rust) today — would require new instrumentation, out of scope.',
      },
      nats: {
        status: 'unknown',
        note: 'No NATS client/health check is reachable from apps/api or this router today — the NATS client lives only inside the Rust capture/ingest services.',
      },
      failedWebhookDeliveries,
      orgsOverQuota,
    }
  }),
})
