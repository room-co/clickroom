import { describe, expect, it } from 'vitest'
import {
  betaBinomialResults,
  gammaPoissonResults,
  gammaRatioResults,
  modelForMetricType,
} from './experiments.stats.js'

describe('modelForMetricType', () => {
  it('maps funnel/retention to beta-binomial and mean/ratio to gamma-poisson', () => {
    expect(modelForMetricType('funnel')).toBe('beta-binomial')
    expect(modelForMetricType('retention')).toBe('beta-binomial')
    expect(modelForMetricType('mean')).toBe('gamma-poisson')
    expect(modelForMetricType('ratio')).toBe('gamma-poisson')
  })
})

describe('betaBinomialResults', () => {
  const variants = [
    { key: 'control', exposed: 1000, converted: 100 },
    { key: 'test', exposed: 1000, converted: 200 },
  ]

  it('is deterministic for the same seed', () => {
    const runA = betaBinomialResults(variants, { seed: 7 })
    const runB = betaBinomialResults(variants, { seed: 7 })
    expect(runA).toEqual(runB)
  })

  it('gives a higher-converting variant a probabilityToBeBest well above 0.5', () => {
    const { results } = betaBinomialResults(variants, { seed: 7 })
    const control = results.find((r) => r.variant === 'control')
    const test = results.find((r) => r.variant === 'test')
    expect(test?.probabilityToBeBest).toBeGreaterThan(0.5)
    expect(test?.probabilityToBeBest ?? 0).toBeGreaterThan(control?.probabilityToBeBest ?? 1)
  })

  it('reports uplift vs control and a zero uplift for control itself', () => {
    const { results } = betaBinomialResults(variants, { seed: 7 })
    const control = results.find((r) => r.variant === 'control')
    const test = results.find((r) => r.variant === 'test')
    expect(control?.upliftVsControl).toBe(0)
    expect(test?.upliftVsControl ?? 0).toBeGreaterThan(0)
  })

  it('sets winner when probabilityToBeBest clears the threshold (large, clearly separated samples)', () => {
    const clearCut = [
      { key: 'control', exposed: 5000, converted: 500 },
      { key: 'test', exposed: 5000, converted: 1000 },
    ]
    const { winner } = betaBinomialResults(clearCut, { seed: 7 })
    expect(winner).toBe('test')
  })

  it('omits winner when variants are indistinguishable (below threshold)', () => {
    const tooClose = [
      { key: 'control', exposed: 50, converted: 10 },
      { key: 'test', exposed: 50, converted: 11 },
    ]
    const { winner } = betaBinomialResults(tooClose, { seed: 7 })
    expect(winner).toBeUndefined()
  })

  it('returns a valid credible interval bounding the metric value', () => {
    const { results } = betaBinomialResults(variants, { seed: 7 })
    for (const r of results) {
      const [lo, hi] = r.credibleInterval
      expect(lo).toBeLessThanOrEqual(r.metricValue)
      expect(hi).toBeGreaterThanOrEqual(r.metricValue)
      expect(lo).toBeGreaterThanOrEqual(0)
      expect(hi).toBeLessThanOrEqual(1)
    }
  })
})

describe('gammaPoissonResults', () => {
  const variants = [
    { key: 'control', exposed: 1000, totalCount: 1000 },
    { key: 'test', exposed: 1000, totalCount: 2000 },
  ]

  it('is deterministic for the same seed', () => {
    const runA = gammaPoissonResults(variants, { seed: 11 })
    const runB = gammaPoissonResults(variants, { seed: 11 })
    expect(runA).toEqual(runB)
  })

  it('gives the variant with 2x the per-user rate a probabilityToBeBest well above 0.5', () => {
    const { results } = gammaPoissonResults(variants, { seed: 11 })
    const control = results.find((r) => r.variant === 'control')
    const test = results.find((r) => r.variant === 'test')
    expect(test?.probabilityToBeBest).toBeGreaterThan(0.9)
    expect(test?.probabilityToBeBest ?? 0).toBeGreaterThan(control?.probabilityToBeBest ?? 1)
  })

  it('sets winner when clearly separated, omits it when indistinguishable', () => {
    const clearCut = gammaPoissonResults(
      [
        { key: 'control', exposed: 5000, totalCount: 5000 },
        { key: 'test', exposed: 5000, totalCount: 10000 },
      ],
      { seed: 11 },
    )
    expect(clearCut.winner).toBe('test')

    const tooClose = gammaPoissonResults(
      [
        { key: 'control', exposed: 20, totalCount: 20 },
        { key: 'test', exposed: 20, totalCount: 21 },
      ],
      { seed: 11 },
    )
    expect(tooClose.winner).toBeUndefined()
  })
})

describe('gammaRatioResults', () => {
  const variants = [
    { key: 'control', exposed: 1000, numeratorCount: 100, denominatorCount: 1000 },
    { key: 'test', exposed: 1000, numeratorCount: 250, denominatorCount: 1000 },
  ]

  it('is deterministic for the same seed', () => {
    const runA = gammaRatioResults(variants, { seed: 13 })
    const runB = gammaRatioResults(variants, { seed: 13 })
    expect(runA).toEqual(runB)
  })

  it('gives the variant with a higher true numerator/denominator ratio a probabilityToBeBest well above 0.5', () => {
    const { results } = gammaRatioResults(variants, { seed: 13 })
    const control = results.find((r) => r.variant === 'control')
    const test = results.find((r) => r.variant === 'test')
    expect(test?.probabilityToBeBest).toBeGreaterThan(0.9)
    expect(test?.probabilityToBeBest ?? 0).toBeGreaterThan(control?.probabilityToBeBest ?? 1)
    // Sanity check the ratio itself, not just win probability: metricValue
    // should track numeratorCount / denominatorCount roughly.
    expect(test?.metricValue ?? 0).toBeGreaterThan(control?.metricValue ?? 0)
  })

  it('is sensitive to the denominator, not just the numerator (a real ratio, not a raw numerator rate)', () => {
    // Same numerator count in both variants, but 'test' has a much smaller
    // denominator -> a much higher ratio. If the denominator were being
    // dropped (the pre-fix bug), these two variants would look identical.
    const sameNumerator = [
      { key: 'control', exposed: 1000, numeratorCount: 100, denominatorCount: 1000 },
      { key: 'test', exposed: 1000, numeratorCount: 100, denominatorCount: 200 },
    ]
    const { results } = gammaRatioResults(sameNumerator, { seed: 13 })
    const control = results.find((r) => r.variant === 'control')
    const test = results.find((r) => r.variant === 'test')
    expect(test?.metricValue ?? 0).toBeGreaterThan((control?.metricValue ?? 0) * 2)
  })

  it('sets winner when clearly separated, omits it when indistinguishable', () => {
    const clearCut = gammaRatioResults(
      [
        { key: 'control', exposed: 5000, numeratorCount: 500, denominatorCount: 5000 },
        { key: 'test', exposed: 5000, numeratorCount: 1500, denominatorCount: 5000 },
      ],
      { seed: 13 },
    )
    expect(clearCut.winner).toBe('test')

    const tooClose = gammaRatioResults(
      [
        { key: 'control', exposed: 20, numeratorCount: 20, denominatorCount: 20 },
        { key: 'test', exposed: 20, numeratorCount: 21, denominatorCount: 20 },
      ],
      { seed: 13 },
    )
    expect(tooClose.winner).toBeUndefined()
  })

  it('returns a non-negative credible interval bounding the metric value', () => {
    const { results } = gammaRatioResults(variants, { seed: 13 })
    for (const r of results) {
      const [lo, hi] = r.credibleInterval
      expect(lo).toBeLessThanOrEqual(r.metricValue)
      expect(hi).toBeGreaterThanOrEqual(r.metricValue)
      expect(lo).toBeGreaterThanOrEqual(0)
    }
  })
})
