import { createRequire } from 'node:module'
import type BetaRandomFactory from '@stdlib/random/base/beta'
import type GammaRandomFactory from '@stdlib/random/base/gamma'

// @stdlib/random's subpath packages ship `"main": "./lib"` with no `exports`
// map, which Node's strict ESM resolver can't follow (it doesn't do
// directory/index.js fallback the way CJS `require` does). `createRequire`
// gets CJS resolution semantics back for this one import.
const stdlibRequire = createRequire(import.meta.url)
const betaRandomFactory: typeof BetaRandomFactory = stdlibRequire('@stdlib/random/base/beta')
const gammaRandomFactory: typeof GammaRandomFactory = stdlibRequire('@stdlib/random/base/gamma')

// Pure Bayesian conjugate-model stats for experiment results.
//
// No ClickHouse/Prisma imports on purpose — this module is testable in
// isolation (see experiments.stats.test.ts) and is fed plain per-variant
// aggregate counts by experiments.router.ts's `results` procedure, which is
// responsible for producing those counts from ClickHouse.
//
// Which conjugate model applies to which ExperimentMetric.type (37.3):
//   - funnel, retention  -> Beta-Binomial   (binary per-user outcome: did the
//                           user convert / return, yes or no)
//   - mean, ratio        -> Gamma-Poisson   (count per-user outcome: a rate
//                           or numeric total per exposed user)
export const METRIC_TYPE_TO_MODEL = {
  funnel: 'beta-binomial',
  retention: 'beta-binomial',
  mean: 'gamma-poisson',
  ratio: 'gamma-poisson',
} as const

export type ExperimentMetricType = keyof typeof METRIC_TYPE_TO_MODEL
export type ConjugateModel = (typeof METRIC_TYPE_TO_MODEL)[ExperimentMetricType]

export function modelForMetricType(type: ExperimentMetricType): ConjugateModel {
  return METRIC_TYPE_TO_MODEL[type]
}

export interface VariantResult {
  variant: string
  exposed: number
  metricValue: number
  credibleInterval: [number, number]
  probabilityToBeBest: number
  upliftVsControl: number
}

export interface BetaBinomialInput {
  key: string
  exposed: number
  converted: number
}

export interface GammaPoissonInput {
  key: string
  exposed: number
  totalCount: number
}

export interface GammaRatioInput {
  key: string
  exposed: number
  numeratorCount: number
  denominatorCount: number
}

// Fixed Monte-Carlo sample count — large enough for stable probability /
// interval estimates, small enough to stay fast in a request handler and to
// keep unit tests snappy.
const MONTE_CARLO_SAMPLES = 20_000

// A variant needs to clear this probability-to-be-best threshold before it
// is surfaced as a `winner` — otherwise the result is left inconclusive
// (omitted), never a forced pick.
const WINNER_PROBABILITY_THRESHOLD = 0.95

const DEFAULT_SEED = 0x9e3779b9

// Random sampling is delegated entirely to `@stdlib/random`'s seeded base
// generators (Mersenne-Twister backed, deterministic given a `seed`) — no
// hand-rolled PRNG or sampler math in this module. Never use bare
// Math.random() here.
//
// `@stdlib/random/base/gamma(alpha, beta)` uses the shape/**rate**
// convention (not shape/scale) — `beta` here is the gamma rate parameter,
// which matches this module's `Gamma(shape, rate)` posterior math directly
// with no conversion needed.
// `@stdlib/random/base/beta(alpha, beta)` uses the standard two-shape-
// parameter Beta convention, matching `Beta(alpha, beta)` directly.

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))
  return sorted[idx] as number
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

interface SampledVariant {
  key: string
  exposed: number
  samples: number[]
}

/**
 * Shared assembly step: given, per variant, a full Monte-Carlo sample array
 * from that variant's posterior, computes the metric value (posterior
 * mean), 95% credible interval, probability-to-be-best (fraction of draws
 * where this variant's sample is the max across all variants, drawn
 * pairwise per Monte-Carlo iteration), uplift vs. the control (first
 * variant by convention), and an overall winner if one variant clears the
 * threshold.
 */
function assembleResults(variants: SampledVariant[]): {
  results: VariantResult[]
  winner?: string
} {
  if (variants.length === 0) return { results: [] }

  const n = variants[0]?.samples.length ?? 0
  const wins = new Array(variants.length).fill(0)
  for (let i = 0; i < n; i++) {
    let bestIdx = 0
    let bestVal = Number.NEGATIVE_INFINITY
    for (let v = 0; v < variants.length; v++) {
      const sample = variants[v]?.samples[i] ?? 0
      if (sample > bestVal) {
        bestVal = sample
        bestIdx = v
      }
    }
    wins[bestIdx] += 1
  }

  const controlMean = mean(variants[0]?.samples ?? [])

  const results: VariantResult[] = variants.map((variant, idx) => {
    const sorted = [...variant.samples].sort((a, b) => a - b)
    const metricValue = mean(variant.samples)
    const upliftVsControl =
      idx === 0 || controlMean === 0 ? 0 : (metricValue - controlMean) / controlMean
    return {
      variant: variant.key,
      exposed: variant.exposed,
      metricValue,
      credibleInterval: [quantile(sorted, 0.025), quantile(sorted, 0.975)],
      probabilityToBeBest: (wins[idx] ?? 0) / n,
      upliftVsControl,
    }
  })

  const best = results.reduce(
    (acc, r) => (r.probabilityToBeBest > acc.probabilityToBeBest ? r : acc),
    results[0] as VariantResult,
  )
  const winner = best.probabilityToBeBest >= WINNER_PROBABILITY_THRESHOLD ? best.variant : undefined

  return winner === undefined ? { results } : { results, winner }
}

/**
 * Beta-Binomial conjugate results for funnel/retention metrics.
 * Posterior per variant: Beta(1 + converted, 1 + (exposed - converted)).
 * First variant in the array is treated as control (convention).
 */
export function betaBinomialResults(
  variants: BetaBinomialInput[],
  opts?: { seed?: number; samples?: number },
): { results: VariantResult[]; winner?: string } {
  const rand = betaRandomFactory.factory({ seed: opts?.seed ?? DEFAULT_SEED })
  const sampleCount = opts?.samples ?? MONTE_CARLO_SAMPLES

  const sampled: SampledVariant[] = variants.map((variant) => {
    const alpha = 1 + variant.converted
    const beta = 1 + Math.max(0, variant.exposed - variant.converted)
    const samples = new Array(sampleCount)
    for (let i = 0; i < sampleCount; i++) {
      samples[i] = rand(alpha, beta)
    }
    return { key: variant.key, exposed: variant.exposed, samples }
  })

  return assembleResults(sampled)
}

/**
 * Gamma-Poisson conjugate results for mean/ratio metrics.
 * Posterior per variant (per-exposed-user rate): Gamma(shape = 1 +
 * totalCount, rate = 1 + exposed). First variant in the array is treated as
 * control (convention).
 */
export function gammaPoissonResults(
  variants: GammaPoissonInput[],
  opts?: { seed?: number; samples?: number },
): { results: VariantResult[]; winner?: string } {
  const rand = gammaRandomFactory.factory({ seed: opts?.seed ?? DEFAULT_SEED })
  const sampleCount = opts?.samples ?? MONTE_CARLO_SAMPLES

  const sampled: SampledVariant[] = variants.map((variant) => {
    const shape = 1 + variant.totalCount
    const rate = 1 + variant.exposed
    const samples = new Array(sampleCount)
    for (let i = 0; i < sampleCount; i++) {
      samples[i] = rand(shape, rate)
    }
    return { key: variant.key, exposed: variant.exposed, samples }
  })

  return assembleResults(sampled)
}

/**
 * Gamma-Poisson conjugate results for `ratio` metrics — a true ratio of two
 * independent per-user counts (e.g. purchases / views), not a single count.
 * A ratio metric's own posterior isn't a single conjugate distribution, so
 * this samples each variant's numerator rate and denominator rate from their
 * *independent* Gamma-Poisson posteriors (same shape/rate convention as
 * `gammaPoissonResults`) and divides them per Monte-Carlo draw — the
 * resulting `ratio = numeratorRate / denominatorRate` samples are what feed
 * `assembleResults`' metricValue/credibleInterval/probabilityToBeBest, so
 * uncertainty from *both* counts propagates into the ratio correctly instead
 * of naively dividing two independently-computed point estimates or
 * intervals. First variant in the array is treated as control (convention).
 */
export function gammaRatioResults(
  variants: GammaRatioInput[],
  opts?: { seed?: number; samples?: number },
): { results: VariantResult[]; winner?: string } {
  const rand = gammaRandomFactory.factory({ seed: opts?.seed ?? DEFAULT_SEED })
  const sampleCount = opts?.samples ?? MONTE_CARLO_SAMPLES

  const sampled: SampledVariant[] = variants.map((variant) => {
    const numeratorShape = 1 + variant.numeratorCount
    const numeratorRate = 1 + variant.exposed
    const denominatorShape = 1 + variant.denominatorCount
    const denominatorRate = 1 + variant.exposed
    const samples = new Array(sampleCount)
    for (let i = 0; i < sampleCount; i++) {
      const numeratorSample = rand(numeratorShape, numeratorRate)
      const denominatorSample = rand(denominatorShape, denominatorRate)
      // Gamma support is (0, Infinity) so denominatorSample === 0 is a
      // measure-zero event in theory; guard anyway so a pathological draw
      // can't produce Infinity/NaN and poison the mean/quantile math.
      samples[i] = denominatorSample > 0 ? numeratorSample / denominatorSample : 0
    }
    return { key: variant.key, exposed: variant.exposed, samples }
  })

  return assembleResults(sampled)
}
