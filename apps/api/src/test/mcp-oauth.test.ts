// /rewrite: the OAuth wire format (RFC 7591/8414/9728
// register/authorize/token/metadata) is served by
// `@modelcontextprotocol/sdk`'s own `mcpAuthRouter` (mounted in `main.ts`),
// not hand-rolled here — so this suite exercises the pieces clickroom still
// owns directly: `ClickroomOAuthProvider`'s five `OAuthServerProvider`
// methods, the `mcpOAuth` tRPC router the real `apps/web` consent page
// (`McpConsentPage.tsx`) drives, and `request-context.middleware.ts`
// resolving an SDK-issued access token.
// `client-store.test.ts`/`code-store.test.ts`/`grant-store.test.ts` cover
// the three stores in isolation.
import { createHash, randomBytes } from 'node:crypto'
import { issueAccessToken, verifyMcpAccessToken } from '@clickroom/auth'
import { prisma, requestContextStorage } from '@clickroom/db'
import { appRouter } from '@clickroom/trpc-router'
import { redis } from '@clickroom/trpc-router/lib/redis.js'
import {
  mcpOAuthJwtSecret,
  mcpOAuthStateSecret,
} from '@clickroom/trpc-router/mcp/oauth/mcp-oauth.constants.js'
import {
  InvalidGrantError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'
import { TRPCError } from '@trpc/server'
import { SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ClickroomOAuthProvider } from '../mcp/oauth/mcp-oauth.provider.js'
import { makeRequestContextMiddleware } from '../request-context/request-context.middleware.js'
import { authService, cleanupOrg, cleanupUser, makeCtx } from './helpers.js'

const JWT_SECRET = mcpOAuthJwtSecret()

const suffix = Date.now().toString(36)
const createdUserIds: string[] = []
const createdOrgIds: string[] = []

let userId: string
let orgId: string
let projectId: string
let sessionToken: string

const provider = new ClickroomOAuthProvider(prisma, redis, {
  jwtSecret: JWT_SECRET,
  stateSecret: mcpOAuthStateSecret(),
  webPublicUrl: 'http://localhost:5180',
})

// The consent screen runs under `authedProcedure` (real web-session bearer),
// so tests drive it via `appRouter.createCaller` the same way `mcp.test.ts` does.
function callerFor(uid: string | null) {
  return appRouter.createCaller(
    makeCtx({ tokenPayload: uid ? { sub: uid, sessionId: 'test-session', orgId } : null }),
  )
}

beforeAll(async () => {
  const s = await authService.signup({
    email: `mcp-oauth-admin-${suffix}@test.invalid`,
    password: 'password123',
    orgName: `MCP OAuth Org ${suffix}`,
  })
  userId = s.user.id
  orgId = s.org!.id
  createdUserIds.push(userId)
  createdOrgIds.push(orgId)

  const project = await prisma.project.findFirstOrThrow({ where: { orgId } })
  projectId = project.id

  // The "logged-in web session" bearer the consent screen identifies the
  // user with — same shape auth.router.ts issues on login (sub/sessionId/orgId).
  sessionToken = await issueAccessToken(
    { sub: userId, sessionId: 'test-session', orgId },
    JWT_SECRET,
  )
})

afterAll(async () => {
  await prisma.mcpOAuthRefreshToken.deleteMany({ where: { orgId } })
  await prisma.mcpOAuthClient.deleteMany({ where: { clientName: { contains: suffix } } })
  for (const oid of createdOrgIds) await cleanupOrg(oid)
  for (const uid of createdUserIds) await cleanupUser(uid)
  await redis.quit()
  await prisma.$disconnect()
})

// --- Express req/res test doubles -------------------------------------------

interface ResState {
  statusCode: number
  body?: unknown
  redirectLocation?: string
}

function makeRes() {
  const state: ResState = { statusCode: 200 }
  // biome-ignore lint/suspicious/noExplicitAny: minimal Express Response stub
  const res: any = {
    status(code: number) {
      state.statusCode = code
      return res
    },
    json(body: unknown) {
      state.body = body
      return res
    },
    redirect(codeOrUrl: number | string, maybeUrl?: string) {
      if (typeof codeOrUrl === 'number') {
        state.statusCode = codeOrUrl
        state.redirectLocation = maybeUrl
      } else {
        state.statusCode = 302
        state.redirectLocation = codeOrUrl
      }
      return res
    },
  }
  return { res, state }
}

// --- PKCE helpers ------------------------------------------------------------

function makePkcePair() {
  const codeVerifier = randomBytes(32).toString('hex')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  return { codeVerifier, codeChallenge }
}

async function registerTestClient(clientName: string): Promise<OAuthClientInformationFull> {
  return provider.clientsStore.registerClient({
    redirect_uris: ['http://127.0.0.1:9999/callback'],
    client_name: clientName,
  })
}

/** Drives `provider.authorize()` → the real `mcpOAuth` tRPC procedures →
 * a minted authorization code, exactly as `McpConsentPage.tsx` would (minus
 * the actual HTTP hop — this suite calls the router caller directly). */
async function fullAuthorize(client: OAuthClientInformationFull) {
  const { codeVerifier, codeChallenge } = makePkcePair()
  const state = `state-${randomBytes(4).toString('hex')}`

  const authorizeRes = makeRes()
  await provider.authorize(
    client,
    { redirectUri: client.redirect_uris[0]!, codeChallenge, state, scopes: ['mcp'] },
    authorizeRes.res,
  )
  expect(authorizeRes.state.statusCode).toBe(302)
  const consentUrl = new URL(authorizeRes.state.redirectLocation as string, 'http://localhost')
  expect(consentUrl.pathname).toBe('/oauth/mcp/consent')
  const req = consentUrl.searchParams.get('req')
  expect(req).toBeTruthy()

  const caller = callerFor(userId)
  const info = await caller.mcpOAuth.consentInfo({ req: req as string })
  expect(info.projects.some((p) => p.projectId === projectId)).toBe(true)

  const { redirectTo } = await caller.mcpOAuth.approve({ req: req as string, projectId })
  const location = new URL(redirectTo)
  expect(location.searchParams.get('state')).toBe(state)
  const code = location.searchParams.get('code')
  expect(code).toBeTruthy()

  return { code: code as string, codeVerifier, state }
}

describe('McpOAuthClientStore (via the provider)', () => {
  it('registers a public (PKCE-only) client with no client_secret field at all', async () => {
    const client = await registerTestClient(`register-${suffix}`)
    expect(client.client_id).toMatch(/^mcp_client_/)
    expect(client.token_endpoint_auth_method).toBe('none')
    // The bug this rewrite fixes: `client_secret` must be OMITTED, not a bare `null`.
    expect('client_secret' in client).toBe(false)
  })
})

describe('authorize → consent (web app) → code → token round trip', () => {
  it('redirects authorize() to the real web-app consent page', async () => {
    const client = await registerTestClient(`redirect-${suffix}`)
    const { codeChallenge } = makePkcePair()
    const authorizeRes = makeRes()
    await provider.authorize(
      client,
      { redirectUri: client.redirect_uris[0]!, codeChallenge, state: 'xyz', scopes: ['mcp'] },
      authorizeRes.res,
    )
    const location = authorizeRes.state.redirectLocation as string
    expect(location.startsWith('http://localhost:5180/oauth/mcp/consent?req=')).toBe(true)
  })

  it('completes the consent flow and issues a scoped access token', async () => {
    const client = await registerTestClient(`roundtrip-${suffix}`)
    const { code, codeVerifier, state } = await fullAuthorize(client)
    expect(state).toBeTruthy()

    await expect(provider.challengeForAuthorizationCode(client, code)).resolves.not.toBe('')

    const tokens = await provider.exchangeAuthorizationCode(
      client,
      code,
      codeVerifier,
      client.redirect_uris[0],
    )
    expect(tokens.token_type).toBe('bearer')
    expect(tokens.access_token).toBeTruthy()
    expect(tokens.refresh_token).toBeTruthy()

    const claims = await verifyMcpAccessToken(tokens.access_token, JWT_SECRET)
    expect(claims).toMatchObject({
      sub: userId,
      orgId,
      projectId,
      clientId: client.client_id,
      mcp: true,
    })
  })

  it('a code cannot be redeemed twice', async () => {
    const client = await registerTestClient(`replay-${suffix}`)
    const { code, codeVerifier } = await fullAuthorize(client)

    await provider.exchangeAuthorizationCode(client, code, codeVerifier, client.redirect_uris[0])
    await expect(
      provider.exchangeAuthorizationCode(client, code, codeVerifier, client.redirect_uris[0]),
    ).rejects.toThrow(InvalidGrantError)
  })

  it('rejects a code minted for a different client', async () => {
    const client = await registerTestClient(`mismatch-${suffix}`)
    const otherClient = await registerTestClient(`other-${suffix}`)
    const { code, codeVerifier } = await fullAuthorize(client)

    await expect(
      provider.exchangeAuthorizationCode(
        otherClient,
        code,
        codeVerifier,
        otherClient.redirect_uris[0],
      ),
    ).rejects.toThrow(InvalidGrantError)
  })

  it('consentInfo lists the projects the user may authorize against', async () => {
    const client = await registerTestClient(`picker-${suffix}`)
    const { codeChallenge } = makePkcePair()

    const authorizeRes = makeRes()
    await provider.authorize(
      client,
      { redirectUri: client.redirect_uris[0]!, codeChallenge, state: 'xyz', scopes: ['mcp'] },
      authorizeRes.res,
    )
    const req = new URL(
      authorizeRes.state.redirectLocation as string,
      'http://localhost',
    ).searchParams.get('req')

    const info = await callerFor(userId).mcpOAuth.consentInfo({ req: req as string })
    expect(info.clientName).toBe(`picker-${suffix}`)
    expect(info.projects.map((p) => p.projectId)).toContain(projectId)
  })

  it('an unauthenticated consentInfo request is rejected', async () => {
    const client = await registerTestClient(`unauth-${suffix}`)
    const { codeChallenge } = makePkcePair()

    const authorizeRes = makeRes()
    await provider.authorize(
      client,
      { redirectUri: client.redirect_uris[0]!, codeChallenge, state: 'xyz', scopes: ['mcp'] },
      authorizeRes.res,
    )
    const req = new URL(
      authorizeRes.state.redirectLocation as string,
      'http://localhost',
    ).searchParams.get('req')

    await expect(callerFor(null).mcpOAuth.consentInfo({ req: req as string })).rejects.toThrow(
      TRPCError,
    )
  })

  it('deny redirects back with access_denied and preserves state', async () => {
    const client = await registerTestClient(`deny-${suffix}`)
    const { codeChallenge } = makePkcePair()
    const authorizeRes = makeRes()
    await provider.authorize(
      client,
      {
        redirectUri: client.redirect_uris[0]!,
        codeChallenge,
        state: 'deny-state',
        scopes: ['mcp'],
      },
      authorizeRes.res,
    )
    const req = new URL(
      authorizeRes.state.redirectLocation as string,
      'http://localhost',
    ).searchParams.get('req')

    const { redirectTo } = await callerFor(userId).mcpOAuth.deny({ req: req as string })
    const location = new URL(redirectTo)
    expect(location.searchParams.get('error')).toBe('access_denied')
    expect(location.searchParams.get('state')).toBe('deny-state')
  })

  it('approve rejects a projectId the user is not a member of', async () => {
    const client = await registerTestClient(`forbidden-${suffix}`)
    const { codeChallenge } = makePkcePair()
    const authorizeRes = makeRes()
    await provider.authorize(
      client,
      { redirectUri: client.redirect_uris[0]!, codeChallenge, state: 'xyz', scopes: ['mcp'] },
      authorizeRes.res,
    )
    const req = new URL(
      authorizeRes.state.redirectLocation as string,
      'http://localhost',
    ).searchParams.get('req')

    await expect(
      callerFor(userId).mcpOAuth.approve({ req: req as string, projectId: 'not-a-real-project' }),
    ).rejects.toThrow(TRPCError)
  })
})

describe('refresh_token grant', () => {
  it('issues a new access token and rotates the refresh token', async () => {
    const client = await registerTestClient(`refresh-${suffix}`)
    const { code, codeVerifier } = await fullAuthorize(client)
    const first = await provider.exchangeAuthorizationCode(
      client,
      code,
      codeVerifier,
      client.redirect_uris[0],
    )

    // Give the new access token a distinguishable `iat` from the refreshed one.
    await new Promise((r) => setTimeout(r, 1100))

    const refreshed = await provider.exchangeRefreshToken(client, first.refresh_token as string)
    expect(refreshed.access_token).toBeTruthy()
    expect(refreshed.access_token).not.toBe(first.access_token)
    expect(refreshed.refresh_token).not.toBe(first.refresh_token)

    const claims = await verifyMcpAccessToken(refreshed.access_token, JWT_SECRET)
    expect(claims).toMatchObject({ sub: userId, orgId, projectId, clientId: client.client_id })

    // The rotated-away refresh token must no longer work.
    await expect(
      provider.exchangeRefreshToken(client, first.refresh_token as string),
    ).rejects.toThrow(InvalidGrantError)
  })

  it('an unknown refresh token is rejected', async () => {
    const client = await registerTestClient(`refresh-unknown-${suffix}`)
    await expect(provider.exchangeRefreshToken(client, 'not-a-real-token')).rejects.toThrow(
      InvalidGrantError,
    )
  })
})

describe('verifyAccessToken / revokeToken', () => {
  it('rejects an expired access token', async () => {
    const expired = await new SignJWT({ orgId, projectId, clientId: 'mcp_client_x', mcp: true })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 1000)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(new TextEncoder().encode(JWT_SECRET))

    await expect(provider.verifyAccessToken(expired)).rejects.toThrow(InvalidTokenError)
  })

  it('rejects a garbage token', async () => {
    await expect(provider.verifyAccessToken('not-a-jwt-at-all')).rejects.toThrow(InvalidTokenError)
  })

  it('rejects a well-formed web-session access token (no mcp marker claim)', async () => {
    await expect(provider.verifyAccessToken(sessionToken)).rejects.toThrow(InvalidTokenError)
  })

  it('revokeToken on an unknown refresh token never throws', async () => {
    const client = await registerTestClient(`revoke-unknown-${suffix}`)
    await expect(
      provider.revokeToken?.(client, { token: 'never-existed' }),
    ).resolves.toBeUndefined()
  })

  it('revokeToken invalidates a real refresh token', async () => {
    const client = await registerTestClient(`revoke-${suffix}`)
    const { code, codeVerifier } = await fullAuthorize(client)
    const tokens = await provider.exchangeAuthorizationCode(
      client,
      code,
      codeVerifier,
      client.redirect_uris[0],
    )

    await provider.revokeToken?.(client, { token: tokens.refresh_token as string })
    await expect(
      provider.exchangeRefreshToken(client, tokens.refresh_token as string),
    ).rejects.toThrow(InvalidGrantError)
  })
})

describe('request-context middleware: mcp-oauth bearer', () => {
  async function runMiddleware(token: string) {
    const middleware = makeRequestContextMiddleware(prisma, JWT_SECRET)
    const { res, state } = makeRes()
    let nextCalled = false
    let store: ReturnType<typeof requestContextStorage.getStore> | undefined
    const next = () => {
      nextCalled = true
      store = requestContextStorage.getStore()
    }
    const req = { headers: { authorization: `Bearer ${token}` } }
    // biome-ignore lint/suspicious/noExplicitAny: minimal Express req/res stubs
    await middleware(req as any, res as any, next as any)
    return { nextCalled, store, statusCode: state.statusCode }
  }

  it('resolves org/project from an SDK-issued OAuth access token and sets authSource "mcp-oauth"', async () => {
    const client = await registerTestClient(`middleware-${suffix}`)
    const { code, codeVerifier } = await fullAuthorize(client)
    const tokens = await provider.exchangeAuthorizationCode(
      client,
      code,
      codeVerifier,
      client.redirect_uris[0],
    )

    const { nextCalled, store, statusCode } = await runMiddleware(tokens.access_token)
    expect(statusCode).toBe(200) // unchanged default — 401 never set
    expect(nextCalled).toBe(true)
    expect(store).toMatchObject({ userId, orgId, projectId, authSource: 'mcp-oauth' })
  })

  it('rejects an expired OAuth access token by falling through to plain next()', async () => {
    const expired = await new SignJWT({ orgId, projectId, clientId: 'mcp_client_x', mcp: true })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 1000)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(new TextEncoder().encode(JWT_SECRET))

    const { nextCalled, store } = await runMiddleware(expired)
    expect(nextCalled).toBe(true)
    expect(store).toBeUndefined()
  })

  it('rejects a garbage bearer token', async () => {
    const { nextCalled, store } = await runMiddleware('not-a-jwt-at-all')
    expect(nextCalled).toBe(true)
    expect(store).toBeUndefined()
  })

  it("rejects a token for a user who's no longer an org member", async () => {
    const client = await registerTestClient(`orphan-${suffix}`)
    const { code, codeVerifier } = await fullAuthorize(client)
    const tokens = await provider.exchangeAuthorizationCode(
      client,
      code,
      codeVerifier,
      client.redirect_uris[0],
    )

    await prisma.orgMembership.deleteMany({ where: { orgId, userId } })
    const { nextCalled, statusCode } = await runMiddleware(tokens.access_token)
    expect(nextCalled).toBe(false)
    expect(statusCode).toBe(401)

    // Restore membership so later tests / cleanup in this suite still work.
    await prisma.orgMembership.create({
      data: { id: `restored-${suffix}`, orgId, userId, role: 'org_admin' },
    })
  })
})
