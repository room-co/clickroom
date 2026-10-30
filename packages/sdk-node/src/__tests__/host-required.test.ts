import { describe, expect, it } from 'vitest'
import { ClickroomClient } from '../index'

describe('host option', () => {
  it('is required: no hardcoded cloud default', () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the required type
    expect(() => new ClickroomClient({ writeKey: 'ckw_test' } as any)).toThrow(/host/)
  })
})
