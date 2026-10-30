import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { API_KEY_PREFIX_LENGTH, generateApiKey, hashApiKey, parseMcpApiKey } from './apikey.js'

describe('api keys', () => {
  it('write keys carry the ckw_live_ prefix', () => {
    const { token } = generateApiKey('write')
    expect(token.startsWith('ckw_live_')).toBe(true)
  })

  it('read keys carry the ckr_live_ prefix', () => {
    const { token } = generateApiKey('read')
    expect(token.startsWith('ckr_live_')).toBe(true)
  })

  it('hashApiKey is a deterministic sha256 hex digest', () => {
    const token = 'ckw_live_deadbeef'
    expect(hashApiKey(token)).toBe(hashApiKey(token))
    expect(hashApiKey(token)).toBe(createHash('sha256').update(token).digest('hex'))
    expect(hashApiKey(token)).toHaveLength(64)
  })

  it('keyPrefix length matches the agreed value', () => {
    const { token, keyPrefix } = generateApiKey('write')
    expect(keyPrefix).toHaveLength(API_KEY_PREFIX_LENGTH)
    expect(keyPrefix).toBe(token.slice(0, API_KEY_PREFIX_LENGTH))
  })

  it('generateApiKey().keyHash equals hashApiKey(token)', () => {
    const { token, keyHash } = generateApiKey('read')
    expect(keyHash).toBe(hashApiKey(token))
  })

  it('write/read tokens have a null selector', () => {
    expect(generateApiKey('write').selector).toBeNull()
    expect(generateApiKey('read').selector).toBeNull()
  })
})

describe('mcp api keys', () => {
  it('carries the ckmcp_ prefix and a <selector>.<secret> shape', () => {
    const { token } = generateApiKey('mcp')
    expect(token.startsWith('ckmcp_')).toBe(true)
    const rest = token.slice('ckmcp_'.length)
    const parts = rest.split('.')
    expect(parts).toHaveLength(2)
    expect(parts[0]).toHaveLength(16)
  })

  it('returns a non-null selector matching the token', () => {
    const { token, selector } = generateApiKey('mcp')
    expect(selector).not.toBeNull()
    expect(token).toContain(`ckmcp_${selector}.`)
  })

  it('keyHash is hashApiKey(secret), not hashApiKey(token)', () => {
    const { token, keyHash } = generateApiKey('mcp')
    const parsed = parseMcpApiKey(token)
    expect(parsed).not.toBeNull()
    expect(keyHash).toBe(hashApiKey(parsed!.secret))
    expect(keyHash).not.toBe(hashApiKey(token))
  })

  it('two generated mcp tokens never collide on selector or secret', () => {
    const a = generateApiKey('mcp')
    const b = generateApiKey('mcp')
    expect(a.selector).not.toBe(b.selector)
    expect(a.keyHash).not.toBe(b.keyHash)
  })

  it('parseMcpApiKey splits a valid token into selector + secret', () => {
    const { token, selector } = generateApiKey('mcp')
    const parsed = parseMcpApiKey(token)
    expect(parsed).toEqual({ selector, secret: expect.any(String) })
  })

  it('parseMcpApiKey rejects non-mcp and malformed tokens', () => {
    expect(parseMcpApiKey('ckw_live_deadbeef')).toBeNull()
    expect(parseMcpApiKey('ckmcp_noseparator')).toBeNull()
    expect(parseMcpApiKey('ckmcp_a.b.c')).toBeNull()
    expect(parseMcpApiKey('ckmcp_.secret')).toBeNull()
    expect(parseMcpApiKey('ckmcp_selector.')).toBeNull()
  })
})
