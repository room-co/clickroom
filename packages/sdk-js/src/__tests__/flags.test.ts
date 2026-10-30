import { describe, expect, it } from 'vitest'
import fixture from '../__fixtures__/flag-vectors.json'
import { evaluate, type Filters, type Flag, hashFlag, inRollout } from '../flags'
import { sha1 } from '../sha1'

interface Vector {
  flag: Flag
  distinct_id: string
  person_properties: Record<string, unknown>
  expected: { enabled: boolean; variant: string | null; payload: unknown }
}

const vectors = (fixture as { vectors: Vector[] }).vectors

describe('sha1', () => {
  it('matches the canonical NIST test vector', () => {
    expect(sha1('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
  })

  it('hashes the empty string correctly', () => {
    expect(sha1('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709')
  })
})

describe('flag parity vectors', () => {
  it(`covers ${vectors.length} vectors`, () => {
    expect(vectors.length).toBeGreaterThan(0)
  })

  for (const [i, v] of vectors.entries()) {
    it(`vector ${i} — ${v.flag.key} / ${v.distinct_id}`, () => {
      const result = evaluate(v.flag, v.distinct_id, v.person_properties)
      expect(result).toEqual(v.expected)
    })
  }
})

describe('value-based (string/number) flags — kind is a pure UI-layer discriminator', () => {
  // Mirrors the production `signup-mode` pattern: NO `multivariate` block; each
  // group's `variant` directly picks the served value, with a catch-all default.
  const numberFilters: Filters = {
    groups: [
      {
        properties: [{ key: 'plan', operator: 'exact', value: 'enterprise' }],
        rollout_percentage: 100,
        variant: 'high',
      },
      { properties: [], rollout_percentage: 100, variant: 'low' },
    ],
    payloads: { low: 10, high: 20 },
  }

  it('evaluate() picks the variant-pinned value and payload (getFeatureFlag/getFeatureFlagPayload pattern)', () => {
    const flag: Flag = { key: 'rate-limit-tier', active: true, filters: numberFilters }
    const result = evaluate(flag, 'user-1', { plan: 'enterprise' })
    expect(result.enabled).toBe(true)
    expect(result.variant).toBe('high')
    expect(result.payload).toBe(20)
  })

  it('evaluate() ignores a top-level `kind` field entirely', () => {
    const withKind: Filters = { ...numberFilters, kind: 'number' } as Filters
    const flagWithoutKind: Flag = { key: 'rate-limit-tier', active: true, filters: numberFilters }
    const flagWithKind: Flag = { key: 'rate-limit-tier', active: true, filters: withKind }

    const distinctId = 'user-42'
    const personProps = { plan: 'enterprise' }
    expect(evaluate(flagWithKind, distinctId, personProps)).toEqual(
      evaluate(flagWithoutKind, distinctId, personProps),
    )

    // Also check the catch-all/default path (no plan match).
    const otherProps = { plan: 'free' }
    expect(evaluate(flagWithKind, distinctId, otherProps)).toEqual(
      evaluate(flagWithoutKind, distinctId, otherProps),
    )
  })
})

describe('hash determinism', () => {
  it('returns the same value for the same inputs', () => {
    const a = hashFlag('flag-x', 'user-42', '')
    const b = hashFlag('flag-x', 'user-42', '')
    expect(a).toBe(b)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThan(1)
  })

  it('evaluate is deterministic across calls', () => {
    const flag: Flag = {
      key: 'det',
      active: true,
      filters: { groups: [{ properties: [], rollout_percentage: 50 }] },
    }
    const first = evaluate(flag, 'someone', {})
    const second = evaluate(flag, 'someone', {})
    expect(first).toEqual(second)
  })
})

describe('inRollout boundaries', () => {
  it('serves nobody at 0% — even the zero bucket', () => {
    expect(inRollout(0, 0)).toBe(false)
    expect(inRollout(0.5, 0)).toBe(false)
  })

  it('serves everyone at 100% — including the max bucket of exactly 1.0', () => {
    expect(inRollout(1, 100)).toBe(true)
    expect(inRollout(0, 100)).toBe(true)
  })

  it('is strict at the boundary — the boundary bucket belongs to the next slice', () => {
    expect(inRollout(0.5, 50)).toBe(false)
    expect(inRollout(0.4999, 50)).toBe(true)
    expect(inRollout(0.3, 30)).toBe(false)
  })
})

describe('AC-6 multivariate distribution (50/50)', () => {
  it('splits within ±2% of 50% over 10000 distinct ids', () => {
    const flag: Flag = {
      key: 'dist-50-50',
      active: true,
      filters: {
        groups: [{ properties: [], rollout_percentage: 100 }],
        multivariate: {
          variants: [
            { key: 'control', rollout_percentage: 50 },
            { key: 'test', rollout_percentage: 50 },
          ],
        },
      },
    }

    const N = 10000
    const counts: Record<string, number> = { control: 0, test: 0 }
    for (let i = 0; i < N; i += 1) {
      const r = evaluate(flag, `user_${i}`, {})
      expect(r.enabled).toBe(true)
      expect(r.variant).not.toBeNull()
      counts[r.variant as string] += 1
    }

    for (const key of ['control', 'test']) {
      const share = counts[key] / N
      expect(Math.abs(share - 0.5)).toBeLessThan(0.02)
    }
  })
})
