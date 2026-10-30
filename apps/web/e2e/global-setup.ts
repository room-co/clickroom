import { e2eEnv } from './helpers/env'

const HEALTH_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 1_000

/**
 * Fail fast, with a clear message, if the e2e API stack isn't up yet —
 * otherwise every spec would fail one-by-one with opaque connection-refused
 * errors. Run `make up:e2e` (see .env.e2e) before `pnpm test:e2e`.
 */
export default async function globalSetup(): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS

  for (;;) {
    try {
      const res = await fetch(`${e2eEnv.apiUrl}/health`)
      if (res.ok) return
    } catch {
      // API not reachable yet — keep polling until the deadline.
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `e2e API not reachable at :3100 — did you run 'make up:e2e'? (waited ${HEALTH_TIMEOUT_MS}ms)`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}
