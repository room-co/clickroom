import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encryptApiKey } from './crypto.js'
import { CHEAP_MODELS, createAIProvider, DEFAULT_MODELS, UnifiedAIProvider } from './provider.js'
import type { AIProviderName } from './types.js'

describe('provider defaults', () => {
  it('defaults the Anthropic model to claude-opus-4-8', () => {
    expect(DEFAULT_MODELS.anthropic).toBe('claude-opus-4-8')
  })

  it('defaults the Anthropic cheap model to claude-haiku-4-5', () => {
    expect(CHEAP_MODELS.anthropic).toBe('claude-haiku-4-5')
  })
})

describe('UnifiedAIProvider construction', () => {
  it.each<AIProviderName>([
    'anthropic',
    'openai',
    'google',
  ])('builds a %s client without throwing', (provider) => {
    expect(() => new UnifiedAIProvider({ provider, apiKey: 'test-key-not-real' })).not.toThrow()
  })

  it('falls back to anthropic and its default model when unset', () => {
    const provider = new UnifiedAIProvider({ apiKey: 'test-key-not-real' })
    expect(provider.providerName).toBe('anthropic')
    expect(provider.modelId).toBe(DEFAULT_MODELS.anthropic)
  })

  it('uses a caller-supplied model id over the default', () => {
    const provider = new UnifiedAIProvider({
      provider: 'openai',
      apiKey: 'test-key-not-real',
      model: 'gpt-4o-mini',
    })
    expect(provider.modelId).toBe('gpt-4o-mini')
  })
})

describe('createAIProvider', () => {
  const originalKey = process.env.AI_ENCRYPTION_KEY

  beforeEach(() => {
    process.env.AI_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex')
  })

  afterEach(() => {
    if (originalKey === undefined) delete process.env.AI_ENCRYPTION_KEY
    else process.env.AI_ENCRYPTION_KEY = originalKey
  })

  it.each<AIProviderName>([
    'anthropic',
    'openai',
    'google',
  ])('builds a working %s client from encrypted org settings', (provider) => {
    const apiKey = encryptApiKey('test-key-not-real')
    const aiProvider = createAIProvider({ provider, api_key_encrypted: apiKey })
    expect(aiProvider.providerName).toBe(provider)
    expect(aiProvider.modelId).toBe(DEFAULT_MODELS[provider])
  })

  it('throws fast when AI_ENCRYPTION_KEY is missing, not a silent no-op', () => {
    const apiKey = encryptApiKey('test-key-not-real')
    delete process.env.AI_ENCRYPTION_KEY
    expect(() => createAIProvider({ provider: 'anthropic', api_key_encrypted: apiKey })).toThrow(
      'AI_ENCRYPTION_KEY not set',
    )
  })
})
