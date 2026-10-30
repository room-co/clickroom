/**
 * Tests for streaming Ask AI surface:
 *  - kill-switch + 409 `ai_not_configured` gates (ordering)
 *  - scope-guard refusal short-circuits before the main model
 *  - `agent-toolset.ts`'s read (auto-exec) vs. mutating (confirm-gated) split
 *  - `POST /ai/chat/tool-confirm` end-to-end through the real loopback/tRPC
 *    pipeline (mirrors `mcp.test.ts`'s "boot a real server" rationale — a
 *    mutating tool call must actually re-enter `requirePermission` +
 *    `scopedForProject`, not a mock).
 */
import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { AGENT_TOOLS } from '@clickroom/agent-tools'
import type { AIProvider, UIMessage } from '@clickroom/ai'
import { encryptApiKey } from '@clickroom/ai'
import { newId, prisma } from '@clickroom/db'
import { appRouter, makeCreateContext } from '@clickroom/trpc-router'
import { ConflictException, Controller, Module, ServiceUnavailableException } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { createExpressMiddleware } from '@trpc/server/adapters/express'
import type { Request, Response } from 'express'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildAgentToolSet } from '../ai/agent-toolset.js'
import { AskAiController } from '../ai/ask-ai.controller.js'
import { REFUSAL_TEXT } from '../ai/scope-guard.js'
import { ScopeGuardService } from '../ai/scope-guard.service.js'
import { createLoopbackClient } from '../lib/loopback-client.js'
import { makeRequestContextMiddleware } from '../request-context/request-context.middleware.js'
import { authService, callAs, cleanupOrg, cleanupUser, JWT_SECRET } from './helpers.js'

const suffix = Date.now().toString(36)
const createdUserIds: string[] = []
const createdOrgIds: string[] = []

let adminUserId: string
let orgId: string
let projectId: string
let accessToken: string

// `@Controller` (not just `extends`) is required here: without a decorator
// directly on this subclass, TS/Nest never emits `design:paramtypes`
// metadata for it, so Nest's DI can't see the inherited `ScopeGuardService`
// constructor param and silently instantiates it with none (crashing at
// `this.scopeGuard.check`).
@Controller('ai')
class TestableAskAiController extends AskAiController {
  public providerToReturn!: AIProvider
  protected override createProvider(): AIProvider {
    return this.providerToReturn
  }
}

@Module({ controllers: [TestableAskAiController], providers: [ScopeGuardService] })
class TestAiModule {}

let app: NestExpressApplication
let controller: TestableAskAiController

const originalAiEncryptionKey = process.env.AI_ENCRYPTION_KEY

function makeFakeProvider(opts?: { inScope?: boolean }): AIProvider {
  return {
    providerName: 'anthropic',
    modelId: 'fake',
    generateText: async () => '',
    streamChat: vi.fn(() => ({
      pipeUIMessageStreamToResponse: (
        res: Response,
        streamOpts: {
          generateMessageId?: () => string
          onFinish?: (e: { responseMessage: UIMessage }) => void | Promise<void>
        },
      ) => {
        const messageId = streamOpts.generateMessageId?.() ?? 'no-id'
        const chunks = [
          { type: 'start', messageId },
          { type: 'start-step' },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'ok' },
          { type: 'text-end', id: 't1' },
          { type: 'finish-step' },
          { type: 'finish' },
        ]
        for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        void streamOpts.onFinish?.({
          responseMessage: {
            id: messageId,
            role: 'assistant',
            parts: [{ type: 'text', text: 'ok' }],
          } as UIMessage,
        })
      },
    })) as never,
    classifyInScope: vi.fn(async () => opts?.inScope ?? true),
  }
}

function captureRes() {
  const writes: string[] = []
  const res = {
    setHeader: () => {},
    write: (c: string) => {
      writes.push(c)
      return true
    },
    end: () => {},
  } as unknown as Response
  return { writes, res }
}

async function createConversation() {
  const id = newId()
  await prisma.aiConversation.create({
    data: { id, project_id: projectId, user_id: adminUserId },
  })
  return id
}

beforeAll(async () => {
  process.env.AI_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex')
  const s = await authService.signup({
    email: `ask-ai-${suffix}@test.invalid`,
    password: 'password123',
    orgName: `Ask AI Org ${suffix}`,
  })
  adminUserId = s.user.id
  orgId = s.org!.id
  accessToken = s.accessToken
  createdUserIds.push(adminUserId)
  createdOrgIds.push(orgId)

  const project = await prisma.project.findFirstOrThrow({ where: { orgId } })
  projectId = project.id
  await prisma.org.update({ where: { id: orgId }, data: { maxFlagsOverride: 1000 } })

  app = await NestFactory.create<NestExpressApplication>(TestAiModule, { logger: false })
  app.use(['/trpc', '/ai'], makeRequestContextMiddleware(prisma, JWT_SECRET))
  app.use(
    '/trpc',
    createExpressMiddleware({
      router: appRouter,
      createContext: makeCreateContext(prisma, JWT_SECRET),
    }),
  )
  await app.listen(0)
  const port = (app.getHttpServer().address() as AddressInfo).port
  process.env.API_PORT = String(port)

  controller = app.get(TestableAskAiController)
})

afterAll(async () => {
  await app.close()
  await prisma.aiMessage.deleteMany({ where: { conversation: { project_id: projectId } } })
  await prisma.aiConversation.deleteMany({ where: { project_id: projectId } })
  for (const oid of createdOrgIds) await cleanupOrg(oid)
  for (const uid of createdUserIds) await cleanupUser(uid)
  await prisma.$disconnect()
  if (originalAiEncryptionKey === undefined) delete process.env.AI_ENCRYPTION_KEY
  else process.env.AI_ENCRYPTION_KEY = originalAiEncryptionKey
})

afterEach(() => {
  delete process.env.AI_CHAT_ENABLED
})

const admin = () => ({ userId: adminUserId, orgId, orgRole: 'org_admin' as const })
function authedReq(): Request {
  return { headers: { authorization: `Bearer ${accessToken}` } } as unknown as Request
}

describe('POST /ai/chat — gates', () => {
  it('returns 409 ai_not_configured when the org has no AI key', async () => {
    await prisma.org.update({ where: { id: orgId }, data: { ai_settings: {} } })
    const { res } = captureRes()
    await expect(
      callAs(admin(), () =>
        controller.chat(authedReq(), res, {
          conversationId: 'x',
          message: { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException)
  })

  it('AI_CHAT_ENABLED=false short-circuits BEFORE the ai_not_configured check', async () => {
    // Configure a (dummy) key so, absent the kill-switch, this call would
    // pass the 409 gate — proves ordering, not just "some" error is thrown.
    await prisma.org.update({
      where: { id: orgId },
      data: {
        ai_settings: {
          provider: 'anthropic',
          model: 'claude-opus-4-8',
          api_key_encrypted: encryptApiKey('dummy-key'),
        },
      },
    })
    process.env.AI_CHAT_ENABLED = 'false'
    const { res } = captureRes()
    await expect(
      callAs(admin(), () =>
        controller.chat(authedReq(), res, {
          conversationId: 'x',
          message: { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        }),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException)
  })
})

describe('POST /ai/chat — scope guard refusal', () => {
  it('streams the canned refusal and persists it without calling the model', async () => {
    await prisma.org.update({
      where: { id: orgId },
      data: {
        ai_settings: {
          provider: 'anthropic',
          model: 'claude-opus-4-8',
          api_key_encrypted: encryptApiKey('dummy-key'),
        },
      },
    })
    const conversationId = await createConversation()
    controller.providerToReturn = makeFakeProvider({ inScope: false })
    const { res, writes } = captureRes()

    await callAs(admin(), () =>
      controller.chat(authedReq(), res, {
        conversationId,
        message: {
          id: `u-${suffix}`,
          role: 'user',
          parts: [{ type: 'text', text: 'code me a snake game' }],
        },
      }),
    )

    const body = writes.join('')
    expect(body).toContain(REFUSAL_TEXT)
    expect(controller.providerToReturn.streamChat).not.toHaveBeenCalled()

    const persisted = await prisma.aiMessage.findMany({
      where: { conversation_id: conversationId, role: 'assistant' },
    })
    expect(persisted).toHaveLength(1)
    const parts = persisted[0]!.parts as Array<{ text?: string }>
    expect(parts[0]?.text).toBe(REFUSAL_TEXT)
  })

  it('a conversation belonging to another user is rejected as not found', async () => {
    const conversationId = newId()
    await prisma.aiConversation.create({
      data: { id: conversationId, project_id: projectId, user_id: 'someone-else' },
    })
    controller.providerToReturn = makeFakeProvider()
    const { res } = captureRes()
    await expect(
      callAs(admin(), () =>
        controller.chat(authedReq(), res, {
          conversationId,
          message: { id: `u2-${suffix}`, role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        }),
      ),
    ).rejects.toThrow()
  })
})

describe('agent-toolset.ts — read vs. mutating split', () => {
  it('read tools get an execute bound to the loopback client; mutating tools do not', async () => {
    const client = createLoopbackClient(`Bearer ${accessToken}`)
    const tools = buildAgentToolSet(client)

    expect(typeof tools.flags_list?.execute).toBe('function')
    expect(tools.flag_toggle?.execute).toBeUndefined()

    // Every registered tool is represented in the built set (sanity check —
    // catches a tool silently dropped from the switchboard).
    expect(Object.keys(tools)).toHaveLength(AGENT_TOOLS.length)
  })

  it('a read tool auto-execs through the real loopback tRPC pipeline', async () => {
    const client = createLoopbackClient(`Bearer ${accessToken}`)
    const tools = buildAgentToolSet(client)
    const execute = tools.usage_summary?.execute as (args: unknown) => Promise<unknown>
    const parsed = await execute({})
    expect(parsed).toHaveProperty('seats')
  })
})

describe('POST /ai/chat/tool-confirm — mutating tool only applies on confirm', () => {
  let flagId: string
  let conversationId: string

  beforeAll(async () => {
    await prisma.org.update({
      where: { id: orgId },
      data: {
        ai_settings: {
          provider: 'anthropic',
          model: 'claude-opus-4-8',
          api_key_encrypted: encryptApiKey('dummy-key'),
        },
      },
    })
    const caller = appRouter.createCaller({
      req: {} as never,
      res: {} as never,
      prisma,
      tokenPayload: { sub: adminUserId, sessionId: 'test', iat: 0, exp: 9_999_999_999 } as never,
    } as never)
    const flag = await callAs(admin(), () =>
      caller.flags.create({
        projectId,
        key: `ask-ai-flag-${suffix}`,
        active: false,
        filters: { groups: [{ properties: [], rollout_percentage: 0, variant: null }] },
      }),
    )
    flagId = flag.id
    conversationId = await createConversation()
  })

  it('declining does not toggle the flag', async () => {
    const before = await prisma.featureFlag.findUniqueOrThrow({ where: { id: flagId } })
    const result = await callAs(admin(), () =>
      controller.toolConfirm(authedReq(), {
        conversationId,
        toolCallId: 'call-decline',
        toolName: 'flag_toggle',
        args: { projectId, id: flagId, active: true },
        approved: false,
      }),
    )
    expect((result as { output: string }).output).toMatch(/declined/i)
    const after = await prisma.featureFlag.findUniqueOrThrow({ where: { id: flagId } })
    expect(after.active).toBe(before.active)
    expect(after.version).toBe(before.version)
  })

  it('approving applies the mutation through the real tRPC pipeline (version bumps)', async () => {
    const before = await prisma.featureFlag.findUniqueOrThrow({ where: { id: flagId } })
    await callAs(admin(), () =>
      controller.toolConfirm(authedReq(), {
        conversationId,
        toolCallId: 'call-approve',
        toolName: 'flag_toggle',
        args: { projectId, id: flagId, active: true },
        approved: true,
      }),
    )
    const after = await prisma.featureFlag.findUniqueOrThrow({ where: { id: flagId } })
    expect(after.active).toBe(true)
    expect(after.version).toBe(before.version + 1)
  })

  it('rejects a non-mutating tool name', async () => {
    await expect(
      callAs(admin(), () =>
        controller.toolConfirm(authedReq(), {
          conversationId,
          toolCallId: 'call-bad',
          toolName: 'flags_list',
          args: { projectId, env: 'production' },
          approved: true,
        }),
      ),
    ).rejects.toThrow()
  })
})
