import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  type Configuration,
  calculatePKCECodeChallenge,
  discovery,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
} from 'openid-client'

/**
 * Self-contained OIDC helper built on `openid-client@6` (the v6 functional API:
 * {@link discovery}, {@link buildAuthorizationUrl}, {@link authorizationCodeGrant},
 * {@link randomPKCECodeVerifier}, {@link calculatePKCECodeChallenge},
 * {@link randomState}, {@link randomNonce}).
 *
 * These functions are pure with respect to persistence — the caller supplies all
 * connection config and is responsible for storing/retrieving the per-request
 * `state`, `nonce`, and `codeVerifier` (e.g. in a signed relay-state cookie).
 *
 * Tested issuers:
 * - **Google**: `https://accounts.google.com`
 * - **Microsoft Entra ID**: `https://login.microsoftonline.com/<tenant>/v2.0`
 *
 * Both support the requested scope `openid email profile` and PKCE (`S256`).
 */

const OIDC_SCOPE = 'openid email profile'

/** Default claim that carries the user's group memberships. */
const DEFAULT_GROUPS_CLAIM = 'groups'

interface OidcConnectionConfig {
  /** Issuer URL used for OIDC discovery (`.well-known/openid-configuration`). */
  issuerUrl: string
  clientId: string
  clientSecret: string
  /** The exact `redirect_uri` registered with the IdP. */
  redirectUri: string
}

export interface BuildOidcAuthRequestResult {
  authUrl: string
  state: string
  nonce: string
  codeVerifier: string
}

export interface OidcCallbackResult {
  externalId: string
  email: string
  fullName: string
  groups: string[]
}

/**
 * Runs OIDC discovery against the configured issuer and returns the
 * pre-built {@link Configuration} authenticated with `client_secret_post`.
 */
async function discoverConfiguration(opts: OidcConnectionConfig): Promise<Configuration> {
  return discovery(new URL(opts.issuerUrl), opts.clientId, opts.clientSecret)
}

/**
 * Builds the OIDC authorization request for the start of an SSO login.
 *
 * Generates a fresh PKCE verifier + `S256` challenge, `state`, and `nonce`,
 * then constructs the authorization URL with scope `openid email profile`.
 *
 * The caller MUST persist the returned `state`, `nonce`, and `codeVerifier`
 * (e.g. signed cookie) and pass them back to {@link handleOidcCallback}.
 */
export async function buildOidcAuthRequest(
  opts: OidcConnectionConfig,
): Promise<BuildOidcAuthRequestResult> {
  const config = await discoverConfiguration(opts)

  const codeVerifier = randomPKCECodeVerifier()
  const codeChallenge = await calculatePKCECodeChallenge(codeVerifier)
  const state = randomState()
  const nonce = randomNonce()

  const authUrl = buildAuthorizationUrl(config, {
    redirect_uri: opts.redirectUri,
    scope: OIDC_SCOPE,
    response_type: 'code',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  })

  return { authUrl: authUrl.href, state, nonce, codeVerifier }
}

/**
 * Handles the IdP redirect back to the callback endpoint.
 *
 * Re-runs discovery and exchanges the authorization code via
 * {@link authorizationCodeGrant}, which validates the `state`, `nonce`, PKCE
 * verifier, and the ID Token's `iss` / `aud` / `exp` / signature.
 *
 * Identity claims:
 * - `externalId` ← `sub`
 * - `email` ← `email`
 * - `fullName` ← `name` (falls back to `email`)
 * - `groups` ← the claim named by `opts.groupsClaim` (default `groups`).
 *   For Entra ID, group/role memberships may surface under `groups` or `roles`;
 *   pass `groupsClaim: 'roles'` to read from the roles claim instead.
 */
export async function handleOidcCallback(
  opts: OidcConnectionConfig & {
    /** The full callback URL as received, including the query string. */
    callbackUrl: string
    expectedState: string
    expectedNonce: string
    codeVerifier: string
    /** Override the claim read for group memberships. Default `groups`. */
    groupsClaim?: string
  },
): Promise<OidcCallbackResult> {
  const config = await discoverConfiguration(opts)

  const tokens = await authorizationCodeGrant(config, new URL(opts.callbackUrl), {
    expectedState: opts.expectedState,
    expectedNonce: opts.expectedNonce,
    pkceCodeVerifier: opts.codeVerifier,
    idTokenExpected: true,
  })

  const claims = tokens.claims()
  if (!claims) {
    throw new Error('OIDC callback: ID Token claims missing from token response')
  }

  const externalId = claims.sub
  const email = readStringClaim(claims.email)
  if (!email) {
    throw new Error('OIDC callback: required `email` claim missing or invalid')
  }
  const fullName = readStringClaim(claims.name) ?? email

  const groupsClaim = opts.groupsClaim ?? DEFAULT_GROUPS_CLAIM
  const groups = readStringArrayClaim(claims[groupsClaim])

  return { externalId, email, fullName, groups }
}

/** Narrows an arbitrary JSON claim value to a non-empty string, else undefined. */
function readStringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Narrows an arbitrary JSON claim value to an array of strings (empty if absent). */
function readStringArrayClaim(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((item): item is string => typeof item === 'string')
}
