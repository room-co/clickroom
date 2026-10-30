import { describe, expect, it, vi } from 'vitest'
import {
  checkReadiness,
  type DependencyChecks,
  HealthController,
  sanitizeError,
} from '../health.controller.js'

/** Minimal express `Response` stand-in capturing status + body. */
function fakeRes() {
  const captured: { status?: number; body?: unknown } = {}
  const res = {
    status(code: number) {
      captured.status = code
      return res
    },
    json(body: unknown) {
      captured.body = body
      return res
    },
  }
  return { res, captured }
}

const allUp: DependencyChecks = {
  postgres: async () => [{ '?column?': 1 }],
  redis: async () => 'PONG',
  clickhouse: async () => undefined,
}

describe('liveness /health', () => {
  it('is dependency-free and always ok while the process runs', () => {
    const controller = new HealthController()
    // Even with every dependency wired to a failing check, liveness stays ok:
    // a DB blip must not trigger a restart storm.
    controller.checks = {
      postgres: async () => {
        throw new Error('down')
      },
    }
    expect(controller.health()).toEqual({ status: 'ok' })
  })
})

describe('checkReadiness', () => {
  it('reports ok when every dependency answers', async () => {
    await expect(checkReadiness(allUp)).resolves.toEqual({
      status: 'ok',
      checks: { postgres: 'ok', redis: 'ok', clickhouse: 'ok' },
    })
  })

  it('marks only the failing dependency and degrades overall status', async () => {
    const report = await checkReadiness({
      ...allUp,
      clickhouse: async () => {
        throw new Error('connect ECONNREFUSED 10.0.1.5:8123')
      },
    })

    expect(report.status).toBe('degraded')
    expect(report.checks.postgres).toBe('ok')
    expect(report.checks.redis).toBe('ok')
    expect(report.checks.clickhouse).toBe('error: connect ECONNREFUSED 10.0.1.5:8123')
  })

  it('runs the checks in parallel', async () => {
    const started: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const checks: DependencyChecks = {
      postgres: async () => {
        started.push('postgres')
        await gate
      },
      redis: async () => {
        started.push('redis')
        await gate
      },
    }

    const pending = checkReadiness(checks)
    await Promise.resolve()
    expect(started).toEqual(['postgres', 'redis'])
    release()
    await expect(pending).resolves.toMatchObject({ status: 'ok' })
  })

  it('times a hung dependency out instead of hanging the probe', async () => {
    vi.useFakeTimers()
    try {
      const pending = checkReadiness(
        { postgres: () => new Promise(() => {}), redis: async () => 'PONG' },
        2_000,
      )
      await vi.advanceTimersByTimeAsync(2_000)
      const report = await pending
      expect(report.status).toBe('degraded')
      expect(report.checks.postgres).toBe('error: timed out after 2000ms')
      expect(report.checks.redis).toBe('ok')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('readiness /ready', () => {
  it('returns 200 when all dependencies are up', async () => {
    const controller = new HealthController()
    controller.checks = allUp
    const { res, captured } = fakeRes()

    await controller.ready(res as never)

    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({
      status: 'ok',
      checks: { postgres: 'ok', redis: 'ok', clickhouse: 'ok' },
    })
  })

  it('returns 503 with the failing dependency named when one is down', async () => {
    const controller = new HealthController()
    controller.checks = {
      ...allUp,
      postgres: async () => {
        throw new Error("Can't reach database server at 127.0.0.1:5432")
      },
    }
    const { res, captured } = fakeRes()

    await controller.ready(res as never)

    expect(captured.status).toBe(503)
    expect(captured.body).toEqual({
      status: 'degraded',
      checks: {
        postgres: "error: Can't reach database server at 127.0.0.1:5432",
        redis: 'ok',
        clickhouse: 'ok',
      },
    })
  })
})

describe('sanitizeError', () => {
  it('redacts connection strings so credentials never reach the response body', () => {
    const err = new Error(
      'failed to connect to postgresql://clickroom:hunter2@db.internal:5432/clickroom',
    )
    expect(sanitizeError(err)).toBe('failed to connect to [redacted]')
  })

  it('keeps only the first line, dropping any stack-trace-shaped tail', () => {
    const err = new Error('ECONNREFUSED\n    at Socket.emit (node:events:517:28)\n    at ...')
    expect(sanitizeError(err)).toBe('ECONNREFUSED')
  })

  it('caps very long messages', () => {
    expect(sanitizeError(new Error('x'.repeat(500)))).toHaveLength(160)
  })

  it('handles non-Error throws', () => {
    expect(sanitizeError(undefined)).toBe('unknown error')
  })
})
