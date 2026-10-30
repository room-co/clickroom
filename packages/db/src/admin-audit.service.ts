/**
 * Record admin-console mutations.
 *
 * Bypasses the scoped Prisma client because admin actions are cross-tenant by design.
 * Security is enforced upstream via `adminProcedure`; this service trusts callers.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { newId } from './client.js'

export interface RecordAuditInput {
  targetOrgId?: string | null
  before?: Prisma.InputJsonValue
  after?: Prisma.InputJsonValue
  tx?: Prisma.TransactionClient
}

export interface AdminAuditEntry {
  id: string
  adminUserId: string
  adminUserEmail: string | null
  action: string
  targetOrgId: string | null
  before: unknown
  after: unknown
  createdAt: Date
}

export class AdminAuditService {
  constructor(private readonly prisma: PrismaClient) {}

  async record(adminUserId: string, action: string, input: RecordAuditInput = {}): Promise<void> {
    const client = input.tx ?? this.prisma
    await client.adminAuditLog.create({
      data: {
        id: newId(),
        adminUserId,
        action,
        targetOrgId: input.targetOrgId ?? null,
        before: input.before ?? {},
        after: input.after ?? {},
      },
    })
  }

  async listByOrg(orgId: string, limit = 20): Promise<AdminAuditEntry[]> {
    const rows = await this.prisma.adminAuditLog.findMany({
      where: { targetOrgId: orgId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { adminUser: { select: { email: true } } },
    })
    return rows.map((r) => ({
      id: r.id,
      adminUserId: r.adminUserId,
      adminUserEmail: r.adminUser?.email ?? null,
      action: r.action,
      targetOrgId: r.targetOrgId,
      before: r.before,
      after: r.after,
      createdAt: r.createdAt,
    }))
  }
}
