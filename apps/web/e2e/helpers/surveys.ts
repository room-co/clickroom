// Survey seeding + assertion helpers for the real-browser survey exposure smoke
// (surveys-exposure.spec.ts).
//
// IMPORTANT: `./env` must be imported first — it loads `.env.e2e` and sets
// `process.env.DATABASE_URL` before `@clickroom/db`'s prisma singleton is
// constructed at import time. Same load-bearing order as `helpers/db.ts`.
import './env'
import { prisma } from '@clickroom/db'
import { loginViaApi } from './auth'
import { queryClickHouse } from './clickhouse'
import { e2eEnv } from './env'
import { waitFor } from './waitFor'

// ── Why seed via the REAL surveys.create/update tRPC path ────────────────────
// Surveys are an ENFORCED, plan-gated feature (OFF on `free`,
// packages/db/src/plan-registry.ts). The dedicated `e2e-surveys` org is on the
// `pro` plan (packages/db/src/seed.e2e.ts), so `surveys.create` / `surveys.update`
// pass the `feature:surveys` entitlement gate for it. We therefore seed through
// the SAME procedures the dashboard uses — `NewSurveyDialog` calls
// `surveys.create`, the builder's `changeStatus('active')` calls
// `surveys.update({ patch: { status } })` — instead of hand-writing FeatureFlag +
// Survey rows and poking Redis. The router already fans the linked flag out to
// every environment and rebuilds the per-env Redis flag blob, so nothing here has
// to know about that machinery.
//
// Auth: a plain (non-batched) tRPC v11 HTTP POST to `${apiUrl}/trpc/<proc>`,
// carrying `Authorization: Bearer <accessToken>` from `loginViaApi` as the
// `e2e-surveys` org's admin user. `apps/api` has no data transformer, and a
// non-batch call reads the raw JSON body as the input directly (no
// `{"json": …}` envelope) — same shape `helpers/auth.ts`'s `loginViaApi` proved
// live. Response is `{"result": {"data": <row>}}`; a gate/validation failure maps
// to the matching HTTP status (e.g. 403 FORBIDDEN), so `!res.ok` catches it.

/** Cached `e2e-surveys` admin bearer — one login per test worker. */
let cachedToken: string | undefined
async function surveysToken(): Promise<string> {
  if (cachedToken === undefined) {
    const { accessToken } = await loginViaApi(
      e2eEnv.surveysOrg.userEmail,
      e2eEnv.surveysOrg.userPassword,
    )
    cachedToken = accessToken
  }
  return cachedToken
}

/** One non-batched tRPC mutation over HTTP, authenticated as `e2e-surveys`. */
async function trpcMutation<T>(proc: string, input: unknown): Promise<T> {
  const token = await surveysToken()
  const res = await fetch(`${e2eEnv.apiUrl}/trpc/${proc}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  })
  const payload = await res.json().catch(() => undefined)
  if (!res.ok || payload?.error || payload?.result?.data === undefined) {
    throw new Error(`trpc ${proc} failed (${res.status}): ${JSON.stringify(payload)}`)
  }
  return payload.result.data as T
}

/** Minimal survey definition shape (the `version: 1` config the SDK caches).
 *  Passed straight through to `surveys.create`'s `definition` input — see
 *  `surveys.schema.ts` for the full accepted shape (appearance + triggers are
 *  required; triggers must carry a `frequency`). */
export interface SeedSurveyDefinition {
  version: 1
  questions: Array<Record<string, unknown>>
  appearance: Record<string, unknown>
  triggers: Record<string, unknown>
}

export interface SeedSurveyArgs {
  projectId: string
  name: string
  definition: SeedSurveyDefinition
}

export interface SeededSurvey {
  surveyId: string
  /** The linked `FeatureFlag.key` the SDK gates display on — enabled in every env. */
  flagKey: string
}

/** The shape `surveys.create` returns (Survey row) — only the fields we need. */
interface CreatedSurveyRow {
  id: string
  featureFlagId: string
}

/**
 * Seed one ACTIVE survey through the real product path: `surveys.create`
 * (creates the survey `draft` + its off linked flag in every env) then
 * `surveys.update` with `patch: { status: 'active' }` (flips the flags on +
 * rebuilds the Redis flag caches, exactly as the builder's activate does).
 * Returns the ids needed to assert (`surveyId`) and drive the SDK (`flagKey`).
 */
export async function seedActiveSurvey(args: SeedSurveyArgs): Promise<SeededSurvey> {
  const created = await trpcMutation<CreatedSurveyRow>('surveys.create', {
    projectId: args.projectId,
    name: args.name,
    definition: args.definition,
  })

  await trpcMutation<CreatedSurveyRow>('surveys.update', {
    id: created.id,
    projectId: args.projectId,
    patch: { status: 'active' },
  })

  // The linked flag's key isn't in the create response — read it back (a plain
  // read, not a product-row write) so the SDK-readiness/assertion code can gate
  // on `isFeatureEnabled(flagKey)`.
  const flag = await prisma.featureFlag.findUniqueOrThrow({
    where: { id: created.featureFlagId },
    select: { key: true },
  })

  return { surveyId: created.id, flagKey: flag.key }
}

/**
 * Crash-proof cleanup: soft-delete the survey (and its linked flags) through the
 * real `surveys.delete` procedure, which also rebuilds the flag caches so capture
 * stops serving them. No-op-safe — callable unconditionally from
 * `afterAll`/`finally` regardless of how far a test got; swallows any error so a
 * cleanup failure never masks the test result.
 */
export async function deleteSeededSurvey(seeded: {
  projectId: string
  surveyId: string
}): Promise<void> {
  try {
    await trpcMutation('surveys.delete', {
      id: seeded.surveyId,
      projectId: seeded.projectId,
    })
  } catch {
    // Last-resort soft-delete straight in Postgres so a stuck survey can't keep
    // counting against the org's quotas if the tRPC delete is unreachable.
    await prisma.survey.updateMany({
      where: { id: seeded.surveyId, deletedAt: null },
      data: { deletedAt: new Date() },
    })
  }
}

export interface WaitForSurveyShownArgs {
  projectId: string
  surveyId: string
}

/**
 * Poll (up to ~20s) until at least one `$survey_shown` event for this survey id
 * has landed in ClickHouse, returning the observed count. Keyed by
 * `properties.$survey_id` (unique per seeded survey) so it's isolated from other
 * runs' data. `FINAL` because `events` is a `ReplacingMergeTree`. Same budget as
 * `helpers/clickhouse.ts`'s `waitForEvent`.
 */
export async function waitForSurveyShown({
  projectId,
  surveyId,
}: WaitForSurveyShownArgs): Promise<number> {
  return waitFor(
    async () => {
      const rows = await queryClickHouse(
        "SELECT count() as c FROM events FINAL WHERE project_id={pid:String} AND event='$survey_shown' AND JSONExtractString(properties, '$survey_id')={sid:String}",
        { pid: projectId, sid: surveyId },
      )
      const count = Number(rows[0]?.c ?? 0)
      return count >= 1 ? count : false
    },
    { timeoutMs: 20_000, intervalMs: 250 },
  )
}
