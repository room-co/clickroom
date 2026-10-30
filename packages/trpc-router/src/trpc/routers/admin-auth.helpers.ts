/**
 * Shared building blocks for the two-step admin login flow. Split out of
 * admin-auth.router.ts so each mutation handler stays a short sequence of calls into these.
 *
 * Ported field-for-field from a sibling codebase's admin-auth helpers, adapted to clickroom's plain-string
 * `jwtSecret` signature (vs. an `AdminTokenConfig` object) and camelCase Prisma fields.
 */
import { createHash } from 'node:crypto'
import {
  type Admin2faChallengePayload,
  generateAdminRefreshJti,
  signAdminAccessToken,
  signAdminRefreshToken,
  verifyAdmin2faChallenge,
} from '@clickroom/auth'
import { AdminAuditService, type PrismaClient } from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import type { Response } from 'express'
import { setAdminRefreshCookie } from '../../lib/cookies.js'

export const LOCKOUT_THRESHOLD = 3

export interface AdminUserRow {
  id: string
  email: string
  isDisabled: boolean
  totpSecretEnc: string | null
  totpPendingEnc: string | null
  totpEnrolledAt: Date | null
  failedLoginCount: number
  loginLockedAt: Date | null
}

/** Pins a 2FA challenge to the admin's current TOTP state so it dies the moment that state changes. */
export function hashBind(secret: string | null): string {
  return createHash('sha256')
    .update(secret ?? 'none')
    .digest('hex')
    .slice(0, 16)
}

export async function issueAdminTokens(adminUserId: string, email: string, jwtSecret: string) {
  const accessToken = await signAdminAccessToken({ sub: adminUserId, email }, jwtSecret)
  const refreshToken = await signAdminRefreshToken(
    { sub: adminUserId, jti: generateAdminRefreshJti() },
    jwtSecret,
  )
  return { accessToken, refreshToken }
}

/** Verifies a 2FA challenge token and loads the AdminUser it names, or throws a generic UNAUTHORIZED. */
export async function loadChallengedAdmin(
  prisma: PrismaClient,
  challengeToken: string,
  jwtSecret: string,
  expectedPurpose: 'verify' | 'enroll',
): Promise<{ row: AdminUserRow; challenge: Admin2faChallengePayload }> {
  const fail = () =>
    new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid or expired challenge.' })

  const challenge = await verifyAdmin2faChallenge(challengeToken, jwtSecret)
  if (!challenge || challenge.purpose !== expectedPurpose) throw fail()

  const row = await prisma.adminUser.findUnique({
    where: { id: challenge.sub },
    select: {
      id: true,
      email: true,
      isDisabled: true,
      totpSecretEnc: true,
      totpPendingEnc: true,
      totpEnrolledAt: true,
      failedLoginCount: true,
      loginLockedAt: true,
    },
  })
  if (!row || row.isDisabled || row.loginLockedAt) throw fail()
  if (challenge.bind !== hashBind(row.totpSecretEnc)) throw fail()

  return { row, challenge }
}

export interface AdminSignInCtx {
  prisma: PrismaClient
  res: Response
}

/** Mints tokens, sets the refresh cookie, resets the failure counter, and audits the sign-in. */
export async function completeAdminSignIn(
  ctx: AdminSignInCtx,
  row: { id: string; email: string },
  method: 'totp' | 'recovery' | 'enrollment',
  jwtSecret: string,
): Promise<{ accessToken: string }> {
  const { accessToken, refreshToken } = await issueAdminTokens(row.id, row.email, jwtSecret)
  setAdminRefreshCookie(ctx.res, refreshToken)
  // Deliberately does NOT clear loginLockedAt — a locked account stays locked even after a
  // subsequent correct attempt; only the admin:unlock CLI can clear it.
  await ctx.prisma.adminUser.update({
    where: { id: row.id },
    data: { failedLoginCount: 0, lastLoginAt: new Date() },
  })
  await new AdminAuditService(ctx.prisma).record(row.id, 'admin.login.succeeded', {
    after: { method },
  })
  return { accessToken }
}

async function applyLockoutIfThresholdReached(
  prisma: PrismaClient,
  auditService: AdminAuditService,
  adminUserId: string,
  failedCount: number,
): Promise<void> {
  if (failedCount < LOCKOUT_THRESHOLD) return
  await prisma.adminUser.update({
    where: { id: adminUserId },
    data: { loginLockedAt: new Date() },
  })
  await auditService.record(adminUserId, 'admin.login.locked', {})
}

/**
 * One combined counter across the whole login flow: a wrong password, wrong TOTP code, or wrong
 * recovery code all count against the same limit. At 3 failures the account locks indefinitely.
 */
export async function registerLoginFailure(
  prisma: PrismaClient,
  adminUserId: string,
  auditService: AdminAuditService,
  kind: 'password' | 'totp' | 'recovery',
): Promise<void> {
  const updated = await prisma.adminUser.update({
    where: { id: adminUserId },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true },
  })
  const action = kind === 'password' ? 'admin.login.failed' : 'admin.2fa.verify_failed'
  await auditService.record(adminUserId, action, {
    after: { kind, failedCount: updated.failedLoginCount },
  })
  await applyLockoutIfThresholdReached(prisma, auditService, adminUserId, updated.failedLoginCount)
}
