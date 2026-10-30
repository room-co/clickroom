import crypto from 'node:crypto'
import { DEV_SSO_RELAY_STATE_SECRET, resolveSecret } from '@clickroom/auth'
import {
  OrgDomainService,
  type PrismaClient,
  SsoConnectionService,
  SsoProvisioningService,
} from '@clickroom/db'
import {
  buildSamlAuthRequest,
  generateSamlMetadata,
  validateSamlResponse,
} from '@clickroom/trpc-router/http/sso/saml.js'
import { setRefreshCookie } from '@clickroom/trpc-router/lib/cookies.js'
import {
  mcpOAuthIssuer,
  mcpWebPublicUrl,
} from '@clickroom/trpc-router/mcp/oauth/mcp-oauth.constants.js'
import type { AuthService } from '@clickroom/trpc-router/services/auth.service.js'
import { Logger } from '@nestjs/common'
import express, { type Request, type Response, type Router } from 'express'
import { buildOidcAuthRequest, handleOidcCallback } from './sso/oidc.js'

/**
 * SSO browser-redirect endpoints (SP-initiated OIDC + SAML), ported near-
 * verbatim from the reference implementation's `sso.controller.ts`.
 * A plain `express.Router()`, NOT a Nest `@Controller`: these routes need raw
 * Express semantics (302 redirects, a form-POST ACS endpoint), mirroring how
 * `mcpAuthRouter` is mounted at the application root in `main.ts`.
 *
 * Token handoff: on success we set the SAME refresh cookie password login
 * uses (`setRefreshCookie`, identical name + options) and 302 the browser to
 * the web app. The SPA bootstraps via `auth.refresh` (cookie-based) to mint
 * an access token — exactly how a returning user's session is restored. We
 * deliberately do NOT pass the access token in the URL (query/hash) to avoid
 * leaking it via referrer / history.
 *
 * No feature-flag/entitlement gating anywhere in this router
 * decision: SSO ships available to any org_admin, full stop.
 */

/**
 * Every failure in this router 302s the browser to `/login?sso_error=1` — a
 * deliberately opaque response, since the person hitting it is unauthenticated
 * and must not learn which part of the config is wrong. That opacity only works
 * if the operator can see what the browser can't: an SSO login that silently
 * bounced with no server-side trace cost a VPC route-table audit to diagnose
 * once already (the tasks had no NAT route, so OIDC discovery to Google hung).
 *
 * So: never redirect to `loginErrorUrl()` without calling `logSsoFailure` first.
 * Log the connection id and the cause, never the assertion, token, or secret.
 */
const logger = new Logger('SsoRouter')

function logSsoFailure(stage: string, connectionId: string, cause: unknown): void {
  const reason = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
  logger.warn(`SSO ${stage} failed [connection=${connectionId}]: ${reason}`)
}

const RELAY_COOKIE = 'clickroom_sso_relay'
const RELAY_TTL_MS = 10 * 60 * 1000 // 10 minutes

interface OidcRelayPayload {
  k: 'oidc'
  connectionId: string
  state: string
  nonce: string
  codeVerifier: string
  exp: number
}

interface SamlRelayPayload {
  k: 'saml'
  connectionId: string
  relayState: string
  exp: number
}

type RelayPayload = OidcRelayPayload | SamlRelayPayload

function relaySecret(): string {
  return resolveSecret('SSO_RELAY_STATE_SECRET', DEV_SSO_RELAY_STATE_SECRET)
}

function signRelay(payload: RelayPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sig = crypto.createHmac('sha256', relaySecret()).update(body).digest('base64url')
  return `${body}.${sig}`
}

function verifyRelay(raw: string | undefined): RelayPayload | null {
  if (!raw) return null
  const dot = raw.lastIndexOf('.')
  if (dot < 0) return null
  const body = raw.slice(0, dot)
  const sig = raw.slice(dot + 1)
  const expected = crypto.createHmac('sha256', relaySecret()).update(body).digest('base64url')
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as RelayPayload
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}

function setRelayCookie(res: Response, value: string): void {
  res.cookie(RELAY_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // `lax` (not `strict`) so the cookie survives the top-level redirect back
    // from the IdP on the GET callback.
    sameSite: 'lax',
    maxAge: RELAY_TTL_MS,
    path: '/auth/sso',
  })
}

function clearRelayCookie(res: Response): void {
  res.clearCookie(RELAY_COOKIE, { path: '/auth/sso' })
}

/** Read the configured groups claim/attribute name from attributeMapping. */
function groupsKey(attributeMapping: unknown): string | undefined {
  if (attributeMapping && typeof attributeMapping === 'object') {
    const v = (attributeMapping as Record<string, unknown>).groups
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

interface SsoProfile {
  externalId: string
  email: string
  fullName: string
  groups: string[]
}

export function createSsoRouter(prisma: PrismaClient, authService: AuthService): Router {
  const router: Router = express.Router()
  const ssoConnections = new SsoConnectionService(prisma)
  const orgDomains = new OrgDomainService(prisma)
  const provisioning = new SsoProvisioningService(prisma)

  const apiBase = (): string => mcpOAuthIssuer()
  const loginErrorUrl = (): string => `${mcpWebPublicUrl()}/login?sso_error=1`

  /**
   * Discovery: resolve an org's enabled SSO connection from an email domain.
   * 204 (fall back to password) when no enabled connection is found — no
   * flag/entitlement check
   */
  router.get('/discover', async (req: Request, res: Response) => {
    const email = typeof req.query.email === 'string' ? req.query.email : ''
    if (!email) {
      res.status(204).end()
      return
    }
    try {
      const resolved = await orgDomains.resolveOrgByEmailDomain(email)
      if (!resolved?.connection) {
        res.status(204).end()
        return
      }
      res.status(200).json({
        connectionId: resolved.connection.id,
        startUrl: `${apiBase()}/auth/sso/${resolved.connection.id}/login`,
      })
    } catch (err) {
      // Still 204 (fall back to password) — but a thrown lookup is a real fault, not
      // "this domain has no SSO", and the two are indistinguishable to the caller.
      logSsoFailure('discover', '-', err)
      res.status(204).end()
    }
  })

  /** Start an SSO login — builds the IdP request and 302s to the IdP. */
  router.get('/:connectionId/login', async (req: Request, res: Response) => {
    const { connectionId } = req.params
    try {
      const row = await ssoConnections.getByIdWithSecrets(connectionId)
      if (!row?.connection.enabled) {
        logSsoFailure('login', connectionId, row ? 'connection is disabled' : 'no such connection')
        res.redirect(loginErrorUrl())
        return
      }
      const { connection, secrets } = row

      if (connection.protocol === 'oidc') {
        const redirectUri = `${apiBase()}/auth/sso/${connectionId}/callback`
        const built = await buildOidcAuthRequest({
          issuerUrl: connection.oidcIssuerUrl ?? '',
          clientId: connection.oidcClientId ?? '',
          clientSecret: secrets.clientSecret ?? '',
          redirectUri,
        })
        const cookie = signRelay({
          k: 'oidc',
          connectionId,
          state: built.state,
          nonce: built.nonce,
          codeVerifier: built.codeVerifier,
          exp: Date.now() + RELAY_TTL_MS,
        })
        setRelayCookie(res, cookie)
        res.redirect(built.authUrl)
        return
      }

      // SAML
      const callbackUrl = `${apiBase()}/auth/sso/${connectionId}/acs`
      const built = await buildSamlAuthRequest({
        idpEntityId: connection.samlIdpEntityId ?? '',
        idpSsoUrl: connection.samlIdpSsoUrl ?? '',
        idpCert: connection.samlIdpX509Cert ?? '',
        spEntityId: connection.samlSpEntityId ?? `${apiBase()}/auth/sso/${connectionId}`,
        callbackUrl,
        wantAssertionsSigned: connection.samlWantAssertionsSigned,
      })
      const cookie = signRelay({
        k: 'saml',
        connectionId,
        relayState: built.relayState ?? '',
        exp: Date.now() + RELAY_TTL_MS,
      })
      setRelayCookie(res, cookie)
      res.redirect(built.redirectUrl)
    } catch (err) {
      // Reaching the IdP is a network call to the public internet — this is where a
      // missing egress route surfaces, as a hang/connect error against the issuer.
      logSsoFailure('login', connectionId, err)
      res.redirect(loginErrorUrl())
    }
  })

  /** OIDC authorization-code callback. */
  router.get('/:connectionId/callback', async (req: Request, res: Response) => {
    const { connectionId } = req.params
    try {
      const relay = verifyRelay(req.cookies?.[RELAY_COOKIE] as string | undefined)
      clearRelayCookie(res)
      if (relay?.k !== 'oidc' || relay.connectionId !== connectionId) {
        logSsoFailure('oidc-callback', connectionId, 'relay-state cookie missing or mismatched')
        res.redirect(loginErrorUrl())
        return
      }

      const row = await ssoConnections.getByIdWithSecrets(connectionId)
      if (!row?.connection.enabled) {
        logSsoFailure(
          'oidc-callback',
          connectionId,
          row ? 'connection is disabled' : 'no such connection',
        )
        res.redirect(loginErrorUrl())
        return
      }
      const { connection, secrets } = row

      const redirectUri = `${apiBase()}/auth/sso/${connectionId}/callback`
      const callbackUrl = `${redirectUri}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`

      const profile = await handleOidcCallback({
        issuerUrl: connection.oidcIssuerUrl ?? '',
        clientId: connection.oidcClientId ?? '',
        clientSecret: secrets.clientSecret ?? '',
        redirectUri,
        callbackUrl,
        expectedState: relay.state,
        expectedNonce: relay.nonce,
        codeVerifier: relay.codeVerifier,
        groupsClaim: groupsKey(connection.attributeMapping),
      })

      await finish(res, connection.orgId, connectionId, profile)
    } catch (err) {
      logSsoFailure('oidc-callback', connectionId, err)
      res.redirect(loginErrorUrl())
    }
  })

  /** SAML assertion consumer (ACS). Form-urlencoded SAMLResponse + RelayState. */
  router.post('/:connectionId/acs', async (req: Request, res: Response) => {
    const { connectionId } = req.params
    const body = req.body as { SAMLResponse?: string; RelayState?: string }
    try {
      const relay = verifyRelay(req.cookies?.[RELAY_COOKIE] as string | undefined)
      clearRelayCookie(res)
      if (
        relay?.k !== 'saml' ||
        relay.connectionId !== connectionId ||
        !body.SAMLResponse ||
        (relay.relayState && body.RelayState && relay.relayState !== body.RelayState)
      ) {
        logSsoFailure(
          'saml-acs',
          connectionId,
          !body.SAMLResponse
            ? 'no SAMLResponse in POST body'
            : 'relay-state cookie missing or mismatched',
        )
        res.redirect(loginErrorUrl())
        return
      }

      const row = await ssoConnections.getByIdWithSecrets(connectionId)
      if (!row?.connection.enabled) {
        logSsoFailure(
          'saml-acs',
          connectionId,
          row ? 'connection is disabled' : 'no such connection',
        )
        res.redirect(loginErrorUrl())
        return
      }
      const { connection } = row

      const callbackUrl = `${apiBase()}/auth/sso/${connectionId}/acs`
      const profile = await validateSamlResponse({
        idpEntityId: connection.samlIdpEntityId ?? '',
        idpSsoUrl: connection.samlIdpSsoUrl ?? '',
        idpCert: connection.samlIdpX509Cert ?? '',
        spEntityId: connection.samlSpEntityId ?? `${apiBase()}/auth/sso/${connectionId}`,
        callbackUrl,
        wantAssertionsSigned: connection.samlWantAssertionsSigned,
        samlResponseBody: { SAMLResponse: body.SAMLResponse, RelayState: body.RelayState },
        groupsAttribute: groupsKey(connection.attributeMapping),
      })

      await finish(res, connection.orgId, connectionId, profile)
    } catch (err) {
      logSsoFailure('saml-acs', connectionId, err)
      res.redirect(loginErrorUrl())
    }
  })

  /** SAML SP metadata XML for IdP-side configuration. SAML connections only. */
  router.get('/:connectionId/metadata', async (req: Request, res: Response) => {
    const { connectionId } = req.params
    try {
      const row = await ssoConnections.getByIdWithSecrets(connectionId)
      if (row?.connection.protocol !== 'saml') {
        res.status(404).end()
        return
      }
      const { connection } = row
      const xml = generateSamlMetadata({
        spEntityId: connection.samlSpEntityId ?? `${apiBase()}/auth/sso/${connectionId}`,
        callbackUrl: `${apiBase()}/auth/sso/${connectionId}/acs`,
        wantAssertionsSigned: connection.samlWantAssertionsSigned,
      })
      res.type('application/xml').send(xml)
    } catch (err) {
      logSsoFailure('saml-metadata', connectionId, err)
      res.status(500).end()
    }
  })

  /**
   * Shared success path for both OIDC and SAML callbacks: JIT-provision the
   * user, mint a session via AuthService, set the refresh cookie, and
   * redirect the browser into the web app.
   */
  async function finish(
    res: Response,
    orgId: string,
    connectionId: string,
    profile: SsoProfile,
  ): Promise<void> {
    const { userId } = await provisioning.provision({
      orgId,
      connectionId,
      externalId: profile.externalId,
      email: profile.email,
      fullName: profile.fullName,
      groups: profile.groups,
    })

    const result = await authService.signInViaSso({ userId, orgId, connectionId })

    setRefreshCookie(res, result.refreshToken)
    res.redirect(`${mcpWebPublicUrl()}/`)
  }

  return router
}
