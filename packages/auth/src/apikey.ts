import { createHash, randomBytes } from 'node:crypto'

export type ApiKeyType = 'write' | 'read' | 'mcp'

/** Number of leading chars of a token stored/shown as a non-secret display prefix. */
export const API_KEY_PREFIX_LENGTH = 16

/** Number of hex chars in the `mcp` token's public `<selector>` half. */
const MCP_SELECTOR_LENGTH = 16

/** Human/machine-readable token prefix for a key type (e.g. `ckw_live_`, `ckmcp_`). */
export function apiKeyTypePrefix(type: ApiKeyType): string {
  if (type === 'write') return 'ckw_live_'
  if (type === 'read') return 'ckr_live_'
  return 'ckmcp_'
}

/**
 * SHA-256 (hex) hash of a raw API key (or, for `mcp` tokens, just the `<secret>`
 * half). Deterministic — capture-rs (Rust) hashes incoming keys identically and
 * looks up ApiKey.keyHash. Never store plaintext.
 */
export function hashApiKey(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Mint a new API key. Returns the plaintext `token` (shown once), its `keyHash`
 * (stored for lookup), and a non-secret `keyPrefix` for UI display.
 *
 * `write`/`read` tokens keep the flat `ck{w,r}_live_<hex>` shape and are looked
 * up by the (unique-indexed) `keyHash` of the whole token — already O(1).
 *
 * `mcp` tokens use `ckmcp_<selector>.<secret>`: `selector` is a public,
 * unique-indexed value the request-context middleware uses to find the row in
 * one lookup *before* hashing anything; `secret` is then hashed with
 * {@link hashApiKey} and compared against the stored `keyHash`. `selector` is
 * also returned so callers can persist it on `ApiKey.selector`.
 */
export function generateApiKey(type: ApiKeyType): {
  token: string
  keyHash: string
  keyPrefix: string
  selector: string | null
} {
  if (type !== 'mcp') {
    const token = `${apiKeyTypePrefix(type)}${randomBytes(24).toString('hex')}`
    const keyHash = hashApiKey(token)
    const keyPrefix = token.slice(0, API_KEY_PREFIX_LENGTH)
    return { token, keyHash, keyPrefix, selector: null }
  }

  const selector = randomBytes(MCP_SELECTOR_LENGTH / 2).toString('hex')
  const mcpSecret = randomBytes(24).toString('hex')
  const token = `${apiKeyTypePrefix(type)}${selector}.${mcpSecret}`
  const keyHash = hashApiKey(mcpSecret)
  const keyPrefix = token.slice(0, API_KEY_PREFIX_LENGTH)
  return { token, keyHash, keyPrefix, selector }
}

/**
 * Split a `ckmcp_<selector>.<secret>` bearer token into its two halves for
 * lookup/verification. Returns `null` if the token doesn't carry the `ckmcp_`
 * prefix or is malformed (missing/extra `.` separator).
 */
export function parseMcpApiKey(token: string): { selector: string; secret: string } | null {
  const prefix = apiKeyTypePrefix('mcp')
  if (!token.startsWith(prefix)) return null
  const rest = token.slice(prefix.length)
  const parts = rest.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return { selector: parts[0], secret: parts[1] }
}
