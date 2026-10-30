import { randomBytes } from 'node:crypto'
import * as argon2 from 'argon2'
import { jwtVerify, SignJWT } from 'jose'

// No refresh-token rotation is wired on the client yet, so the access token is
// the whole session. Give it a generous TTL (7 days) so users aren't kicked
// out mid-work; on real expiry the client redirects to /login.
export const ACCESS_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60
export const REFRESH_TOKEN_COOKIE = 'clickroom_rt'

export interface AccessTokenPayload {
  sub: string
  sessionId: string
  orgId: string | null
}

function secret(jwtSecret: string): Uint8Array {
  return new TextEncoder().encode(jwtSecret)
}

/** Sign a short-lived HS256 access token carrying sub/sessionId/orgId. */
export async function issueAccessToken(
  payload: AccessTokenPayload,
  jwtSecret: string,
): Promise<string> {
  return new SignJWT({ sessionId: payload.sessionId, orgId: payload.orgId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secret(jwtSecret))
}

/**
 * Verify an access token. Returns the typed payload, or null on ANY failure
 * (bad signature, expiry, tampering, or missing required claims). The `orgId`
 * claim must be present as a key (its value may be null).
 */
export async function verifyAccessToken(
  token: string,
  jwtSecret: string,
): Promise<AccessTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret(jwtSecret))
    if (typeof payload.sub !== 'string' || typeof payload.sessionId !== 'string') return null
    if (!('orgId' in payload)) return null
    const orgId =
      payload.orgId === null ? null : typeof payload.orgId === 'string' ? payload.orgId : null
    return { sub: payload.sub, sessionId: payload.sessionId, orgId }
  } catch {
    return null
  }
}

/**
 * Generate a random refresh token (80 hex chars = 40 bytes).
 * The first 32 chars serve as a DB selector for O(1) lookup;
 * the full token is Argon2id-hashed and stored for verification.
 */
export function generateRefreshToken(): string {
  return randomBytes(40).toString('hex')
}

/** Extract the selector (first 32 hex chars) for indexed DB lookup. */
export function refreshTokenSelector(token: string): string {
  return token.slice(0, 32)
}

/** Produce an Argon2id hash of the full token for storage. */
export async function hashRefreshToken(token: string): Promise<string> {
  return argon2.hash(token, { type: argon2.argon2id })
}

/** Constant-time verification of a raw token against its stored Argon2id hash. */
export async function verifyRefreshToken(token: string, hash: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, token)
  } catch {
    return false
  }
}

export function refreshTokenExpiresAt(): Date {
  return new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000)
}

// ── MCP OAuth 2.1 ──────────────────────────────────────────────
//
// Two more HS256 JWT shapes, signed with the same `jwtSecret` as the web
// session access token (`issueAccessToken`/`verifyAccessToken` above) but
// structurally distinct so they never cross-verify by accident: neither
// carries `sessionId` (so `verifyAccessToken` rejects them) and both carry
// their own literal marker claim `request-context.middleware.ts` checks for
// before falling back to the web-session verifier.

/** Access tokens issued by the MCP OAuth `/token` endpoint. 1h TTL — short
 * relative to the 30d refresh token below, since refreshing is cheap and this
 * is the credential an external MCP client's `/mcp` bearer carries directly. */
export const MCP_ACCESS_TOKEN_TTL_SECONDS = 60 * 60

/** MCP OAuth refresh-token TTL (McpOAuthRefreshToken.expiresAt). */
export const MCP_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60

/** TTL for the short-lived consent ticket that bridges `GET /authorize`
 * (renders the consent page) and `POST /authorize/consent` (acts on it)
 * without needing server-side session state between the two requests. */
export const MCP_CONSENT_TICKET_TTL_SECONDS = 5 * 60

export interface McpAccessTokenPayload {
  sub: string
  orgId: string
  projectId: string
  clientId: string
  mcp: true
}

/** Sign a 1h HS256 access token for an MCP OAuth client, scoped to one org+project. */
export async function issueMcpAccessToken(
  payload: Omit<McpAccessTokenPayload, 'mcp'>,
  jwtSecret: string,
): Promise<string> {
  return new SignJWT({
    orgId: payload.orgId,
    projectId: payload.projectId,
    clientId: payload.clientId,
    mcp: true,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${MCP_ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secret(jwtSecret))
}

/**
 * Verify an MCP OAuth access token. Returns null for any failure (bad
 * signature, expiry, tampering, missing claims) OR for a well-formed web
 * session access token — the `mcp: true` marker claim disambiguates the two
 * shapes so `request-context.middleware.ts` can try both safely.
 */
export async function verifyMcpAccessToken(
  token: string,
  jwtSecret: string,
): Promise<McpAccessTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret(jwtSecret))
    if (payload.mcp !== true) return null
    if (typeof payload.sub !== 'string') return null
    if (typeof payload.orgId !== 'string') return null
    if (typeof payload.projectId !== 'string') return null
    if (typeof payload.clientId !== 'string') return null
    return {
      sub: payload.sub,
      orgId: payload.orgId,
      projectId: payload.projectId,
      clientId: payload.clientId,
      mcp: true,
    }
  } catch {
    return null
  }
}

export interface McpConsentTicketPayload {
  userId: string
  orgId: string
  projectId: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  state: string
  scope: string
}

/** Sign a short-lived (5m) ticket binding a rendered consent page to the
 * exact authorize request that produced it, so `POST /authorize/consent`
 * doesn't need a server-side session to trust the approval. */
export async function issueMcpConsentTicket(
  payload: McpConsentTicketPayload,
  jwtSecret: string,
): Promise<string> {
  return new SignJWT({ ...payload, consent: true })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MCP_CONSENT_TICKET_TTL_SECONDS}s`)
    .sign(secret(jwtSecret))
}

/** Verify a consent ticket. Returns null on any failure (including a token
 * that isn't a consent ticket at all — the `consent: true` marker claim). */
export async function verifyMcpConsentTicket(
  ticket: string,
  jwtSecret: string,
): Promise<McpConsentTicketPayload | null> {
  try {
    const { payload } = await jwtVerify(ticket, secret(jwtSecret))
    if (payload.consent !== true) return null
    const { userId, orgId, projectId, clientId, redirectUri, codeChallenge, state, scope } =
      payload as Record<string, unknown>
    if (
      typeof userId !== 'string' ||
      typeof orgId !== 'string' ||
      typeof projectId !== 'string' ||
      typeof clientId !== 'string' ||
      typeof redirectUri !== 'string' ||
      typeof codeChallenge !== 'string' ||
      typeof state !== 'string' ||
      typeof scope !== 'string'
    ) {
      return null
    }
    return { userId, orgId, projectId, clientId, redirectUri, codeChallenge, state, scope }
  } catch {
    return null
  }
}
