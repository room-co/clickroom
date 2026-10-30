import {
  buildExperimentExposures,
  buildExperimentFunnelByVariant,
  buildExperimentMeanByVariant,
  buildExperimentRatioByVariant,
  buildExperimentRetentionByVariant,
  clickhouse,
} from '@clickroom/clickhouse'
import { newId, slugify } from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { requirePermission, router, scopedForProject } from '../trpc.js'
import {
  type ExperimentMetricInput,
  type ExperimentVariantInput,
  experimentMetricSchema,
  experimentVariantsSchema,
} from './experiments.schema.js'
import {
  betaBinomialResults,
  type ExperimentMetricType,
  gammaPoissonResults,
  gammaRatioResults,
  modelForMetricType,
  type VariantResult,
} from './experiments.stats.js'
import { rebuildFlagCache, recordFlagAudit } from './flags.cache.js'
import {
  defaultEnvironment,
  envSlugSchema,
  type FlagFilters,
  resolveEnvironment,
} from './flags.router.js'

// Experiment auto-creates a linked multivariate FeatureFlag on create — the
// flag *is* the bucketing/exposure mechanism. Unless the
// caller overrides `variants`, new experiments get a 50/50 control/test split.
const DEFAULT_VARIANTS: ExperimentVariantInput[] = [
  { key: 'control', rolloutPercentage: 50 },
  { key: 'test', rolloutPercentage: 50 },
]

/**
 * Build the linked FeatureFlag's `filters` JSON from an experiment's
 * variants. One always-on group (100% rollout, no property filters) gates
 * the flag to "on" for everyone; `multivariate.variants` does the actual
 * per-person split (evaluate()'s `pickVariant`, packages/sdk-js/src/flags.ts).
 * Note the snake_case `rollout_percentage` here — that's the FeatureFlag wire
 * shape (flags.router.ts's `filtersSchema`), distinct from the camelCase
 * `rolloutPercentage` used by Experiment.variants/experiments.schema.ts.
 */
function variantsToFlagFilters(variants: ExperimentVariantInput[]): FlagFilters {
  return {
    groups: [{ properties: [], rollout_percentage: 100, variant: null }],
    multivariate: {
      variants: variants.map((v) => ({ key: v.key, rollout_percentage: v.rolloutPercentage })),
    },
    kind: 'string',
  }
}

/** ClickHouse DateTime64 params reject a trailing `Z` — same normalization as events.router.ts's toChRange. */
function toChTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '')
}

const patchSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    hypothesis: z.string().nullable().optional(),
    variants: experimentVariantsSchema.optional(),
    primaryMetric: experimentMetricSchema.optional(),
    secondaryMetrics: z.array(experimentMetricSchema).optional(),
    minimumDetectableEffect: z.number().nullable().optional(),
  })
  .strict()

export interface MetricResultsOutput {
  metric: ExperimentMetricInput
  results: VariantResult[]
  winner?: string
}

interface ExperimentCHArgs {
  projectId: string
  flagKey: string
  from: string
  to: string
}

/**
 * Runs the metric-specific ClickHouse builder for one ExperimentMetric,
 * shapes its rows into the per-variant input the matching conjugate stats
 * function (Beta-Binomial for funnel/retention, Gamma-Poisson for
 * mean/ratio — `modelForMetricType`, experiments.stats.ts) expects, and
 * returns the assembled VariantResult[] + optional winner.
 */
async function computeMetricResults(
  metric: ExperimentMetricInput,
  variantKeys: string[],
  baseArgs: ExperimentCHArgs,
  exposedByVariant: Map<string, number>,
): Promise<MetricResultsOutput> {
  const model = modelForMetricType(metric.type as ExperimentMetricType)

  if (model === 'beta-binomial') {
    const converted = new Map<string, number>()

    if (metric.type === 'funnel') {
      const rs = await clickhouse.query({
        ...buildExperimentFunnelByVariant({
          ...baseArgs,
          steps: metric.steps.map((s) => ({ event: s.event, filters: s.properties ?? [] })),
          window: metric.window,
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ response: string; level: number; reached: string }>()
      // Nobody can reach a level beyond the step count — the row where
      // level === steps.length IS the full-funnel completion count per
      // variant (no suffix-sum needed beyond that single bucket).
      for (const row of rows) {
        if (Number(row.level) === metric.steps.length) {
          converted.set(row.response, (converted.get(row.response) ?? 0) + Number(row.reached))
        }
      }
    } else if (metric.type === 'retention') {
      const rs = await clickhouse.query({
        ...buildExperimentRetentionByVariant({
          ...baseArgs,
          returnEvent: metric.returnEvent,
          days: metric.days,
        }),
        format: 'JSONEachRow',
      })
      const rows = await rs.json<{ response: string; exposed: string; retained: string }>()
      for (const row of rows) converted.set(row.response, Number(row.retained))
    }

    const variants = variantKeys.map((key) => ({
      key,
      exposed: exposedByVariant.get(key) ?? 0,
      converted: converted.get(key) ?? 0,
    }))
    const { results, winner } = betaBinomialResults(variants)
    return winner === undefined ? { metric, results } : { metric, results, winner }
  }

  // Gamma-Poisson (mean): per-variant count fed as `totalCount`.
  if (metric.type === 'mean') {
    const rs = await clickhouse.query({
      ...buildExperimentMeanByVariant({
        ...baseArgs,
        event: metric.event,
        property: metric.property,
      }),
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ response: string; exposed: string; mean: string; total: string }>()
    const totalCount = new Map(rows.map((row) => [row.response, Number(row.total)]))

    const variants = variantKeys.map((key) => ({
      key,
      exposed: exposedByVariant.get(key) ?? 0,
      totalCount: totalCount.get(key) ?? 0,
    }))
    const { results, winner } = gammaPoissonResults(variants)
    return winner === undefined ? { metric, results } : { metric, results, winner }
  }

  // Ratio: numerator and denominator are each fit as their own independent
  // Gamma-Poisson posterior (per-exposed-user rate), then combined per
  // Monte-Carlo draw into a ratio-of-two-Gammas sample — see
  // `gammaRatioResults`'s doc comment for why this isn't just two separate
  // gammaPoissonResults() calls divided afterward.
  if (metric.type !== 'ratio') {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Unhandled metric type for gamma-poisson model: ${metric.type}`,
    })
  }
  const rs = await clickhouse.query({
    ...buildExperimentRatioByVariant({
      ...baseArgs,
      numeratorEvent: metric.numeratorEvent,
      denominatorEvent: metric.denominatorEvent,
    }),
    format: 'JSONEachRow',
  })
  const rows = await rs.json<{ response: string; numerator: string; denominator: string }>()
  const numeratorCount = new Map(rows.map((row) => [row.response, Number(row.numerator)]))
  const denominatorCount = new Map(rows.map((row) => [row.response, Number(row.denominator)]))

  const variants = variantKeys.map((key) => ({
    key,
    exposed: exposedByVariant.get(key) ?? 0,
    numeratorCount: numeratorCount.get(key) ?? 0,
    denominatorCount: denominatorCount.get(key) ?? 0,
  }))
  const { results, winner } = gammaRatioResults(variants)
  return winner === undefined ? { metric, results } : { metric, results, winner }
}

export const experimentsRouter = router({
  list: requirePermission('projects:read')
    .input(z.object({ projectId: z.string(), env: envSlugSchema }))
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const environment = await resolveEnvironment(pdb, input.projectId, input.env)
      return pdb.experiment.findMany({
        where: { deletedAt: null, featureFlag: { environmentId: environment.id } },
        orderBy: { name: 'asc' },
      })
    }),

  get: requirePermission('projects:read')
    .input(z.object({ projectId: z.string(), id: z.string() }))
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const experiment = await pdb.experiment.findFirst({
        where: { id: input.id, deletedAt: null },
      })
      if (!experiment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Experiment not found.' })
      return experiment
    }),

  create: requirePermission('projects:manage')
    .input(
      z.object({
        projectId: z.string(),
        name: z.string().min(1),
        description: z.string().optional(),
        hypothesis: z.string().optional(),
        variants: experimentVariantsSchema.optional(),
        primaryMetric: experimentMetricSchema,
        secondaryMetrics: z.array(experimentMetricSchema).optional(),
        env: envSlugSchema.optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const environment =
        input.env !== undefined
          ? await resolveEnvironment(pdb, input.projectId, input.env)
          : await defaultEnvironment(pdb, input.projectId)
      const variants = input.variants ?? DEFAULT_VARIANTS

      const experimentId = newId()
      const flagId = newId()
      // Suffixed with the experiment id's tail so distinct experiments never
      // collide on the (projectId, key, environmentId) unique constraint even
      // when their names slugify to the same string.
      const flagKey = `exp-${slugify(input.name)}-${experimentId.slice(-6).toLowerCase()}`

      // Flag-create + experiment-create run in one DB transaction so a
      // mid-failure never leaves an orphaned flag with no experiment (or vice
      // versa) — Prisma extensions (createScopedClient) propagate through
      // $transaction, so tenant scoping still applies inside the callback.
      const { flag, experiment } = await pdb.$transaction(async (tx) => {
        const flag = await tx.featureFlag.create({
          data: {
            id: flagId,
            projectId: input.projectId,
            key: flagKey,
            name: `${input.name} (experiment)`,
            active: false,
            // Experiment-bound flags track exposures by default — the
            // experiment's denominator is $feature_flag_called. Pinned true while
            // the experiment runs (flags.router `assertTrackNotPinned`).
            track: true,
            environmentId: environment.id,
            filters: variantsToFlagFilters(variants),
          },
        })
        const experiment = await tx.experiment.create({
          data: {
            id: experimentId,
            projectId: input.projectId,
            name: input.name,
            description: input.description ?? null,
            hypothesis: input.hypothesis ?? null,
            featureFlagId: flag.id,
            status: 'draft',
            variants,
            primaryMetric: input.primaryMetric,
            secondaryMetrics: input.secondaryMetrics ?? [],
            createdBy: ctx.tokenPayload?.sub ?? '',
          },
        })
        return { flag, experiment }
      })

      await rebuildFlagCache(pdb, input.projectId, environment)
      await recordFlagAudit(pdb, {
        flagId: flag.id,
        projectId: input.projectId,
        action: 'created',
        actorUserId: ctx.tokenPayload?.sub ?? '',
        diff: { before: null, after: { active: flag.active, filters: flag.filters } },
        version: flag.version,
      })

      return experiment
    }),

  update: requirePermission('projects:manage')
    .input(z.object({ projectId: z.string(), id: z.string(), patch: patchSchema }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const existing = await pdb.experiment.findFirst({
        where: { id: input.id, deletedAt: null },
      })
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Experiment not found.' })

      // Changing bucketing mid-run corrupts in-flight results — variant
      // edits are only allowed while the experiment is still a draft.
      if (input.patch.variants !== undefined && existing.status !== 'draft') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Variants can only be edited while the experiment is in draft.',
        })
      }

      // Keep the linked flag's multivariate split in sync with the
      // experiment's variants whenever they change (draft-only, checked above).
      if (input.patch.variants !== undefined) {
        const flag = await pdb.featureFlag.findFirst({
          where: { id: existing.featureFlagId, deletedAt: null },
          select: { filters: true, environment: { select: { id: true, key: true } } },
        })
        if (flag) {
          const filters = flag.filters as FlagFilters
          await pdb.featureFlag.updateMany({
            where: { id: existing.featureFlagId, deletedAt: null },
            data: {
              version: { increment: 1 },
              filters: {
                ...filters,
                multivariate: {
                  variants: input.patch.variants.map((v) => ({
                    key: v.key,
                    rollout_percentage: v.rolloutPercentage,
                  })),
                },
              },
            },
          })
          await rebuildFlagCache(pdb, input.projectId, flag.environment)
        }
      }

      const { count } = await pdb.experiment.updateMany({
        where: { id: input.id, deletedAt: null },
        data: {
          ...(input.patch.name !== undefined && { name: input.patch.name }),
          ...(input.patch.description !== undefined && { description: input.patch.description }),
          ...(input.patch.hypothesis !== undefined && { hypothesis: input.patch.hypothesis }),
          ...(input.patch.variants !== undefined && { variants: input.patch.variants }),
          ...(input.patch.primaryMetric !== undefined && {
            primaryMetric: input.patch.primaryMetric,
          }),
          ...(input.patch.secondaryMetrics !== undefined && {
            secondaryMetrics: input.patch.secondaryMetrics,
          }),
          ...(input.patch.minimumDetectableEffect !== undefined && {
            minimumDetectableEffect: input.patch.minimumDetectableEffect,
          }),
        },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Experiment not found.' })
      }
      return pdb.experiment.findFirstOrThrow({ where: { id: input.id } })
    }),

  delete: requirePermission('projects:manage')
    .input(z.object({ projectId: z.string(), id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const { count } = await pdb.experiment.updateMany({
        where: { id: input.id, deletedAt: null },
        data: { deletedAt: new Date() },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Experiment not found.' })
      }
      // Flag lifecycle stays independent — deleting the experiment doesn't
      // yank a flag that might have other consumers.
      return { id: input.id, deleted: true }
    }),

  launch: requirePermission('projects:manage')
    .input(z.object({ projectId: z.string(), id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const existing = await pdb.experiment.findFirst({
        where: { id: input.id, deletedAt: null },
      })
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Experiment not found.' })

      const { count } = await pdb.experiment.updateMany({
        where: { id: input.id, deletedAt: null },
        // Clear endedAt so a relaunch (e.g. draft -> running, or
        // complete -> running restart) doesn't leave a stale endedAt from a
        // prior run that would cap the new run's results query window.
        data: { status: 'running', startedAt: new Date(), endedAt: null },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Experiment not found.' })
      }

      const flag = await pdb.featureFlag.findFirst({
        where: { id: existing.featureFlagId, deletedAt: null },
        select: {
          active: true,
          track: true,
          version: true,
          environment: { select: { id: true, key: true } },
        },
      })
      // Launch both activates the flag and pins exposure tracking on,
      // so a launched experiment always records exposures even if the flag was
      // manually created untracked. Skip the write (and version bump) only when
      // neither needs changing.
      if (flag && (!flag.active || !flag.track)) {
        await pdb.featureFlag.updateMany({
          where: { id: existing.featureFlagId, deletedAt: null },
          data: { active: true, track: true, version: { increment: 1 } },
        })
        await rebuildFlagCache(pdb, input.projectId, flag.environment)
      }

      return pdb.experiment.findFirstOrThrow({ where: { id: input.id } })
    }),

  stop: requirePermission('projects:manage')
    .input(z.object({ projectId: z.string(), id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const { count } = await pdb.experiment.updateMany({
        where: { id: input.id, deletedAt: null },
        data: { status: 'complete', endedAt: new Date() },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Experiment not found.' })
      }
      // Flag is left active — whether the winning variant stays rolled out
      // is a separate flag-management decision, out of scope here.
      return pdb.experiment.findFirstOrThrow({ where: { id: input.id } })
    }),

  results: requirePermission('projects:read')
    .input(z.object({ projectId: z.string(), id: z.string() }))
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const experiment = await pdb.experiment.findFirst({
        where: { id: input.id, deletedAt: null },
      })
      if (!experiment) throw new TRPCError({ code: 'NOT_FOUND', message: 'Experiment not found.' })

      // Never launched — explicit "not ready" shape, not an error, so the UI
      // renders a "not launched yet" state instead of a broken results panel.
      if (!experiment.startedAt) {
        return {
          primary: null as MetricResultsOutput | null,
          secondary: [] as MetricResultsOutput[],
        }
      }

      const flag = await pdb.featureFlag.findFirst({
        where: { id: experiment.featureFlagId },
        select: { key: true },
      })
      if (!flag) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Linked feature flag not found.' })
      }

      const baseArgs: ExperimentCHArgs = {
        projectId: input.projectId,
        flagKey: flag.key,
        from: toChTimestamp(experiment.startedAt),
        to: toChTimestamp(experiment.endedAt ?? new Date()),
      }

      const exposuresRs = await clickhouse.query({
        ...buildExperimentExposures(baseArgs),
        format: 'JSONEachRow',
      })
      const exposureRows = await exposuresRs.json<{
        response: string
        exposed: string
        firstExposure: string
      }>()
      const exposedByVariant = new Map(exposureRows.map((r) => [r.response, Number(r.exposed)]))

      // biome-ignore lint/suspicious/noExplicitAny: Prisma Json column
      const variantKeys = (experiment.variants as any[]).map((v) => v.key as string)
      const primaryMetric = experiment.primaryMetric as unknown as ExperimentMetricInput
      const secondaryMetrics = (experiment.secondaryMetrics ??
        []) as unknown as ExperimentMetricInput[]

      const primary = await computeMetricResults(
        primaryMetric,
        variantKeys,
        baseArgs,
        exposedByVariant,
      )
      const secondary: MetricResultsOutput[] = []
      for (const metric of secondaryMetrics) {
        secondary.push(await computeMetricResults(metric, variantKeys, baseArgs, exposedByVariant))
      }

      return { primary, secondary }
    }),
})
