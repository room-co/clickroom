// The remote `/mcp` endpoint's key architectural piece: builds
// a tRPC *proxy* client (not `appRouter.createCaller()`) pointed at this same
// process's own public `/trpc` mount, forwarding the caller's original bearer
// token unchanged. That re-enters the real Express request pipeline — the
// same `request-context.middleware.ts` + `requirePermission`/
// `scopedForProject` checks a normal dashboard request would hit — so
// `AGENT_TOOLS` handlers never need a parallel authz path, and behave
// identically whether called from the stdio bridge (public client) or here.

import type { AppRouter } from '@clickroom/trpc-router'
import { createTRPCProxyClient, httpBatchLink, type TRPCClient } from '@trpc/client'

/** Same env var `main.ts` reads to pick the port this process listens on. */
function apiPort(): number {
  return Number(process.env.API_PORT ?? 3000)
}

/**
 * Builds a tRPC proxy client bound to `http://127.0.0.1:${API_PORT}/trpc`,
 * sending `authorization` verbatim as the loopback request's own
 * `Authorization` header — whatever bearer the incoming `/mcp` request itself
 * carried (a `ckmcp_` token or an OAuth access token).
 */
export function createLoopbackClient(authorization: string): TRPCClient<AppRouter> {
  return createTRPCProxyClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `http://127.0.0.1:${apiPort()}/trpc`,
        headers: () => ({ authorization }),
      }),
    ],
  })
}
