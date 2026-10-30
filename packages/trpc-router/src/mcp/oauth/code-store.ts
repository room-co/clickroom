// Authorization-code store for the MCP OAuth provider (
// rewrite of `mcp-oauth.codes.ts`, converted from a pair of free functions
// into a class so `ClickroomOAuthProvider` can depend on it the same way it
// depends on `McpOAuthClientStore`/`McpGrantStore`). Codes are single-use +
// short-lived (RFC 6749, so — unlike the client/grant stores — they
// live in Redis, not Postgres: read exactly once and TTL out in minutes.
import { randomBytes } from 'node:crypto'
import type { Redis } from 'ioredis'

/** 120s — generous enough for the `/authorize` → consent → `/token` round
 * trip, short enough that a leaked/logged code is worthless soon after. */
const AUTH_CODE_TTL_SECONDS = 120

function codeKey(code: string): string {
  return `mcp:oauth:code:${code}`
}

interface StoredCode {
  clientId: string
  userId: string
  orgId: string
  projectId: string
  redirectUri: string
  codeChallenge: string
  codeChallengeMethod: string
}

export interface MintCodeInput {
  clientId: string
  userId: string
  orgId: string
  projectId: string
  redirectUri: string
  codeChallenge: string
  codeChallengeMethod?: string
}

export interface ConsumedCode {
  clientId: string
  userId: string
  orgId: string
  projectId: string
  redirectUri: string
  codeChallenge: string
}

export class McpAuthCodeStore {
  constructor(private readonly redis: Redis) {}

  /** Mint a fresh authorization code and persist its payload for one redemption. */
  async mintCode(input: MintCodeInput): Promise<string> {
    const code = randomBytes(32).toString('hex')
    const payload: StoredCode = {
      clientId: input.clientId,
      userId: input.userId,
      orgId: input.orgId,
      projectId: input.projectId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod ?? 'S256',
    }
    await this.redis.set(codeKey(code), JSON.stringify(payload), 'EX', AUTH_CODE_TTL_SECONDS)
    return code
  }

  /**
   * Return the stored `code_challenge` for a not-yet-consumed code, or ''
   * when unknown/expired — the SDK's token handler compares this against the
   * caller's `code_verifier` for equality, so an empty string always forces
   * a PKCE mismatch rather than accidentally validating.
   */
  async peekChallenge(rawCode: string): Promise<string> {
    const raw = await this.redis.get(codeKey(rawCode))
    if (!raw) return ''
    try {
      return (JSON.parse(raw) as StoredCode).codeChallenge
    } catch {
      return ''
    }
  }

  /**
   * Atomically consume (read + delete) a code. Returns null if unknown or
   * already redeemed — deleting before returning means a racing double-
   * redemption (retry, replay) can't both succeed.
   */
  async consumeCode(rawCode: string): Promise<ConsumedCode | null> {
    const key = codeKey(rawCode)
    const raw = await this.redis.get(key)
    if (!raw) return null
    await this.redis.del(key)
    try {
      const stored = JSON.parse(raw) as StoredCode
      return {
        clientId: stored.clientId,
        userId: stored.userId,
        orgId: stored.orgId,
        projectId: stored.projectId,
        redirectUri: stored.redirectUri,
        codeChallenge: stored.codeChallenge,
      }
    } catch {
      return null
    }
  }
}
