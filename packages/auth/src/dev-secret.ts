// Fail-closed secret resolution. A committed dev literal may only be used when
// NODE_ENV is explicitly `development` or `test`; any other value (including
// `production` and unset) means a missing secret is a hard error, never a
// silent fallback to a publicly-known string.

type Env = Record<string, string | undefined>

export function isDevLikeEnv(env: Env = process.env): boolean {
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test'
}

/**
 * Return `env[name]` when set; otherwise `devFallback` if (and only if) NODE_ENV is
 * development/test; otherwise throw.
 */
export function resolveSecret(name: string, devFallback: string, env: Env = process.env): string {
  const value = env[name]
  if (value) return value
  if (isDevLikeEnv(env)) return devFallback
  throw new Error(
    `${name} is required (NODE_ENV=${env.NODE_ENV ?? '<unset>'}). Refusing to fall back to a ` +
      'development default; the dev literal is only usable when NODE_ENV is development or test. ' +
      'Generate one with `openssl rand -hex 32`.',
  )
}

/** Dev-only literals, shared so tests/dev tooling and the resolvers agree. */
export const DEV_JWT_SECRET = 'dev-only-change-me'
export const DEV_ADMIN_JWT_SECRET = 'dev-only-admin-secret-change-me'
export const DEV_MCP_OAUTH_STATE_SECRET = 'dev-mcp-oauth-state-secret'
export const DEV_SSO_RELAY_STATE_SECRET = 'dev-sso-relay-state-secret-change-in-prod'
