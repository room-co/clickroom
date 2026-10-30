import { newId } from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { reconcileParts } from '../../ai/reconcile-parts.js'
import { requirePermission, router, scopedForProject } from '../trpc.js'

/**
 * `AiConversation`/`AiMessage` columns are `project_id`/`user_id` (snake_case,
 * no per-field `@map`) — unlike every other project-scoped model, they are NOT
 * in `PROJECT_TENANT_MODELS` (packages/db/src/scoped-client.ts only
 * auto-injects a `projectId` filter, which doesn't match this column name), so
 * `project_id`/`user_id` must be filtered explicitly on every query below.
 * `scopedForProject` is still used first to fail closed (NOT_FOUND) on a
 * cross-org projectId before we ever touch AiConversation/AiMessage.
 */

/**
 * Conversation CRUD is intentionally ungated by `isAIConfigured` — a user may
 * start/rename/browse conversations before an org admin has connected a key
 * (or after a key was removed, e.g. to review past threads). The 409
 * `ai_not_configured` gate belongs to the streaming surface (`/ai/chat`), not this tRPC router.
 */

/**
 * Turn a stored `AiMessage` row into its DTO, reconciling `parts` against the
 * keyed `tool_calls` map via the canonical `reconcile-parts.ts` helper
 * — resolves any confirmed mutating-tool output back into its awaiting-
 * confirmation tool part so a reloaded conversation doesn't re-show the
 * approval gate for an already-taken action.
 */
function toMessageDto(message: {
  id: string
  role: string
  parts: unknown
  tool_calls: unknown
  created_at: Date
}) {
  return {
    id: message.id,
    role: message.role,
    createdAt: message.created_at,
    parts: reconcileParts(message.parts, message.tool_calls),
  }
}

export const aiRouter = router({
  listConversations: requirePermission('projects:read')
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const userId = ctx.tokenPayload?.sub ?? ''
      return pdb.aiConversation.findMany({
        where: { project_id: input.projectId, user_id: userId, deleted_at: null },
        orderBy: { updated_at: 'desc' },
      })
    }),

  createConversation: requirePermission('projects:read')
    .input(z.object({ projectId: z.string(), title: z.string().min(1).optional() }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const userId = ctx.tokenPayload?.sub ?? ''
      return pdb.aiConversation.create({
        data: {
          id: newId(),
          project_id: input.projectId,
          user_id: userId,
          title: input.title ?? null,
        },
      })
    }),

  renameConversation: requirePermission('projects:read')
    .input(z.object({ projectId: z.string(), id: z.string(), title: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const userId = ctx.tokenPayload?.sub ?? ''
      const { count } = await pdb.aiConversation.updateMany({
        where: {
          id: input.id,
          project_id: input.projectId,
          user_id: userId,
          deleted_at: null,
        },
        data: { title: input.title },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Conversation not found.' })
      }
      return pdb.aiConversation.findFirstOrThrow({ where: { id: input.id } })
    }),

  deleteConversation: requirePermission('projects:read')
    .input(z.object({ projectId: z.string(), id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const userId = ctx.tokenPayload?.sub ?? ''
      const { count } = await pdb.aiConversation.updateMany({
        where: {
          id: input.id,
          project_id: input.projectId,
          user_id: userId,
          deleted_at: null,
        },
        data: { deleted_at: new Date() },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Conversation not found.' })
      }
      return { id: input.id, deleted: true }
    }),

  getMessages: requirePermission('projects:read')
    .input(z.object({ projectId: z.string(), conversationId: z.string() }))
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const userId = ctx.tokenPayload?.sub ?? ''
      const conversation = await pdb.aiConversation.findFirst({
        where: {
          id: input.conversationId,
          project_id: input.projectId,
          user_id: userId,
          deleted_at: null,
        },
      })
      if (!conversation) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Conversation not found.' })
      }
      const messages = await pdb.aiMessage.findMany({
        where: { conversation_id: conversation.id },
        orderBy: { created_at: 'asc' },
      })
      return messages.map(toMessageDto)
    }),
})
