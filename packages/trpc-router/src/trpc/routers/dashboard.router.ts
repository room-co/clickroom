import { newId } from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { requirePermission, router, scopedForProject } from '../trpc.js'
import {
  addWidgetInputSchema,
  removeWidgetInputSchema,
  updateLayoutInputSchema,
  updateWidgetInputSchema,
  widgetsInputSchema,
} from './dashboard.schema.js'

const DEFAULT_WIDGET_W = 4
const DEFAULT_WIDGET_H = 6

export const dashboardRouter = router({
  widgets: requirePermission('projects:read')
    .input(widgetsInputSchema)
    .query(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      return pdb.dashboardWidget.findMany({
        where: { deletedAt: null },
        orderBy: { createdAt: 'asc' },
        include: { insight: { select: { id: true, name: true, type: true } } },
      })
    }),

  addWidget: requirePermission('projects:manage')
    .input(addWidgetInputSchema)
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)

      let layout = input.layout
      if (!layout) {
        const existing = await pdb.dashboardWidget.findMany({
          where: { deletedAt: null },
          select: { y: true, h: true },
        })
        const bottom = existing.reduce(
          (max: number, w: { y: number; h: number }) => Math.max(max, w.y + w.h),
          0,
        )
        layout = { x: 0, y: bottom, w: DEFAULT_WIDGET_W, h: DEFAULT_WIDGET_H }
      }

      return pdb.dashboardWidget.create({
        data: {
          id: newId(),
          projectId: input.projectId,
          insightId: input.insightId,
          x: layout.x,
          y: layout.y,
          w: layout.w,
          h: layout.h,
          createdBy: ctx.tokenPayload?.sub ?? '',
        },
      })
    }),

  updateLayout: requirePermission('projects:manage')
    .input(updateLayoutInputSchema)
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      for (const l of input.layouts) {
        await pdb.dashboardWidget.updateMany({
          where: { id: l.id, deletedAt: null },
          data: { x: l.x, y: l.y, w: l.w, h: l.h },
        })
      }
      return { updated: input.layouts.length }
    }),

  updateWidget: requirePermission('projects:manage')
    .input(updateWidgetInputSchema)
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const { count } = await pdb.dashboardWidget.updateMany({
        where: { id: input.id, deletedAt: null },
        data: { rangeKey: input.rangeKey },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Widget not found.' })
      }
      return pdb.dashboardWidget.findFirstOrThrow({ where: { id: input.id } })
    }),

  removeWidget: requirePermission('projects:manage')
    .input(removeWidgetInputSchema)
    .mutation(async ({ input, ctx }) => {
      const pdb = await scopedForProject(ctx, input.projectId)
      const { count } = await pdb.dashboardWidget.updateMany({
        where: { id: input.id, deletedAt: null },
        data: { deletedAt: new Date() },
      })
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Widget not found.' })
      }
      return { id: input.id, deleted: true }
    }),
})
