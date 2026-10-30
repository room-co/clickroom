// OAuth Dynamic Client Registration (RFC 7591) store for `mcpAuthRouter`
// (/rewrite — replaces the hand-rolled `registerClient`/`findClient`
// in the old `mcp-oauth.service.ts`). Public PKCE clients only:
// `token_endpoint_auth_method: 'none'`, no client secret — mirrors the reference
// implementation exactly, including the bugfix this rewrite
// exists for: `client_secret` is OMITTED from the response for public clients
// (never a bare `null`), because `OAuthClientInformationFull`'s field is
// optional and this store simply never sets it.

import { newId, type PrismaClient } from '@clickroom/db'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import { InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'

const DEFAULT_GRANT_TYPES = ['authorization_code', 'refresh_token']
const DEFAULT_RESPONSE_TYPES = ['code']

type OAuthClientRow = {
  clientId: string
  clientName: string | null
  redirectUris: string[]
  grantTypes: string[]
  responseTypes: string[]
  scope: string | null
  tokenEndpointAuthMethod: string
  createdAt: Date
}

function toEpochSeconds(date: Date | null | undefined): number | undefined {
  if (!date) return undefined
  const ms = date.getTime()
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

/**
 * PURE, total adapter: DB row → SDK `OAuthClientInformationFull`. Never
 * throws; defaults missing arrays to []. Every client this store issues is
 * public (no secret persisted), so `client_secret` is always omitted — the
 * exact fix for the DCR bug that motivated this rewrite (the old hand-rolled
 * controller sent `client_secret: null`, which some MCP SDK clients,
 * including Claude Code's own, reject as a malformed registration response).
 */
export function oauthClientRowToSdk(row: OAuthClientRow): OAuthClientInformationFull {
  const info: OAuthClientInformationFull = {
    client_id: row.clientId,
    redirect_uris: Array.isArray(row.redirectUris) ? row.redirectUris : [],
    grant_types:
      Array.isArray(row.grantTypes) && row.grantTypes.length > 0
        ? row.grantTypes
        : DEFAULT_GRANT_TYPES,
    response_types:
      Array.isArray(row.responseTypes) && row.responseTypes.length > 0
        ? row.responseTypes
        : DEFAULT_RESPONSE_TYPES,
    token_endpoint_auth_method: row.tokenEndpointAuthMethod ?? 'none',
  }
  if (row.clientName) info.client_name = row.clientName
  if (row.scope) info.scope = row.scope
  const issuedAt = toEpochSeconds(row.createdAt)
  if (issuedAt !== undefined) info.client_id_issued_at = issuedAt
  return info
}

/**
 * PURE predicate: is `uri` an allowed redirect target? Allows any https://
 * URI, plus http loopback (127.0.0.1, localhost, [::1]) with any port/path —
 * the shape every real MCP client (Claude Desktop, Claude Code, mcp-remote,
 * MCP Inspector) uses for its native-app redirect (RFC 8252. Never
 * throws — returns false on malformed input.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return false
  }
  if (parsed.protocol === 'https:') return true
  if (parsed.protocol !== 'http:') return false
  const host = parsed.hostname
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
}

export class McpOAuthClientStore implements OAuthRegisteredClientsStore {
  constructor(private readonly prisma: PrismaClient) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const row = await this.prisma.mcpOAuthClient.findUnique({ where: { clientId } })
    return row ? oauthClientRowToSdk(row) : undefined
  }

  /**
   * Called by the SDK's `clientRegistrationHandler` with the parsed +
   * SDK-generated `clientInfo` (including a placeholder `client_id` per the
   * `OAuthRegisteredClientsStore` contract note on `registerClient` — the
   * SDK generates one before calling this method by default). This store
   * discards it and mints its own `mcp_client_<id>`, matching clickroom's
   * existing ID convention (`newId()`, same as every other durable row) —
   * the value it returns here is what's actually sent back to the client.
   */
  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): Promise<OAuthClientInformationFull> {
    const redirectUris = client.redirect_uris ?? []
    if (redirectUris.length === 0 || !redirectUris.every(isAllowedRedirectUri)) {
      throw new InvalidClientMetadataError('redirect_uris must be https or loopback http')
    }
    const clientId = `mcp_client_${newId()}`
    const row = await this.prisma.mcpOAuthClient.create({
      data: {
        id: newId(),
        clientId,
        clientName: client.client_name ?? null,
        redirectUris,
        grantTypes: client.grant_types ?? DEFAULT_GRANT_TYPES,
        responseTypes: client.response_types ?? DEFAULT_RESPONSE_TYPES,
        scope: client.scope ?? null,
        tokenEndpointAuthMethod: 'none',
      },
    })
    return oauthClientRowToSdk(row)
  }
}
