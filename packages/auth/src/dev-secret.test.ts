import { describe, expect, it } from 'vitest'
import { resolveSecret } from './dev-secret.js'

describe('resolveSecret', () => {
  it('returns the configured value in any environment', () => {
    expect(resolveSecret('X', 'dev', { NODE_ENV: 'production', X: 'real' })).toBe('real')
  })
  it('uses the dev literal only in development/test', () => {
    expect(resolveSecret('X', 'dev', { NODE_ENV: 'development' })).toBe('dev')
    expect(resolveSecret('X', 'dev', { NODE_ENV: 'test' })).toBe('dev')
  })
  it('throws in production, staging and when NODE_ENV is unset', () => {
    for (const NODE_ENV of ['production', 'staging', undefined]) {
      expect(() => resolveSecret('X', 'dev', { NODE_ENV })).toThrow(/X is required/)
    }
    expect(() => resolveSecret('X', 'dev', { NODE_ENV: 'production', X: '' })).toThrow()
  })
})
