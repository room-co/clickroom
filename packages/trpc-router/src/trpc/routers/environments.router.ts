import { newId, Prisma } from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { requirePermission, router, scopedForProject } from '../trpc.js'

const slugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens only.')

export const environmentsRouter = router({
  list: requirePermission('projects:read')
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      return pdb.environment.findMany({
        where: { projectId: input.projectId },
        orderBy: { createdAt: 'asc' },
      })
    }),

  create: requirePermission('flags:write')
    .input(
      z.object({
        projectId: z.string(),
        key: slugSchema,
        name: z.string().min(1),
        color: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      try {
        return await pdb.environment.create({
          data: {
            id: newId(),
            projectId: input.projectId,
            key: input.key,
            name: input.name,
            color: input.color ?? null,
          },
        })
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `An environment with key "${input.key}" already exists.`,
          })
        }
        throw err
      }
    }),

  update: requirePermission('flags:write')
    .input(
      z.object({
        projectId: z.string(),
        id: z.string(),
        name: z.string().min(1).optional(),
        color: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const { count } = await pdb.environment.updateMany({
        where: { id: input.id },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.color !== undefined && { color: input.color }),
        },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Environment not found.' })
      }
      return pdb.environment.findFirstOrThrow({ where: { id: input.id } })
    }),

  delete: requirePermission('flags:write')
    .input(z.object({ projectId: z.string(), id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const existing = await pdb.environment.findFirst({ where: { id: input.id } })
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Environment not found.' })
      }

      const [flagCount, keyCount] = await Promise.all([
        pdb.featureFlag.count({ where: { environmentId: input.id } }),
        pdb.apiKey.count({ where: { environmentId: input.id, revokedAt: null } }),
      ])
      if (flagCount > 0 || keyCount > 0) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `Cannot delete: ${flagCount} flag(s) and ${keyCount} key(s) reference this environment.`,
        })
      }

      // Revoked keys don't block deletion, but ApiKey.environmentId is a
      // NOT NULL FK (ON DELETE RESTRICT) — Postgres would still reject the
      // delete below if any revoked key row still points here. Sweep those
      // dead rows first; they're already unusable, this isn't live-data cascade.
      await pdb.apiKey.deleteMany({
        where: { environmentId: input.id, revokedAt: { not: null } },
      })

      await pdb.environment.delete({ where: { id: input.id } })
      return { ok: true }
    }),
})
