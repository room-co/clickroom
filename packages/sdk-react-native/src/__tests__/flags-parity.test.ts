// Parity check: sdk-react-native must reuse @clickroom/sdk-js's evaluate/hash, not fork it —
// even though flags here are evaluated remotely at runtime, this fixture proves nothing has drifted
// from the shared source of truth (in case any future local-eval fallback is added).
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

describe('sdk-react-native flag parity vectors (via @clickroom/sdk-js/eval)', () => {
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
