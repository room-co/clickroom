import { createHmac, randomBytes } from 'node:crypto'
import { hashPassword, verifyPassword } from '@clickroom/auth'
import type { PrismaClient } from '@prisma/client'
import { newId } from './client.js'

// Crockford base32 minus ambiguous chars (i, l, o, u already excluded by the alphabet).
const CODE_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

export function formatRecoveryCode(raw: Buffer): string {
  let bits = ''
  for (const byte of raw) bits += byte.toString(2).padStart(8, '0')

  let out = ''
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += CODE_ALPHABET[Number.parseInt(bits.slice(i, i + 5), 2)]
  }
  return `${out.slice(0, 5)}-${out.slice(5, 10)}`
}

export function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function codeIndex(normalized: string, hmacKey: string): string {
  return createHmac('sha256', hmacKey).update(normalized).digest('hex')
}

export class AdminRecoveryCodesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly hmacKey: string,
  ) {}

  async issue(adminUserId: string): Promise<string[]> {
    const plaintexts = Array.from({ length: 10 }, () => formatRecoveryCode(randomBytes(10)))
    const rows = await Promise.all(
      plaintexts.map(async (code) => ({
        id: newId(),
        adminUserId,
        codeIndex: codeIndex(normalizeRecoveryCode(code), this.hmacKey),
        codeHash: await hashPassword(normalizeRecoveryCode(code)),
      })),
    )

    await this.prisma.$transaction([
      this.prisma.adminRecoveryCode.deleteMany({ where: { adminUserId } }),
      this.prisma.adminRecoveryCode.createMany({ data: rows }),
    ])

    return plaintexts
  }

  async consume(adminUserId: string, code: string): Promise<boolean> {
    const normalized = normalizeRecoveryCode(code)
    const row = await this.prisma.adminRecoveryCode.findUnique({
      where: { codeIndex: codeIndex(normalized, this.hmacKey) },
    })
    if (!row || row.adminUserId !== adminUserId || row.usedAt) return false

    const ok = await verifyPassword(row.codeHash, normalized)
    if (!ok) return false

    const { count } = await this.prisma.adminRecoveryCode.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    })
    return count > 0
  }

  async countRemaining(adminUserId: string): Promise<number> {
    return this.prisma.adminRecoveryCode.count({
      where: { adminUserId, usedAt: null },
    })
  }
}
