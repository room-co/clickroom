import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Load the monorepo-root .env (DATABASE_URL, TEST_DATABASE_URL, etc.) so the
// behavioral integration test can reach an isolated test Postgres, not the
// live dev one (DATABASE_URL below is overridden to TEST_DATABASE_URL). Parsed
// by hand to avoid a direct `vite`/`dotenv` dependency (not hoisted under
// pnpm's strict layout).
function loadRootEnv(): Record<string, string> {
  const path = fileURLToPath(new URL('../../.env', import.meta.url))
  const env: Record<string, string> = {}
  try {
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      env[key] = value
    }
  } catch {
    // No .env — the behavioral test will skip gracefully.
  }
  return env
}

const rootEnv = loadRootEnv()

export default defineConfig({
  test: {
    // `tsc` compiles `src/**` into `dist/**` too, so without this every suite runs
    // twice — once from source, once from its stale compiled copy — as soon as
    // anything has built `dist/` (Docker, turbo, CI). The two copies then race on
    // shared Postgres fixtures and collide on unique constraints. Same exclude as
    // apps/api and packages/clickhouse.
    exclude: ['**/node_modules/**', '**/dist/**'],
    env: {
      ...rootEnv,
      // Existing suites assert the hosted (plan-gated) behaviour; self_host-specific
      // suites flip this per case. Production default is `self_host`.
      CLICKROOM_DEPLOYMENT: 'cloud',
      DATABASE_URL: rootEnv.TEST_DATABASE_URL ?? '',
    },
  },
})
