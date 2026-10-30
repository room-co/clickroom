// SSO. Ported from the reference implementation's packages/db/src/sso-group-mapping.service.ts
// with all Team/team_role branches stripped — Clickroom's tenancy is
// Org → Project only (no Team model), so every group mapping resolves
// straight to an OrgRole (SsoMappingTarget has only the `org_role` variant).
import type { OrgRole, PrismaClient, SsoGroupMapping } from '@prisma/client'
import { newId } from './client.js'
import type { ScopedPrismaClient } from './scoped-client.js'

export interface UpsertGroupMappingInput {
  idpGroup: string
  orgRole: OrgRole
}

export interface ResolvedMappings {
  orgRole: OrgRole | null
}

/** Org role precedence — higher index = higher privilege. */
const ORG_ROLE_PRECEDENCE: OrgRole[] = ['viewer', 'member', 'org_admin']

function rank(role: OrgRole): number {
  return ORG_ROLE_PRECEDENCE.indexOf(role)
}

/** Return the higher-privilege of two org roles. Used to keep SSO login monotonic. */
export function higherRole(a: OrgRole, b: OrgRole): OrgRole {
  return rank(a) >= rank(b) ? a : b
}

/**
 * Resolve matched group mappings into a single org role (highest privilege).
 * Pure function — exported for reuse inside the provisioning transaction.
 */
export function resolveMappingsFromRows(
  mappings: SsoGroupMapping[],
  groups: string[],
): ResolvedMappings {
  const groupSet = new Set(groups)
  let orgRole: OrgRole | null = null

  for (const mapping of mappings) {
    if (!groupSet.has(mapping.idpGroup)) continue
    if (orgRole === null || rank(mapping.orgRole) > rank(orgRole)) {
      orgRole = mapping.orgRole
    }
  }

  return { orgRole }
}

export class SsoGroupMappingService {
  constructor(private readonly prisma: PrismaClient | ScopedPrismaClient) {}

  private get client(): PrismaClient {
    return this.prisma as PrismaClient
  }

  async list(connectionId: string): Promise<SsoGroupMapping[]> {
    return this.client.ssoGroupMapping.findMany({
      where: { ssoConnectionId: connectionId },
      orderBy: { createdAt: 'asc' },
    })
  }

  async upsert(connectionId: string, data: UpsertGroupMappingInput): Promise<SsoGroupMapping> {
    return this.client.ssoGroupMapping.upsert({
      where: {
        ssoConnectionId_idpGroup: {
          ssoConnectionId: connectionId,
          idpGroup: data.idpGroup,
        },
      },
      create: {
        id: newId(),
        ssoConnectionId: connectionId,
        idpGroup: data.idpGroup,
        orgRole: data.orgRole,
      },
      update: {
        orgRole: data.orgRole,
      },
    })
  }

  async delete(mappingId: string, connectionId: string): Promise<void> {
    await this.client.ssoGroupMapping.deleteMany({
      where: { id: mappingId, ssoConnectionId: connectionId },
    })
  }

  async resolveMappings(connectionId: string, groups: string[]): Promise<ResolvedMappings> {
    const mappings = await this.list(connectionId)
    return resolveMappingsFromRows(mappings, groups)
  }
}
