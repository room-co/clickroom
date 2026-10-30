import { type ApiKeyType, generateApiKey } from '@clickroom/auth'
import { createDefaultEnvironments, newId, seedSystemDefinitions } from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { requirePermission, router, scopedForProject } from '../trpc.js'
import { defaultEnvironment, envSlugSchema, resolveEnvironment } from './flags.router.js'

const apiKeyTypeSchema: z.ZodType<ApiKeyType> = z.enum(['write', 'read'])

// Non-secret ApiKey fields safe to return to the client (never keyHash). `env`
// is now resolved via the `Environment` relation rather than a
// stored enum column — joined here and flattened to a slug string by
// `withEnvSlug` below, keeping the wire shape (`key.env`) unchanged for
// existing consumers (web, tests).
const API_KEY_PUBLIC_SELECT = {
  id: true,
  keyPrefix: true,
  publicToken: true,
  type: true,
  scopes: true,
  environment: { select: { key: true } },
  label: true,
  lastUsedAt: true,
  revokedAt: true,
  expiresAt: true,
  createdAt: true,
} as const

function withEnvSlug<T extends { environment: { key: string } }>(
  key: T,
): Omit<T, 'environment'> & { env: string } {
  const { environment, ...rest } = key
  return { ...rest, env: environment.key }
}

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

const keysRouter = router({
  list: requirePermission('keys:manage')
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const rows = await pdb.apiKey.findMany({
        // `mcp` tokens are a distinct type managed via their own
        // `mcpKey` router/UI — excluded here so they don't leak into the
        // regular read/write API key list.
        where: { type: { in: ['write', 'read'] } },
        select: API_KEY_PUBLIC_SELECT,
        orderBy: { createdAt: 'desc' },
      })
      return rows.map(withEnvSlug)
    }),

  create: requirePermission('keys:manage')
    .input(
      z.object({
        projectId: z.string(),
        type: apiKeyTypeSchema,
        label: z.string().optional(),
        scopes: z.array(z.string()).default([]),
        // Env slug is optional — defaults to the project's `isDefault`
        // environment (was the literal 'production' before custom
        // environments existed).
        env: envSlugSchema.optional(),
        expiry: z.enum(['30d', '90d', '1y', 'never']).default('never'),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const environment =
        input.env !== undefined
          ? await resolveEnvironment(pdb, input.projectId, input.env)
          : await defaultEnvironment(pdb, input.projectId)
      const generated = generateApiKey(input.type)
      const key = await pdb.apiKey.create({
        data: {
          id: newId(),
          projectId: input.projectId,
          keyHash: generated.keyHash,
          keyPrefix: generated.keyPrefix,
          publicToken: input.type === 'write' ? generated.token : null,
          type: input.type,
          label: input.label ?? null,
          scopes: input.scopes,
          environmentId: environment.id,
          expiresAt: resolveExpiresAt(input.expiry),
        },
        select: API_KEY_PUBLIC_SELECT,
      })
      // The plaintext token is returned exactly once and never persisted.
      return { token: generated.token, key: withEnvSlug(key) }
    }),

  revoke: requirePermission('keys:manage')
    .input(z.object({ keyId: z.string(), projectId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const { count } = await pdb.apiKey.updateMany({
        where: { id: input.keyId },
        data: { revokedAt: new Date() },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'API key not found.' })
      }
      return { ok: true }
    }),

  delete: requirePermission('keys:manage')
    .input(z.object({ keyId: z.string(), projectId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const { count } = await pdb.apiKey.deleteMany({
        where: { id: input.keyId },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'API key not found.' })
      }
      return { ok: true }
    }),
})

export const projectsRouter = router({
  list: requirePermission('projects:read').query(({ ctx }) =>
    ctx.db.project.findMany({ orderBy: { createdAt: 'asc' } }),
  ),

  create: requirePermission('projects:manage')
    .input(z.object({ name: z.string().min(1) }))
    .mutation(({ input, ctx }) =>
      // Same starter environments signup gives the Default project; without them
      // key/flag creation has no environment to attach to.
      ctx.prisma.$transaction(async (tx) => {
        const project = await tx.project.create({
          data: { id: newId(), orgId: ctx.orgId, name: input.name },
        })
        await createDefaultEnvironments(tx, project.id)
        await seedSystemDefinitions(tx, project.id)
        return project
      }),
    ),

  update: requirePermission('projects:manage')
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        timezone: z.string().optional(),
        domain: z.string().url().nullable().optional(),
        dataRetentionDays: z.number().int().min(1).max(3650).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input
      const { count } = await ctx.db.project.updateMany({ where: { id }, data })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Project not found.' })
      }
      return { ok: true }
    }),

  delete: requirePermission('projects:manage')
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      // Environments are born with the project, so they must go with it (a bare
      // project delete trips Environment_projectId_fkey). One tx: all or nothing.
      const count = await ctx.prisma.$transaction(async (tx) => {
        const owned = await tx.project.findFirst({
          where: { id: input.id, orgId: ctx.orgId },
          select: { id: true },
        })
        if (!owned) return 0
        await tx.environment.deleteMany({ where: { projectId: owned.id } })
        return (await tx.project.deleteMany({ where: { id: owned.id, orgId: ctx.orgId } })).count
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Project not found.' })
      }
      return { ok: true }
    }),

  keys: keysRouter,
})
