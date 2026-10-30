/**
 * Cross-tenant org administration.
 *
 * Every procedure here reads through the unscoped `prisma` singleton (never
 * `createScopedClient`) — this router is inherently cross-tenant, which is
 * exactly the boundary `adminProcedure` exists to fence off (see the "does
 * not read tokenPayload" comment on `adminProcedure` in ../trpc.ts). Every
 * mutation writes a before/after `AdminAuditLog` row inside the same
 * `$transaction` as the write, via `AdminAuditService.record(..., { tx })`.
 *
 * tRPC has no superjson/devalue transformer here (see taxonomy.router.ts /
 * usage.router.ts) — every BigInt (`Plan.maxEventsPerMonth`,
 * `Org.maxEventsPerMonthOverride`, …) is coerced to `number` before leaving a
 * procedure, and every Date field uses `z.coerce.date()` on the input side.
 *
 * `Org.suspendedAt`/`suspensionReason` (nullable) landed via the
 * `20260911180000_add_org_suspension` migration; `suspendOrg`/`unsuspendOrg`
 * below flip them. Enforcement lives in
 * `apps/api/src/request-context/request-context.middleware.ts`'s JWT branch,
 * which now rejects (falls through unauthenticated) any request whose org is
 * suspended — every org-scoped tRPC procedure already 401s from there.
 */
import { AdminAuditService, effectiveLimits, prisma } from '@clickroom/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { adminProcedure, router } from '../trpc.js'

const auditService = new AdminAuditService(prisma)

const orgRoleSchema = z.enum(['org_admin', 'member', 'viewer'])
const overagePolicySchema = z.enum(['block', 'allow'])

// ── shared helpers ──────────────────────────────────────────────────────

/** BigInt limit columns -> JSON-safe numbers (MVP scale; see usage.router.ts). */
function toJsonSafeLimits(limits: {
  maxSeats: number
  maxFlags: number
  maxEventsPerMonth: bigint
  maxFlagCallsPerMonth: bigint
  overagePolicy: 'block' | 'allow'
}) {
  return {
    maxSeats: limits.maxSeats,
    maxFlags: limits.maxFlags,
    maxEventsPerMonth: Number(limits.maxEventsPerMonth),
    maxFlagCallsPerMonth: Number(limits.maxFlagCallsPerMonth),
    overagePolicy: limits.overagePolicy,
  }
}

async function requireOrg(orgId: string) {
  const org = await prisma.org.findUnique({ where: { id: orgId }, include: { plan: true } })
  if (!org) throw new TRPCError({ code: 'NOT_FOUND', message: 'Org not found.' })
  return org
}

// ── router ───────────────────────────────────────────────────────────────

export const adminOrgsRouter = router({
  /**
   * Cross-tenant org directory. `eventsThisMonth` is a placeholder — real
   * ClickHouse-backed volume is (`admin.usage`) responsibility;
   * this only surfaces what Postgres already knows (seat count + plan).
   */
  list: adminProcedure
    .input(
      z.object({
        search: z.string().trim().min(1).optional(),
        planKey: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(async ({ input }) => {
      const where = {
        ...(input.search
          ? {
              OR: [
                { name: { contains: input.search, mode: 'insensitive' as const } },
                { slug: { contains: input.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
        ...(input.planKey ? { plan: { key: input.planKey } } : {}),
      }

      const orgs = await prisma.org.findMany({
        where,
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        orderBy: { createdAt: 'desc' },
        include: {
          plan: { select: { key: true, name: true } },
          _count: { select: { members: true, projects: true } },
        },
      })

      const hasMore = orgs.length > input.limit
      const page = hasMore ? orgs.slice(0, input.limit) : orgs

      return {
        orgs: page.map((org) => ({
          id: org.id,
          name: org.name,
          slug: org.slug,
          planKey: org.plan?.key ?? null,
          planName: org.plan?.name ?? null,
          seatCount: org._count.members,
          projectCount: org._count.projects,
          overagePolicy: org.overagePolicy,
          suspendedAt: org.suspendedAt,
          createdAt: org.createdAt,
          // TODO: wire real event-volume rollup from ClickHouse.
          eventsThisMonth: null as number | null,
        })),
        nextCursor: hasMore ? page[page.length - 1]?.id : undefined,
      }
    }),

  get: adminProcedure.input(z.object({ orgId: z.string() })).query(async ({ input }) => {
    const org = await requireOrg(input.orgId)
    const [memberCount, projectCount, recentAudit] = await Promise.all([
      prisma.orgMembership.count({ where: { orgId: org.id } }),
      prisma.project.count({ where: { orgId: org.id } }),
      auditService.listByOrg(org.id, 20),
    ])

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      planKey: org.plan?.key ?? null,
      planName: org.plan?.name ?? null,
      overridesRaw: {
        maxSeatsOverride: org.maxSeatsOverride,
        maxFlagsOverride: org.maxFlagsOverride,
        maxEventsPerMonthOverride:
          org.maxEventsPerMonthOverride === null ? null : Number(org.maxEventsPerMonthOverride),
        maxFlagCallsPerMonthOverride:
          org.maxFlagCallsPerMonthOverride === null
            ? null
            : Number(org.maxFlagCallsPerMonthOverride),
      },
      effectiveLimits: toJsonSafeLimits(effectiveLimits(org, org.plan)),
      memberCount,
      projectCount,
      suspendedAt: org.suspendedAt,
      suspensionReason: org.suspensionReason,
      createdAt: org.createdAt,
      updatedAt: org.updatedAt,
      recentAuditLogs: recentAudit,
    }
  }),

  listMembers: adminProcedure.input(z.object({ orgId: z.string() })).query(async ({ input }) => {
    await requireOrg(input.orgId)
    const memberships = await prisma.orgMembership.findMany({
      where: { orgId: input.orgId },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    })
    return memberships.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
      joinedAt: m.createdAt,
    }))
  }),

  setMemberRole: adminProcedure
    .input(z.object({ orgId: z.string(), userId: z.string(), role: orgRoleSchema }))
    .mutation(async ({ input, ctx }) => {
      await requireOrg(input.orgId)
      const membership = await prisma.orgMembership.findUnique({
        where: { orgId_userId: { orgId: input.orgId, userId: input.userId } },
      })
      if (!membership) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Membership not found.' })
      }
      if (membership.role === input.role) {
        return { userId: input.userId, role: membership.role }
      }

      const before = { role: membership.role }
      const after = { role: input.role }
      await prisma.$transaction(async (tx) => {
        await tx.orgMembership.update({
          where: { orgId_userId: { orgId: input.orgId, userId: input.userId } },
          data: { role: input.role },
        })
        await auditService.record(ctx.adminUser.id, 'org.setMemberRole', {
          targetOrgId: input.orgId,
          before: { userId: input.userId, ...before },
          after: { userId: input.userId, ...after },
          tx,
        })
      })

      return { userId: input.userId, role: input.role }
    }),

  /**
   * Supersedes the standalone `set-org-plan.ts` CLI as the primary path
   * (that CLI is left in place as a scripting escape hatch). Purely a
   * `planId` swap — per-org `*Override` columns are untouched, matching the
   * CLI's own documented behavior.
   */
  setPlan: adminProcedure
    .input(z.object({ orgId: z.string(), planKey: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const org = await requireOrg(input.orgId)
      const plan = await prisma.plan.findUnique({ where: { key: input.planKey } })
      if (!plan) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Unknown plan key '${input.planKey}'.` })
      }
      if (org.planId === plan.id) {
        return { orgId: org.id, planKey: plan.key }
      }

      const before = { planKey: org.plan?.key ?? null }
      const after = { planKey: plan.key }
      await prisma.$transaction(async (tx) => {
        await tx.org.update({ where: { id: org.id }, data: { planId: plan.id } })
        await auditService.record(ctx.adminUser.id, 'org.setPlan', {
          targetOrgId: org.id,
          before,
          after,
          tx,
        })
      })

      return { orgId: org.id, planKey: plan.key }
    }),

  setLimitOverrides: adminProcedure
    .input(
      z.object({
        orgId: z.string(),
        maxSeatsOverride: z.number().int().min(0).nullable(),
        maxEventsPerMonthOverride: z.number().int().min(0).nullable(),
        maxFlagsOverride: z.number().int().min(0).nullable(),
        maxFlagCallsPerMonthOverride: z.number().int().min(0).nullable(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const org = await requireOrg(input.orgId)

      const before = {
        maxSeatsOverride: org.maxSeatsOverride,
        maxEventsPerMonthOverride:
          org.maxEventsPerMonthOverride === null ? null : Number(org.maxEventsPerMonthOverride),
        maxFlagsOverride: org.maxFlagsOverride,
        maxFlagCallsPerMonthOverride:
          org.maxFlagCallsPerMonthOverride === null
            ? null
            : Number(org.maxFlagCallsPerMonthOverride),
      }
      const after = {
        maxSeatsOverride: input.maxSeatsOverride,
        maxEventsPerMonthOverride: input.maxEventsPerMonthOverride,
        maxFlagsOverride: input.maxFlagsOverride,
        maxFlagCallsPerMonthOverride: input.maxFlagCallsPerMonthOverride,
      }

      await prisma.$transaction(async (tx) => {
        await tx.org.update({
          where: { id: org.id },
          data: {
            maxSeatsOverride: input.maxSeatsOverride,
            maxFlagsOverride: input.maxFlagsOverride,
            maxEventsPerMonthOverride:
              input.maxEventsPerMonthOverride === null
                ? null
                : BigInt(input.maxEventsPerMonthOverride),
            maxFlagCallsPerMonthOverride:
              input.maxFlagCallsPerMonthOverride === null
                ? null
                : BigInt(input.maxFlagCallsPerMonthOverride),
          },
        })
        await auditService.record(ctx.adminUser.id, 'org.setLimitOverrides', {
          targetOrgId: org.id,
          before,
          after,
          tx,
        })
      })

      return after
    }),

  suspendOrg: adminProcedure
    .input(z.object({ orgId: z.string(), reason: z.string().trim().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const org = await requireOrg(input.orgId)
      if (org.suspendedAt) {
        return { orgId: org.id, suspendedAt: org.suspendedAt }
      }

      const suspendedAt = new Date()
      await prisma.$transaction(async (tx) => {
        await tx.org.update({
          where: { id: org.id },
          data: { suspendedAt, suspensionReason: input.reason },
        })
        await auditService.record(ctx.adminUser.id, 'org.suspend', {
          targetOrgId: org.id,
          before: { suspendedAt: null },
          after: { suspendedAt, reason: input.reason },
          tx,
        })
      })

      return { orgId: org.id, suspendedAt }
    }),

  unsuspendOrg: adminProcedure
    .input(z.object({ orgId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const org = await requireOrg(input.orgId)
      if (!org.suspendedAt) {
        return { orgId: org.id, suspendedAt: null }
      }

      await prisma.$transaction(async (tx) => {
        await tx.org.update({
          where: { id: org.id },
          data: { suspendedAt: null, suspensionReason: null },
        })
        await auditService.record(ctx.adminUser.id, 'org.unsuspend', {
          targetOrgId: org.id,
          before: { suspendedAt: org.suspendedAt },
          after: { suspendedAt: null },
          tx,
        })
      })

      return { orgId: org.id, suspendedAt: null }
    }),

  setOveragePolicy: adminProcedure
    .input(z.object({ orgId: z.string(), overagePolicy: overagePolicySchema }))
    .mutation(async ({ input, ctx }) => {
      const org = await requireOrg(input.orgId)
      if (org.overagePolicy === input.overagePolicy) {
        return { orgId: org.id, overagePolicy: org.overagePolicy }
      }

      const before = { overagePolicy: org.overagePolicy }
      const after = { overagePolicy: input.overagePolicy }
      await prisma.$transaction(async (tx) => {
        await tx.org.update({ where: { id: org.id }, data: { overagePolicy: input.overagePolicy } })
        await auditService.record(ctx.adminUser.id, 'org.setOveragePolicy', {
          targetOrgId: org.id,
          before,
          after,
          tx,
        })
      })

      return { orgId: org.id, overagePolicy: input.overagePolicy }
    }),

  listProjects: adminProcedure.input(z.object({ orgId: z.string() })).query(async ({ input }) => {
    await requireOrg(input.orgId)
    const projects = await prisma.project.findMany({
      where: { orgId: input.orgId },
      orderBy: { createdAt: 'asc' },
    })
    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      timezone: p.timezone,
      domain: p.domain,
      dataRetentionDays: p.dataRetentionDays,
      createdAt: p.createdAt,
    }))
  }),

  /**
   * Metadata only — `keyHash` (and any future secret column) is never
   * selected, let alone returned. `ApiKey` is project-scoped, not
   * org-scoped, so this fans out over the org's projects.
   */
  listApiKeys: adminProcedure.input(z.object({ orgId: z.string() })).query(async ({ input }) => {
    await requireOrg(input.orgId)
    const projects = await prisma.project.findMany({
      where: { orgId: input.orgId },
      select: { id: true, name: true },
    })
    const projectIds = projects.map((p) => p.id)
    const projectNameById = new Map(projects.map((p) => [p.id, p.name]))

    const keys = await prisma.apiKey.findMany({
      where: { projectId: { in: projectIds } },
      select: {
        id: true,
        projectId: true,
        keyPrefix: true,
        type: true,
        scopes: true,
        label: true,
        lastUsedAt: true,
        revokedAt: true,
        expiresAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    return keys.map((k) => ({
      id: k.id,
      projectId: k.projectId,
      projectName: projectNameById.get(k.projectId) ?? null,
      keyPrefix: k.keyPrefix,
      type: k.type,
      scopes: k.scopes,
      label: k.label,
      lastUsedAt: k.lastUsedAt,
      revokedAt: k.revokedAt,
      expiresAt: k.expiresAt,
      createdAt: k.createdAt,
    }))
  }),
})
