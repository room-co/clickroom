import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  AdminRecoveryCodesService,
  formatRecoveryCode,
  normalizeRecoveryCode,
} from './admin-recovery-codes.service.js'
import { newId, prisma } from './client.js'

// ---------------------------------------------------------------------------
// Behavioral test against the live test Postgres (TEST_DATABASE_URL), same
// skip-gracefully pattern as scoped-client.test.ts / seed.plans.test.ts.
// Exercises the CAS `updateMany({ where: { id, usedAt: null } })` single-use
// guarantee end to end, plus the plain classification helpers.
// ---------------------------------------------------------------------------

const HMAC_KEY = 'test-admin-recovery-hmac-key'

let dbUp = false
const createdAdminUserIds: string[] = []

async function createAdminUser(): Promise<string> {
  const id = newId()
  await prisma.adminUser.create({
    data: {
      id,
      email: `${id}@admin-recovery-codes.test`,
      passwordHash: 'unused-in-this-test',
    },
  })
  createdAdminUserIds.push(id)
  return id
}

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`
    dbUp = true
  } catch {
    dbUp = false
  }
})

afterEach(async () => {
  if (!dbUp) return
  if (createdAdminUserIds.length === 0) return
  // AdminRecoveryCode.adminUserId -> AdminUser has ON DELETE CASCADE, so
  // deleting the AdminUser rows is sufficient cleanup.
  await prisma.adminUser.deleteMany({ where: { id: { in: createdAdminUserIds } } })
  createdAdminUserIds.length = 0
})

afterAll(async () => {
  try {
    await prisma.$disconnect()
  } catch {
    // ignore — DB may never have connected
  }
})

describe('formatRecoveryCode / normalizeRecoveryCode', () => {
  it('formats a 10-byte buffer as xxxxx-xxxxx (5 chars, hyphen, 5 chars)', () => {
    const code = formatRecoveryCode(Buffer.alloc(10, 0xab))
    expect(code).toMatch(/^[0-9a-z]{5}-[0-9a-z]{5}$/)
  })

  it('normalize strips hyphens/case so a formatted code round-trips to the same index input', () => {
    const code = formatRecoveryCode(Buffer.alloc(10, 0x42))
    const normalized = normalizeRecoveryCode(code)
    expect(normalized).toBe(normalized.toLowerCase())
    expect(normalized).not.toContain('-')
    // Re-normalizing an already-normalized, uppercased-with-noise variant matches.
    expect(normalizeRecoveryCode(code.toUpperCase())).toBe(normalized)
    expect(normalizeRecoveryCode(`  ${code}  `.replace(/-/g, ' - '))).toBe(normalized)
  })
})

describe('AdminRecoveryCodesService (live DB)', () => {
  it('issue() returns 10 distinct plaintext codes and persists rows for them', async () => {
    if (!dbUp) return
    const adminUserId = await createAdminUser()
    const service = new AdminRecoveryCodesService(prisma, HMAC_KEY)

    const codes = await service.issue(adminUserId)
    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)

    const remaining = await service.countRemaining(adminUserId)
    expect(remaining).toBe(10)
  })

  it('a freshly issued code validates and consuming it decrements the remaining count', async () => {
    if (!dbUp) return
    const adminUserId = await createAdminUser()
    const service = new AdminRecoveryCodesService(prisma, HMAC_KEY)
    const codes = await service.issue(adminUserId)

    const ok = await service.consume(adminUserId, codes[0]!)
    expect(ok).toBe(true)
    expect(await service.countRemaining(adminUserId)).toBe(9)
  })

  it('single-use enforcement: the same code cannot be consumed twice (CAS updateMany)', async () => {
    if (!dbUp) return
    const adminUserId = await createAdminUser()
    const service = new AdminRecoveryCodesService(prisma, HMAC_KEY)
    const codes = await service.issue(adminUserId)

    const first = await service.consume(adminUserId, codes[0]!)
    const second = await service.consume(adminUserId, codes[0]!)
    expect(first).toBe(true)
    expect(second).toBe(false)
    // Only one code got spent, not two.
    expect(await service.countRemaining(adminUserId)).toBe(9)
  })

  it('an unconsumed code still validates after a sibling code is consumed', async () => {
    if (!dbUp) return
    const adminUserId = await createAdminUser()
    const service = new AdminRecoveryCodesService(prisma, HMAC_KEY)
    const codes = await service.issue(adminUserId)

    await service.consume(adminUserId, codes[0]!)
    const stillGood = await service.consume(adminUserId, codes[1]!)
    expect(stillGood).toBe(true)
    expect(await service.countRemaining(adminUserId)).toBe(8)
  })

  it('an unknown code fails cleanly (no matching codeIndex row)', async () => {
    if (!dbUp) return
    const adminUserId = await createAdminUser()
    const service = new AdminRecoveryCodesService(prisma, HMAC_KEY)
    await service.issue(adminUserId)

    const ok = await service.consume(adminUserId, 'zzzzz-99999')
    expect(ok).toBe(false)
  })

  it('a code issued for a different admin user fails for this one', async () => {
    if (!dbUp) return
    const adminUserId = await createAdminUser()
    const otherAdminUserId = await createAdminUser()
    const service = new AdminRecoveryCodesService(prisma, HMAC_KEY)
    const otherCodes = await service.issue(otherAdminUserId)

    const ok = await service.consume(adminUserId, otherCodes[0]!)
    expect(ok).toBe(false)
    // The other admin's code is still unconsumed.
    expect(await service.countRemaining(otherAdminUserId)).toBe(10)
  })

  it('re-issuing replaces the prior code set (old codes stop validating)', async () => {
    if (!dbUp) return
    const adminUserId = await createAdminUser()
    const service = new AdminRecoveryCodesService(prisma, HMAC_KEY)
    const firstBatch = await service.issue(adminUserId)

    const secondBatch = await service.issue(adminUserId)
    expect(await service.countRemaining(adminUserId)).toBe(10)

    const oldStillWorks = await service.consume(adminUserId, firstBatch[0]!)
    expect(oldStillWorks).toBe(false)

    const newWorks = await service.consume(adminUserId, secondBatch[0]!)
    expect(newWorks).toBe(true)
  })
})
