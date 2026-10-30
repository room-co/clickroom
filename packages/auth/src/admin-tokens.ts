import { randomBytes } from 'node:crypto'
import { jwtVerify, SignJWT } from 'jose'

export const ADMIN_ACCESS_TOKEN_TTL_SECONDS = 15 * 60
export const ADMIN_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
export const ADMIN_REFRESH_TOKEN_COOKIE = 'clickroom_admin_rt'

export const ADMIN_2FA_CHALLENGE_TTL_SECONDS = 5 * 60

const ADMIN_ACCESS_AUDIENCE = 'admin'
const ADMIN_REFRESH_AUDIENCE = 'admin-refresh'
const ADMIN_2FA_AUDIENCE = 'admin-2fa'

export interface AdminAccessTokenPayload {
  sub: string // AdminUser id
  email: string
}

export interface AdminRefreshTokenPayload {
  sub: string // AdminUser id
  jti: string
}

export interface Admin2faChallengePayload {
  sub: string // AdminUser id
  email: string
  purpose: 'verify' | 'enroll'
  bind: string // pins the challenge to the admin's current 2FA state
  jti: string
}

function secret(jwtSecret: string): Uint8Array {
  return new TextEncoder().encode(jwtSecret)
}

export async function signAdminAccessToken(
  payload: AdminAccessTokenPayload,
  jwtSecret: string,
): Promise<string> {
  return new SignJWT({ email: payload.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setAudience(ADMIN_ACCESS_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ADMIN_ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secret(jwtSecret))
}

export async function verifyAdminAccessToken(
  token: string,
  jwtSecret: string,
): Promise<AdminAccessTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret(jwtSecret), {
      audience: ADMIN_ACCESS_AUDIENCE,
    })
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') return null
    return { sub: payload.sub, email: payload.email }
  } catch {
    return null
  }
}

export async function signAdminRefreshToken(
  payload: AdminRefreshTokenPayload,
  jwtSecret: string,
): Promise<string> {
  return new SignJWT({ jti: payload.jti })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setAudience(ADMIN_REFRESH_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ADMIN_REFRESH_TOKEN_TTL_SECONDS}s`)
    .sign(secret(jwtSecret))
}

export async function verifyAdminRefreshToken(
  token: string,
  jwtSecret: string,
): Promise<AdminRefreshTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret(jwtSecret), {
      audience: ADMIN_REFRESH_AUDIENCE,
    })
    if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string') return null
    return { sub: payload.sub, jti: payload.jti }
  } catch {
    return null
  }
}

export function generateAdminRefreshJti(): string {
  return randomBytes(16).toString('hex')
}

export async function signAdmin2faChallenge(
  payload: Admin2faChallengePayload,
  jwtSecret: string,
): Promise<string> {
  return new SignJWT({
    email: payload.email,
    purpose: payload.purpose,
    bind: payload.bind,
    jti: payload.jti,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setAudience(ADMIN_2FA_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ADMIN_2FA_CHALLENGE_TTL_SECONDS}s`)
    .sign(secret(jwtSecret))
}

export async function verifyAdmin2faChallenge(
  token: string,
  jwtSecret: string,
): Promise<Admin2faChallengePayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret(jwtSecret), {
      audience: ADMIN_2FA_AUDIENCE,
    })
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.email !== 'string' ||
      (payload.purpose !== 'verify' && payload.purpose !== 'enroll') ||
      typeof payload.bind !== 'string' ||
      typeof payload.jti !== 'string'
    ) {
      return null
    }
    return {
      sub: payload.sub,
      email: payload.email,
      purpose: payload.purpose,
      bind: payload.bind,
      jti: payload.jti,
    }
  } catch {
    return null
  }
}
