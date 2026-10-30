import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { httpBatchLink } from '@trpc/client'
import { type ReactNode, useState } from 'react'
import { TRPC_URL } from './api-origin'
import { getAccessToken } from './auth-store'
import { retryOnUnauthorizedLink, trpc } from './trpc'

/**
 * Authenticated tRPC client. `retryOnUnauthorizedLink` sits before `httpBatchLink` so it
 * can retry a request once after a silent refresh; the bearer header always reads the current
 * in-memory token (never persisted — see `lib/auth-store.ts`), so a retry after refresh picks up
 * the new token automatically.
 */
export function TrpcProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        retryOnUnauthorizedLink(),
        httpBatchLink({
          url: TRPC_URL,
          // `credentials: 'include'` carries the httpOnly admin refresh cookie
          // cross-origin in prod; a no-op against dev's same-origin proxy.
          fetch: (input, init) => fetch(input, { ...init, credentials: 'include' }),
          headers: () => {
            const token = getAccessToken()
            return token ? { Authorization: `Bearer ${token}` } : {}
          },
        }),
      ],
    }),
  )

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  )
}
