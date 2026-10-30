import type { PrismaClient } from '@prisma/client'

// Auto-scoping tenant Prisma client (app-layer $extends query injection).
//
// This mirrors the reference implementation's `createScopedClient` pattern but adapts it to
// clickroom's TWO-level tenancy. There is NO Postgres RLS and NO special DB
// role: isolation is enforced purely by rewriting each query's `where` clause
// before it reaches the database.
//
// Clickroom has two scope levels plus one special case:
//   - ORG-scoped models carry an `orgId` column   → filtered by scope.orgId.
//   - PROJECT-scoped models carry a `projectId` column → filtered by scope.projectId.
//   - `Org` itself carries neither column; the tenant boundary IS its `id`, so
//     it is scoped by `id: scope.orgId` (handled explicitly below).
//   - Identity-plane models (User, Session) carry no tenant column and are
//     queried before/across tenant context, so they pass through untouched.
//
// INVARIANT: every Prisma model that has an `orgId` OR `projectId` column must
// appear in EXACTLY ONE of ORG_TENANT_MODELS, PROJECT_TENANT_MODELS, or
// INTENTIONALLY_UNSCOPED. `scoped-models.test.ts` enforces this from the Prisma
// DMMF and fails CI when a new tenant-column model is added without a
// deliberate classification — closing the default-open gap where a forgotten
// model would silently leak rows across tenants.

// Models with an `orgId` column, auto-scoped to scope.orgId. Lowercase names
// (Prisma model names lowercased, matching the DMMF-driven completeness test).
export const ORG_TENANT_MODELS = new Set([
  'orgmembership',
  'project',
  'orginvite',
  // SSO: one SsoConnection + any number of OrgDomain rows
  // per org.
  'ssoconnection',
  'orgdomain',
])

// Models with a `projectId` column, auto-scoped to scope.projectId. Querying
// any of these requires a defined scope.projectId (fail-closed — see below).
export const PROJECT_TENANT_MODELS = new Set([
  'apikey',
  'datasource',
  'environment',
  'featureflag',
  'flagaudit',
  'funnel',
  'segment',
  'segmentsnapshot',
  'experiment',
  'survey',
  'supportform',
  'supportticket',
  'supportwebhook',
  'insight',
  'savedquery',
  'savedvisualization',
  'eventdefinition',
  'propertydefinition',
  'eventproperty',
  'dashboardwidget',
  // McpOAuthRefreshToken: resolved directly via raw `prisma` by
  // its own `selector`/`clientId` before any tenant scope exists (same
  // reason ApiKey is here and looked up the same way by
  // request-context.middleware.ts), not through a scoped client.
  'mcpoauthrefreshtoken',
])

// Models that DO carry an `orgId`/`projectId` column but are deliberately NOT
// auto-scoped. Each must document why. Listed here so the completeness test
// passes and the choice is explicit rather than an accidental omission.
//
// NOTE: User and Session are NOT listed here — they have no tenant column, so
// the completeness test never requires them, and they pass through untouched.
export const INTENTIONALLY_UNSCOPED: Record<string, string> = {}

// Operations that carry no `where` clause; the caller sets tenant fields in
// `data`, so there is nothing to inject (create/createMany/createManyAndReturn).
const OP_NO_WHERE = new Set(['create', 'createMany', 'createManyAndReturn'])

/**
 * Tenant scope captured by {@link createScopedClient}. `orgId` is always
 * required; `projectId` is required only when the caller will touch a
 * PROJECT-scoped model (enforced at query time, fail-closed).
 */
export interface TenantScope {
  orgId: string
  projectId?: string
}

/**
 * Returns a Prisma client extended to auto-inject tenant filters on every
 * tenant-scoped model read and mutation:
 *   - ORG_TENANT_MODELS     → `where.orgId = scope.orgId`
 *   - PROJECT_TENANT_MODELS → `where.projectId = scope.projectId`
 *   - `org`                 → `where.id = scope.orgId`
 *   - everything else       → untouched
 *
 * The scope is captured as a closure so the extension does not depend on
 * AsyncLocalStorage propagating through Prisma's internal async context (which
 * is unreliable). Build one scoped client per request/tenant context.
 *
 * FAIL-CLOSED: a PROJECT-scoped model queried without `scope.projectId` throws
 * rather than running an un-project-scoped query that could return another
 * project's rows.
 */
export function createScopedClient(prisma: PrismaClient, scope: TenantScope) {
  return prisma.$extends({
    query: {
      $allModels: {
        // biome-ignore lint/suspicious/noExplicitAny: Prisma extension generic args
        async $allOperations({ model, operation, args, query }: any) {
          if (OP_NO_WHERE.has(operation)) {
            return query(args)
          }

          const name = model.toLowerCase()

          if (name === 'org') {
            return query({ ...args, where: { ...args.where, id: scope.orgId } })
          }

          if (ORG_TENANT_MODELS.has(name)) {
            return query({ ...args, where: { ...args.where, orgId: scope.orgId } })
          }

          if (PROJECT_TENANT_MODELS.has(name)) {
            if (scope.projectId === undefined) {
              throw new Error(
                `createScopedClient: model "${model}" is project-scoped but the tenant scope has no projectId. ` +
                  'Refusing to run an un-project-scoped query (fail-closed). Provide { orgId, projectId }.',
              )
            }
            return query({ ...args, where: { ...args.where, projectId: scope.projectId } })
          }

          return query(args)
        },
      },
    },
  })
}

export type ScopedPrismaClient = ReturnType<typeof createScopedClient>
