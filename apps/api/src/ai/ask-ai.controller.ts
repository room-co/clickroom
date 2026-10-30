import { AGENT_TOOLS } from '@clickroom/agent-tools'
import {
  type AIProvider,
  type AIProviderName,
  convertToModelMessages,
  createAIProvider,
  type OrgAISettings,
  stepCountIs,
  type UIMessage,
} from '@clickroom/ai'
import { prisma, requestContextStorage } from '@clickroom/db'
import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  NotFoundException,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { z } from 'zod'
import { createLoopbackClient } from '../lib/loopback-client.js'
import { buildAgentToolSet } from './agent-toolset.js'
import { hasRenderableContent, toToolCallMap } from './message-parts.js'
import { buildReplayMessages } from './replay-messages.js'
import { REFUSAL_TEXT } from './scope-guard.js'
import { ScopeGuardService } from './scope-guard.service.js'
import { buildSystemPrompt } from './system-prompt.js'
import { ulid } from './ulid.js'

const uiMessageSchema = z
  .object({
    id: z.string().optional(),
    role: z.enum(['system', 'user', 'assistant']),
    parts: z.array(z.any()),
  })
  .passthrough()

const chatBodySchema = z.object({ conversationId: z.string().min(1), message: uiMessageSchema })

const toolConfirmBodySchema = z.object({
  conversationId: z.string().min(1),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  args: z.unknown(),
  approved: z.boolean(),
})

interface ChatContext {
  userId: string
  orgId: string
  bearer: string
}

/**
 * `AI_CHAT_ENABLED` is an operational kill-switch, independent of whether an
 * org has connected a key — checked FIRST (ahead of the 409
 * `ai_not_configured` gate) so an incident can shut off the whole surface
 * without touching per-org data. Defaults to enabled; only the literal
 * string `'false'` disables it.
 */
function isAiChatEnabled(): boolean {
  return process.env.AI_CHAT_ENABLED !== 'false'
}

@Controller('ai')
export class AskAiController {
  // Default value (not just a type annotation) is deliberate: vitest's
  // esbuild transform doesn't emit `design:paramtypes` metadata, so a test
  // module that boots this controller through Nest's real DI container
  // (rather than `Test.createTestingModule`) gets called with zero
  // constructor args — the default keeps that path working without pulling
  // in `@nestjs/testing`, at the cost of one throwaway instance per such
  // test process. Production Nest (tsc, full decorator metadata) always
  // injects the real singleton and never touches this default.
  constructor(private readonly scopeGuard: ScopeGuardService = new ScopeGuardService()) {}

  /**
   * Provider factory seam. Production builds the real AI provider from org
   * settings; tests override this to inject a scripted fake stream without
   * touching the constructor / Nest DI.
   */
  protected createProvider(ai: OrgAISettings): AIProvider {
    return createAIProvider(ai)
  }

  /**
   * Resolves auth + org context from the AsyncLocalStorage the `/ai`
   * request-context middleware populates (mounted in main.ts, same as
   * `/trpc`/`/mcp`), and runs the required gates: the `AI_CHAT_ENABLED`
   * kill-switch (503) first, then configured org AI settings (409). Throws
   * an HttpException on any failure so it never streams.
   *
   * Reads `Org.ai_settings` directly via Prisma rather than looping back
   * through `org.isAIConfigured` — that tRPC procedure deliberately never
   * returns the encrypted key material (only a `has_api_key` boolean), and
   * building the provider needs the encrypted key anyway, so a loopback call
   * would just be a redundant extra hop in front of this same read. This is
   * the one deliberate exception to the phase's "route authz through the
   * loopback client" rule.
   */
  private async resolveContext(req: Request): Promise<{ ctx: ChatContext; ai: OrgAISettings }> {
    if (!isAiChatEnabled()) {
      throw new ServiceUnavailableException({
        error: 'ai_chat_disabled',
        message: 'Ask AI is temporarily disabled.',
      })
    }

    const store = requestContextStorage.getStore()
    if (!store?.userId || !store?.orgId) {
      throw new UnauthorizedException('Authentication required.')
    }
    const { userId, orgId } = store

    const authHeader = req.headers.authorization
    const bearer =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!bearer) throw new UnauthorizedException('Authentication required.')

    const ai = await this.loadAiSettings(orgId)
    if (!ai) {
      throw new ConflictException({
        error: 'ai_not_configured',
        message: 'No AI provider is configured for this organization.',
      })
    }

    return { ctx: { userId, orgId, bearer }, ai }
  }

  private async loadAiSettings(orgId: string): Promise<OrgAISettings | null> {
    const org = await prisma.org.findUnique({ where: { id: orgId }, select: { ai_settings: true } })
    const settings = org?.ai_settings as
      | { api_key_encrypted?: string; model?: string; provider?: AIProviderName }
      | null
      | undefined
    return settings?.api_key_encrypted ? (settings as OrgAISettings) : null
  }

  @Post('chat')
  async chat(@Req() req: Request, @Res() res: Response, @Body() body: unknown): Promise<void> {
    const { ctx, ai } = await this.resolveContext(req)
    const parsed = chatBodySchema.parse(body)

    // Verify the conversation belongs to this user, then that its project
    // belongs to the caller's org — `AiConversation`/`AiMessage` are NOT in
    // `PROJECT_TENANT_MODELS` (snake_case columns, see ai.router.ts's header
    // comment), so this fail-closed check is done by hand rather than via
    // `scopedForProject`.
    const conversation = await prisma.aiConversation.findFirst({
      where: { id: parsed.conversationId, user_id: ctx.userId, deleted_at: null },
    })
    if (!conversation) {
      throw new NotFoundException({ error: 'conversation_not_found' })
    }
    const project = await prisma.project.findFirst({
      where: { id: conversation.project_id, orgId: ctx.orgId },
      select: { id: true, name: true, org: { select: { name: true } } },
    })
    if (!project) {
      throw new NotFoundException({ error: 'conversation_not_found' })
    }

    // The client sends only the latest message; rebuild prior history from
    // the persisted AiMessage rows so we don't re-POST the whole transcript.
    const history = await prisma.aiMessage.findMany({
      where: { conversation_id: conversation.id },
      orderBy: { created_at: 'asc' },
      select: { id: true, role: true, parts: true, tool_calls: true },
    })
    const incomingMessage = parsed.message as unknown as UIMessage
    const messages = buildReplayMessages(history, incomingMessage)

    const client = createLoopbackClient(`Bearer ${ctx.bearer}`)
    const tools = buildAgentToolSet(client)
    const system = buildSystemPrompt({
      currentDate: new Date().toISOString(),
      projectId: conversation.project_id,
      projectName: project.name,
      orgId: ctx.orgId,
      orgName: project.org.name,
    })

    const provider = this.createProvider(ai)
    const modelMessages = await convertToModelMessages(messages)

    // Layer 2 guard: refuse clearly out-of-scope / injection requests with a
    // canned reply before the expensive main model + tools run. Fail-open
    // (see ScopeGuardService).
    const { inScope } = await this.scopeGuard.check(provider, modelMessages)
    if (!inScope) {
      await this.streamRefusal(res, conversation.id, incomingMessage)
      return
    }

    const result = provider.streamChat({
      messages: modelMessages,
      system,
      tools,
      stopWhen: stepCountIs(8),
      traceName: 'ask-ai-chat',
      metadata: {
        orgId: ctx.orgId,
        projectId: conversation.project_id,
        conversationId: conversation.id,
      },
    })

    result.pipeUIMessageStreamToResponse(res, {
      originalMessages: messages,
      // Author the assistant message id server-side and emit it in the
      // stream's `start` chunk so the client adopts the SAME id. Without
      // this the client and server diverge: on a tool-confirm auto-resume
      // `isResume` (id match, see replay-messages.ts) fails, so the resumed
      // turn is persisted as a NEW row instead of updating the proposal
      // turn — duplicating the widget and putting a duplicate toolCallId
      // into rebuilt history (which then breaks the next turn's stream). A
      // stable shared id makes the resume UPDATE one row.
      generateMessageId: ulid,
      onFinish: async ({ responseMessage }) => {
        try {
          await this.persistTurn(conversation.id, incomingMessage, responseMessage)
        } catch {
          // Persistence failures must not break the stream the user already received.
        }
      },
    })
  }

  /**
   * Emit a canned refusal as a UI message stream (same protocol the client
   * already parses for real model output) and persist it like a normal
   * turn. Used when the scope guard rejects an out-of-scope / injection
   * request, so we skip the main model + tools entirely.
   */
  private async streamRefusal(
    res: Response,
    conversationId: string,
    incomingMessage: UIMessage,
  ): Promise<void> {
    const messageId = ulid()
    const textId = 'txt-1'
    const chunks: Array<Record<string, unknown>> = [
      { type: 'start', messageId },
      { type: 'start-step' },
      { type: 'text-start', id: textId },
      { type: 'text-delta', id: textId, delta: REFUSAL_TEXT },
      { type: 'text-end', id: textId },
      { type: 'finish-step' },
      { type: 'finish' },
    ]

    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('cache-control', 'no-cache')
    res.setHeader('connection', 'keep-alive')
    res.setHeader('x-vercel-ai-ui-message-stream', 'v1')
    for (const chunk of chunks) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }
    res.write('data: [DONE]\n\n')
    res.end()

    const responseMessage: UIMessage = {
      id: messageId,
      role: 'assistant',
      parts: [{ type: 'text', text: REFUSAL_TEXT }],
    }
    try {
      await this.persistTurn(conversationId, incomingMessage, responseMessage)
    } catch {
      // Persistence failures must not break the response the user already received.
    }
  }

  /**
   * Persists the incoming user message from the request plus the assistant
   * response. Earlier history was already stored on prior turns, so we only
   * upsert these two (keyed by their UIMessage id to stay idempotent).
   */
  private async persistTurn(
    conversationId: string,
    incomingMessage: UIMessage,
    responseMessage: UIMessage,
  ): Promise<void> {
    const toPersist: UIMessage[] = []
    if (incomingMessage.role === 'user') toPersist.push(incomingMessage)
    // Drop content-free assistant turns (e.g. a lone `step-start` the model
    // emits on a confirmation): they render as an empty bubble and pollute
    // replayed model history. Non-assistant rows always persist.
    if (responseMessage.role !== 'assistant' || hasRenderableContent(responseMessage.parts)) {
      toPersist.push(responseMessage)
    }

    for (const msg of toPersist) {
      const id = msg.id?.trim() ? msg.id : ulid()
      const toolCalls = toToolCallMap(msg.parts)
      await prisma.aiMessage.upsert({
        where: { id },
        create: {
          id,
          conversation_id: conversationId,
          role: msg.role,
          parts: msg.parts as unknown as object,
          tool_calls: toolCalls as unknown as object | undefined,
        },
        update: {
          parts: msg.parts as unknown as object,
          tool_calls: toolCalls as unknown as object | undefined,
        },
      })
    }

    await prisma.aiConversation.update({
      where: { id: conversationId },
      data: { updated_at: new Date() },
    })
  }

  @Post('chat/tool-confirm')
  async toolConfirm(@Req() req: Request, @Body() body: unknown): Promise<unknown> {
    const { ctx } = await this.resolveContext(req)
    const parsed = toolConfirmBodySchema.parse(body)

    const conversation = await prisma.aiConversation.findFirst({
      where: { id: parsed.conversationId, user_id: ctx.userId, deleted_at: null },
      select: { id: true, project_id: true },
    })
    if (!conversation) {
      throw new NotFoundException({ error: 'conversation_not_found' })
    }
    const project = await prisma.project.findFirst({
      where: { id: conversation.project_id, orgId: ctx.orgId },
      select: { id: true },
    })
    if (!project) {
      throw new NotFoundException({ error: 'conversation_not_found' })
    }

    const agentTool = AGENT_TOOLS.find((t) => t.name === parsed.toolName)
    if (!agentTool?.mutates) {
      throw new ForbiddenException({
        error: 'not_a_mutating_tool',
        message: `Tool ${parsed.toolName} is not a confirmable mutating tool.`,
      })
    }

    let toolResult: { ok: boolean; output: string }
    if (!parsed.approved) {
      toolResult = { ok: false, output: 'User declined to run this action.' }
    } else {
      // A tool failure (bad args, not-found, downstream error) must resume
      // the stream with an error the model can relay — not crash the
      // request with a 500. Capture the message and feed it back as the
      // tool output.
      try {
        const input = agentTool.input.parse(parsed.args)
        const client = createLoopbackClient(`Bearer ${ctx.bearer}`)
        const r = await agentTool.handle(input, { client })
        toolResult = { ok: true, output: r.content.map((c) => c.text).join('\n') }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toolResult = { ok: false, output: `Action failed: ${message}` }
      }
    }

    await this.recordToolResult(conversation.id, parsed.toolCallId, {
      toolName: parsed.toolName,
      approved: parsed.approved,
      result: toolResult,
    })

    return {
      toolCallId: parsed.toolCallId,
      toolName: parsed.toolName,
      approved: parsed.approved,
      output: toolResult.output,
    }
  }

  /**
   * Best-effort: merge the resolved tool result into the most recent
   * assistant message's `tool_calls` JSON for the conversation, keyed by
   * toolCallId.
   */
  private async recordToolResult(
    conversationId: string,
    toolCallId: string,
    payload: unknown,
  ): Promise<void> {
    const assistant = await prisma.aiMessage.findFirst({
      where: { conversation_id: conversationId, role: 'assistant' },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      select: { id: true, tool_calls: true },
    })
    if (!assistant) return
    const existing =
      assistant.tool_calls && typeof assistant.tool_calls === 'object'
        ? (assistant.tool_calls as Record<string, unknown>)
        : {}
    await prisma.aiMessage.update({
      where: { id: assistant.id },
      data: { tool_calls: { ...existing, [toolCallId]: payload } as unknown as object },
    })
  }
}
