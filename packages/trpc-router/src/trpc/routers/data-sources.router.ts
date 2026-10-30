import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { requirePermission, router, scopedForProject } from '../trpc.js'

export const dataSourcesRouter = router({
  list: requirePermission('projects:read')
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      return pdb.dataSource.findMany({
        where: { deletedAt: null },
        orderBy: { isDefault: 'desc' },
      })
    }),

  get: requirePermission('projects:read')
    .input(z.object({ projectId: z.string(), id: z.string() }))
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const dataSource = await pdb.dataSource.findFirst({
        where: { id: input.id, deletedAt: null },
      })
      if (!dataSource) throw new TRPCError({ code: 'NOT_FOUND', message: 'Data source not found.' })
      return dataSource
    }),
})
