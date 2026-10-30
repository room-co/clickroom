import type { AccessTokenPayload, OrgRole } from '@clickroom/auth'
import { prisma, requestContextStorage } from '@clickroom/db'
import type { Context } from '@clickroom/trpc-router'
import { AuthService } from '@clickroom/trpc-router/services/auth.service.js'

// All integration tests share the @clickroom/db Prisma singleton — the same one
// the org-scoped procedures use (trpc.ts) — so writes and cleanup see one DB.
export const JWT_SECRET = 'test-secret-clickroom-api'
export const authService = new AuthService(prisma, JWT_SECRET)

/** Minimal Express Response stub that records cookies for assertions. */
export function makeRes() {
  const cookies: Record<string, string> = {}
  return {
    cookie: (name: string, value: string) => {
      cookies[name] = value
    },
    clearCookie: (name: string) => {
      delete cookies[name]
    },
    _cookies: cookies,
  }
}

export function makeCtx(opts?: {
  tokenPayload?: AccessTokenPayload | null
  cookies?: Record<string, string>
  res?: ReturnType<typeof makeRes>
}): Context {
  const res = opts?.res ?? makeRes()
  return {
    prisma,
    req: { headers: {}, cookies: opts?.cookies ?? {} },
    res,
    tokenPayload: opts?.tokenPayload ?? null,
    authService,
  } as unknown as Context
}

/** Run `fn` inside a request-context store (as the middleware would). */
export function callAs<T>(
  store: {
    userId: string
    orgId: string
    orgRole: OrgRole
    projectId?: string
    authSource?: 'jwt' | 'mcp' | 'mcp-oauth'
  },
  fn: () => Promise<T>,
): Promise<T> {
  return requestContextStorage.run({ authSource: 'jwt', ...store }, fn)
}

export async function cleanupOrg(orgId: string): Promise<void> {
  const projects = await prisma.project.findMany({ where: { orgId } })
  const projectIds = projects.map((p) => p.id)
  if (projectIds.length > 0) {
    await prisma.apiKey.deleteMany({ where: { projectId: { in: projectIds } } })
    await prisma.flagAudit.deleteMany({ where: { projectId: { in: projectIds } } })
    // Experiment references FeatureFlag, so it must be dropped first.
    await prisma.experiment.deleteMany({ where: { projectId: { in: projectIds } } })
    await prisma.featureFlag.deleteMany({ where: { projectId: { in: projectIds } } })
    await prisma.funnel.deleteMany({ where: { projectId: { in: projectIds } } })
    await prisma.eventDefinition.deleteMany({ where: { projectId: { in: projectIds } } })
    await prisma.propertyDefinition.deleteMany({ where: { projectId: { in: projectIds } } })
    await prisma.eventProperty.deleteMany({ where: { projectId: { in: projectIds } } })
    await prisma.dataSource.deleteMany({ where: { projectId: { in: projectIds } } })
    // SegmentSnapshot references Segment, so it must be dropped first.
    await prisma.segmentSnapshot.deleteMany({ where: { projectId: { in: projectIds } } })
    await prisma.segment.deleteMany({ where: { projectId: { in: projectIds } } })
    // DashboardWidget references Insight, so it must be dropped first.
    await prisma.dashboardWidget.deleteMany({ where: { projectId: { in: projectIds } } })
    await prisma.insight.deleteMany({ where: { projectId: { in: projectIds } } })
    // Environment rows are referenced by ApiKey/FeatureFlag (already cleared
    // above), so they must be dropped before the project itself.
    await prisma.environment.deleteMany({ where: { projectId: { in: projectIds } } })
    await prisma.project.deleteMany({ where: { orgId } })
  }
  await prisma.orgInvite.deleteMany({ where: { orgId } })
  await prisma.orgMembership.deleteMany({ where: { orgId } })
  await prisma.org.deleteMany({ where: { id: orgId } })
}

export async function cleanupUser(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } })
  await prisma.orgInvite.deleteMany({ where: { invitedBy: userId } })
  await prisma.orgMembership.deleteMany({ where: { userId } })
  await prisma.user.deleteMany({ where: { id: userId } })
}
