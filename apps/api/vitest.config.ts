import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Load the monorepo-root .env (DATABASE_URL, JWT_SECRET, TEST_DATABASE_URL, ...)
// so the integration tests can reach an isolated test database, not the live
// dev one. Hand-parsed to avoid a direct dotenv dependency (not hoisted under
// pnpm's strict layout). Also mirrored onto the real process.env so
// `globalSetup` (which runs in this same process) can read TEST_DATABASE_URL /
// TEST_CLICKHOUSE_DATABASE before the test workers start.
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
    // No .env — integration tests will fail fast on the missing DATABASE_URL.
  }
  return env
}

const rootEnv = loadRootEnv()
Object.assign(process.env, rootEnv)

export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: './src/test/vitest.globalSetup.ts',
    // `tsc` compiles `src/test/**` into `dist/test/**` too, so without this
    // every suite runs twice — once from source, once from its stale compiled
    // copy — as soon as anything has built `dist/` (Docker, turbo, CI).
    exclude: ['**/node_modules/**', '**/dist/**'],
    env: {
      ...rootEnv,
      // Existing suites assert the hosted (plan-gated) behaviour; self_host-specific
      // suites flip this per case. Production default is `self_host`.
      CLICKROOM_DEPLOYMENT: 'cloud',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
      CLICKHOUSE_DATABASE: process.env.TEST_CLICKHOUSE_DATABASE ?? '',
    },
  },
})
