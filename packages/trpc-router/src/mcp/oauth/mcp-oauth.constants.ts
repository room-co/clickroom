import { DEV_JWT_SECRET, DEV_MCP_OAUTH_STATE_SECRET, resolveSecret } from '@clickroom/auth'

/**
 * Shared config for clickroom's MCP OAuth 2.1 authorization server
 * (/, now backed by `@modelcontextprotocol/sdk`'s `mcpAuthRouter`
 * — see `mcp-oauth.provider.ts` + `apps/api/src/main.ts`). Kept in one file
 * so the SDK router, the in-API consent controller, and
 * `request-context.middleware.ts` all agree on the same issuer/secrets
 * without re-deriving them. `mcpAuthRouter` serves `/register`, `/authorize`,
 * `/token`, `/revoke`, and both `/.well-known/*` metadata docs itself, at the
 * application root — this file no longer hand-builds those paths.
 */

/** JWT signing secret — same one the web-session access token uses (see
 * `apps/api/src/main.ts`), so both share a verification path in
 * `request-context.middleware.ts`. */
export function mcpOAuthJwtSecret(): string {
  return resolveSecret('JWT_SECRET', DEV_JWT_SECRET)
}

/** HMAC secret for the `authorize` → consent-screen state blob
 * (`oauth-state.ts`). Distinct from the JWT secret so a leaked state blob
 * can't be replayed as anything resembling an access token. */
export function mcpOAuthStateSecret(): string {
  return resolveSecret('MCP_OAUTH_STATE_SECRET', DEV_MCP_OAUTH_STATE_SECRET)
}

/**
 * Public origin this API is reachable at. Also the SDK `mcpAuthRouter`'s
 * `issuerUrl`/`resourceServerUrl` base (`main.ts`), and the base of
 * `WWW-Authenticate: Bearer resource_metadata="..."` on `/mcp`'s 401
 * response. Defaults to `http://localhost:<API_PORT>` for local/dev; set
 * `MCP_OAUTH_ISSUER` in prod so it points at a URL the outside world can
 * actually reach.
 */
export function mcpOAuthIssuer(): string {
  const fromEnv = process.env.MCP_OAUTH_ISSUER
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  const port = process.env.API_PORT ?? '3000'
  return `http://localhost:${port}`
}

export const MCP_ENDPOINT_PATH = '/mcp'

/**
 * Public origin `apps/web` (the dashboard SPA) is reachable at.
 * `ClickroomOAuthProvider.authorize()` redirects the browser here
 * (`${webPublicUrl}/oauth/mcp/consent?req=...`) so the human-facing consent
 * step runs in the real web app — with real login — instead of a
 * server-rendered page in `apps/api`. Mirrors the reference implementation's `WEB_PUBLIC_URL`.
 * Defaults to the web app's own dev server port (see `apps/web/vite.config.ts`).
 */
export function mcpWebPublicUrl(): string {
  return (process.env.WEB_PUBLIC_URL ?? 'http://localhost:5180').replace(/\/$/, '')
}
