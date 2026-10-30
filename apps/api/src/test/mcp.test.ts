// integration tests for the remote Streamable-HTTP `/mcp` endpoint.
// Unlike the rest of this suite (which drives `appRouter.createCaller()`
// in-process), this file boots a REAL Nest/Express server and drives it over
// real HTTP — the whole point of the endpoint's loopback-client design (see
// `../lib/loopback-client.ts` and in spec) is that tool
// calls re-enter the actual `/trpc` pipeline (request-context middleware +
// `requirePermission`/`scopedForProject`) instead of a parallel authz path,
// so only a real round trip actually exercises that.
import type { AddressInfo } from 'node:net'
import { AGENT_TOOLS } from '@clickroom/agent-tools'
import { issueMcpAccessToken } from '@clickroom/auth'
import { newId, prisma } from '@clickroom/db'
import { appRouter, makeCreateContext } from '@clickroom/trpc-router'
import { redis } from '@clickroom/trpc-router/lib/redis.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { createExpressMiddleware } from '@trpc/server/adapters/express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AppModule } from '../app.module.js'
import { makeRequestContextMiddleware } from '../request-context/request-context.middleware.js'
import { authService, callAs, cleanupOrg, cleanupUser, makeCtx } from './helpers.js'

// `mcp-oauth.constants.ts`'s `mcpOAuthJwtSecret()` reads `process.env.JWT_SECRET`
// (mirrored from the monorepo-root `.env` by `vitest.config.ts`), not
// `helpers.ts`'s `JWT_SECRET` constant — same distinction `mcp-oauth.test.ts`
// documents. The server harness below is signed/verified with this one.
const OAUTH_JWT_SECRET = process.env.JWT_SECRET ?? 'dev-only-change-me'

const suffix = Date.now().toString(36)
const createdUserIds: string[] = []
const createdOrgIds: string[] = []

let adminUserId: string
let memberUserId: string
let viewerUserId: string
let orgId: string
let projectId: string
let flagId: string

let app: NestExpressApplication
let mcpUrl: string
let ckmcpToken: string
let oauthMemberToken: string
let oauthViewerToken: string

function callerFor(userId: string) {
  return appRouter.createCaller(
    makeCtx({ tokenPayload: { sub: userId, sessionId: 'test', orgId } }),
  )
}

beforeAll(async () => {
  if (redis.status !== 'ready' && redis.status !== 'connecting') {
    await redis.connect()
  }

  const s = await authService.signup({
    email: `mcp-admin-${suffix}@test.invalid`,
    password: 'password123',
    orgName: `MCP HTTP Org ${suffix}`,
  })
  adminUserId = s.user.id
  orgId = s.org!.id
  createdUserIds.push(adminUserId)
  createdOrgIds.push(orgId)

  const project = await prisma.project.findFirstOrThrow({ where: { orgId } })
  projectId = project.id

  // No `Plan` row exists in the isolated test DB, so without an override the
  // lifetime flags-created quota fails closed to 0 — override it
  // so this suite's one flag exercises the MCP endpoint, not the quota gate.
  await prisma.org.update({ where: { id: orgId }, data: { maxFlagsOverride: 1000 } })

  const member = await prisma.user.create({
    data: {
      id: newId(),
      email: `mcp-member-${suffix}@test.invalid`,
      passwordHash: 'unused',
    },
  })
  memberUserId = member.id
  createdUserIds.push(memberUserId)
  await prisma.orgMembership.create({
    data: { id: newId(), orgId, userId: memberUserId, role: 'member' },
  })

  const viewer = await prisma.user.create({
    data: {
      id: newId(),
      email: `mcp-viewer-${suffix}@test.invalid`,
      passwordHash: 'unused',
    },
  })
  viewerUserId = viewer.id
  createdUserIds.push(viewerUserId)
  await prisma.orgMembership.create({
    data: { id: newId(), orgId, userId: viewerUserId, role: 'viewer' },
  })

  // A flag `flag_toggle` can flip, created by the admin via the normal
  // in-process caller (same helper the rest of the suite uses).
  const adminCaller = callerFor(adminUserId)
  const flag = await callAs({ userId: adminUserId, orgId, orgRole: 'org_admin' }, () =>
    adminCaller.flags.create({
      projectId,
      key: `mcp-http-flag-${suffix}`,
      active: false,
      filters: { groups: [{ properties: [], rollout_percentage: 0, variant: null }] },
    }),
  )
  flagId = flag.id

  // A real `ckmcp_` token, self-minted by the member user (member has
  // `keys:manage` — see `packages/auth/src/permissions.ts`).
  const memberCaller = callerFor(memberUserId)
  const created = await callAs({ userId: memberUserId, orgId, orgRole: 'member' }, () =>
    memberCaller.mcpKey.create({ projectId, label: 'HTTP test' }),
  )
  ckmcpToken = created.token

  // Raw OAuth 2.1 access tokens for both roles — bypasses the actual
  // authorize/token dance (already covered by `mcp-oauth.test.ts`); this file
  // only needs a token shaped exactly like what that flow produces.
  oauthMemberToken = await issueMcpAccessToken(
    { sub: memberUserId, orgId, projectId, clientId: 'mcp-http-test' },
    OAUTH_JWT_SECRET,
  )
  oauthViewerToken = await issueMcpAccessToken(
    { sub: viewerUserId, orgId, projectId, clientId: 'mcp-http-test' },
    OAUTH_JWT_SECRET,
  )

  // Boot a real server: same middleware wiring as `main.ts`'s `bootstrap()`,
  // minus helmet/CORS (irrelevant here) and on an OS-assigned port so tests
  // can run in parallel with a dev instance. `API_PORT` is set to the actual
  // bound port so `../lib/loopback-client.ts` (which reads it per-call, not
  // at import time) targets this same server for the loopback hop.
  // `makeRequestContextMiddleware`/`makeCreateContext` take the JWT secret as
  // a parameter and use it for BOTH the web-session and MCP-OAuth bearer
  // shapes (see `request-context.middleware.ts`) — pass the same secret
  // `issueMcpAccessToken` above signed with, so verification round-trips.
  app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false })
  app.use(['/trpc', '/mcp'], makeRequestContextMiddleware(prisma, OAUTH_JWT_SECRET))
  app.use(
    '/trpc',
    createExpressMiddleware({
      router: appRouter,
      createContext: makeCreateContext(prisma, OAUTH_JWT_SECRET),
    }),
  )
  await app.listen(0)
  const address = app.getHttpServer().address() as AddressInfo
  process.env.API_PORT = String(address.port)
  mcpUrl = `http://127.0.0.1:${address.port}/mcp`
})

afterAll(async () => {
  await app?.close()
  for (const oid of createdOrgIds) await cleanupOrg(oid)
  for (const uid of createdUserIds) await cleanupUser(uid)
  await redis.del(`flags:def:${projectId}:production`)
  await redis.quit()
  await prisma.$disconnect()
})

/** Connects a real MCP `Client` over Streamable HTTP, bearer-authenticated as `token`. */
async function connectClient(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: 'mcp-http-test-client', version: '0.0.0' })
  await client.connect(transport)
  return client
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0]
  if (block?.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('Expected a text content block.')
  }
  return block.text
}

describe('POST /mcp — auth gate', () => {
  it('401s with a WWW-Authenticate resource_metadata challenge when unauthenticated', async () => {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(res.status).toBe(401)
    const challenge = res.headers.get('www-authenticate')
    expect(challenge).toContain('Bearer')
    expect(challenge).toContain('resource_metadata="')
    expect(challenge).toContain('/.well-known/oauth-protected-resource')
  })

  it('401s for a garbage bearer too', async () => {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer not-a-real-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(res.status).toBe(401)
  })
})

describe('GET/DELETE /mcp', () => {
  it('GET → 405', async () => {
    const res = await fetch(mcpUrl, { method: 'GET' })
    expect(res.status).toBe(405)
  })

  it('DELETE → 405', async () => {
    const res = await fetch(mcpUrl, { method: 'DELETE' })
    expect(res.status).toBe(405)
  })
})

describe('tools/list — same registry, two auth sources', () => {
  it('lists every AGENT_TOOLS entry for a ckmcp_ bearer', async () => {
    const client = await connectClient(ckmcpToken)
    try {
      const { tools } = await client.listTools()
      expect(tools).toHaveLength(AGENT_TOOLS.length)
      const names = new Set(tools.map((t) => t.name))
      for (const tool of AGENT_TOOLS) expect(names.has(tool.name)).toBe(true)
    } finally {
      await client.close()
    }
  })

  it('lists every AGENT_TOOLS entry for an OAuth bearer', async () => {
    const client = await connectClient(oauthMemberToken)
    try {
      const { tools } = await client.listTools()
      expect(tools).toHaveLength(AGENT_TOOLS.length)
    } finally {
      await client.close()
    }
  })
})

describe('read tool round-trip through the loopback client', () => {
  it('flags_list returns the real seeded flag', async () => {
    const client = await connectClient(ckmcpToken)
    try {
      const result = await client.callTool({
        name: 'flags_list',
        arguments: { projectId, env: 'production' },
      })
      expect(result.isError).not.toBe(true)
      const flags = JSON.parse(firstText(result as never)) as Array<{ id: string; key: string }>
      expect(flags.some((f) => f.id === flagId)).toBe(true)
    } finally {
      await client.close()
    }
  })
})

describe('mutate tool — real requirePermission enforcement via the loopback hop', () => {
  it('flag_toggle applies for a member-role (flags:write) caller', async () => {
    const client = await connectClient(ckmcpToken)
    try {
      const result = await client.callTool({
        name: 'flag_toggle',
        arguments: { projectId, id: flagId, active: true },
      })
      expect(result.isError).not.toBe(true)
      const toggled = JSON.parse(firstText(result as never)) as { active: boolean }
      expect(toggled.active).toBe(true)
    } finally {
      await client.close()
    }

    const row = await prisma.featureFlag.findUniqueOrThrow({ where: { id: flagId } })
    expect(row.active).toBe(true)
  })

  it('flag_toggle is rejected FORBIDDEN (-32002) for a viewer-role caller', async () => {
    const client = await connectClient(oauthViewerToken)
    try {
      const result = await client.callTool({
        name: 'flag_toggle',
        arguments: { projectId, id: flagId, active: false },
      })
      expect(result.isError).toBe(true)
      const text = firstText(result as never)
      expect(text).toContain('[-32002]')
      expect(text).toContain('FORBIDDEN')
    } finally {
      await client.close()
    }

    // Enforcement actually ran server-side (`requirePermission('flags:write')`
    // rejected it) — the flag is unchanged, not just the tool result shape.
    const row = await prisma.featureFlag.findUniqueOrThrow({ where: { id: flagId } })
    expect(row.active).toBe(true)
  })

  it('flags_list (read) still succeeds for the viewer-role caller', async () => {
    const client = await connectClient(oauthViewerToken)
    try {
      const result = await client.callTool({
        name: 'flags_list',
        arguments: { projectId, env: 'production' },
      })
      expect(result.isError).not.toBe(true)
    } finally {
      await client.close()
    }
  })
})
