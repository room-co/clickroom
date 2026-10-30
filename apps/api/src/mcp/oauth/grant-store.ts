// Refresh-token grant store for the MCP OAuth provider (
// rewrite of the refresh-token half of `mcp-oauth.service.ts`, converted to a
// class alongside `McpOAuthClientStore`/`McpAuthCodeStore`). Rotation
// revokes the redeemed row and inserts a fresh one (rather than the reference implementation's
// rotate-in-place) — this was clickroom's existing behavior and is
// kept unchanged: still OAuth 2.1-compliant refresh-token rotation, just
// audit-friendly (every grant a token was ever active under stays queryable).
import {
  generateRefreshToken,
  hashRefreshToken,
  MCP_ACCESS_TOKEN_TTL_SECONDS,
  MCP_REFRESH_TOKEN_TTL_SECONDS,
  refreshTokenSelector,
  verifyRefreshToken,
} from '@clickroom/auth'
import { newId, type PrismaClient } from '@clickroom/db'

export interface CreateGrantInput {
  clientId: string
  userId: string
  orgId: string
  projectId: string
}

export interface IssuedGrant {
  clientId: string
  userId: string
  orgId: string
  projectId: string
  refreshToken: string
  expiresIn: number
}

export class McpGrantStore {
  constructor(private readonly prisma: PrismaClient) {}

  /** Mint a fresh (Argon2id-hashed) refresh-token row scoped to one org+project. */
  async createGrant(input: CreateGrantInput): Promise<IssuedGrant> {
    const refreshToken = generateRefreshToken()
    await this.prisma.mcpOAuthRefreshToken.create({
      data: {
        id: newId(),
        selector: refreshTokenSelector(refreshToken),
        tokenHash: await hashRefreshToken(refreshToken),
        clientId: input.clientId,
        userId: input.userId,
        orgId: input.orgId,
        projectId: input.projectId,
        expiresAt: new Date(Date.now() + MCP_REFRESH_TOKEN_TTL_SECONDS * 1000),
      },
    })
    return {
      clientId: input.clientId,
      userId: input.userId,
      orgId: input.orgId,
      projectId: input.projectId,
      refreshToken,
      expiresIn: MCP_ACCESS_TOKEN_TTL_SECONDS,
    }
  }

  /**
   * Redeem a refresh token: verify it against its stored hash, reject if
   * revoked/expired/client-mismatched, revoke the redeemed row, and mint a
   * replacement grant (OAuth 2.1 refresh-token rotation). Returns null for
   * any invalid input — all collapse to `invalid_grant` at the caller.
   */
  async rotateGrant(rawRefreshToken: string, clientId: string): Promise<IssuedGrant | null> {
    const selector = refreshTokenSelector(rawRefreshToken)
    const row = await this.prisma.mcpOAuthRefreshToken.findUnique({ where: { selector } })
    if (!row) return null
    if (row.clientId !== clientId) return null
    if (row.revokedAt) return null
    if (row.expiresAt.getTime() < Date.now()) return null
    if (!(await verifyRefreshToken(rawRefreshToken, row.tokenHash))) return null

    await this.prisma.mcpOAuthRefreshToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    })

    return this.createGrant({
      clientId: row.clientId,
      userId: row.userId,
      orgId: row.orgId,
      projectId: row.projectId,
    })
  }

  /** Best-effort revocation by refresh token — never throws, matches the
   * SDK's `revokeToken?` contract ("if invalid or already revoked, do nothing"). */
  async revokeByRefreshToken(rawRefreshToken: string): Promise<void> {
    await this.prisma.mcpOAuthRefreshToken.updateMany({
      where: { selector: refreshTokenSelector(rawRefreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }
}
