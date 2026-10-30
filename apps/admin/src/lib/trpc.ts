import type { AppRouter } from '@clickroom/trpc-router'
import type { TRPCLink } from '@trpc/client'
import { TRPCClientError } from '@trpc/client'
import { type CreateTRPCReact, createTRPCReact } from '@trpc/react-query'
import { observable } from '@trpc/server/observable'
import { refreshAccessToken } from './refresh'

// Explicit annotation avoids TS2742 ("inferred type cannot be named") in this
// monorepo — the inferred type otherwise drags in non-portable transitive
// references (express types, server-only context types) from
// @clickroom/trpc-router. Same pattern as apps/web/src/lib/trpc.ts.
export const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>()

/**
 * On an UNAUTHORIZED error (expired/missing access token), attempts one silent cookie-backed
 * refresh via `lib/refresh.ts` and retries the original operation exactly once with whatever
 * token that produced. If the refresh also fails, the original error propagates — the token is
 * left cleared (refresh.ts's job), and `ProtectedAdminRoute` is what turns that into a redirect,
 * not this link.
 *
 * Must be placed BEFORE `httpBatchLink` in the link chain so it can intercept that link's errors
 * and re-invoke `next(op)` (which re-reads the Authorization header, i.e. the refreshed token).
 */
export function retryOnUnauthorizedLink(): TRPCLink<AppRouter> {
  return () =>
    ({ next, op }) =>
      observable((observer) => {
        let retried = false
        let sub: { unsubscribe: () => void } | null = null

        function run() {
          sub = next(op).subscribe({
            next: (value) => observer.next(value),
            complete: () => observer.complete(),
            error: (err) => {
              if (!retried && err instanceof TRPCClientError && err.data?.code === 'UNAUTHORIZED') {
                retried = true
                refreshAccessToken()
                  .then((token) => (token ? run() : observer.error(err)))
                  .catch(() => observer.error(err))
              } else {
                observer.error(err)
              }
            },
          })
        }

        run()
        return () => sub?.unsubscribe()
      })
}
