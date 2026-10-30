import { clickhouse } from '@clickroom/clickhouse'
import { prisma } from '@clickroom/db'
import { redis } from '@clickroom/trpc-router/lib/redis.js'
import { Controller, Get, Res } from '@nestjs/common'
import type { Response } from 'express'

/**
 * Per-dependency timeout. Kept short so a hung dependency (a TCP connect that
 * never completes, a Postgres that accepts the socket but never answers) fails
 * the readiness probe fast instead of hanging until the ALB's own timeout.
 * Checks run in parallel, so the whole probe is bounded by this, not by N * this.
 */
export const CHECK_TIMEOUT_MS = 2_000

/** A dependency probe: resolves if the dependency answered, rejects/throws otherwise. */
export type DependencyCheck = () => Promise<unknown>
export type DependencyChecks = Record<string, DependencyCheck>

/** `'ok'` or `'error: <sanitized message>'` per dependency. */
export type ReadinessReport = {
  status: 'ok' | 'degraded'
  checks: Record<string, string>
}

/**
 * The dependencies the api genuinely cannot serve a request without.
 *
 * Postgres is the control plane (auth, orgs, flags); ClickHouse backs every
 * analytics read; Redis backs the flag/quota caches and the MCP OAuth code store.
 * A task that cannot reach one of these must never enter the ALB's rotation —
 * that blind spot is exactly how three prod-breaking bugs shipped "green".
 */
export const defaultChecks: DependencyChecks = {
  postgres: () => prisma.$queryRaw`SELECT 1`,
  redis: () => redis.ping(),
  clickhouse: async () => {
    const rs = await clickhouse.query({ query: 'SELECT 1', format: 'JSONEachRow' })
    // Drain the response — the HTTP request isn't really complete until we do.
    await rs.text()
  },
}

/** Matches anything that looks like a connection string, with or without credentials. */
const CONNECTION_STRING = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi

/**
 * Health check bodies are served unauthenticated to the ALB and to anything else
 * that can reach the task, so they must never carry a DSN, a password, or a stack
 * trace. Keep the first line of the message only, redact anything URL-shaped, and
 * cap the length.
 */
export function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown error'
  const firstLine = raw.split('\n', 1)[0] ?? 'unknown error'
  const redacted = firstLine.replace(CONNECTION_STRING, '[redacted]').trim()
  const message = redacted.length > 0 ? redacted : 'unknown error'
  return message.length > 160 ? `${message.slice(0, 157)}...` : message
}

/** Reject with a timeout error if `check` hasn't settled within `timeoutMs`. */
async function withTimeout(check: DependencyCheck, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
    // Don't keep the event loop alive on the loser of the race.
    timer.unref?.()
  })
  try {
    await Promise.race([check(), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Ping every dependency in parallel and report per-dependency status.
 * `status` is `'ok'` only when every check passed.
 */
export async function checkReadiness(
  checks: DependencyChecks = defaultChecks,
  timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<ReadinessReport> {
  const entries = Object.entries(checks)
  const results = await Promise.all(
    entries.map(async ([name, check]) => {
      try {
        await withTimeout(check, timeoutMs)
        return [name, 'ok'] as const
      } catch (err) {
        return [name, `error: ${sanitizeError(err)}`] as const
      }
    }),
  )

  const report: Record<string, string> = {}
  for (const [name, result] of results) report[name] = result
  const healthy = results.every(([, result]) => result === 'ok')
  return { status: healthy ? 'ok' : 'degraded', checks: report }
}

@Controller()
export class HealthController {
  /** Seam for tests — overridden with fakes so the suite needs no real infra. */
  checks: DependencyChecks = defaultChecks

  /**
   * Liveness. Deliberately dependency-free: it answers "is this process still
   * running and able to serve HTTP?", which is the only question a *restart*
   * decision should turn on. Touching Postgres here would turn a DB blip into a
   * cluster-wide restart storm. Readiness — not liveness — gates traffic.
   */
  @Get('health')
  health(): { status: string } {
    return { status: 'ok' }
  }

  /**
   * Readiness. Actually pings Postgres, Redis and ClickHouse; 200 only if all
   * answered, 503 + per-dependency breakdown otherwise. This is what the ALB
   * target group probes, so a task that cannot reach its dependencies never goes
   * into service instead of serving 500s while reporting healthy.
   */
  @Get('ready')
  async ready(@Res() res: Response): Promise<void> {
    const report = await checkReadiness(this.checks)
    if (report.status !== 'ok') {
      // The ALB discards the body, so a failing probe is otherwise invisible: the task
      // logs a clean boot, the service events only say "unhealthy", and the deploy stalls
      // with no record of *which* dependency was unreachable.
      const failed = Object.entries(report.checks)
        .filter(([, result]) => result !== 'ok')
        .map(([name, result]) => `${name}: ${result}`)
        .join('; ')
      console.error(`[readiness] degraded — ${failed}`)
    }
    res.status(report.status === 'ok' ? 200 : 503).json(report)
  }
}
