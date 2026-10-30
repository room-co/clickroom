/**
 * `admin.audit`: cross-tenant read of `AdminAuditLog`.
 *
 * Reads through the raw `prisma` singleton, not a scoped client — this is the
 * deliberate cross-tenant escape hatch fenced to `adminProcedure`. Category filtering happens in SQL via an `action: { in: [...] }`
 * where clause built from `ACTIONS_BY_CATEGORY`/`classifyAuditAction`, never a
 * post-fetch JS filter loop.
 */
import { ACTIONS_BY_CATEGORY, type AuditCategory, classifyAuditAction, prisma } from '@clickroom/db'
import { z } from 'zod'
import { adminProcedure, router } from '../trpc.js'

const AUDIT_CATEGORIES = ['destructive', 'billing', 'impersonation', 'routine'] as const

/** destructive/impersonation = high, billing = medium, routine = low. */
const SEVERITY_BY_CATEGORY: Record<AuditCategory, 'high' | 'medium' | 'low'> = {
  destructive: 'high',
  impersonation: 'high',
  billing: 'medium',
  routine: 'low',
}

/**
 * `routine` isn't a plain `action: { in: ACTIONS_BY_CATEGORY.routine } }` filter
 * (per classify-audit-action.ts's own doc comment) — it also has to catch
 * unrecognized action strings, since `classifyAuditAction` defaults unknowns to
 * `routine`. So "routine" means "not destructive/billing/impersonation".
 */
function actionFilterForCategory(category: AuditCategory): { in: string[] } | { notIn: string[] } {
  if (category === 'routine') {
    return {
      notIn: [
        ...ACTIONS_BY_CATEGORY.destructive,
        ...ACTIONS_BY_CATEGORY.billing,
        ...ACTIONS_BY_CATEGORY.impersonation,
      ],
    }
  }
  return { in: ACTIONS_BY_CATEGORY[category] }
}

export interface AdminAuditListItem {
  id: string
  action: string
  category: AuditCategory
  severity: 'high' | 'medium' | 'low'
  before: unknown
  after: unknown
  createdAt: Date
  adminUser: { id: string; email: string }
  targetOrg: { id: string; name: string } | null
}

export const adminAuditRouter = router({
  list: adminProcedure
    .input(
      z.object({
        category: z.enum(AUDIT_CATEGORIES).optional(),
        targetOrgId: z.string().optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        cursor: z.string().nullish(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(
      async ({ input }): Promise<{ items: AdminAuditListItem[]; nextCursor: string | null }> => {
        const rows = await prisma.adminAuditLog.findMany({
          where: {
            ...(input.category && { action: actionFilterForCategory(input.category) }),
            ...(input.targetOrgId && { targetOrgId: input.targetOrgId }),
            ...((input.from || input.to) && {
              createdAt: {
                ...(input.from && { gte: new Date(input.from) }),
                ...(input.to && { lte: new Date(input.to) }),
              },
            }),
          },
          orderBy: { createdAt: 'desc' },
          take: input.limit + 1,
          ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
          include: { adminUser: { select: { id: true, email: true } } },
        })
        const hasMore = rows.length > input.limit
        const page = hasMore ? rows.slice(0, input.limit) : rows

        const orgIds = [
          ...new Set(page.map((r) => r.targetOrgId).filter((id): id is string => id !== null)),
        ]
        const orgs = orgIds.length
          ? await prisma.org.findMany({
              where: { id: { in: orgIds } },
              select: { id: true, name: true },
            })
          : []
        const orgById = new Map(orgs.map((o) => [o.id, o]))

        const items: AdminAuditListItem[] = page.map((r) => {
          const category = classifyAuditAction(r.action)
          return {
            id: r.id,
            action: r.action,
            category,
            severity: SEVERITY_BY_CATEGORY[category],
            before: r.before,
            after: r.after,
            createdAt: r.createdAt,
            adminUser: r.adminUser,
            targetOrg: r.targetOrgId
              ? (orgById.get(r.targetOrgId) ?? { id: r.targetOrgId, name: 'unknown' })
              : null,
          }
        })

        return { items, nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null }
      },
    ),
})
