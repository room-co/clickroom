/**
 * Admin console auth router.
 *
 * Identity is fully decoupled from tenant `User` / `UserOrgMembership`. Signs JWTs with
 * `ADMIN_JWT_SECRET` and `aud: 'admin'` so tenant tokens cannot cross into admin context (see
 * `../trpc.js`'s `adminProcedure`, which reads only `ctx.adminUser`, never `ctx.tokenPayload`).
 * Refresh tokens live in an httpOnly cookie (`clickroom_admin_rt`); access tokens are short-lived
 * (15 min) and returned in the response body for the SPA to hold in memory only.
 *
 * TOTP 2FA is mandatory: `login` verifies the password but never returns an access token — it
 * returns a short-lived challenge token that must be redeemed via `verifyTotp` /
 * `verifyRecoveryCode` / `enrollTotpConfirm`. There is no signup/register procedure here or
 * anywhere else — admins are provisioned only via `pnpm --filter @clickroom/db admin:create`
 * (see packages/db/src/admin-create.ts). Adapted from
 * a sibling codebase's admin-auth router.
 */
import {
  ADMIN_REFRESH_TOKEN_COOKIE,
  buildOtpauthUri,
  DEV_ADMIN_JWT_SECRET,
  generateAdminRefreshJti,
  generateTotpSecret,
  resolveSecret,
  signAdmin2faChallenge,
  verifyAdminRefreshToken,
  verifyPassword,
  verifyTotp,
} from '@clickroom/auth'
import {
  AdminAuditService,
  AdminRecoveryCodesService,
  decryptTotpSecret,
  encryptTotpSecret,
  type PrismaClient,
} from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { clearAdminRefreshCookie, setAdminRefreshCookie } from '../../lib/cookies.js'
import {
  adminSignInLimiter,
  adminTotpIpLimiter,
  adminTotpUserLimiter,
} from '../../lib/rate-limit.js'
import { adminProcedure, publicProcedure, router } from '../trpc.js'
import {
  completeAdminSignIn,
  hashBind,
  issueAdminTokens,
  loadChallengedAdmin,
  registerLoginFailure,
} from './admin-auth.helpers.js'

// Fails closed: the dev literal is only usable when NODE_ENV is development/test (see
// `@clickroom/auth` resolveSecret); apps/api's env.ts validates the same secret at boot.
const ADMIN_JWT_SECRET = resolveSecret('ADMIN_JWT_SECRET', DEV_ADMIN_JWT_SECRET)

const SIX_DIGIT = /^\d{6}$/
// A valid argon2id hash of an arbitrary string with no corresponding AdminUser row. Compared
// against on every login where the email is missing/disabled so the request pays the same
// argon2 cost as a real attempt — no email-enumeration timing oracle.
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$9KudCrEEwBJJlh1VedhPLg$mYTCznPLuPGiD/l2ktSep8sdB+R4+u2FBQ4ECwWPoQo'

function recoveryCodesService(prisma: PrismaClient) {
  return new AdminRecoveryCodesService(prisma, ADMIN_JWT_SECRET)
}

function deriveIssuer(adminPublicUrl: string | undefined): string {
  if (!adminPublicUrl) return 'Clickroom Admin'
  try {
    return new URL(adminPublicUrl).hostname || 'Clickroom Admin'
  } catch {
    return 'Clickroom Admin'
  }
}

export const adminAuthRouter = router({
  login: publicProcedure
    .input(z.object({ email: z.string().email(), password: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      // Rate-limit by IP first so password compare cost can't be used to amplify attacks.
      const ip = ctx.req.ip ?? 'unknown'
      await adminSignInLimiter.check(ip)

      const email = input.email.toLowerCase()
      const row = await ctx.prisma.adminUser.findUnique({
        where: { email },
        select: {
          id: true,
          email: true,
          passwordHash: true,
          isDisabled: true,
          totpSecretEnc: true,
          totpEnrolledAt: true,
          loginLockedAt: true,
        },
      })

      // Generic error on every failure path — no email enumeration, no disabled/locked-account oracle.
      const fail = () => new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid credentials.' })
      if (!row || row.isDisabled) {
        // Run a dummy verify to equalize timing when the row is missing or disabled.
        await verifyPassword(DUMMY_PASSWORD_HASH, input.password).catch(() => false)
        throw fail()
      }

      // Always run the real compare, even when locked, so a locked account's timing matches a
      // normal wrong-password attempt — an attacker can't distinguish "locked" from "wrong".
      const ok = await verifyPassword(row.passwordHash, input.password)
      if (row.loginLockedAt) throw fail()
      if (!ok) {
        await registerLoginFailure(
          ctx.prisma,
          row.id,
          new AdminAuditService(ctx.prisma),
          'password',
        )
        throw fail()
      }

      // Local-dev-only 2FA bypass — explicit opt-in via ADMIN_DEV_DISABLE_2FA=true, and hard-
      // blocked whenever NODE_ENV=production regardless of that flag. Off by default so a plain
      // checkout, and the test suite (which also runs with NODE_ENV=development), still exercise
      // the real TOTP flow. Skips straight to a signed-in session when enabled.
      if (process.env.ADMIN_DEV_DISABLE_2FA === 'true' && process.env.NODE_ENV !== 'production') {
        const { accessToken } = await completeAdminSignIn(ctx, row, 'enrollment', ADMIN_JWT_SECRET)
        return { status: 'signed_in' as const, accessToken }
      }

      const purpose = row.totpEnrolledAt ? ('verify' as const) : ('enroll' as const)
      const challengeToken = await signAdmin2faChallenge(
        {
          sub: row.id,
          email: row.email,
          purpose,
          bind: hashBind(row.totpSecretEnc),
          jti: generateAdminRefreshJti(),
        },
        ADMIN_JWT_SECRET,
      )
      return {
        status: row.totpEnrolledAt
          ? ('totp_required' as const)
          : ('totp_enrollment_required' as const),
        challengeToken,
      }
    }),

  enrollTotpStart: publicProcedure
    .input(z.object({ challengeToken: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const { row } = await loadChallengedAdmin(
        ctx.prisma,
        input.challengeToken,
        ADMIN_JWT_SECRET,
        'enroll',
      )

      const secretBase32 = generateTotpSecret()
      await ctx.prisma.adminUser.update({
        where: { id: row.id },
        data: { totpPendingEnc: encryptTotpSecret(secretBase32) },
      })

      const issuer = deriveIssuer(process.env.ADMIN_PUBLIC_URL)
      const otpauthUri = buildOtpauthUri({ secret: secretBase32, account: row.email, issuer })

      await new AdminAuditService(ctx.prisma).record(row.id, 'admin.2fa.enrollment_started', {})
      return { secretBase32, otpauthUri }
    }),

  enrollTotpConfirm: publicProcedure
    .input(z.object({ challengeToken: z.string().min(1), code: z.string().regex(SIX_DIGIT) }))
    .mutation(async ({ input, ctx }) => {
      const ip = ctx.req.ip ?? 'unknown'
      await adminTotpIpLimiter.check(ip)
      const auditService = new AdminAuditService(ctx.prisma)

      const { row } = await loadChallengedAdmin(
        ctx.prisma,
        input.challengeToken,
        ADMIN_JWT_SECRET,
        'enroll',
      )
      await adminTotpUserLimiter.check(row.id)

      const secret = row.totpPendingEnc ? decryptTotpSecret(row.totpPendingEnc) : null
      const result = secret
        ? verifyTotp(secret, input.code, { window: 1 })
        : ({ ok: false } as const)
      if (!result.ok) {
        await registerLoginFailure(ctx.prisma, row.id, auditService, 'totp')
        throw new TRPCError({ code: 'UNAUTHORIZED' })
      }

      await ctx.prisma.adminUser.update({
        where: { id: row.id },
        data: {
          totpSecretEnc: row.totpPendingEnc,
          totpPendingEnc: null,
          totpEnrolledAt: new Date(),
          totpLastStep: result.step,
        },
      })

      const recoveryCodes = await recoveryCodesService(ctx.prisma).issue(row.id)
      await auditService.record(row.id, 'admin.2fa.enrolled', {
        after: { recoveryCodesIssued: recoveryCodes.length },
      })

      const { accessToken } = await completeAdminSignIn(ctx, row, 'enrollment', ADMIN_JWT_SECRET)
      return { accessToken, recoveryCodes }
    }),

  verifyTotp: publicProcedure
    .input(z.object({ challengeToken: z.string().min(1), code: z.string().regex(SIX_DIGIT) }))
    .mutation(async ({ input, ctx }) => {
      const ip = ctx.req.ip ?? 'unknown'
      await adminTotpIpLimiter.check(ip)
      const auditService = new AdminAuditService(ctx.prisma)

      const { row } = await loadChallengedAdmin(
        ctx.prisma,
        input.challengeToken,
        ADMIN_JWT_SECRET,
        'verify',
      )
      await adminTotpUserLimiter.check(row.id)

      const secret = row.totpSecretEnc ? decryptTotpSecret(row.totpSecretEnc) : null
      const result = secret
        ? verifyTotp(secret, input.code, { window: 1 })
        : ({ ok: false } as const)
      if (!result.ok) {
        await registerLoginFailure(ctx.prisma, row.id, auditService, 'totp')
        throw new TRPCError({ code: 'UNAUTHORIZED' })
      }

      // Compare-and-swap replay guard: a code is only accepted once, and an older step within
      // the window can't be replayed after a newer one has already been consumed.
      const { count } = await ctx.prisma.adminUser.updateMany({
        where: {
          id: row.id,
          OR: [{ totpLastStep: null }, { totpLastStep: { lt: result.step } }],
        },
        data: { totpLastStep: result.step },
      })
      if (count === 0) {
        await registerLoginFailure(ctx.prisma, row.id, auditService, 'totp')
        throw new TRPCError({ code: 'UNAUTHORIZED' })
      }

      return completeAdminSignIn(ctx, row, 'totp', ADMIN_JWT_SECRET)
    }),

  verifyRecoveryCode: publicProcedure
    .input(z.object({ challengeToken: z.string().min(1), code: z.string().min(8).max(32) }))
    .mutation(async ({ input, ctx }) => {
      const ip = ctx.req.ip ?? 'unknown'
      await adminTotpIpLimiter.check(ip)
      const auditService = new AdminAuditService(ctx.prisma)

      const { row } = await loadChallengedAdmin(
        ctx.prisma,
        input.challengeToken,
        ADMIN_JWT_SECRET,
        'verify',
      )
      await adminTotpUserLimiter.check(row.id)

      const recovery = recoveryCodesService(ctx.prisma)
      const ok = await recovery.consume(row.id, input.code)
      if (!ok) {
        await registerLoginFailure(ctx.prisma, row.id, auditService, 'recovery')
        throw new TRPCError({ code: 'UNAUTHORIZED' })
      }

      const remainingRecoveryCodes = await recovery.countRemaining(row.id)
      await auditService.record(row.id, 'admin.2fa.recovery_code_used', {
        after: { remaining: remainingRecoveryCodes },
      })

      const { accessToken } = await completeAdminSignIn(ctx, row, 'recovery', ADMIN_JWT_SECRET)
      return { accessToken, remainingRecoveryCodes }
    }),

  regenerateRecoveryCodes: adminProcedure
    .input(z.object({ code: z.string().regex(SIX_DIGIT) }))
    .mutation(async ({ input, ctx }) => {
      const row = await ctx.prisma.adminUser.findUnique({
        where: { id: ctx.adminUser.id },
        select: { totpSecretEnc: true },
      })
      const secret = row?.totpSecretEnc ? decryptTotpSecret(row.totpSecretEnc) : null
      const result = secret
        ? verifyTotp(secret, input.code, { window: 1 })
        : ({ ok: false } as const)
      // Re-auth on an already-authenticated admin, not a login attempt — doesn't touch the
      // failedLoginCount lockout counter.
      if (!result.ok) throw new TRPCError({ code: 'UNAUTHORIZED' })

      const recoveryCodes = await recoveryCodesService(ctx.prisma).issue(ctx.adminUser.id)
      await new AdminAuditService(ctx.prisma).record(
        ctx.adminUser.id,
        'admin.2fa.recovery_codes_regenerated',
        { after: { count: recoveryCodes.length } },
      )
      return { recoveryCodes }
    }),

  refresh: publicProcedure.mutation(async ({ ctx }) => {
    const rawToken = ctx.req.cookies?.[ADMIN_REFRESH_TOKEN_COOKIE] as string | undefined
    if (!rawToken) throw new TRPCError({ code: 'UNAUTHORIZED' })

    const payload = await verifyAdminRefreshToken(rawToken, ADMIN_JWT_SECRET)
    if (!payload) throw new TRPCError({ code: 'UNAUTHORIZED' })

    const row = await ctx.prisma.adminUser.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        isDisabled: true,
        totpEnrolledAt: true,
        loginLockedAt: true,
      },
    })
    if (!row || row.isDisabled || !row.totpEnrolledAt || row.loginLockedAt) {
      throw new TRPCError({ code: 'UNAUTHORIZED' })
    }

    // Rotate: every refresh issues a new jti. Old refresh token still validates by signature
    // until expiry — single-use revocation requires a jti store; out of scope
    const { accessToken, refreshToken } = await issueAdminTokens(
      row.id,
      row.email,
      ADMIN_JWT_SECRET,
    )
    setAdminRefreshCookie(ctx.res, refreshToken)
    return { accessToken }
  }),

  me: adminProcedure.query(async ({ ctx }) => {
    const row = await ctx.prisma.adminUser.findUnique({
      where: { id: ctx.adminUser.id },
      select: { fullName: true, totpEnrolledAt: true },
    })
    const recoveryCodesRemaining = await recoveryCodesService(ctx.prisma).countRemaining(
      ctx.adminUser.id,
    )
    return {
      id: ctx.adminUser.id,
      email: ctx.adminUser.email,
      fullName: row?.fullName ?? '',
      twoFactorEnabled: Boolean(row?.totpEnrolledAt),
      recoveryCodesRemaining,
    }
  }),

  logout: adminProcedure.mutation(({ ctx }) => {
    clearAdminRefreshCookie(ctx.res)
    return { ok: true }
  }),
})
