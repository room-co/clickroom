import {
  buildSurveyOpenResponses,
  buildSurveyQuestionBreakdown,
  buildSurveyRespondent,
  buildSurveyResponseRate,
  buildSurveyScore,
  buildSurveySegmentBreakdown,
  buildSurveyTrend,
  clickhouse,
} from '@clickroom/clickhouse'
import { newId, slugify } from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { entitlementMiddleware } from '../middleware/entitlement.js'
import { requirePermission, router, scopedForProject } from '../trpc.js'
import { rebuildFlagCache, recordFlagAudit } from './flags.cache.js'
import { defaultEnvironment, type FlagFilters } from './flags.router.js'
import {
  createSurveyInput,
  deleteSurveyInput,
  getSurveyInput,
  listSurveysInput,
  surveyOpenResponsesInput,
  surveyQuestionBreakdownInput,
  surveyRespondentInput,
  surveyResultsInput,
  surveyScoreInput,
  surveySegmentBreakdownInput,
  surveyTrendInput,
  updateSurveyInput,
} from './surveys.schema.js'

/**
 * ClickHouse DateTime64 params reject a trailing `Z`, which zod's `.datetime()`
 * always emits — normalize the results range to `YYYY-MM-DD HH:mm:ss.SSS` (UTC)
 * before handing it to a survey builder. Same contract as events.router.ts's
 * `toChRange`.
 */
function toChRange(range: { from: string; to: string }): { from: string; to: string } {
  const fmt = (iso: string) => new Date(iso).toISOString().replace('T', ' ').replace('Z', '')
  return { from: fmt(range.from), to: fmt(range.to) }
}

/**
 * Survey procedures: RBAC first, entitlement (`feature:surveys`) second —
 * matches `sql-explorer.router.ts`'s gate order (see
 * ../middleware/entitlement.ts). A user without the permission gets the
 * *permissions* error, not an upsell. Manage-tier ops (create/update/delete)
 * require `projects:manage`; reads (list/get/results) require `projects:read`.
 */
const surveyProcedure = requirePermission('projects:manage').use(
  entitlementMiddleware('feature:surveys'),
)
const surveyReadProcedure = requirePermission('projects:read').use(
  entitlementMiddleware('feature:surveys'),
)

/**
 * The linked boolean FeatureFlag a survey owns is the single eligibility
 * mechanism: rollout %, per-segment conditions and environment scoping all
 * ride the existing flag machinery. One always-eligible group (100% rollout, no
 * property filters); the flag's own `active` gate + the survey's `status` gate
 * whether anyone actually sees it. `kind: 'boolean'` is a pure UI hint.
 */
const SURVEY_FLAG_FILTERS: FlagFilters = {
  groups: [{ properties: [], rollout_percentage: 100, variant: null }],
  kind: 'boolean',
}

/**
 * The FeatureFlag rows a survey owns: one per environment, all sharing the same
 * `key`. Surveys mean "show to everyone", so the flag must exist and track the
 * survey's active state in EVERY project environment — capture's `/v1/flags`
 * resolves flags per-environment by key, so a key present in only one env is
 * invisible to SDKs pointed at any other env. Resolve the whole set by key
 * (not by a single `featureFlagId`) so status-sync and delete fan out to all
 * environments. Each row carries its `environment` so the caller can rebuild the
 * per-env Redis cache.
 */
type LinkedFlagRow = {
  id: string
  version: number
  active: boolean
  filters: unknown
  environment: { id: string; key: string }
}
async function linkedFlagRows(
  pdb: Awaited<ReturnType<typeof scopedForProject>>,
  projectId: string,
  key: string,
): Promise<LinkedFlagRow[]> {
  return pdb.featureFlag.findMany({
    where: { projectId, key, deletedAt: null },
    select: {
      id: true,
      version: true,
      active: true,
      filters: true,
      environment: { select: { id: true, key: true } },
    },
  }) as unknown as Promise<LinkedFlagRow[]>
}

/** Rebuild the per-env Redis flag blob for each of the given environments. */
async function rebuildCachesForEnvironments(
  pdb: Awaited<ReturnType<typeof scopedForProject>>,
  projectId: string,
  environments: Array<{ id: string; key: string }>,
): Promise<void> {
  for (const env of environments) {
    await rebuildFlagCache(pdb, projectId, env)
  }
}

export const surveysRouter = router({
  list: surveyReadProcedure.input(listSurveysInput).query(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    return pdb.survey.findMany({
      where: {
        deletedAt: null,
        ...(input.status !== undefined && { status: input.status }),
      },
      orderBy: { name: 'asc' },
    })
  }),

  get: surveyReadProcedure.input(getSurveyInput).query(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    const survey = await pdb.survey.findFirst({
      where: { id: input.id, deletedAt: null },
    })
    if (!survey) throw new TRPCError({ code: 'NOT_FOUND', message: 'Survey not found.' })
    return survey
  }),

  create: surveyProcedure.input(createSurveyInput).mutation(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    // A survey is "show to everyone", so its linked flag must exist in EVERY
    // environment — capture's `/v1/flags` resolves flags per-env by key, so a
    // key present only in the default env is invisible to any SDK pointed at
    // another env. Create one flag row per environment, all sharing the
    // same key; the survey's `featureFlagId` points at the DEFAULT env's row so
    // the builder's "Advanced targeting" link resolves.
    const environments = await pdb.environment.findMany({
      where: { projectId: input.projectId },
    })
    const defaultEnv = await defaultEnvironment(pdb, input.projectId)

    const surveyId = newId()
    // Suffixed with the survey id's tail so distinct surveys never collide on
    // the (projectId, key, environmentId) unique constraint even when their
    // names slugify to the same string — mirrors experiments' `exp-` keys.
    const flagKey = `survey-${slugify(input.name)}-${surveyId.slice(-6).toLowerCase()}`

    const flagInputs = environments.map((env) => ({
      id: newId(),
      projectId: input.projectId,
      key: flagKey,
      name: `${input.name} (survey)`,
      // Off until the survey is enabled — the linked flag gates per-user
      // eligibility, the survey's `status` gates the config fetch.
      active: false,
      // Surveys don't need $feature_flag_called exposures — response-rate is
      // computed off $survey_shown, not flag calls.
      track: false,
      environmentId: env.id,
      filters: SURVEY_FLAG_FILTERS,
    }))
    const defaultFlagId =
      flagInputs.find((f) => f.environmentId === defaultEnv.id)?.id ?? flagInputs[0]?.id

    // Flag-creates + survey-create run in one DB transaction so a mid-failure
    // never leaves orphaned flags with no survey (or vice versa). Prisma
    // extensions (createScopedClient) propagate through $transaction, so tenant
    // scoping still applies inside the callback.
    const { createdFlags, survey } = await pdb.$transaction(async (tx) => {
      const createdFlags = []
      for (const data of flagInputs) {
        createdFlags.push(await tx.featureFlag.create({ data }))
      }
      const survey = await tx.survey.create({
        data: {
          id: surveyId,
          projectId: input.projectId,
          name: input.name,
          description: input.description ?? null,
          status: 'draft',
          definition: input.definition,
          version: 1,
          featureFlagId: defaultFlagId,
          createdBy: ctx.tokenPayload?.sub ?? '',
        },
      })
      return { createdFlags, survey }
    })

    await rebuildCachesForEnvironments(pdb, input.projectId, environments)
    for (const flag of createdFlags) {
      await recordFlagAudit(pdb, {
        flagId: flag.id,
        projectId: input.projectId,
        action: 'created',
        actorUserId: ctx.tokenPayload?.sub ?? '',
        diff: { before: null, after: { active: flag.active, filters: flag.filters } },
        version: flag.version,
      })
    }

    return survey
  }),

  update: surveyProcedure.input(updateSurveyInput).mutation(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    const existing = await pdb.survey.findFirst({
      where: { id: input.id, deletedAt: null },
    })
    if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Survey not found.' })

    // Resolve the linked flag's KEY from the survey's default-env row, then load
    // ALL flag rows sharing that key across every environment — a `status`
    // change must drive `active` on the whole set, not just the default env, or
    // `/v1/flags` returns false forever in every other env.
    const linkedFlag = await pdb.featureFlag.findFirst({
      where: { id: existing.featureFlagId, deletedAt: null },
      select: { key: true },
    })
    const flagRows = linkedFlag ? await linkedFlagRows(pdb, input.projectId, linkedFlag.key) : []

    // `active` when the survey is running, off when draft/archived. Only touch
    // the flags when `status` is being changed AND at least one row's `active`
    // differs from the desired value — avoids needless flag churn on a
    // name/description/definition-only edit or a no-op status write.
    const desiredActive = input.patch.status === 'active'
    const flagActiveChanges =
      linkedFlag != null &&
      input.patch.status !== undefined &&
      flagRows.some((f) => f.active !== desiredActive)

    await pdb.$transaction(async (tx) => {
      const { count } = await tx.survey.updateMany({
        where: { id: input.id, deletedAt: null },
        data: {
          ...(input.patch.name !== undefined && { name: input.patch.name }),
          ...(input.patch.description !== undefined && { description: input.patch.description }),
          ...(input.patch.status !== undefined && { status: input.patch.status }),
          // Every definition edit bumps `version` so the SDK's localStorage
          // version gate re-fetches the changed config, mirrors flags.ts).
          ...(input.patch.definition !== undefined && {
            definition: input.patch.definition,
            version: { increment: 1 },
          }),
        },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Survey not found.' })
      }
      if (flagActiveChanges && linkedFlag) {
        // Flip every env's row for this key in one shot.
        await tx.featureFlag.updateMany({
          where: { projectId: input.projectId, key: linkedFlag.key, deletedAt: null },
          data: { active: desiredActive, version: { increment: 1 } },
        })
      }
    })

    // Only rebuild the caches / write audits when the flags' `active` actually
    // flipped — mirrors `delete`'s post-transaction flag bookkeeping, fanned out
    // per environment.
    if (flagActiveChanges) {
      await rebuildCachesForEnvironments(
        pdb,
        input.projectId,
        flagRows.map((f) => f.environment),
      )
      for (const flag of flagRows) {
        await recordFlagAudit(pdb, {
          flagId: flag.id,
          projectId: input.projectId,
          action: 'updated',
          actorUserId: ctx.tokenPayload?.sub ?? '',
          diff: { before: { active: flag.active }, after: { active: desiredActive } },
          version: flag.version + 1,
        })
      }
    }

    return pdb.survey.findFirstOrThrow({ where: { id: input.id } })
  }),

  delete: surveyProcedure.input(deleteSurveyInput).mutation(async ({ input, ctx }) => {
    const pdb = await scopedForProject(ctx, input.projectId)
    const existing = await pdb.survey.findFirst({
      where: { id: input.id, deletedAt: null },
    })
    if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Survey not found.' })

    // Unlike experiments (whose flag may have other consumers), a survey's
    // linked flags are private to the survey — soft-delete the survey together
    // with EVERY env's flag row sharing the linked key.
    const linkedFlag = await pdb.featureFlag.findFirst({
      where: { id: existing.featureFlagId, deletedAt: null },
      select: { key: true },
    })
    const flagRows = linkedFlag ? await linkedFlagRows(pdb, input.projectId, linkedFlag.key) : []

    await pdb.$transaction(async (tx) => {
      await tx.survey.updateMany({
        where: { id: input.id, deletedAt: null },
        data: { deletedAt: new Date() },
      })
      if (linkedFlag) {
        await tx.featureFlag.updateMany({
          where: { projectId: input.projectId, key: linkedFlag.key, deletedAt: null },
          data: { deletedAt: new Date(), version: { increment: 1 } },
        })
      }
    })

    if (flagRows.length > 0) {
      await rebuildCachesForEnvironments(
        pdb,
        input.projectId,
        flagRows.map((f) => f.environment),
      )
      for (const flag of flagRows) {
        await recordFlagAudit(pdb, {
          flagId: flag.id,
          projectId: input.projectId,
          action: 'deleted',
          actorUserId: ctx.tokenPayload?.sub ?? '',
          diff: { before: { active: flag.active, filters: flag.filters }, after: null },
          version: flag.version + 1,
        })
      }
    }

    return { id: input.id, deleted: true }
  }),

  // ── results.* ──────────────────────────────────────────────────────────────
  // Each procedure runs a pure survey builder from @clickroom/clickhouse
  // via `clickhouse.query` (JSONEachRow) and coerces CH's stringified aggregates
  // to numbers. Reads are gated by `surveyReadProcedure` (projects:read +
  // feature:surveys). The range is normalized through `toChRange` first.
  results: router({
    responseRate: surveyReadProcedure.input(surveyResultsInput).query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const range = toChRange(input.range)
      const rs = await clickhouse.query({
        ...buildSurveyResponseRate({
          projectId: input.projectId,
          surveyId: input.surveyId,
          from: range.from,
          to: range.to,
        }),
        format: 'JSONEachRow',
      })
      const [row] = await rs.json<{ shown: string; responded: string; rate: string }>()
      return {
        shown: Number(row?.shown ?? 0),
        responded: Number(row?.responded ?? 0),
        rate: Number(row?.rate ?? 0),
      }
    }),

    score: surveyReadProcedure.input(surveyScoreInput).query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const range = toChRange(input.range)
      const rs = await clickhouse.query({
        ...buildSurveyScore({
          projectId: input.projectId,
          surveyId: input.surveyId,
          questionId: input.questionId,
          scoreType: input.scoreType,
          from: range.from,
          to: range.to,
        }),
        format: 'JSONEachRow',
      })
      const [row] = await rs.json<Record<string, string>>()
      // Row shape varies by scoreType; coerce every numeric field present.
      const out: Record<string, number> = {}
      for (const [k, v] of Object.entries(row ?? {})) {
        out[k] = Number(v)
      }
      return { scoreType: input.scoreType, ...out }
    }),

    questionBreakdown: surveyReadProcedure
      .input(surveyQuestionBreakdownInput)
      .query(async ({ input, ctx }) => {
        await scopedForProject(ctx, input.projectId)
        const range = toChRange(input.range)
        const rs = await clickhouse.query({
          ...buildSurveyQuestionBreakdown({
            projectId: input.projectId,
            surveyId: input.surveyId,
            questionId: input.questionId,
            from: range.from,
            to: range.to,
          }),
          format: 'JSONEachRow',
        })
        const rows = await rs.json<{ value: string; count: string; users: string }>()
        return rows.map((r) => ({
          value: r.value,
          count: Number(r.count),
          users: Number(r.users),
        }))
      }),

    // Open-text feed: raw answers to one open question, newest first, paginated.
    // Fetch `limit + 1` so a trailing sentinel row tells us `hasMore` without a
    // separate COUNT (the Responses stat card already shows the total).
    openResponses: surveyReadProcedure
      .input(surveyOpenResponsesInput)
      .query(async ({ input, ctx }) => {
        await scopedForProject(ctx, input.projectId)
        const range = toChRange(input.range)
        const rs = await clickhouse.query({
          ...buildSurveyOpenResponses({
            projectId: input.projectId,
            surveyId: input.surveyId,
            questionId: input.questionId,
            from: range.from,
            to: range.to,
            limit: input.limit + 1,
            offset: input.offset,
          }),
          format: 'JSONEachRow',
        })
        const rows = await rs.json<{ resp: string; did: string; ts: string }>()
        const hasMore = rows.length > input.limit
        const items = (hasMore ? rows.slice(0, input.limit) : rows).map((r) => ({
          response: r.resp,
          distinctId: r.did,
          timestamp: r.ts,
        }))
        return { items, hasMore }
      }),

    // Drill-down: every answered question for one respondent (all their answers
    // to this survey), keyed off a response's distinct_id.
    respondent: surveyReadProcedure.input(surveyRespondentInput).query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const range = toChRange(input.range)
      const rs = await clickhouse.query({
        ...buildSurveyRespondent({
          projectId: input.projectId,
          surveyId: input.surveyId,
          distinctId: input.distinctId,
          from: range.from,
          to: range.to,
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ qid: string; resp: string; ts: string }>()
      return rows.map((r) => ({
        questionId: r.qid,
        response: r.resp,
        timestamp: r.ts,
      }))
    }),

    trend: surveyReadProcedure.input(surveyTrendInput).query(async ({ input, ctx }) => {
      await scopedForProject(ctx, input.projectId)
      const range = toChRange(input.range)
      const rs = await clickhouse.query({
        ...buildSurveyTrend({
          projectId: input.projectId,
          surveyId: input.surveyId,
          interval: input.interval,
          from: range.from,
          to: range.to,
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ bucket: string; shown: string; sent: string }>()
      return rows.map((r) => ({
        bucket: r.bucket,
        shown: Number(r.shown),
        sent: Number(r.sent),
      }))
    }),

    segmentBreakdown: surveyReadProcedure
      .input(surveySegmentBreakdownInput)
      .query(async ({ input, ctx }) => {
        await scopedForProject(ctx, input.projectId)
        const range = toChRange(input.range)
        const rs = await clickhouse.query({
          ...buildSurveySegmentBreakdown({
            projectId: input.projectId,
            surveyId: input.surveyId,
            segmentId: input.segmentId,
            from: range.from,
            to: range.to,
          }),
          format: 'JSONEachRow',
        })
        const rows = await rs.json<{
          member: string
          shown: string
          responded: string
          rate: string
        }>()
        return rows.map((r) => ({
          member: r.member,
          shown: Number(r.shown),
          responded: Number(r.responded),
          rate: Number(r.rate),
        }))
      }),
  }),
})
