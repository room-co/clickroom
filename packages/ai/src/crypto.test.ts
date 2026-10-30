import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decryptApiKey, encryptApiKey } from './crypto.js'

describe('crypto', () => {
  const originalKey = process.env.AI_ENCRYPTION_KEY

  beforeEach(() => {
    process.env.AI_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex')
  })

  afterEach(() => {
    if (originalKey === undefined) delete process.env.AI_ENCRYPTION_KEY
    else process.env.AI_ENCRYPTION_KEY = originalKey
  })

  it('round-trips: encrypt then decrypt returns the original key', () => {
    const apiKey = 'sk-ant-super-secret-key-value'
    const encrypted = encryptApiKey(apiKey)
    expect(decryptApiKey(encrypted)).toBe(apiKey)
  })

  it('produces a different ciphertext on every call (random iv)', () => {
    const apiKey = 'sk-ant-super-secret-key-value'
    expect(encryptApiKey(apiKey)).not.toBe(encryptApiKey(apiKey))
  })

  it('stores iv/ciphertext/tag as base64 in a JSON blob', () => {
    const blob = JSON.parse(encryptApiKey('sk-ant-super-secret-key-value'))
    expect(blob).toMatchObject({
      iv: expect.any(String),
      ciphertext: expect.any(String),
      tag: expect.any(String),
    })
  })

  it('encryptApiKey throws fast when AI_ENCRYPTION_KEY is not set', () => {
    delete process.env.AI_ENCRYPTION_KEY
    expect(() => encryptApiKey('sk-ant-super-secret-key-value')).toThrow(
      'AI_ENCRYPTION_KEY not set',
    )
  })

  it('decryptApiKey throws fast when AI_ENCRYPTION_KEY is not set', () => {
    const encrypted = encryptApiKey('sk-ant-super-secret-key-value')
    delete process.env.AI_ENCRYPTION_KEY
    expect(() => decryptApiKey(encrypted)).toThrow('AI_ENCRYPTION_KEY not set')
  })
})
