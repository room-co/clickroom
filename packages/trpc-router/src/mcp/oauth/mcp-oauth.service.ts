// User / org / project resolution for the MCP OAuth consent screen
// (`apps/web`'s `McpConsentPage.tsx`, driven by
// `apps/api/src/trpc/routers/mcp-oauth.router.ts`). /rewrite:
// dynamic client registration + token issuance moved to
// `client-store.ts`/`code-store.ts`/`grant-store.ts`, consumed via
// `mcpAuthRouter` + `mcp-oauth.provider.ts` — only the "which org+project
// may this user authorize the MCP client against" lookups (unrelated to the
// SDK's OAuth wire format) remain here.
import type { PrismaClient } from '@clickroom/db'

export interface UserProjectOption {
  orgId: string
  orgName: string
  projectId: string
  projectName: string
}

/** Every project the user can authorize the MCP client against — the
 * consent screen's project picker when `GET /mcp/oauth/consent` is called
 * without a `projectId` yet. */
export async function listUserProjects(
  prisma: PrismaClient,
  userId: string,
): Promise<UserProjectOption[]> {
  const memberships = await prisma.orgMembership.findMany({
    where: { userId },
    include: { org: true },
  })
  const orgIds = memberships.map((m) => m.orgId)
  if (orgIds.length === 0) return []

  const projects = await prisma.project.findMany({ where: { orgId: { in: orgIds } } })
  const orgNameById = new Map(memberships.map((m) => [m.orgId, m.org.name]))

  return projects.map((p) => ({
    orgId: p.orgId,
    orgName: orgNameById.get(p.orgId) ?? p.orgId,
    projectId: p.id,
    projectName: p.name,
  }))
}

/** Verify `projectId` belongs to an org `userId` is a member of. Returns the
 * resolved `orgId` + project name for display, or null if not authorized. */
export async function resolveUserProject(
  prisma: PrismaClient,
  userId: string,
  projectId: string,
): Promise<{ orgId: string; projectName: string } | null> {
  const project = await prisma.project.findUnique({ where: { id: projectId } })
  if (!project) return null
  const membership = await prisma.orgMembership.findUnique({
    where: { orgId_userId: { orgId: project.orgId, userId } },
  })
  if (!membership) return null
  return { orgId: project.orgId, projectName: project.name }
}
