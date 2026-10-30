// SSO. Ported near-verbatim from the reference implementation's
// packages/db/src/sso-connection.service.ts, adapted to Clickroom's field
// naming (camelCase columns — clickroom's schema has no `@map` snake_case
// aliasing) and secret sealing (packages/auth `sealJson`/`openJson` in place
// of the reference implementation's notification envelope helpers).
import { openJson, sealJson } from '@clickroom/auth'
import type { OrgRole, Prisma, PrismaClient, SsoConnection, SsoProtocol } from '@prisma/client'
import { newId } from './client.js'
import type { ScopedPrismaClient } from './scoped-client.js'

/**
 * Decrypted secret material for an SSO connection. Used server-side only
 * (IdP token exchange / SAML SP signing). Never returned to the client.
 */
export interface SsoConnectionSecrets {
  clientSecret?: string
  spPrivateKey?: string
}

/**
 * Connection shape returned to clients — secrets stripped, replaced by
 * presence booleans.
 */
export interface SafeSsoConnection extends Omit<SsoConnection, 'secretsEnvelope'> {
  hasClientSecret: boolean
  hasSpPrivateKey: boolean
}

/** Connection row with decrypted secrets, for server-side IdP flows. */
export interface SsoConnectionWithSecrets {
  connection: SsoConnection
  secrets: SsoConnectionSecrets
}

export interface UpsertSsoConnectionInput {
  protocol: SsoProtocol
  displayName: string
  enabled?: boolean
  defaultOrgRole?: OrgRole
  attributeMapping?: Prisma.InputJsonValue
  // OIDC
  oidcIssuerUrl?: string | null
  oidcClientId?: string | null
  // SAML
  samlIdpEntityId?: string | null
  samlIdpSsoUrl?: string | null
  samlIdpX509Cert?: string | null
  samlSpEntityId?: string | null
  samlWantAssertionsSigned?: boolean
  // Secrets — only re-sealed when provided.
  clientSecret?: string
  spPrivateKey?: string
}

export class SsoConnectionService {
  constructor(private readonly prisma: PrismaClient | ScopedPrismaClient) {}

  private get client(): PrismaClient {
    return this.prisma as PrismaClient
  }

  /** Decrypt the secretsEnvelope of a connection. Server-side use only. */
  openSecrets(connection: SsoConnection): SsoConnectionSecrets {
    const envelope = connection.secretsEnvelope
    if (typeof envelope !== 'string' || envelope.length === 0) return {}
    // An envelope is present — if decryption fails, RE-THROW so callers (e.g.
    // upsert's secret merge) abort instead of silently re-sealing an empty
    // envelope and wiping the stored secrets.
    return openJson<SsoConnectionSecrets>(envelope)
  }

  private toSafe(connection: SsoConnection): SafeSsoConnection {
    const secrets = this.openSecrets(connection)
    const { secretsEnvelope: _omit, ...rest } = connection
    return {
      ...rest,
      hasClientSecret: Boolean(secrets.clientSecret),
      hasSpPrivateKey: Boolean(secrets.spPrivateKey),
    }
  }

  /** Client-facing read — never leaks raw secrets. */
  async getByOrg(orgId: string): Promise<SafeSsoConnection | null> {
    const connection = await this.client.ssoConnection.findUnique({
      where: { orgId },
    })
    return connection ? this.toSafe(connection) : null
  }

  /** Full row including decrypted secrets — for the HTTP callback flow. */
  async getByIdWithSecrets(connectionId: string): Promise<SsoConnectionWithSecrets | null> {
    const connection = await this.client.ssoConnection.findUnique({
      where: { id: connectionId },
    })
    if (!connection) return null
    return { connection, secrets: this.openSecrets(connection) }
  }

  async upsert(orgId: string, data: UpsertSsoConnectionInput): Promise<SafeSsoConnection> {
    const existing = await this.client.ssoConnection.findUnique({
      where: { orgId },
    })

    // Merge secrets: keep existing sealed values unless a new one is supplied.
    const currentSecrets = existing ? this.openSecrets(existing) : {}
    const nextSecrets: SsoConnectionSecrets = { ...currentSecrets }
    if (data.clientSecret !== undefined) nextSecrets.clientSecret = data.clientSecret
    if (data.spPrivateKey !== undefined) nextSecrets.spPrivateKey = data.spPrivateKey

    // Fields shared by create and update. enabled/defaultOrgRole/
    // attributeMapping/samlWantAssertionsSigned are already undefined-skip.
    const commonFields = {
      protocol: data.protocol,
      displayName: data.displayName,
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      ...(data.defaultOrgRole !== undefined ? { defaultOrgRole: data.defaultOrgRole } : {}),
      ...(data.attributeMapping !== undefined ? { attributeMapping: data.attributeMapping } : {}),
      ...(data.samlWantAssertionsSigned !== undefined
        ? { samlWantAssertionsSigned: data.samlWantAssertionsSigned }
        : {}),
      secretsEnvelope: sealJson(nextSecrets),
    }

    // Protocol string fields. On CREATE, default omitted keys to explicit null.
    // On UPDATE, only set keys that were provided so omitted fields are left
    // untouched rather than nulled out.
    const createFields = {
      ...commonFields,
      oidcIssuerUrl: data.oidcIssuerUrl ?? null,
      oidcClientId: data.oidcClientId ?? null,
      samlIdpEntityId: data.samlIdpEntityId ?? null,
      samlIdpSsoUrl: data.samlIdpSsoUrl ?? null,
      samlIdpX509Cert: data.samlIdpX509Cert ?? null,
      samlSpEntityId: data.samlSpEntityId ?? null,
    }

    const updateFields = {
      ...commonFields,
      ...(data.oidcIssuerUrl !== undefined ? { oidcIssuerUrl: data.oidcIssuerUrl } : {}),
      ...(data.oidcClientId !== undefined ? { oidcClientId: data.oidcClientId } : {}),
      ...(data.samlIdpEntityId !== undefined ? { samlIdpEntityId: data.samlIdpEntityId } : {}),
      ...(data.samlIdpSsoUrl !== undefined ? { samlIdpSsoUrl: data.samlIdpSsoUrl } : {}),
      ...(data.samlIdpX509Cert !== undefined ? { samlIdpX509Cert: data.samlIdpX509Cert } : {}),
      ...(data.samlSpEntityId !== undefined ? { samlSpEntityId: data.samlSpEntityId } : {}),
    }

    const connection = await this.client.ssoConnection.upsert({
      where: { orgId },
      create: { id: newId(), orgId, ...createFields },
      update: updateFields,
    })
    return this.toSafe(connection)
  }

  async setEnforced(orgId: string, enforced: boolean): Promise<SafeSsoConnection> {
    const connection = await this.client.ssoConnection.update({
      where: { orgId },
      data: { enforced },
    })
    return this.toSafe(connection)
  }

  async delete(orgId: string): Promise<void> {
    await this.client.ssoConnection.delete({ where: { orgId } })
  }
}
