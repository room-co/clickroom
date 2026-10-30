import { config } from './env.js' // MUST be first: populates process.env before the db singleton reads DATABASE_URL
import 'reflect-metadata'
import {
  backfillProjectEnvironments,
  backfillSystemDefinitions,
  enforceSelfHostPlans,
  ensureBootstrapAdmin,
  prisma,
} from '@clickroom/db'
import { appRouter, makeCreateContext } from '@clickroom/trpc-router'
import {
  MCP_ENDPOINT_PATH,
  mcpOAuthIssuer,
} from '@clickroom/trpc-router/mcp/oauth/mcp-oauth.constants.js'
import { AuthService } from '@clickroom/trpc-router/services/auth.service.js'
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { createExpressMiddleware } from '@trpc/server/adapters/express'
import cookieParser from 'cookie-parser'
import express from 'express'
import helmet from 'helmet'
import { AppModule } from './app.module.js'
import { createSsoRouter } from './http/sso.router.js'
import { ClickroomOAuthProvider } from './mcp/oauth/mcp-oauth.provider.js'
import { makeRequestContextMiddleware } from './request-context/request-context.middleware.js'

const JWT_SECRET = config.secrets.jwt
const ADMIN_JWT_SECRET = config.secrets.adminJwt

const PORT = Number(process.env.API_PORT ?? 3000)

function getCorsOrigins(): string[] {
  const fromEnv = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
        .map((o) => o.trim())
        .filter(Boolean)
    : []
  if (fromEnv.length > 0) return fromEnv
  // Single-domain installs: the dashboard origin is the only browser origin that needs CORS.
  const webOrigin = process.env.WEB_PUBLIC_URL?.trim().replace(/\/+$/, '')
  if (webOrigin) return [webOrigin]
  // Dev default: the dev-proxy origin the browser sees (fronts marketing + web SPA).
  return ['http://localhost:5177']
}

async function bootstrap() {
  // `bodyParser: false` so we install the JSON parser ourselves with a
  // raised limit, instead of Nest's automatic default (~100kb — plenty for
  // `/mcp`'s small JSON-RPC tool-call payloads, never needed to
  // touch it, but `/ai/chat`'s replayed conversation history + tool-output
  // parts can comfortably exceed that). Nest has no cheap per-mount-path
  // body-limit override, so this raises it once for the whole app — 5mb is
  // harmless for every other route, which all send far smaller payloads.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false })
  app.use(express.json({ limit: '5mb' }))
  app.use(express.urlencoded({ extended: true, limit: '5mb' }))

  app.use(helmet())
  app.use(cookieParser())
  app.enableCors({ origin: getCorsOrigins(), credentials: true })

  // tRPC mounts as Express middleware (official tRPC + Nest pattern). The ALS
  // request-context middleware MUST run before tRPC so org/user context is
  // populated for org-scoped procedures. It also gates `/mcp`,
  // Nest-routed) and `/ai`, Nest-routed): both read the same ALS
  // store to decide whether the caller is authenticated before building
  // their loopback client.
  app.use(['/trpc', '/mcp', '/ai'], makeRequestContextMiddleware(prisma, JWT_SECRET))
  app.use(
    '/trpc',
    createExpressMiddleware({
      router: appRouter,
      createContext: makeCreateContext(prisma, JWT_SECRET, ADMIN_JWT_SECRET),
    }),
  )

  // SSO browser-redirect endpoints — plain express.Router(), not a
  // Nest controller, mounted at the application root like `mcpAuthRouter`
  // below. Must run after `cookieParser()` (relay-state cookie) and
  // `express.urlencoded()` (SAML ACS form POST), both already installed above.
  app.use('/auth/sso', createSsoRouter(prisma, new AuthService(prisma, JWT_SECRET)))

  // Self-hosted OAuth 2.1 authorization server for the MCP endpoint
  // rewrite — replaces the hand-rolled `mcp-oauth.controller.ts`). `mcpAuthRouter` MUST be installed
  // at the application root (SDK requirement) — it serves `/authorize`,
  // `/token`, `/register`, `/revoke`, and both RFC 8414/9728 metadata docs
  // under `/.well-known/*`. Mounted before `app.listen()` (which registers
  // Nest's own router), so these paths resolve before any Nest catch-all.
  const oauthProvider = app.get(ClickroomOAuthProvider)
  const issuerUrl = new URL(mcpOAuthIssuer())
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl,
      scopesSupported: ['mcp'],
      resourceName: 'Clickroom MCP',
      resourceServerUrl: new URL(`${issuerUrl.origin}${MCP_ENDPOINT_PATH}`),
    }),
  )

  // Opt-in first-boot admin (CLICKROOM_ADMIN_EMAIL + CLICKROOM_ADMIN_PASSWORD). Idempotent;
  // never rotates an existing admin and never prints the password.
  await ensureBootstrapAdmin(prisma, process.env)
  // Idempotent data repairs: projects created without environments (key/flag creation
  // 500s on them) and, in self_host, orgs left on a limited plan (capture's SQL
  // fallback reads plan rows directly, so the rows themselves must say unlimited).
  await backfillProjectEnvironments(prisma)
  await backfillSystemDefinitions(prisma)
  await enforceSelfHostPlans(prisma)
  await app.listen(PORT)
  console.log(`clickroom api listening on :${PORT}`)
}

bootstrap().catch((err) => {
  console.error(err)
  process.exit(1)
})
