// SSO. Ported near-verbatim from the reference implementation's
// packages/db/src/org-domain.service.ts, adapted to Clickroom's camelCase
// field naming and `_clickroom-verify.<domain>` TXT record convention.
import crypto from 'node:crypto'
import { resolveTxt } from 'node:dns/promises'
import type { Org, OrgDomain, PrismaClient, SsoConnection } from '@prisma/client'
import { newId } from './client.js'
import type { ScopedPrismaClient } from './scoped-client.js'

export interface VerifyDomainResult {
  verified: boolean
}

export interface ResolvedOrgByDomain {
  org: Org
  /** The org's SSO connection, only when one exists and is enabled. */
  connection: SsoConnection | null
}

function extractDomain(email: string): string | null {
  const at = email.lastIndexOf('@')
  if (at < 0 || at === email.length - 1) return null
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase()
}

export class OrgDomainService {
  constructor(private readonly prisma: PrismaClient | ScopedPrismaClient) {}

  private get client(): PrismaClient {
    return this.prisma as PrismaClient
  }

  async add(orgId: string, domain: string): Promise<OrgDomain> {
    const normalized = domain.trim().toLowerCase()
    const verificationToken = crypto.randomBytes(16).toString('hex')
    return this.client.orgDomain.create({
      data: { id: newId(), orgId, domain: normalized, verificationToken },
    })
  }

  async list(orgId: string): Promise<OrgDomain[]> {
    return this.client.orgDomain.findMany({
      where: { orgId },
      orderBy: { createdAt: 'asc' },
    })
  }

  async remove(domainId: string): Promise<void> {
    await this.client.orgDomain.delete({ where: { id: domainId } })
  }

  /**
   * Verify a domain via DNS TXT lookup of `_clickroom-verify.<domain>`. If any
   * TXT record equals the stored verification token, mark verified.
   */
  async verifyDomain(domainId: string): Promise<VerifyDomainResult> {
    const record = await this.client.orgDomain.findUnique({ where: { id: domainId } })
    if (!record) return { verified: false }

    let records: string[][] = []
    try {
      records = await resolveTxt(`_clickroom-verify.${record.domain}`)
    } catch {
      return { verified: false }
    }

    const flattened = records.map((parts) => parts.join('').trim())
    const matched = flattened.some((value) => value === record.verificationToken)
    if (!matched) return { verified: false }

    await this.client.orgDomain.update({
      where: { id: domainId },
      data: { verifiedAt: new Date() },
    })
    return { verified: true }
  }

  /**
   * Resolve an org (and its enabled SSO connection) from a user's email
   * domain. Only verified domains are considered.
   */
  async resolveOrgByEmailDomain(email: string): Promise<ResolvedOrgByDomain | null> {
    const domain = extractDomain(email)
    if (!domain) return null

    const record = await this.client.orgDomain.findFirst({
      where: { domain, verifiedAt: { not: null } },
      include: { org: { include: { ssoConnection: true } } },
    })
    if (!record) return null

    const connection = record.org.ssoConnection
    return {
      org: record.org,
      connection: connection?.enabled ? connection : null,
    }
  }
}
