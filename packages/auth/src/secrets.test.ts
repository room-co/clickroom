import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openJson, sealJson } from './secrets.js'

describe('secrets', () => {
  const originalKey = process.env.SSO_SECRETS_KEY

  beforeEach(() => {
    process.env.SSO_SECRETS_KEY = crypto.randomBytes(32).toString('hex')
  })

  afterEach(() => {
    if (originalKey === undefined) delete process.env.SSO_SECRETS_KEY
    else process.env.SSO_SECRETS_KEY = originalKey
  })

  it('round-trips: sealJson then openJson returns the original object', () => {
    const payload = { clientId: 'abc123', clientSecret: 'sk-super-secret', nested: { a: 1 } }
    const sealed = sealJson(payload)
    expect(openJson(sealed)).toEqual(payload)
  })

  it('accepts a base64-encoded 32-byte key', () => {
    process.env.SSO_SECRETS_KEY = crypto.randomBytes(32).toString('base64')
    const payload = { hello: 'world' }
    expect(openJson(sealJson(payload))).toEqual(payload)
  })

  it('produces a different sealed value on every call (random iv)', () => {
    const payload = { a: 1 }
    expect(sealJson(payload)).not.toBe(sealJson(payload))
  })

  it('encodes iv:ciphertext:tag as base64 segments joined by colons', () => {
    const sealed = sealJson({ a: 1 })
    const parts = sealed.split(':')
    expect(parts).toHaveLength(3)
    for (const part of parts) {
      expect(() => Buffer.from(part, 'base64')).not.toThrow()
    }
  })

  it('sealJson throws fast when SSO_SECRETS_KEY is not set', () => {
    delete process.env.SSO_SECRETS_KEY
    expect(() => sealJson({ a: 1 })).toThrow('SSO_SECRETS_KEY not set')
  })

  it('openJson throws fast when SSO_SECRETS_KEY is not set', () => {
    const sealed = sealJson({ a: 1 })
    delete process.env.SSO_SECRETS_KEY
    expect(() => openJson(sealed)).toThrow('SSO_SECRETS_KEY not set')
  })

  it('throws when SSO_SECRETS_KEY does not decode to 32 bytes', () => {
    process.env.SSO_SECRETS_KEY = 'too-short'
    expect(() => sealJson({ a: 1 })).toThrow(/32 bytes/)
  })

  it('throws when opening a malformed sealed value', () => {
    expect(() => openJson('not-a-valid-sealed-string')).toThrow('Malformed sealed value')
  })
})
