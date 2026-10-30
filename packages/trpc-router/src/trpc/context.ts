import {
  DEV_ADMIN_JWT_SECRET,
  resolveSecret,
  verifyAccessToken,
  verifyAdminAccessToken,
} from '@clickroom/auth'
import type { PrismaClient } from '@clickroom/db'
import { requestContextStorage } from '@clickroom/db'
import type { CreateExpressContextOptions } from '@trpc/server/adapters/express'
import { AuthService } from '../services/auth.service.js'

export interface AdminContextUser {
  id: string
  email: string
}

/**
 * Build the tRPC context factory for the Express adapter. Auth precedes org
 * context: this only decodes the access token into `tokenPayload` (or null).
 * The active `orgId`/`orgRole` come from the AsyncLocalStorage store populated
 * by the request-context middleware, read inside `orgScopedProcedure`.
 */
export function makeCreateContext(
  prisma: PrismaClient,
  jwtSecret: string,
  adminJwtSecret = resolveSecret('ADMIN_JWT_SECRET', DEV_ADMIN_JWT_SECRET),
) {
  const authService = new AuthService(prisma, jwtSecret)

  return async function createContext({ req, res }: CreateExpressContextOptions) {
    const authHeader = req.headers.authorization
    const bearerToken =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : null

    // Tenant and admin auth are resolved off the same bearer concurrently — the two identity
    // planes are orthogonal, so there's no reason to pay their latency serially.
    const [tokenPayload, adminAccessPayload] = await Promise.all([
      bearerToken ? verifyAccessToken(bearerToken, jwtSecret) : Promise.resolve(null),
      bearerToken ? verifyAdminAccessToken(bearerToken, adminJwtSecret) : Promise.resolve(null),
    ])
    let resolvedTokenPayload = tokenPayload

    // MCP bearers (`ckmcp_...` project-pinned API keys, OAuth 2.1 access
    // tokens) aren't web-session JWTs, so `verifyAccessToken` above always
    // returns null for them — `request-context.middleware.ts` resolves those
    // into the ALS store instead (`authSource: 'mcp' | 'mcp-oauth'`), which is
    // still readable here since `createContext` runs inside the same
    // `requestContextStorage.run()` call the middleware started. Synthesize an
    // equivalent `tokenPayload` from that store so procedures built on
    // `authedProcedure`/`ctx.tokenPayload.sub` (e.g. flag/experiment/insight
    // audit fields) work identically for MCP callers — no parallel authz path,
    // per loopback-client design.
    if (!resolvedTokenPayload) {
      const reqCtx = requestContextStorage.getStore()
      if (reqCtx?.authSource === 'mcp' || reqCtx?.authSource === 'mcp-oauth') {
        resolvedTokenPayload = { sub: reqCtx.userId, sessionId: '', orgId: reqCtx.orgId }
      }
    }

    // Admin auth is resolved off the same bearer as tenant auth (above) and is orthogonal: a
    // valid tenant token must never satisfy an admin gate and vice versa. Live DB
    // state is re-checked on every request so a disabled, locked, or un-enrolled admin's
    // structurally-valid token goes inert immediately, not just at next refresh.
    let adminUser: AdminContextUser | null = null
    if (adminAccessPayload) {
      const row = await prisma.adminUser.findUnique({
        where: { id: adminAccessPayload.sub },
        select: {
          id: true,
          email: true,
          isDisabled: true,
          totpEnrolledAt: true,
          loginLockedAt: true,
        },
      })
      const totpWaived =
        process.env.ADMIN_DEV_DISABLE_2FA === 'true' && process.env.NODE_ENV !== 'production'
      if (row && !row.isDisabled && (row.totpEnrolledAt || totpWaived) && !row.loginLockedAt) {
        adminUser = { id: row.id, email: row.email }
      }
    }

    return { prisma, req, res, tokenPayload: resolvedTokenPayload, adminUser, authService }
  }
}

export type Context = Awaited<ReturnType<ReturnType<typeof makeCreateContext>>>
