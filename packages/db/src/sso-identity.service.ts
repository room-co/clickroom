// SSO. Ported near-verbatim from the reference implementation's
// packages/db/src/sso-identity.service.ts.
import type { PrismaClient, UserSsoIdentity } from '@prisma/client'
import type { ScopedPrismaClient } from './scoped-client.js'

export class SsoIdentityService {
  constructor(private readonly prisma: PrismaClient | ScopedPrismaClient) {}

  private get client(): PrismaClient {
    return this.prisma as PrismaClient
  }

  async findByExternal(connectionId: string, externalId: string): Promise<UserSsoIdentity | null> {
    return this.client.userSsoIdentity.findUnique({
      where: {
        ssoConnectionId_externalId: {
          ssoConnectionId: connectionId,
          externalId,
        },
      },
    })
  }

  async bumpLastLogin(identityId: string): Promise<UserSsoIdentity> {
    return this.client.userSsoIdentity.update({
      where: { id: identityId },
      data: { lastLoginAt: new Date() },
    })
  }
}
