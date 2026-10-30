import { can, type OrgRole, type Permission } from '@clickroom/auth'
import {
  createScopedClient,
  EntitlementService,
  prisma,
  requestContextStorage,
  type ScopedPrismaClient,
} from '@clickroom/db'
import { initTRPC, TRPCError } from '@trpc/server'
import type { Context } from './context.js'

/**
 * A structured `cause` payload that a procedure attaches to a `TRPCError` so the
 * client can branch on a stable machine code instead of string-matching a
 * message — e.g. `{ code: 'not_entitled', … }` (./middleware/entitlement.ts) and
 * `{ code: 'overage_not_entitled', … }` (./routers/usage.router.ts:149).
 */
export interface StructuredErrorCause {
  code: string
  [key: string]: unknown
}

/**
 * Does `cause` carry a caller-authored structured payload, as opposed to being a
 * real thrown `Error`?
 *
 * The subtlety: `new TRPCError({ cause: { code: 'not_entitled', … } })` does NOT
 * keep that plain object. The constructor runs it through tRPC's internal
 * `getCauseFromUnknown`, which wraps any non-Error object in
 * `UnknownCauseError extends Error` and `Object.assign`s the object's own keys
 * onto it. So by the time an errorFormatter runs, EVERY `error.cause` is an
 * `Error` instance — a bare `cause instanceof Error` rejection would drop the
 * structured causes it is meant to forward (verified by
 * ./trpc.error-formatter.test.ts, which fails against that version).
 *
 * The wrapper class is therefore the marker for "the throw site passed a plain
 * object". A genuine `Error` cause — a Prisma/ClickHouse driver error tRPC
 * wrapped — is any other Error subclass, and is still never forwarded: several
 * of them carry a string `code` of their own (`P2002`, `ECONNREFUSED`) plus
 * enumerable internals, which is exactly the stack/query-text leak we refuse.
 */
function isStructuredCauseCarrier(cause: unknown): cause is Record<string, unknown> {
  if (typeof cause !== 'object' || cause === null) return false
  if (cause instanceof Error) return cause.constructor.name === 'UnknownCauseError'
  return true
}

/**
 * tRPC does NOT serialize `TRPCError.cause` into the wire error shape — it is
 * dropped on the floor unless an errorFormatter puts it there. Both call sites
 * above were relying on a client contract that never actually shipped.
 *
 * Only a caller-authored payload carrying a string `code` is forwarded, and only
 * its own enumerable keys — never the `Error` object itself.
 */
function structuredCause(cause: unknown): StructuredErrorCause | undefined {
  if (!isStructuredCauseCarrier(cause)) return undefined
  const code = cause.code
  if (typeof code !== 'string') return undefined
  return { ...cause, code }
}

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    const cause = structuredCause(error.cause)
    if (!cause) return shape
    return { ...shape, data: { ...shape.data, cause } }
  },
})

export const router = t.router
export const publicProcedure = t.procedure
/** Raw middleware factory — see ./middleware/ for the middlewares built on it. */
export const middleware = t.middleware

/** Requires a verified access token; org context is not required here. */
export const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.tokenPayload) throw new TRPCError({ code: 'UNAUTHORIZED' })
  return next({ ctx: { ...ctx, tokenPayload: ctx.tokenPayload } })
})

/**
 * Gate for internal admin-console procedures. Deliberately reads
 * ONLY `ctx.adminUser`, never `ctx.tokenPayload` — a structurally-valid
 * tenant JWT presented on the same request must NOT satisfy this middleware.
 * The two identity planes are wholly separate; this
 * line is the enforcement point reviewers should check first.
 */
export const adminProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.adminUser) throw new TRPCError({ code: 'UNAUTHORIZED' })
  return next({ ctx: { ...ctx, adminUser: ctx.adminUser } })
})

/**
 * Requires an active org (from the ALS request context) and attaches an
 * org-scoped Prisma client. Org-scoped models are auto-filtered by orgId; touch
 * project-scoped models (ApiKey, FeatureFlag, taxonomy) through
 * {@link scopedForProject} instead — a bare org scope fails closed on them.
 */
export const orgScopedProcedure = authedProcedure.use(({ ctx, next }) => {
  const reqCtx = requestContextStorage.getStore()
  if (!reqCtx?.orgId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'No active org context.' })
  }

  const scopedDb = createScopedClient(prisma, { orgId: reqCtx.orgId })

  return next({
    ctx: {
      ...ctx,
      db: scopedDb,
      orgId: reqCtx.orgId,
      orgRole: reqCtx.orgRole as OrgRole,
      // Plan-feature checks for this org. Consumed by `entitlementMiddleware`
      // (./middleware/entitlement.ts) and the `entitlements.summary` procedure.
      entitlements: new EntitlementService(scopedDb, reqCtx.orgId),
    },
  })
})

/** org-scoped procedure that additionally requires every listed permission. */
export function requirePermission(...perms: Permission[]) {
  return orgScopedProcedure.use(({ ctx, next }) => {
    for (const perm of perms) {
      if (!can(ctx.orgRole, perm)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Insufficient permissions.' })
      }
    }
    return next({ ctx })
  })
}

/**
 * Resolve a project-scoped Prisma client after verifying the project belongs to
 * the caller's org. Verification runs through the org-scoped client (`ctx.db`),
 * which injects the orgId filter — so a project from another tenant reads as
 * NOT_FOUND. Project routers MUST go through this so ApiKey/FeatureFlag queries
 * never run without a projectId (the scoped client fails closed otherwise).
 */
export async function scopedForProject(
  ctx: { db: ScopedPrismaClient; orgId: string },
  projectId: string,
): Promise<ScopedPrismaClient> {
  const project = await ctx.db.project.findFirst({ where: { id: projectId } })
  if (!project) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Project not found.' })
  }
  return createScopedClient(prisma, { orgId: ctx.orgId, projectId })
}
