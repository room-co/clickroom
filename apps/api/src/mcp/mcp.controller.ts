// Remote Streamable-HTTP MCP endpoint. `POST /mcp` only; GET/DELETE
// respond 405 (this server never needs the standalone GET SSE stream or
// session-scoped DELETE — every request is a fresh, self-contained,
// stateless transport, see `mcp-server.factory.ts`).
import { requestContextStorage } from '@clickroom/db'
import {
  MCP_ENDPOINT_PATH,
  mcpOAuthIssuer,
} from '@clickroom/trpc-router/mcp/oauth/mcp-oauth.constants.js'
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { Controller, Delete, Get, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { createLoopbackClient } from '../lib/loopback-client.js'
import { createMcpHttpServer } from './mcp-server.factory.js'

@Controller('mcp')
export class McpController {
  @Post()
  async post(@Req() req: Request, @Res() res: Response): Promise<void> {
    const authHeader = req.headers.authorization
    const store = requestContextStorage.getStore()

    // `request-context.middleware.ts` already ran by the time a controller
    // executes — for BOTH `ckmcp_` and OAuth-JWT bearers it populates the ALS
    // store with a resolved `orgId`; anything else (missing/invalid/orphaned
    // bearer) leaves the store empty, which is this endpoint's signal to
    // reject with a spec-compliant `WWW-Authenticate` challenge rather than
    // let a tool call fail deep inside the loopback hop.
    if (!authHeader || !store?.orgId) {
      this.reject401(res)
      return
    }

    const client = createLoopbackClient(authHeader)
    const { server, transport } = createMcpHttpServer(client)

    res.on('close', () => {
      transport.close().catch(() => {})
      server.close().catch(() => {})
    })

    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  }

  @Get()
  get(@Res() res: Response): void {
    res.status(405).end()
  }

  @Delete()
  delete(@Res() res: Response): void {
    res.status(405).end()
  }

  /** 401 + the RFC 9728 challenge pointing at the protected-resource metadata
   * document `mcpAuthRouter` serves, so an MCP client that speaks OAuth 2.1
   * discovery can bootstrap dynamic client registration from this alone.
   * `mcpAuthRouter` serves that doc at the resource-suffixed path
   * (`/.well-known/oauth-protected-resource/mcp`), NOT the bare path — the
   * SDK helper derives the exact URL it actually mounted (a bare path 404s). */
  private reject401(res: Response): void {
    const metadataUrl = getOAuthProtectedResourceMetadataUrl(
      new URL(`${mcpOAuthIssuer()}${MCP_ENDPOINT_PATH}`),
    )
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}"`)
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } })
  }
}
