import { describe, expect, it } from 'vitest'
import { resolveClickhousePassword } from './client.js'

describe('resolveClickhousePassword', () => {
  it('uses the configured password', () => {
    expect(resolveClickhousePassword({ NODE_ENV: 'production', CLICKHOUSE_PASSWORD: 'x' })).toBe(
      'x',
    )
  })
  it('falls back to the dev default only in development/test', () => {
    expect(resolveClickhousePassword({ NODE_ENV: 'development' })).toBe('clickroom')
    expect(resolveClickhousePassword({ NODE_ENV: 'test' })).toBe('clickroom')
  })
  it('throws in production or when NODE_ENV is unset', () => {
    expect(() => resolveClickhousePassword({ NODE_ENV: 'production' })).toThrow(
      /CLICKHOUSE_PASSWORD/,
    )
    expect(() => resolveClickhousePassword({})).toThrow(/CLICKHOUSE_PASSWORD/)
  })
})
