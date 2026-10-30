import { defineConfig } from 'vitest/config'

// Only the pure unit tests live in this package (`trpc/routers/experiments.stats.test.ts`
// — deterministic Monte-Carlo math, no I/O). Everything that needs a live
// Postgres/ClickHouse/Redis still runs from `apps/api`, which owns the
// integration harness (`src/test/vitest.globalSetup.ts`, isolated test DBs).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Existing suites assert hosted (plan-gated) behaviour; self_host suites set their own.
    env: { CLICKROOM_DEPLOYMENT: 'cloud' },
  },
})
