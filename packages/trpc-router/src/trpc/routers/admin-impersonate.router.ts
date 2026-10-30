/**
 * Mint/end a real, time-boxed tenant session on behalf of
 * an admin doing support work. Not a synthetic bearer or read-only render
 * () — `AuthService.createImpersonatedSession` calls the same session
 * machinery a normal login uses, so nothing downstream needs to special-case
 * an impersonated request except attribution (`request-context.middleware.ts`
 * + `requestContextStorage.impersonatedByAdminId`).
 */
import { AdminAuditService, prisma as basePrisma } from '@clickroom/db'
import { z } from 'zod'
import { adminProcedure, router } from '../trpc.js'

const auditService = new AdminAuditService(basePrisma)

export const adminImpersonateRouter = router({
  start: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        orgId: z.string().min(1),
        reason: z.string().min(10, 'A reason (at least 10 characters) is required.'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.$transaction(async (tx) => {
        const result = await ctx.authService.createImpersonatedSession(
          ctx.adminUser.id,
          input.userId,
          input.orgId,
          tx,
        )

        await auditService.record(ctx.adminUser.id, 'impersonate.start', {
          targetOrgId: input.orgId,
          after: { userId: input.userId, reason: input.reason },
          tx,
        })

        return result
      })
    }),

  stop: adminProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.$transaction(async (tx) => {
        await ctx.authService.stopImpersonatedSession(input.sessionId, ctx.adminUser.id, tx)

        await auditService.record(ctx.adminUser.id, 'impersonate.stop', {
          after: { sessionId: input.sessionId },
          tx,
        })
      })
    }),
})
