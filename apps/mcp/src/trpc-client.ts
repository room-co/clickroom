// public tRPC client — same shape (`AgentToolContext['client']`) the
// remote HTTP endpoint's loopback client satisfies, so `AGENT_TOOLS` handlers
// are transport-agnostic.
import type { AppRouter } from '@clickroom/trpc-router'
import type { TRPCClient } from '@trpc/client'
import { createTRPCProxyClient, httpBatchLink } from '@trpc/client'

/** Wraps `fetch` with an `AbortController` timeout, honoring any signal the link already set. */
function timeoutFetch(timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )

    const callerSignal = init?.signal
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason)
      else
        callerSignal.addEventListener('abort', () => controller.abort(callerSignal.reason), {
          once: true,
        })
    }

    try {
      return await fetch(input, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Builds the public tRPC proxy client the stdio bridge forwards every tool call through. */
export function createTrpcClient(
  token: string,
  apiUrl: string,
  timeoutMs: number,
): TRPCClient<AppRouter> {
  return createTRPCProxyClient<AppRouter>({
    links: [
      httpBatchLink({
        url: apiUrl,
        fetch: timeoutFetch(timeoutMs),
        headers: () => ({ authorization: `Bearer ${token}` }),
      }),
    ],
  })
}
