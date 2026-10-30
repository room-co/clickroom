// The tRPC control-plane router, extracted out of `apps/api` so that
// `AppRouter`'s *type* lives somewhere every consumer can depend on
// one-directionally.
//
// `packages/agent-tools` needs `AppRouter` to type `ctx.client`, but `apps/api`
// has a real runtime dependency on `agent-tools` — so an `agent-tools ->
// apps/api` edge (dev, prod, or peer; pnpm/turbo don't distinguish) makes the
// build graph cyclic and destroys `^build` ordering, which is what silently
// raced `apps/api`'s Docker build. This package is the acyclic bottom:
//   config <- db/auth/clickhouse/ai <- trpc-router <- agent-tools <- api
//
// Nothing here touches NestJS — `apps/api` stays the Nest/Express host that
// mounts `appRouter` and owns the controllers, DI and bootstrap.
//
// Deep modules (`lib/redis.js`, `mcp/oauth/*`, `trpc/routers/*`, ...) are
// reachable via the `./*` subpath export; this barrel carries only what the
// router contract itself is.
export { type AppRouter, appRouter } from './trpc/app.router.js'
export { type Context, makeCreateContext } from './trpc/context.js'
