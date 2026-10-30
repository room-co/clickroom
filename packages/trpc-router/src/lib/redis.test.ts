import { describe, expect, it } from 'vitest'
import { resolveRedisUrl } from './redis.js'

describe('resolveRedisUrl', () => {
  it('prefers a literal REDIS_URL', () => {
    expect(resolveRedisUrl({ REDIS_URL: 'redis://elsewhere:6379', REDIS_HOST: 'ignored' })).toBe(
      'redis://elsewhere:6379',
    )
  })

  it('falls back to the local dev instance when nothing is configured', () => {
    expect(resolveRedisUrl({})).toBe('redis://localhost:6380')
  })

  it('composes a TLS URL with the auth token, as ECS injects it', () => {
    expect(
      resolveRedisUrl({
        REDIS_HOST: 'master.example-redis.use1.cache.amazonaws.com',
        REDIS_PORT: '6379',
        REDIS_TLS: 'true',
        REDIS_AUTH_TOKEN: 'sekret',
      }),
    ).toBe('rediss://:sekret@master.example-redis.use1.cache.amazonaws.com:6379')
  })

  it('percent-encodes token characters that would break the URL', () => {
    expect(
      resolveRedisUrl({ REDIS_HOST: 'cache', REDIS_TLS: 'true', REDIS_AUTH_TOKEN: 'a@b/c:d' }),
    ).toBe('rediss://:a%40b%2Fc%3Ad@cache:6379')
  })

  it('composes a plaintext URL when TLS is off', () => {
    expect(resolveRedisUrl({ REDIS_HOST: 'cache', REDIS_PORT: '6380' })).toBe('redis://cache:6380')
  })
})
