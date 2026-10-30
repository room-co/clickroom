import { can, verifyAccessToken } from '@clickroom/auth'
import { prisma } from '@clickroom/db'
import { redis } from '@clickroom/trpc-router/lib/redis.js'
import { flagsChangedChannel } from '@clickroom/trpc-router/trpc/routers/flags.cache.js'
import { Controller, Get, Query, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { config } from '../env.js'

const JWT_SECRET = config.secrets.jwt

/**
 * SSE endpoint for live flag-change propagation. Not a tRPC procedure —
 * `EventSource`/`fetch` browser clients can't ride the `/trpc` batch link, and
 * this is one-directional (server -> browser), so a plain SSE stream is enough
 * (mirrors `/ai` SSE controller shape).
 *
 * Auth is header-based (`Authorization: Bearer <token>`), same as the rest of
 * the app — no token-in-query-string, since query strings leak into server
 * logs/proxies/browser history. The browser side therefore can't use the
 * native `EventSource` (no custom headers) and instead reads the stream via
 * `fetch` + a `ReadableStream` reader (see `apps/web/src/hooks/useFlagsStream.ts`).
 */
@Controller('flags')
export class FlagsStreamController {
  @Get('stream')
  async stream(
    @Query('projectId') projectId: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const authHeader = req.headers.authorization
    if (!projectId || !authHeader?.startsWith('Bearer ')) {
      res.status(401).end()
      return
    }

    const payload = await verifyAccessToken(authHeader.slice(7), JWT_SECRET)
    if (!payload?.orgId) {
      res.status(401).end()
      return
    }

    const membership = await prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId: payload.orgId, userId: payload.sub } },
    })
    if (!membership || !can(membership.role, 'flags:read')) {
      res.status(403).end()
      return
    }

    // Project must belong to the caller's org — fails closed on cross-tenant
    // access the same way `scopedForProject` does for tRPC procedures.
    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId: payload.orgId },
      select: { id: true },
    })
    if (!project) {
      res.status(404).end()
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(':ok\n\n')

    // ioredis: a client in subscriber mode can't run other commands, so use a
    // dedicated connection per stream and close it on disconnect.
    const subscriber = redis.duplicate()
    const channel = flagsChangedChannel(projectId)

    subscriber.on('message', (_channel: string, message: string) => {
      res.write(`data: ${message}\n\n`)
    })

    try {
      await subscriber.subscribe(channel)
    } catch {
      res.status(503).end()
      await subscriber.quit().catch(() => {})
      return
    }

    const cleanup = () => {
      subscriber.quit().catch(() => {})
    }
    req.on('close', cleanup)
  }
}
