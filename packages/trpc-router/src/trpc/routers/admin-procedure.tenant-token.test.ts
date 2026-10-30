import { issueAccessToken } from '@clickroom/auth'
import type { PrismaClient } from '@clickroom/db'
import type { CreateExpressContextOptions } from '@trpc/server/adapters/express'
import { describe, expect, it } from 'vitest'
import { makeCreateContext } from '../context.js'
import { adminAuthRouter } from './admin-auth.router.js'

/**
 * `adminProcedure` reads ONLY `ctx.adminUser`, never
 * `ctx.tokenPayload` (see the "does not read tokenPayload" comment on
 * `adminProcedure` in ../trpc.ts). A structurally-valid TENANT access token —
 * signed with the ordinary `JWT_SECRET`, verifying fine as a tenant session —
 * must still fail to satisfy an admin-gated procedure, because
 * `context.ts` resolves `ctx.adminUser` from a wholly separate
 * `verifyAdminAccessToken`/`ADMIN_JWT_SECRET` check that a tenant token can
 * never pass (different secret, different `aud`).
 */
describe('adminProcedure vs. a tenant access token', () => {
  const TENANT_JWT_SECRET = 'tenant-jwt-secret-for-test'
  const ADMIN_JWT_SECRET = 'admin-jwt-secret-for-test'

  it('resolves ctx.tokenPayload but leaves ctx.adminUser null for a valid tenant token', async () => {
    const tenantToken = await issueAccessToken(
      { sub: 'user_1', sessionId: 'sess_1', orgId: 'org_1' },
      TENANT_JWT_SECRET,
    )

    // adminUser resolution never touches the DB for a tenant token (verifyAdminAccessToken
    // rejects it on signature/audience before any prisma call), so an unused stub suffices.
    const createContext = makeCreateContext(
      {} as unknown as PrismaClient,
      TENANT_JWT_SECRET,
      ADMIN_JWT_SECRET,
    )

    const req = {
      headers: { authorization: `Bearer ${tenantToken}` },
      cookies: {},
      ip: '127.0.0.1',
    } as unknown as CreateExpressContextOptions['req']
    const res = {} as unknown as CreateExpressContextOptions['res']

    const ctx = await createContext({ req, res } as CreateExpressContextOptions)

    expect(ctx.tokenPayload).toMatchObject({ sub: 'user_1', sessionId: 'sess_1', orgId: 'org_1' })
    expect(ctx.adminUser).toBeNull()
  })

  it('an adminProcedure-gated call with a structurally-valid tenant JWT throws UNAUTHORIZED', async () => {
    const tenantToken = await issueAccessToken(
      { sub: 'user_1', sessionId: 'sess_1', orgId: 'org_1' },
      TENANT_JWT_SECRET,
    )

    const createContext = makeCreateContext(
      {} as unknown as PrismaClient,
      TENANT_JWT_SECRET,
      ADMIN_JWT_SECRET,
    )
    const req = {
      headers: { authorization: `Bearer ${tenantToken}` },
      cookies: {},
      ip: '127.0.0.1',
    } as unknown as CreateExpressContextOptions['req']
    const res = {} as unknown as CreateExpressContextOptions['res']
    const ctx = await createContext({ req, res } as CreateExpressContextOptions)

    // `me` is adminProcedure-gated; ctx.adminUser is null so the middleware must reject
    // before the handler ever touches ctx.prisma.
    await expect(adminAuthRouter.createCaller(ctx).me()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })
})
