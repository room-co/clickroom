import {
  apiKeyTypePrefix,
  hashApiKey,
  parseMcpApiKey,
  verifyAccessToken,
  verifyMcpAccessToken,
} from '@clickroom/auth'
import { type PrismaClient, requestContextStorage } from '@clickroom/db'
import type { NextFunction, Request, Response } from 'express'

const MCP_TOKEN_PREFIX = apiKeyTypePrefix('mcp')

/**
 * Express middleware that verifies the caller's Bearer token and, when it
 * resolves to an active org (± pinned project), runs the rest of the request
 * inside an AsyncLocalStorage store. tRPC procedures read that store to build
 * the scoped Prisma client and gate permissions.
 *
 * Three bearer shapes are dispatched:
 *  - `ckmcp_<selector>.<secret>` — a project-pinned agent token,
 *    dispatched on its literal prefix.
 *  - an HS256 JWT carrying the `mcp: true` marker claim — an OAuth 2.1
 *    access token minted by `apps/api/src/mcp/oauth`.
 *  - anything else — the existing HS256 JWT web-session access token.
 *
 * The two JWT shapes share a signing secret but never cross-verify: the OAuth
 * token lacks `sessionId` (so `verifyAccessToken` would reject it) and the web
 * session token lacks `mcp: true` (so `verifyMcpAccessToken` rejects it) — see
 * `packages/auth/src/tokens.ts`. `verifyMcpAccessToken` is tried first since
 * its marker claim makes misidentification impossible either way.
 *
 * A JWT that's missing/invalid/orphaned falls through to a plain `next()` —
 * the request proceeds unauthenticated and org-scoped tRPC procedures reject
 * it later (UNAUTHORIZED / FORBIDDEN). A `ckmcp_` token instead responds
 * 401 directly and does NOT call `next()`: unlike the JWT, this prefix is
 * unambiguously an API credential (never "no auth supplied"), and — critically
 * — Express 4 doesn't route rejected promises from async middleware to error
 * handling, so a mid-chain `throw` here would just hang the request.
 */
export function makeRequestContextMiddleware(prisma: PrismaClient, jwtSecret: string) {
  return async function requestContextMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      next()
      return
    }
    const token = authHeader.slice(7)

    if (token.startsWith(MCP_TOKEN_PREFIX)) {
      await runMcpTokenContext(prisma, token, res, next)
      return
    }

    const oauthPayload = await verifyMcpAccessToken(token, jwtSecret)
    if (oauthPayload) {
      await runMcpOAuthContext(prisma, oauthPayload, res, next)
      return
    }

    const payload = await verifyAccessToken(token, jwtSecret)
    if (!payload?.orgId) {
      next()
      return
    }

    const membership = await prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId: payload.orgId, userId: payload.sub } },
      include: { org: { select: { suspendedAt: true } } },
    })
    // A suspended org (admin.orgs.suspendOrg) is rejected here,
    // the one place every org-scoped JWT request already funnels through, so
    // no individual router needs its own suspension check.
    if (!membership || membership.org.suspendedAt) {
      next()
      return
    }

    // An impersonated session must die at its 30-minute cap even
    // though the JWT itself is long-lived (ACCESS_TOKEN_TTL_SECONDS is 7
    // days). `Session.id` is the PK, so this indexed lookup is cheap; it only
    // runs the extra branch when `impersonationExpiresAt` is actually set.
    let impersonatedByAdminId: string | undefined
    if (payload.sessionId) {
      const session = await prisma.session.findUnique({
        where: { id: payload.sessionId },
        select: { impersonatedByAdminId: true, impersonationExpiresAt: true },
      })
      if (session?.impersonationExpiresAt) {
        if (session.impersonationExpiresAt < new Date()) {
          next()
          return
        }
        impersonatedByAdminId = session.impersonatedByAdminId ?? undefined
      }
    }

    requestContextStorage.run(
      {
        userId: payload.sub,
        orgId: payload.orgId,
        orgRole: membership.role,
        authSource: 'jwt',
        impersonatedByAdminId,
      },
      next,
    )
  }
}

/** Send a 401 for a recognized-but-invalid `ckmcp_` token (never calls `next`). */
function rejectMcpToken(res: Response, message: string): void {
  res.status(401).json({ error: { code: 'UNAUTHORIZED', message } })
}

/**
 * Resolve a `ckmcp_` bearer token to its pinned project + acting user and run
 * `next` inside that ALS store. Any recognized-but-invalid token — unparsable
 * shape, unknown selector, bad secret, revoked, expired, orphaned project/user
 * — short-circuits with a 401 instead of falling through to `next()`.
 */
async function runMcpTokenContext(
  prisma: PrismaClient,
  token: string,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const parsed = parseMcpApiKey(token)
  if (!parsed) {
    rejectMcpToken(res, 'Malformed MCP token.')
    return
  }

  const key = await prisma.apiKey.findUnique({ where: { selector: parsed.selector } })
  if (key?.type !== 'mcp' || !key.userId) {
    rejectMcpToken(res, 'Unknown MCP token.')
    return
  }
  if (key.keyHash !== hashApiKey(parsed.secret)) {
    rejectMcpToken(res, 'Invalid MCP token.')
    return
  }
  if (key.revokedAt) {
    rejectMcpToken(res, 'MCP token revoked.')
    return
  }
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) {
    rejectMcpToken(res, 'MCP token expired.')
    return
  }

  const project = await prisma.project.findUnique({ where: { id: key.projectId } })
  if (!project) {
    rejectMcpToken(res, 'MCP token project not found.')
    return
  }

  const membership = await prisma.orgMembership.findUnique({
    where: { orgId_userId: { orgId: project.orgId, userId: key.userId } },
  })
  if (!membership) {
    rejectMcpToken(res, 'MCP token user is not an org member.')
    return
  }

  await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })

  await requestContextStorage.run(
    {
      userId: key.userId,
      orgId: project.orgId,
      orgRole: membership.role,
      projectId: key.projectId,
      authSource: 'mcp',
    },
    next,
  )
}

/**
 * Resolve an OAuth `mcp: true` access token to its `orgId`/`projectId`
 * claims + the acting user's current `OrgMembership.role` (not itself a JWT
 * claim, so it's re-resolved every request — same as the ckmcp_ path — which
 * also means a user removed from the org after the token was issued loses
 * access immediately rather than at token expiry). Same fail-closed 401 shape
 * as `runMcpTokenContext`: this token is unambiguously an API credential, so
 * an orphaned membership responds 401 instead of falling through to `next()`.
 */
async function runMcpOAuthContext(
  prisma: PrismaClient,
  payload: { sub: string; orgId: string; projectId: string },
  res: Response,
  next: NextFunction,
): Promise<void> {
  const membership = await prisma.orgMembership.findUnique({
    where: { orgId_userId: { orgId: payload.orgId, userId: payload.sub } },
  })
  if (!membership) {
    rejectMcpToken(res, 'MCP OAuth token user is not an org member.')
    return
  }

  await requestContextStorage.run(
    {
      userId: payload.sub,
      orgId: payload.orgId,
      orgRole: membership.role,
      projectId: payload.projectId,
      authSource: 'mcp-oauth',
    },
    next,
  )
}
