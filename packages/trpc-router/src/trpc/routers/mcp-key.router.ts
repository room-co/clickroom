import { generateApiKey } from '@clickroom/auth'
import { newId } from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { requirePermission, router, scopedForProject } from '../trpc.js'
import { defaultEnvironment } from './flags.router.js'

// Non-secret ApiKey fields safe to return for `mcp` tokens — never `keyHash`,
// and `publicToken` is always null for this type (only `write` keys persist a
// plaintext copy, see projects.router.ts) so it's omitted entirely here.
const MCP_KEY_PUBLIC_SELECT = {
  id: true,
  keyPrefix: true,
  userId: true,
  label: true,
  lastUsedAt: true,
  revokedAt: true,
  expiresAt: true,
  createdAt: true,
} as const

/** Milliseconds in a single day. */
const DAY_MS = 24 * 60 * 60 * 1000

/** Map a UI-facing expiry choice to an absolute `expiresAt` (or null for 'never'). */
function resolveExpiresAt(expiry: '30d' | '90d' | '1y' | 'never'): Date | null {
  switch (expiry) {
    case '30d':
      return new Date(Date.now() + 30 * DAY_MS)
    case '90d':
      return new Date(Date.now() + 90 * DAY_MS)
    case '1y':
      return new Date(Date.now() + 365 * DAY_MS)
    case 'never':
      return null
  }
}

/**
 * `ckmcp_` agent-token management. Every token is project-pinned
 * (`projectId`, like the existing `projects.keys` write/read tokens) AND
 * user-pinned (`userId` — the acting user whose `OrgMembership.role` the
 * request-context middleware resolves at auth time, see
 * `request-context.middleware.ts`). Gated the same as the existing key
 * management router (`keys:manage`).
 */
export const mcpKeyRouter = router({
  list: requirePermission('keys:manage')
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      return pdb.apiKey.findMany({
        where: { type: 'mcp' },
        select: MCP_KEY_PUBLIC_SELECT,
        orderBy: { createdAt: 'desc' },
      })
    }),

  create: requirePermission('keys:manage')
    .input(
      z.object({
        projectId: z.string(),
        label: z.string().optional(),
        expiry: z.enum(['30d', '90d', '1y', 'never']).default('never'),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const environment = await defaultEnvironment(pdb, input.projectId)
      const generated = generateApiKey('mcp')
      const key = await pdb.apiKey.create({
        data: {
          id: newId(),
          projectId: input.projectId,
          userId: ctx.tokenPayload.sub,
          keyHash: generated.keyHash,
          keyPrefix: generated.keyPrefix,
          selector: generated.selector,
          type: 'mcp',
          label: input.label ?? null,
          environmentId: environment.id,
          expiresAt: resolveExpiresAt(input.expiry),
        },
        select: MCP_KEY_PUBLIC_SELECT,
      })
      // The plaintext token is returned exactly once and never persisted —
      // only `keyHash` (of the `<secret>` half) is stored.
      return { token: generated.token, key }
    }),

  revoke: requirePermission('keys:manage')
    .input(z.object({ keyId: z.string(), projectId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const { count } = await pdb.apiKey.updateMany({
        where: { id: input.keyId, type: 'mcp' },
        data: { revokedAt: new Date() },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'MCP token not found.' })
      }
      return { ok: true }
    }),

  delete: requirePermission('keys:manage')
    .input(z.object({ keyId: z.string(), projectId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const { count } = await pdb.apiKey.deleteMany({
        where: { id: input.keyId, type: 'mcp' },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'MCP token not found.' })
      }
      return { ok: true }
    }),
})
