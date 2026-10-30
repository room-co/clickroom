// Single source of truth for e2e environment config: service URLs, ClickHouse
// connection info, and the fixed seed identities from
// `packages/db/src/seed.e2e.ts` / `.env.e2e`. Load this module (directly or
// transitively) before anything that reads `process.env.DATABASE_URL` at
// import time (e.g. `@clickroom/db`'s `PrismaClient` — see `helpers/db.ts`).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

// apps/web/e2e/helpers -> apps/web/e2e -> apps/web -> apps -> repo root.
// `apps/web` is ESM ("type": "module"), so __dirname isn't available — derive
// it from import.meta.url instead.
const dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(dirname, '../../../../.env.e2e') })

export interface E2eOrgFixture {
  orgSlug: string
  projectName: string
  userEmail: string
  userPassword: string
  writeKey: string
  readKey?: string
}

export interface E2eEnv {
  /** apps/api, e2e port (see .env.e2e API_PORT). */
  apiUrl: string
  /** services/capture, e2e port (see .env.e2e CAPTURE_PORT). */
  captureUrl: string
  /** apps/web dev server under Playwright's webServer, e2e port. */
  webUrl: string
  clickhouse: {
    url: string
    user: string
    password: string
    database: string
  }
  databaseUrl: string
  /** org `e2e` / project `E2E` — normal happy-path org. */
  org: Required<E2eOrgFixture>
  /** org `e2e-limited` / project `E2E-LIMITED` — maxEventsPerMonthOverride = 2. */
  limitedOrg: E2eOrgFixture & { maxEventsPerMonthOverride: number }
  /**
   * org `e2e-overage` / project `E2E-OVERAGE` — maxEventsPerMonthOverride = 2,
   * dedicated to `overage-policy.spec.ts` so its live
   * `overagePolicy` mutation ('block' <-> 'allow') can never race
   * `schema-and-limits.spec.ts`'s quota test, which shares `e2e-limited` and
   * assumes it stays on the seeded 'block' default. See
   * `packages/db/src/seed.e2e.ts`'s module doc comment.
   */
  overageOrg: E2eOrgFixture & { maxEventsPerMonthOverride: number }
  /**
   * org `e2e-surveys` / project `E2E-SURVEYS` — the only e2e org on the `pro`
   * plan. `surveys` is an ENFORCED feature OFF on `free`
   * (packages/db/src/plan-registry.ts), so surveys-exposure.spec.ts
   * authenticates as this org to drive the real `surveys.create`/`surveys.update`
   * tRPC path; the shared `free` orgs would 403 on the entitlement gate. See
   * `packages/db/src/seed.e2e.ts`'s module doc comment.
   */
  surveysOrg: E2eOrgFixture
  /**
   * A second user in the `e2e` org/project with `OrgRole.viewer` (read-only —
   * `projects:read` but not `projects:manage`, see
   * `packages/auth/src/permissions.ts`'s `ROLE_PERMISSIONS`). Prep fixture for
   * permission-gate scenario; scoped to just this membership row (see
   * `packages/db/src/seed.e2e.ts`), not a broader RBAC change.
   */
  viewerUser: { userEmail: string; userPassword: string }
}

export const e2eEnv: E2eEnv = {
  apiUrl: 'http://localhost:3100',
  captureUrl: 'http://localhost:3101',
  webUrl: 'http://localhost:5273',
  clickhouse: {
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    user: process.env.CLICKHOUSE_USER ?? 'clickroom',
    password: process.env.CLICKHOUSE_PASSWORD ?? 'clickroom',
    database: process.env.CLICKHOUSE_DATABASE ?? 'clickroom_e2e',
  },
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgresql://clickroom:clickroom@localhost:5433/clickroom_e2e?schema=public',
  // Fixed test vectors — literal copies of packages/db/src/seed.e2e.ts's
  // constants. Do not derive these from the seed script at runtime; keep this
  // file in sync by hand if the seed script ever changes them.
  org: {
    orgSlug: 'e2e',
    projectName: 'E2E',
    userEmail: 'e2e@clickroom.dev',
    userPassword: 'e2e-test-pw-2026',
    writeKey: 'ckw_live_a2987d751bd5c7ed4c7d9d603a1dc1b5fb910a5fd82cce3d',
    readKey: 'ckr_live_e2e0000000000000000000000000000000000000000',
  },
  limitedOrg: {
    orgSlug: 'e2e-limited',
    projectName: 'E2E-LIMITED',
    userEmail: 'e2e-limited@clickroom.dev',
    userPassword: 'e2e-limited-test-pw-2026',
    writeKey: 'ckw_live_e2elimited00000000000000000000000000000000000',
    maxEventsPerMonthOverride: 2,
  },
  overageOrg: {
    orgSlug: 'e2e-overage',
    projectName: 'E2E-OVERAGE',
    userEmail: 'e2e-overage@clickroom.dev',
    userPassword: 'e2e-overage-test-pw-2026',
    writeKey: 'ckw_live_e2eoverage0000000000000000000000000000000',
    maxEventsPerMonthOverride: 2,
  },
  surveysOrg: {
    orgSlug: 'e2e-surveys',
    projectName: 'E2E-SURVEYS',
    userEmail: 'e2e-surveys@clickroom.dev',
    userPassword: 'e2e-surveys-test-pw-2026',
    writeKey: 'ckw_live_e2esurveys0000000000000000000000000000000',
  },
  viewerUser: {
    userEmail: 'e2e-viewer@clickroom.dev',
    userPassword: 'e2e-viewer-test-pw-2026',
  },
}

// `@clickroom/db`'s PrismaClient is constructed at module-import time from
// `process.env.DATABASE_URL` (see packages/db/src/client.ts) — make sure it's
// set even if `.env.e2e` failed to load from disk for some reason.
process.env.DATABASE_URL ??= e2eEnv.databaseUrl
