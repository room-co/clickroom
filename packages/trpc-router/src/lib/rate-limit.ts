/**
 * Fixed-window rate limiter for the admin console's auth-sensitive tRPC
 * procedures. Redis-backed (`INCR` + `PEXPIRE` on first hit) so the
 * limit holds across API processes, mirroring the pattern the rest of this
 * repo already uses for Redis-backed caching (./redis.ts).
 *
 * Unlike the tenant-facing auth flow, admin limiters are NOT gated behind a
 * bare `NODE_ENV` check: a brute-force guard that no-opts outside production
 * is exactly the gap that reaches production (this is the reference implementation's own stated
 * rationale for its admin TOTP limiters, and applies it to
 * the admin sign-in limiter too — every admin limiter here opts out only via
 * `ADMIN_2FA_RATE_LIMIT_DISABLED=true`, meant for tests).
 */
import { TRPCError } from '@trpc/server'
import { redis } from './redis.js'

export class RateLimiter {
  constructor(
    private readonly opts: {
      name: string
      windowMs: number
      max: number
      disabled?: boolean
    },
  ) {}

  /** Throws TOO_MANY_REQUESTS if `key` has exceeded `max` hits within the window. */
  async check(key: string): Promise<void> {
    if (this.opts.disabled) return

    const redisKey = `rl:${this.opts.name}:${key}`
    let count: number
    try {
      count = await redis.incr(redisKey)
      if (count === 1) {
        await redis.pexpire(redisKey, this.opts.windowMs)
      }
    } catch {
      // Redis unreachable: fail open rather than lock every admin out of the
      // console because a cache dependency is down.
      return
    }

    if (count > this.opts.max) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many requests. Please try again later.',
      })
    }
  }

  /** Reset the counter for a key (e.g. after a successful login). */
  async reset(key: string): Promise<void> {
    try {
      await redis.del(`rl:${this.opts.name}:${key}`)
    } catch {
      // Best-effort; a stale counter just means a slightly stricter window.
    }
  }
}

const twoFaDisabled = process.env.ADMIN_2FA_RATE_LIMIT_DISABLED === 'true'

/** admin sign-in: 5 attempts per IP per 15 minutes. */
export const adminSignInLimiter = new RateLimiter({
  name: 'admin-signin-ip',
  windowMs: 15 * 60_000,
  max: 5,
  disabled: twoFaDisabled,
})

/** admin TOTP/recovery-code verification: 5 attempts per admin user per 15 minutes. */
export const adminTotpUserLimiter = new RateLimiter({
  name: 'admin-totp-user',
  windowMs: 15 * 60_000,
  max: 5,
  disabled: twoFaDisabled,
})

/** admin TOTP/recovery-code verification: 20 attempts per IP per 15 minutes. */
export const adminTotpIpLimiter = new RateLimiter({
  name: 'admin-totp-ip',
  windowMs: 15 * 60_000,
  max: 20,
  disabled: twoFaDisabled,
})
