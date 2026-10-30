// MCP OAuth `authorize`-state signing/verification (/rewrite).
// Format: base64url(JSON payload).base64url(HMAC-SHA256(payload, secret)).
// Pure + total: verify never throws — returns null on any malformed/tampered/expired input.
// Secret is passed in (from `mcpOAuthStateSecret()` at call sites); this module does not read env.
import crypto from 'node:crypto'

const DEFAULT_TTL_MS = 15 * 60 * 1000

/**
 * Everything the `/authorize` handler validated before calling
 * `ClickroomOAuthProvider.authorize()` (client_id/redirect_uri/PKCE/state
 * already resolved by the SDK's `mcpAuthRouter`) — carried through the
 * redirect to `GET /mcp/oauth/consent` and back without server-side session
 * state.
 */
export interface McpAuthStatePayload {
  clientId: string
  redirectUri: string
  codeChallenge: string
  codeChallengeMethod?: string
  state?: string
  scopes: string[]
  resource?: string
}

interface SignedPayload extends McpAuthStatePayload {
  nonce: string
  exp: number
}

function hmac(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url')
}

export function signMcpAuthState(
  payload: McpAuthStatePayload,
  secret: string,
  ttlMs: number = DEFAULT_TTL_MS,
): string {
  const signed: SignedPayload = {
    ...payload,
    nonce: crypto.randomBytes(16).toString('hex'),
    exp: Date.now() + ttlMs,
  }
  const encoded = Buffer.from(JSON.stringify(signed)).toString('base64url')
  return `${encoded}.${hmac(encoded, secret)}`
}

function sigMatches(encoded: string, sig: string, secret: string): boolean {
  const expected = Buffer.from(hmac(encoded, secret), 'base64url')
  const actual = Buffer.from(sig, 'base64url')
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

function decodePayload(encoded: string): SignedPayload | null {
  try {
    const data = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    if (!data || typeof data !== 'object') return null
    return data as SignedPayload
  } catch {
    return null
  }
}

export function verifyMcpAuthState(blob: string, secret: string): McpAuthStatePayload | null {
  if (typeof blob !== 'string' || typeof secret !== 'string' || secret.length === 0) return null
  const dot = blob.lastIndexOf('.')
  if (dot <= 0) return null
  const encoded = blob.slice(0, dot)
  const sig = blob.slice(dot + 1)
  if (!encoded || !sig) return null
  if (!sigMatches(encoded, sig, secret)) return null
  const data = decodePayload(encoded)
  if (!data || typeof data.exp !== 'number' || data.exp < Date.now()) return null
  const { nonce: _nonce, exp: _exp, ...payload } = data
  return payload
}
