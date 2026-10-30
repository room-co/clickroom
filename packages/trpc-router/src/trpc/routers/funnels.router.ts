import { newId } from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { requirePermission, router, scopedForProject } from '../trpc.js'
import { funnelStepsSchema } from './events.router.js'

const patchSchema = z
  .object({
    name: z.string().min(1).optional(),
    window: z.number().int().positive().optional(),
    steps: funnelStepsSchema.optional(),
  })
  .strict()

export const funnelsRouter = router({
  list: requirePermission('projects:read')
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      return pdb.funnel.findMany({
        where: { deletedAt: null },
        orderBy: { name: 'asc' },
      })
    }),

  get: requirePermission('projects:read')
    .input(z.object({ projectId: z.string(), id: z.string() }))
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const funnel = await pdb.funnel.findFirst({
        where: { id: input.id, deletedAt: null },
      })
      if (!funnel) throw new TRPCError({ code: 'NOT_FOUND', message: 'Funnel not found.' })
      return funnel
    }),

  create: requirePermission('projects:manage')
    .input(
      z.object({
        projectId: z.string(),
        name: z.string().min(1),
        window: z.number().int().positive(),
        steps: funnelStepsSchema,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      return pdb.funnel.create({
        data: {
          id: newId(),
          projectId: input.projectId,
          name: input.name,
          window: input.window,
          steps: input.steps,
        },
      })
    }),

  update: requirePermission('projects:manage')
    .input(z.object({ projectId: z.string(), id: z.string(), patch: patchSchema }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const { count } = await pdb.funnel.updateMany({
        where: { id: input.id, deletedAt: null },
        data: {
          ...(input.patch.name !== undefined && { name: input.patch.name }),
          ...(input.patch.window !== undefined && { window: input.patch.window }),
          ...(input.patch.steps !== undefined && { steps: input.patch.steps }),
        },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Funnel not found.' })
      }
      return pdb.funnel.findFirstOrThrow({ where: { id: input.id } })
    }),

  delete: requirePermission('projects:manage')
    .input(z.object({ projectId: z.string(), id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const { count } = await pdb.funnel.updateMany({
        where: { id: input.id, deletedAt: null },
        data: { deletedAt: new Date() },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Funnel not found.' })
      }
      return { id: input.id, deleted: true }
    }),
})
