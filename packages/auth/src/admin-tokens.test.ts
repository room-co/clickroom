import { describe, expect, it } from 'vitest'
import {
  generateAdminRefreshJti,
  signAdmin2faChallenge,
  signAdminAccessToken,
  signAdminRefreshToken,
  verifyAdmin2faChallenge,
  verifyAdminAccessToken,
  verifyAdminRefreshToken,
} from './admin-tokens.js'

const SECRET = 'test-admin-jwt-secret-please-change'

async function mintAccess(): Promise<string> {
  return signAdminAccessToken({ sub: 'admin_1', email: 'a@x.test' }, SECRET)
}

async function mintRefresh(): Promise<string> {
  return signAdminRefreshToken({ sub: 'admin_1', jti: generateAdminRefreshJti() }, SECRET)
}

async function mint2fa(): Promise<string> {
  return signAdmin2faChallenge(
    {
      sub: 'admin_1',
      email: 'a@x.test',
      purpose: 'verify',
      bind: 'deadbeef',
      jti: generateAdminRefreshJti(),
    },
    SECRET,
  )
}

describe('admin token round trips (same audience)', () => {
  it('access token verifies as an access token', async () => {
    const token = await mintAccess()
    expect(await verifyAdminAccessToken(token, SECRET)).toEqual({
      sub: 'admin_1',
      email: 'a@x.test',
    })
  })

  it('refresh token verifies as a refresh token', async () => {
    const jti = generateAdminRefreshJti()
    const token = await signAdminRefreshToken({ sub: 'admin_1', jti }, SECRET)
    expect(await verifyAdminRefreshToken(token, SECRET)).toEqual({ sub: 'admin_1', jti })
  })

  it('2fa challenge verifies as a 2fa challenge', async () => {
    const jti = generateAdminRefreshJti()
    const token = await signAdmin2faChallenge(
      { sub: 'admin_1', email: 'a@x.test', purpose: 'enroll', bind: 'cafebabe', jti },
      SECRET,
    )
    expect(await verifyAdmin2faChallenge(token, SECRET)).toEqual({
      sub: 'admin_1',
      email: 'a@x.test',
      purpose: 'enroll',
      bind: 'cafebabe',
      jti,
    })
  })
})

// ---------------------------------------------------------------------------
// Audience isolation: a token minted for one stage of the admin login flow
// must be structurally incapable of being replayed at another. All 6
// cross-verify combinations across the 3 audiences (admin / admin-refresh /
// admin-2fa) must return null. This is the
// load-bearing security property of the three-audience design.
// ---------------------------------------------------------------------------
describe('admin token audience isolation (cross-verify must reject)', () => {
  it('access-as-refresh: an access token fails verifyAdminRefreshToken', async () => {
    const token = await mintAccess()
    expect(await verifyAdminRefreshToken(token, SECRET)).toBeNull()
  })

  it('access-as-2fa: an access token fails verifyAdmin2faChallenge', async () => {
    const token = await mintAccess()
    expect(await verifyAdmin2faChallenge(token, SECRET)).toBeNull()
  })

  it('refresh-as-access: a refresh token fails verifyAdminAccessToken', async () => {
    const token = await mintRefresh()
    expect(await verifyAdminAccessToken(token, SECRET)).toBeNull()
  })

  it('refresh-as-2fa: a refresh token fails verifyAdmin2faChallenge', async () => {
    const token = await mintRefresh()
    expect(await verifyAdmin2faChallenge(token, SECRET)).toBeNull()
  })

  it('2fa-as-access: a 2fa challenge token fails verifyAdminAccessToken', async () => {
    const token = await mint2fa()
    expect(await verifyAdminAccessToken(token, SECRET)).toBeNull()
  })

  it('2fa-as-refresh: a 2fa challenge token fails verifyAdminRefreshToken', async () => {
    const token = await mint2fa()
    expect(await verifyAdminRefreshToken(token, SECRET)).toBeNull()
  })
})

describe('admin token misc rejections', () => {
  it('returns null for a wrong secret', async () => {
    const token = await mintAccess()
    expect(await verifyAdminAccessToken(token, 'a-different-secret')).toBeNull()
  })

  it('returns null for a tampered token', async () => {
    const token = await mintAccess()
    const tampered = `${token.slice(0, -2)}xx`
    expect(await verifyAdminAccessToken(tampered, SECRET)).toBeNull()
  })

  it('returns null for garbage input on all three verifiers', async () => {
    expect(await verifyAdminAccessToken('not.a.jwt', SECRET)).toBeNull()
    expect(await verifyAdminRefreshToken('not.a.jwt', SECRET)).toBeNull()
    expect(await verifyAdmin2faChallenge('not.a.jwt', SECRET)).toBeNull()
  })

  it('rejects a 2fa challenge with an invalid purpose claim', async () => {
    // Hand-construct a token with an out-of-union purpose to exercise the
    // payload validation branch (not reachable via the typed sign function).
    const { SignJWT } = await import('jose')
    const secretBytes = new TextEncoder().encode(SECRET)
    const token = await new SignJWT({
      email: 'a@x.test',
      purpose: 'not-a-real-purpose',
      bind: 'deadbeef',
      jti: 'j1',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('admin_1')
      .setAudience('admin-2fa')
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(secretBytes)
    expect(await verifyAdmin2faChallenge(token, SECRET)).toBeNull()
  })

  it('generateAdminRefreshJti produces distinct 32-char hex strings', () => {
    const a = generateAdminRefreshJti()
    const b = generateAdminRefreshJti()
    expect(a).not.toBe(b)
    expect(/^[0-9a-f]{32}$/.test(a)).toBe(true)
  })
})
