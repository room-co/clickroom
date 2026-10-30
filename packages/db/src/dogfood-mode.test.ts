import { describe, expect, it } from 'vitest'
import { assertFixedModeAllowed } from './dogfood-mode.js'

describe('assertFixedModeAllowed', () => {
  it('refuses fixed mode in production', () => {
    expect(() => assertFixedModeAllowed('fixed', { NODE_ENV: 'production' })).toThrow(/Refusing/)
  })
  it('allows fixed mode in development, test, or when NODE_ENV is unset', () => {
    expect(() => assertFixedModeAllowed('fixed', { NODE_ENV: 'development' })).not.toThrow()
    expect(() => assertFixedModeAllowed('fixed', { NODE_ENV: 'test' })).not.toThrow()
    expect(() => assertFixedModeAllowed('fixed', {})).not.toThrow()
  })
  it('allows generate mode in production', () => {
    expect(() => assertFixedModeAllowed('generate', { NODE_ENV: 'production' })).not.toThrow()
  })
})
