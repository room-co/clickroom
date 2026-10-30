/**
 * Integration tests for the SSO browser-facing router —
 * `apps/api/src/http/sso.router.ts`, mounted at `/auth/sso` in `main.ts`.
 *
 * Boots a real `express()` app (cookie-parser + urlencoded, matching
 * `main.ts`'s middleware order) with `createSsoRouter` mounted, and drives it
 * over real HTTP so cookies (the relay-state CSRF cookie, the `clickroom_rt`
 * refresh cookie) round-trip exactly as a browser would see them.
 *
 * The OIDC/SAML *protocol* internals (state/nonce/PKCE validation, SAML
 * signature/audience/expiry checks) are already covered by
 * `sso-oidc.test.ts` / `sso-saml.test.ts`. This suite mocks
 * `http/sso/oidc.js` and `http/sso/saml.js` to isolate the ROUTER's own
 * responsibilities: the relay-cookie CSRF guard, wiring the extracted
 * profile through `SsoProvisioningService` + `AuthService.signInViaSso`, and
 * setting the same `clickroom_rt` cookie password login uses.
 *
 * The SAML mock still delegates to the REAL `assertAssertionNotReplayed`
 * (imported unmocked via `importActual`) so the replay-rejection test
 * exercises genuine replay-protection logic, not a stub. `buildSamlAuthRequest`
 * is otherwise mocked because `@node-saml/node-saml`'s `validateInResponseTo:
 * 'always'` cannot be satisfied by two independently-constructed `SAML`
 * instances (one at `/login`, one at `/acs`) — see the identical caveat
 * documented in `sso-saml.test.ts` ("a fully-correlated happy path ... is not
 * unit-testable in isolation"). That correlation gap is pre-existing
 * documented limitation, out of scope here.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { newId, prisma } from '@clickroom/db'
import cookieParser from 'cookie-parser'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildSignedSamlResponse, generateIdpKeyMaterial } from './helpers/saml-fixture.js'
import { cleanupOrg, cleanupUser } from './helpers.js'

const RELAY_COOKIE = 'clickroom_sso_relay'
const REFRESH_COOKIE = 'clickroom_rt'

vi.mock('../http/sso/oidc.js', () => ({
  buildOidcAuthRequest: vi.fn(async () => ({
    authUrl: 'https://idp.test/oidc/authorize?mock=1',
    state: 'mock-state',
    nonce: 'mock-nonce',
    codeVerifier: 'mock-verifier',
  })),
  handleOidcCallback: vi.fn(
    async (opts: { expectedState: string; expectedNonce: string; codeVerifier: string }) => {
      if (
        opts.expectedState !== 'mock-state' ||
        opts.expectedNonce !== 'mock-nonce' ||
        opts.codeVerifier !== 'mock-verifier'
      ) {
        throw new Error('OIDC state/nonce/PKCE mismatch')
      }
      return {
        externalId: 'oidc-user-1',
        email: 'oidc-user@example.test',
        fullName: 'OIDC User',
        groups: [] as string[],
      }
    },
  ),
}))

vi.mock('@clickroom/trpc-router/http/sso/saml.js', async (importActual) => {
  const actual = await importActual<typeof import('@clickroom/trpc-router/http/sso/saml.js')>()
  return {
    ...actual,
    buildSamlAuthRequest: vi.fn(async () => ({
      redirectUrl: 'https://idp.test/saml/sso?mock=1',
      relayState: 'mock-relay-state',
    })),
    validateSamlResponse: vi.fn(
      async (opts: { samlResponseBody: { SAMLResponse: string; RelayState?: string } }) => {
        const xml = Buffer.from(opts.samlResponseBody.SAMLResponse, 'base64').toString('utf8')
        const match = xml.match(/<(?:[\w-]+:)?Assertion\b[^>]*\bID\s*=\s*["']([^"']+)["']/i)
        const assertionId = match?.[1]
        if (!assertionId) throw new Error('SAML fixture missing assertion ID')
        // Real replay guard — not mocked — so a second POST of the same
        // assertion genuinely throws here, exactly as production does.
        actual.assertAssertionNotReplayed(assertionId, new Date(Date.now() + 5 * 60_000))
        return {
          externalId: 'saml-user-1',
          email: 'saml-user@example.test',
          fullName: 'SAML User',
          groups: [] as string[],
        }
      },
    ),
  }
})

const { createSsoRouter } = await import('../http/sso.router.js')
const { authService } = await import('./helpers.js')

const suffix = Date.now().toString(36)

let server: http.Server
let baseUrl: string

let oidcOrgId: string
let oidcConnectionId: string
let samlOrgId: string
let samlConnectionId: string

/** Extract a cookie's raw `name=value` pair from a fetch response's Set-Cookie headers. */
function extractCookie(res: Response, name: string): string | undefined {
  const setCookie = res.headers.getSetCookie?.() ?? []
  for (const raw of setCookie) {
    const pair = raw.split(';')[0]
    if (pair?.startsWith(`${name}=`)) return pair
  }
  return undefined
}

/** Every FULL raw Set-Cookie header for `name` (attributes included). */
function extractSetCookies(res: Response, name: string): string[] {
  return (res.headers.getSetCookie?.() ?? []).filter((raw) => raw.startsWith(`${name}=`))
}

beforeAll(async () => {
  const app = express()
  app.use(cookieParser())
  app.use(express.urlencoded({ extended: true }))
  app.use(express.json())
  app.use('/auth/sso', createSsoRouter(prisma, authService))

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const { port } = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`

  const oidcOrg = await prisma.org.create({
    data: { id: newId(), name: `SSO Router OIDC ${suffix}`, slug: `sso-router-oidc-${suffix}` },
  })
  oidcOrgId = oidcOrg.id
  const oidcConn = await prisma.ssoConnection.create({
    data: {
      id: newId(),
      orgId: oidcOrgId,
      protocol: 'oidc',
      displayName: 'Mock OIDC IdP',
      enabled: true,
      defaultOrgRole: 'member',
      oidcIssuerUrl: 'https://idp.test',
      oidcClientId: 'mock-client-id',
      secretsEnvelope: {},
    },
  })
  oidcConnectionId = oidcConn.id

  const samlOrg = await prisma.org.create({
    data: { id: newId(), name: `SSO Router SAML ${suffix}`, slug: `sso-router-saml-${suffix}` },
  })
  samlOrgId = samlOrg.id
  const samlConn = await prisma.ssoConnection.create({
    data: {
      id: newId(),
      orgId: samlOrgId,
      protocol: 'saml',
      displayName: 'Mock SAML IdP',
      enabled: true,
      defaultOrgRole: 'member',
      samlIdpEntityId: 'https://idp.test/entity',
      samlIdpSsoUrl: 'https://idp.test/sso',
      samlIdpX509Cert: 'unused-in-mocked-validateSamlResponse',
      samlSpEntityId: 'https://sp.clickroom.test/entity',
      samlWantAssertionsSigned: true,
      secretsEnvelope: {},
    },
  })
  samlConnectionId = samlConn.id
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )

  const oidcUsers = await prisma.user.findMany({ where: { email: 'oidc-user@example.test' } })
  const samlUsers = await prisma.user.findMany({ where: { email: 'saml-user@example.test' } })
  const userIds = [...oidcUsers, ...samlUsers].map((u) => u.id)

  await prisma.userSsoIdentity.deleteMany({
    where: { ssoConnectionId: { in: [oidcConnectionId, samlConnectionId] } },
  })
  await prisma.session.deleteMany({
    where: { ssoConnectionId: { in: [oidcConnectionId, samlConnectionId] } },
  })
  await prisma.ssoConnection.deleteMany({
    where: { id: { in: [oidcConnectionId, samlConnectionId] } },
  })
  for (const userId of userIds) await cleanupUser(userId)
  await cleanupOrg(oidcOrgId)
  await cleanupOrg(samlOrgId)
  await prisma.$disconnect()
})

describe('GET /auth/sso/discover', () => {
  it('returns 204 for an email with no verified domain', async () => {
    const res = await fetch(`${baseUrl}/auth/sso/discover?email=nobody@no-such-domain.invalid`)
    expect(res.status).toBe(204)
  })

  it('returns 204 when the email query param is missing', async () => {
    const res = await fetch(`${baseUrl}/auth/sso/discover`)
    expect(res.status).toBe(204)
  })
})

describe('OIDC round trip', () => {
  it('login sets a relay cookie and redirects to the mocked IdP', async () => {
    const res = await fetch(`${baseUrl}/auth/sso/${oidcConnectionId}/login`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://idp.test/oidc/authorize?mock=1')
    expect(extractCookie(res, RELAY_COOKIE)).toBeTruthy()
  })

  it('a full round trip lands a valid clickroom_rt cookie and redirects to the dashboard', async () => {
    const loginRes = await fetch(`${baseUrl}/auth/sso/${oidcConnectionId}/login`, {
      redirect: 'manual',
    })
    const relayCookie = extractCookie(loginRes, RELAY_COOKIE)
    expect(relayCookie).toBeTruthy()

    const callbackRes = await fetch(
      `${baseUrl}/auth/sso/${oidcConnectionId}/callback?code=abc123&state=mock-state`,
      { redirect: 'manual', headers: { cookie: relayCookie as string } },
    )
    expect(callbackRes.status).toBe(302)
    expect(callbackRes.headers.get('location')).toBe('http://localhost:5180/')

    const refreshCookie = extractCookie(callbackRes, REFRESH_COOKIE)
    expect(refreshCookie).toBeTruthy()

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: 'oidc-user@example.test' },
    })
    const session = await prisma.session.findFirst({
      where: { userId: user.id, ssoConnectionId: oidcConnectionId },
      orderBy: { createdAt: 'desc' },
    })
    expect(session?.authMethod).toBe('sso')
    expect(session?.activeOrgId).toBe(oidcOrgId)

    const identity = await prisma.userSsoIdentity.findUnique({
      where: {
        ssoConnectionId_externalId: {
          ssoConnectionId: oidcConnectionId,
          externalId: 'oidc-user-1',
        },
      },
    })
    expect(identity?.userId).toBe(user.id)
  })

  it('a successful callback also evicts the legacy host-only refresh cookie when COOKIE_DOMAIN is set', async () => {
    // `finish()` uses the same `setRefreshCookie` as password login, so the SSO
    // success response must carry the host-only eviction too — SSO users were
    // the loudest victims of the twin-cookie bug (see packages/trpc-router/src/
    // lib/cookies.ts). `COOKIE_DOMAIN` is read at call time; restore it after.
    const original = process.env.COOKIE_DOMAIN
    process.env.COOKIE_DOMAIN = '.clickroom.co'
    try {
      const loginRes = await fetch(`${baseUrl}/auth/sso/${oidcConnectionId}/login`, {
        redirect: 'manual',
      })
      const relayCookie = extractCookie(loginRes, RELAY_COOKIE)

      const callbackRes = await fetch(
        `${baseUrl}/auth/sso/${oidcConnectionId}/callback?code=abc123&state=mock-state`,
        { redirect: 'manual', headers: { cookie: relayCookie as string } },
      )
      expect(callbackRes.status).toBe(302)

      const cookies = extractSetCookies(callbackRes, REFRESH_COOKIE)
      expect(cookies).toHaveLength(2)

      const deletion = cookies.find((raw) => !/;\s*Domain=/i.test(raw))
      expect(deletion).toMatch(/Expires=Thu, 01 Jan 1970/i)
      expect(deletion).toContain(`${REFRESH_COOKIE}=;`)

      const live = cookies.find((raw) => /;\s*Domain=\.clickroom\.co/i.test(raw))
      expect(live).toBeDefined()
      expect(live).not.toContain(`${REFRESH_COOKIE}=;`)
    } finally {
      if (original === undefined) delete process.env.COOKIE_DOMAIN
      else process.env.COOKIE_DOMAIN = original
    }
  })

  it('rejects a callback with no relay cookie (CSRF guard)', async () => {
    const res = await fetch(
      `${baseUrl}/auth/sso/${oidcConnectionId}/callback?code=abc123&state=mock-state`,
      { redirect: 'manual' },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('/login?sso_error=1')
    expect(extractCookie(res, REFRESH_COOKIE)).toBeFalsy()
  })

  it('rejects a callback whose relay cookie is bound to a different connectionId', async () => {
    const loginRes = await fetch(`${baseUrl}/auth/sso/${oidcConnectionId}/login`, {
      redirect: 'manual',
    })
    const relayCookie = extractCookie(loginRes, RELAY_COOKIE)
    expect(relayCookie).toBeTruthy()

    // Reuse the relay cookie minted for `oidcConnectionId` against a
    // different connection's callback URL — the router's CSRF guard must
    // reject because `relay.connectionId !== connectionId`.
    const res = await fetch(
      `${baseUrl}/auth/sso/${samlConnectionId}/callback?code=abc123&state=mock-state`,
      { redirect: 'manual', headers: { cookie: relayCookie as string } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('/login?sso_error=1')
    expect(extractCookie(res, REFRESH_COOKIE)).toBeFalsy()
  })
})

describe('SAML ACS', () => {
  it('rejects a replayed assertion on the second POST', async () => {
    const km = generateIdpKeyMaterial()
    const { samlResponse } = buildSignedSamlResponse({
      privateKey: km.privateKey,
      certBase64: km.certBase64,
      idpEntityId: 'https://idp.test/entity',
      audience: 'https://sp.clickroom.test/entity',
      recipient: 'https://sp.clickroom.test/acs',
      nameId: 'saml-user-1',
      email: 'saml-user@example.test',
    })

    // First POST: fresh relay cookie + a never-before-seen assertion — must
    // succeed and set the refresh cookie.
    const login1 = await fetch(`${baseUrl}/auth/sso/${samlConnectionId}/login`, {
      redirect: 'manual',
    })
    const relayCookie1 = extractCookie(login1, RELAY_COOKIE)
    expect(relayCookie1).toBeTruthy()

    const acs1 = await fetch(`${baseUrl}/auth/sso/${samlConnectionId}/acs`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: relayCookie1 as string,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: 'mock-relay-state' }),
    })
    expect(acs1.status).toBe(302)
    expect(acs1.headers.get('location')).toBe('http://localhost:5180/')
    expect(extractCookie(acs1, REFRESH_COOKIE)).toBeTruthy()

    // Second POST: fresh relay cookie (CSRF guard would pass) but the SAME
    // signed assertion — `assertAssertionNotReplayed` must reject it.
    const login2 = await fetch(`${baseUrl}/auth/sso/${samlConnectionId}/login`, {
      redirect: 'manual',
    })
    const relayCookie2 = extractCookie(login2, RELAY_COOKIE)
    expect(relayCookie2).toBeTruthy()

    const acs2 = await fetch(`${baseUrl}/auth/sso/${samlConnectionId}/acs`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: relayCookie2 as string,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: 'mock-relay-state' }),
    })
    expect(acs2.status).toBe(302)
    expect(acs2.headers.get('location')).toContain('/login?sso_error=1')
    expect(extractCookie(acs2, REFRESH_COOKIE)).toBeFalsy()
  })

  it('rejects an ACS POST with a missing/mismatched relay cookie', async () => {
    const km = generateIdpKeyMaterial()
    const { samlResponse } = buildSignedSamlResponse({
      privateKey: km.privateKey,
      certBase64: km.certBase64,
      idpEntityId: 'https://idp.test/entity',
      audience: 'https://sp.clickroom.test/entity',
      recipient: 'https://sp.clickroom.test/acs',
      nameId: 'saml-user-2',
      email: 'saml-user-2@example.test',
    })

    const res = await fetch(`${baseUrl}/auth/sso/${samlConnectionId}/acs`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ SAMLResponse: samlResponse }),
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('/login?sso_error=1')
    expect(extractCookie(res, REFRESH_COOKIE)).toBeFalsy()
  })

  it('GET metadata returns SP metadata XML for a SAML connection', async () => {
    const res = await fetch(`${baseUrl}/auth/sso/${samlConnectionId}/metadata`)
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).toContain('EntityDescriptor')
  })

  it('GET metadata 404s for an OIDC connection', async () => {
    const res = await fetch(`${baseUrl}/auth/sso/${oidcConnectionId}/metadata`)
    expect(res.status).toBe(404)
  })
})
