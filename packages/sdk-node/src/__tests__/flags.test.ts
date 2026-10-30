// Parity check: sdk-node must reuse @clickroom/sdk-js's evaluate/hash, not fork it.
// Same fixture used by packages/sdk-js and Rust — any drift here breaks AC-5/6/7.
import { evaluate, type Flag } from '@clickroom/sdk-js/eval'
import { describe, expect, it } from 'vitest'
import fixture from '../__fixtures__/flag-vectors.json'

interface Vector {
  flag: Flag
  distinct_id: string
  person_properties: Record<string, unknown>
  expected: { enabled: boolean; variant: string | null; payload: unknown }
}

const vectors = (fixture as { vectors: Vector[] }).vectors

describe('sdk-node flag parity vectors (via @clickroom/sdk-js/eval)', () => {
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
