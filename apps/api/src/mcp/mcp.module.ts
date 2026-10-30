import { prisma } from '@clickroom/db'
import { redis } from '@clickroom/trpc-router/lib/redis.js'
import {
  mcpOAuthJwtSecret,
  mcpOAuthStateSecret,
  mcpWebPublicUrl,
} from '@clickroom/trpc-router/mcp/oauth/mcp-oauth.constants.js'
import { Module } from '@nestjs/common'
import { McpController } from './mcp.controller.js'
import { ClickroomOAuthProvider } from './oauth/mcp-oauth.provider.js'

/**
 * Everything MCP-related in `apps/api`: the OAuth 2.1 authorization server
 * (now backed by `@modelcontextprotocol/sdk`'s `mcpAuthRouter`, see
 * `main.ts`) plus the remote Streamable-HTTP `/mcp` endpoint it
 * issues tokens for. The human-facing consent step is a real page in
 * `apps/web` (`McpConsentPage.tsx`, driven by `trpc.mcpOAuth.*` —
 * `apps/api/src/trpc/routers/mcp-oauth.router.ts`), not anything in this
 * module. `ClickroomOAuthProvider` is shared by `McpController` (token
 * verification) and `mcpAuthRouter` (mounted directly on the Express app in
 * `main.ts`, not through Nest) — both need the exact same instance, so it's
 * provided here and exported for `main.ts` to pull out via `app.get`.
 */
@Module({
  controllers: [McpController],
  providers: [
    {
      provide: ClickroomOAuthProvider,
      useFactory: () =>
        new ClickroomOAuthProvider(prisma, redis, {
          jwtSecret: mcpOAuthJwtSecret(),
          stateSecret: mcpOAuthStateSecret(),
          webPublicUrl: mcpWebPublicUrl(),
        }),
    },
  ],
  exports: [ClickroomOAuthProvider],
})
export class McpModule {}
