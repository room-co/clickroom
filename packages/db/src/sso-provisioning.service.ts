// SSO. Ported from the reference implementation's packages/db/src/sso-provisioning.service.ts
// with all team-grant logic stripped (Clickroom has no Team model) and field
// names adapted to Clickroom's schema (User.name instead of full_name, no
// email_verified_at / policy_acceptance concept, newId() for app-supplied
// ULID primary keys).
import type { Prisma, PrismaClient } from '@prisma/client'
import { newId } from './client.js'
import type { ScopedPrismaClient } from './scoped-client.js'
import { higherRole, resolveMappingsFromRows } from './sso-group-mapping.service.js'

export interface ProvisionInput {
  orgId: string
  connectionId: string
  /** OIDC `sub` / SAML NameID. */
  externalId: string
  email: string
  fullName: string
  groups: string[]
}

export interface ProvisionResult {
  userId: string
}

export class SsoProvisioningService {
  constructor(private readonly prisma: PrismaClient | ScopedPrismaClient) {}

  private get client(): PrismaClient {
    return this.prisma as PrismaClient
  }

  /**
   * JIT provision an SSO user. Transactional, additive only — never removes
   * an existing membership or downgrades an existing role.
   */
  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    return this.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const now = new Date()

      // 1. Resolve / link / create the user.
      const identity = await tx.userSsoIdentity.findUnique({
        where: {
          ssoConnectionId_externalId: {
            ssoConnectionId: input.connectionId,
            externalId: input.externalId,
          },
        },
      })

      let userId: string
      if (identity) {
        userId = identity.userId
      } else {
        const existingUser = await tx.user.findUnique({ where: { email: input.email } })
        if (existingUser) {
          userId = existingUser.id
        } else {
          const created = await tx.user.create({
            data: {
              id: newId(),
              email: input.email,
              passwordHash: null,
              name: input.fullName,
            },
          })
          userId = created.id
        }
      }

      // 2. Resolve group mappings → org role.
      const connection = await tx.ssoConnection.findUniqueOrThrow({
        where: { id: input.connectionId },
      })
      if (connection.orgId !== input.orgId) {
        throw new Error('SSO connection does not belong to the target org.')
      }
      const mappings = await tx.ssoGroupMapping.findMany({
        where: { ssoConnectionId: input.connectionId },
      })
      const { orgRole } = resolveMappingsFromRows(mappings, input.groups)
      const resolvedOrgRole = orgRole ?? connection.defaultOrgRole

      // 3. Upsert org membership. Monotonic: SSO login may elevate but never
      //    downgrade an existing role — keeps provisioning additive and stops
      //    an org_admin from locking themselves out (e.g. defaultOrgRole=
      //    member, no matching group mappings).
      const existingMembership = await tx.orgMembership.findUnique({
        where: { orgId_userId: { orgId: input.orgId, userId } },
      })
      const nextOrgRole = existingMembership
        ? higherRole(existingMembership.role, resolvedOrgRole)
        : resolvedOrgRole
      if (existingMembership) {
        await tx.orgMembership.update({
          where: { orgId_userId: { orgId: input.orgId, userId } },
          data: { role: nextOrgRole },
        })
      } else {
        await tx.orgMembership.create({
          data: { id: newId(), orgId: input.orgId, userId, role: resolvedOrgRole },
        })
      }

      // 4. Upsert the SSO identity, bump lastLoginAt.
      await tx.userSsoIdentity.upsert({
        where: {
          ssoConnectionId_externalId: {
            ssoConnectionId: input.connectionId,
            externalId: input.externalId,
          },
        },
        create: {
          id: newId(),
          userId,
          ssoConnectionId: input.connectionId,
          externalId: input.externalId,
          email: input.email,
          lastLoginAt: now,
        },
        update: { email: input.email, lastLoginAt: now },
      })

      return { userId }
    })
  }
}
