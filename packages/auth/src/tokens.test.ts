import { SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import {
  type AccessTokenPayload,
  generateRefreshToken,
  hashRefreshToken,
  issueAccessToken,
  REFRESH_TOKEN_TTL_SECONDS,
  refreshTokenExpiresAt,
  refreshTokenSelector,
  verifyAccessToken,
  verifyRefreshToken,
} from './tokens.js'

const SECRET = 'test-jwt-secret-please-change'

describe('access tokens', () => {
  it('round-trips a payload with a non-null orgId', async () => {
    const payload: AccessTokenPayload = { sub: 'user_1', sessionId: 'sess_1', orgId: 'org_1' }
    const token = await issueAccessToken(payload, SECRET)
    expect(await verifyAccessToken(token, SECRET)).toEqual(payload)
  })

  it('round-trips a payload with a null orgId', async () => {
    const payload: AccessTokenPayload = { sub: 'user_2', sessionId: 'sess_2', orgId: null }
    const token = await issueAccessToken(payload, SECRET)
    expect(await verifyAccessToken(token, SECRET)).toEqual(payload)
  })

  it('returns null for a wrong secret', async () => {
    const token = await issueAccessToken({ sub: 'u', sessionId: 's', orgId: null }, SECRET)
    expect(await verifyAccessToken(token, 'a-different-secret')).toBeNull()
  })

  it('returns null for a tampered token', async () => {
    const token = await issueAccessToken({ sub: 'u', sessionId: 's', orgId: null }, SECRET)
    const tampered = `${token.slice(0, -2)}xx`
    expect(await verifyAccessToken(tampered, SECRET)).toBeNull()
  })

  it('returns null for an expired token', async () => {
    const secret = new TextEncoder().encode(SECRET)
    const expired = await new SignJWT({ sessionId: 's', orgId: null })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 1000)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(secret)
    expect(await verifyAccessToken(expired, SECRET)).toBeNull()
  })

  it('returns null when the orgId claim key is absent', async () => {
    const secret = new TextEncoder().encode(SECRET)
    const noOrg = await new SignJWT({ sessionId: 's' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u')
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(secret)
    expect(await verifyAccessToken(noOrg, SECRET)).toBeNull()
  })

  it('returns null for garbage input', async () => {
    expect(await verifyAccessToken('not.a.jwt', SECRET)).toBeNull()
  })
})

describe('refresh tokens', () => {
  it('generates an 80-char hex token', () => {
    const token = generateRefreshToken()
    expect(token).toHaveLength(80)
    expect(/^[0-9a-f]{80}$/.test(token)).toBe(true)
  })

  it('selector is the first 32 chars', () => {
    const token = generateRefreshToken()
    expect(refreshTokenSelector(token)).toBe(token.slice(0, 32))
    expect(refreshTokenSelector(token)).toHaveLength(32)
  })

  it('hash verifies for the same token and rejects a different one', async () => {
    const token = generateRefreshToken()
    const hash = await hashRefreshToken(token)
    expect(await verifyRefreshToken(token, hash)).toBe(true)
    expect(await verifyRefreshToken(generateRefreshToken(), hash)).toBe(false)
  })

  it('verifyRefreshToken returns false for a garbage hash', async () => {
    expect(await verifyRefreshToken(generateRefreshToken(), 'garbage')).toBe(false)
  })

  it('expiry is ~REFRESH_TOKEN_TTL_SECONDS in the future', () => {
    const delta = refreshTokenExpiresAt().getTime() - Date.now()
    expect(delta).toBeGreaterThan((REFRESH_TOKEN_TTL_SECONDS - 5) * 1000)
    expect(delta).toBeLessThanOrEqual(REFRESH_TOKEN_TTL_SECONDS * 1000)
  })
})
