// Self-hosted OAuth 2.1 provider for clickroom's MCP server (
// rewrite). Replaces the hand-rolled `mcp-oauth.controller.ts`'s
// `/register`, `/authorize`, `/token` reimplementations with an
// `OAuthServerProvider` consumed by the SDK's own `mcpAuthRouter`
// (`@modelcontextprotocol/sdk/server/auth/router.js`, mounted in
// `apps/api/src/main.ts`) — mirrors the reference implementation's
// its OAuth provider almost verbatim, including `authorize()`
// redirecting the browser to a real page in `apps/web`
// (`/oauth/mcp/consent`, `McpConsentPage.tsx`) rather than a server-rendered
// screen in this app — the web app is where the user's real login/session
// lives. All business logic lives in the three stores; every method here
// stays thin orchestration.

import {
  issueMcpAccessToken,
  MCP_ACCESS_TOKEN_TTL_SECONDS,
  verifyMcpAccessToken,
} from '@clickroom/auth'
import type { PrismaClient } from '@clickroom/db'
import { McpOAuthClientStore } from '@clickroom/trpc-router/mcp/oauth/client-store.js'
import { McpAuthCodeStore } from '@clickroom/trpc-router/mcp/oauth/code-store.js'
import {
  type McpAuthStatePayload,
  signMcpAuthState,
} from '@clickroom/trpc-router/mcp/oauth/oauth-state.js'
import {
  InvalidGrantError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { Response } from 'express'
import type { Redis } from 'ioredis'
import { McpGrantStore } from './grant-store.js'

/** Every access token this server issues carries the single `mcp` scope
 * (`scopes_supported: ['mcp']` in the RFC 8414 metadata) — clickroom's MCP
 * OAuth server doesn't yet have finer-grained scopes to narrow on refresh. */
const MCP_SCOPES = ['mcp']

export interface ClickroomOAuthConfig {
  jwtSecret: string
  stateSecret: string
  /** `apps/web`'s public origin, e.g. `http://localhost:5180` — the real
   * consent screen lives at `${webPublicUrl}/oauth/mcp/consent`. */
  webPublicUrl: string
}

/** PURE: base64url-decode a JWT's `exp` (epoch secs). Returns undefined on any error. */
export function decodeJwtExp(token: string): number | undefined {
  const parts = token.split('.')
  const body = parts[1]
  if (parts.length !== 3 || !body) return undefined
  try {
    const json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    return typeof json?.exp === 'number' ? json.exp : undefined
  } catch {
    return undefined
  }
}

export class ClickroomOAuthProvider implements OAuthServerProvider {
  private readonly clients: McpOAuthClientStore
  private readonly codes: McpAuthCodeStore
  private readonly grants: McpGrantStore

  constructor(
    prisma: PrismaClient,
    redis: Redis,
    private readonly config: ClickroomOAuthConfig,
  ) {
    this.clients = new McpOAuthClientStore(prisma)
    this.codes = new McpAuthCodeStore(redis)
    this.grants = new McpGrantStore(prisma)
  }

  get clientsStore(): McpOAuthClientStore {
    return this.clients
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const payload: McpAuthStatePayload = {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: 'S256',
      state: params.state,
      scopes: params.scopes ?? MCP_SCOPES,
      resource: params.resource?.href,
    }
    const blob = signMcpAuthState(payload, this.config.stateSecret)
    res.redirect(`${this.config.webPublicUrl}/oauth/mcp/consent?req=${encodeURIComponent(blob)}`)
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    return this.codes.peekChallenge(authorizationCode)
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    // PKCE S256 is verified by the SDK's token handler via
    // `challengeForAuthorizationCode` — we don't hand-verify it here.
    const row = await this.codes.consumeCode(authorizationCode)
    if (!row) throw new InvalidGrantError('authorization code invalid or expired')
    if (row.clientId !== client.client_id) throw new InvalidGrantError('client mismatch')
    if (redirectUri !== undefined && redirectUri !== row.redirectUri) {
      throw new InvalidGrantError('redirect_uri mismatch')
    }
    const grant = await this.grants.createGrant({
      clientId: row.clientId,
      userId: row.userId,
      orgId: row.orgId,
      projectId: row.projectId,
    })
    const accessToken = await issueMcpAccessToken(
      { sub: row.userId, orgId: row.orgId, projectId: row.projectId, clientId: row.clientId },
      this.config.jwtSecret,
    )
    return this.tokens(accessToken, grant.refreshToken)
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
  ): Promise<OAuthTokens> {
    const grant = await this.grants.rotateGrant(refreshToken, client.client_id)
    if (!grant) throw new InvalidGrantError('refresh token invalid or expired')
    const accessToken = await issueMcpAccessToken(
      {
        sub: grant.userId,
        orgId: grant.orgId,
        projectId: grant.projectId,
        clientId: grant.clientId,
      },
      this.config.jwtSecret,
    )
    return this.tokens(accessToken, grant.refreshToken)
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const payload = await verifyMcpAccessToken(token, this.config.jwtSecret)
    if (!payload) throw new InvalidTokenError('invalid MCP access token')
    return {
      token,
      clientId: payload.clientId,
      scopes: MCP_SCOPES,
      expiresAt: decodeJwtExp(token),
      extra: { userId: payload.sub, orgId: payload.orgId, projectId: payload.projectId },
    }
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    // Best-effort: access tokens are stateless JWTs, so only a refresh token
    // can actually be revoked here. Never throws (SDK contract: an invalid
    // or already-revoked token is a no-op, not an error).
    await this.grants.revokeByRefreshToken(request.token)
  }

  private tokens(accessToken: string, refreshToken: string): OAuthTokens {
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: MCP_ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: MCP_SCOPES.join(' '),
    }
  }
}
