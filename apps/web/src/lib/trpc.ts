import type { AppRouter } from '@clickroom/trpc-router'
import { type CreateTRPCReact, createTRPCReact } from '@trpc/react-query'

// Explicit annotation avoids TS2742 ("inferred type cannot be named") in this
// monorepo — the inferred type otherwise drags in non-portable transitive
// references (express types, server-only context types) from @clickroom/trpc-router.
export const trpc: CreateTRPCReact<AppRouter, unknown> = createTRPCReact<AppRouter>()
