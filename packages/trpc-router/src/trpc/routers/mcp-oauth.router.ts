// Consent-screen tRPC procedures for clickroom's MCP OAuth 2.1 authorization
// server. Mirrors the reference implementation's `mcp-oauth.router.ts` — the
// consent screen runs in the WEB app under `RequireAuth`, so these are
// `authedProcedure`s (real userId via the web-session JWT), NOT org-scoped:
// the project isn't chosen until `approve`, and the picker spans every
// project the user can see. `ClickroomOAuthProvider.authorize()` redirects
// the browser to `${WEB_PUBLIC_URL}/oauth/mcp/consent?req=<signed state>`;
// `McpConsentPage.tsx` calls `consentInfo` to render the picker, then
// `approve`/`deny` to complete the flow. Unlike the reference implementation (org + scopes),
// clickroom's grant model is org + project (see `code-store.ts`), so the
// picker here is a flat list of `{orgId, orgName, projectId, projectName}`
// rather than an org-only `Select`.
import { prisma } from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { redis } from '../../lib/redis.js'
import { McpOAuthClientStore } from '../../mcp/oauth/client-store.js'
import { McpAuthCodeStore } from '../../mcp/oauth/code-store.js'
import { mcpOAuthStateSecret } from '../../mcp/oauth/mcp-oauth.constants.js'
import { listUserProjects, resolveUserProject } from '../../mcp/oauth/mcp-oauth.service.js'
import { type McpAuthStatePayload, verifyMcpAuthState } from '../../mcp/oauth/oauth-state.js'
import { authedProcedure, router } from '../trpc.js'

const clients = new McpOAuthClientStore(prisma)
const codes = new McpAuthCodeStore(redis)

const ReqInput = z.object({ req: z.string().min(1) })
const ApproveInput = ReqInput.extend({ projectId: z.string().min(1) })

// Verify + decode the signed authorize `state` blob; a tampered/expired blob is a
// bad request rather than a server error.
function decodeReq(blob: string): McpAuthStatePayload {
  const payload = verifyMcpAuthState(blob, mcpOAuthStateSecret())
  if (!payload) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Invalid or expired authorization request.',
    })
  }
  return payload
}

// Build the client redirect URL, preserving the OAuth `state` round-trip.
function buildRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value)
  }
  return url.toString()
}

export const mcpOAuthRouter = router({
  // Screen data: client name + requested scopes + the user's org/project options.
  consentInfo: authedProcedure.input(ReqInput).query(async ({ ctx, input }) => {
    const state = decodeReq(input.req)
    const client = await clients.getClient(state.clientId)
    const projects = await listUserProjects(prisma, ctx.tokenPayload.sub)
    return {
      clientName: client?.client_name ?? state.clientId,
      scopes: state.scopes,
      projects,
    }
  }),

  // Mint a one-time authorization code bound to the chosen org+project, then
  // send the browser back to the client with code + state.
  approve: authedProcedure.input(ApproveInput).mutation(async ({ ctx, input }) => {
    const state = decodeReq(input.req)
    const userId = ctx.tokenPayload.sub
    const resolved = await resolveUserProject(prisma, userId, input.projectId)
    if (!resolved) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Not a member of that project.',
      })
    }
    const code = await codes.mintCode({
      clientId: state.clientId,
      userId,
      orgId: resolved.orgId,
      projectId: input.projectId,
      redirectUri: state.redirectUri,
      codeChallenge: state.codeChallenge,
      codeChallengeMethod: state.codeChallengeMethod,
    })
    return { redirectTo: buildRedirect(state.redirectUri, { code, state: state.state }) }
  }),

  // User declined: redirect back with the OAuth access_denied error.
  deny: authedProcedure.input(ReqInput).mutation(({ input }) => {
    const state = decodeReq(input.req)
    return {
      redirectTo: buildRedirect(state.redirectUri, { error: 'access_denied', state: state.state }),
    }
  }),
})
