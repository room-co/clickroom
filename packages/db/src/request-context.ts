import { AsyncLocalStorage } from 'node:async_hooks'
import type { OrgRole } from '@prisma/client'

/**
 * Per-request tenant context populated by the API's request-context middleware
 * after it verifies the caller's access token. It lives here (next to the
 * scoped Prisma client) so both share one AsyncLocalStorage store — the tRPC
 * procedures read `orgId`/`orgRole` from it to build the scoped client and gate
 * permissions.
 */
export interface RequestContext {
  userId: string
  orgId: string
  orgRole: OrgRole
  // Set when the caller authenticated with a project-pinned token — an `mcp`
  // (`ckmcp_`) ApiKey today, an OAuth-issued token later (`mcp-oauth`).
  // `jwt` (web session) callers resolve their project per-request from tRPC
  // input instead (see `scopedForProject`), so this stays undefined for them.
  projectId?: string
  // 'mcp' — `ckmcp_` bearer token. 'mcp-oauth' — OAuth 2.1 access
  // token, not issued yet; reserved here so that task doesn't need to
  // touch this file's type again).
  authSource: 'jwt' | 'mcp' | 'mcp-oauth'
  // Set when the current request is running inside a session
  // minted by `admin.impersonate.start`. Every write made during such a
  // request must attribute back to the admin, not just the impersonated
  // user, so routers/services can read this off the ALS store without every
  // one of them threading a new parameter through.
  impersonatedByAdminId?: string
}

export const requestContextStorage = new AsyncLocalStorage<RequestContext>()
