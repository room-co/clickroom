import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId, prisma } from './client.js'
import { ENFORCED_FEATURES, featureKeys, isPlanKey, PLAN_FEATURES } from './plan-registry.js'
import { backfillOrgPlans, seedPlans } from './seed.js'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// `seed.plans.ts` is the entrypoint the prod migrate task runs on
// every deploy. Two things must hold, and neither did before:
//
//   1. It backfills orgs stuck on `planId=NULL`. Seeding the `Plan` rows alone
//      leaves such an org resolving to a limit of 0 (`effectiveLimits`' fail-
//      closed fallback) — a permanent 402 on every event and flag call.
//   2. It does NOT create the demo org/user/API keys. `seed.ts` used to call
//      `main()` at module top level, so merely *importing* it (which
//      `seed.plans.ts` does, for `seedPlans`) ran the whole demo fixture seed.
//
// Runs against the live test Postgres (TEST_DATABASE_URL); skips gracefully
// when it is unreachable, matching `scoped-client.test.ts`.
// ---------------------------------------------------------------------------

const DEMO_ORG_SLUG = 'demo'
const DEMO_USER_EMAIL = 'demo@clickroom.dev'

let dbUp = false
const createdOrgIds: string[] = []

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`
    dbUp = true
    await seedPlans()
  } catch {
    dbUp = false
  }
})

afterAll(async () => {
  try {
    for (const id of createdOrgIds) {
      await prisma.org.delete({ where: { id } }).catch(() => {})
    }
    await prisma.$disconnect()
  } catch {
    // ignore — DB may never have connected
  }
})

/** An org deliberately left in the poisoned `planId=NULL` state. */
async function createPlanlessOrg() {
  const id = newId()
  const org = await prisma.org.create({
    data: { id, name: `Planless ${id}`, slug: `planless-${id.toLowerCase()}`, planId: null },
  })
  createdOrgIds.push(id)
  return org
}

describe('backfillOrgPlans', () => {
  it('assigns the free plan to an org left with planId=NULL', async () => {
    if (!dbUp) return
    const org = await createPlanlessOrg()
    expect(org.planId).toBeNull()

    const count = await backfillOrgPlans()
    expect(count).toBeGreaterThanOrEqual(1)

    const repaired = await prisma.org.findUniqueOrThrow({ where: { id: org.id } })
    const freePlan = await prisma.plan.findUniqueOrThrow({ where: { key: 'free' } })
    expect(repaired.planId).toBe(freePlan.id)
  })

  it('is idempotent — a second run repairs nothing and leaves plans untouched', async () => {
    if (!dbUp) return
    const org = await createPlanlessOrg()
    await backfillOrgPlans()
    const afterFirst = await prisma.org.findUniqueOrThrow({ where: { id: org.id } })

    // No planId=NULL orgs remain, so the second pass must be a no-op.
    expect(await backfillOrgPlans()).toBe(0)

    const afterSecond = await prisma.org.findUniqueOrThrow({ where: { id: org.id } })
    expect(afterSecond.planId).toBe(afterFirst.planId)
  })

  it('never overwrites an org that already has a non-free plan', async () => {
    if (!dbUp) return
    const enterprise = await prisma.plan.findUniqueOrThrow({ where: { key: 'enterprise' } })
    const id = newId()
    await prisma.org.create({
      data: {
        id,
        name: `Enterprise ${id}`,
        slug: `ent-${id.toLowerCase()}`,
        planId: enterprise.id,
      },
    })
    createdOrgIds.push(id)

    await backfillOrgPlans()

    const org = await prisma.org.findUniqueOrThrow({ where: { id } })
    expect(org.planId).toBe(enterprise.id)
  })
})

describe('seedPlans', () => {
  // The monthly limits survive two lossy hops on their way to enforcement:
  // `tonumber(ARGV[2])` in capture-rs's Lua counter script and
  // `Number(limits.maxEventsPerMonth)` in usage.router.ts. Both are IEEE
  // doubles, exact only to 2^53 — so a limit above that silently rounds and
  // the number the gate compares against is not the number in the column.
  // The `unlimited` tier is the one most likely to tempt someone toward
  // i64::MAX, hence the guard rail.
  it('keeps every plan limit exactly representable as a JS number', async () => {
    if (!dbUp) return
    const plans = await prisma.plan.findMany()
    expect(plans.length).toBeGreaterThan(0)

    for (const plan of plans) {
      for (const limit of [plan.maxEventsPerMonth, plan.maxFlagCallsPerMonth]) {
        expect(limit).toBeGreaterThan(0n)
        expect(limit).toBeLessThanOrEqual(BigInt(Number.MAX_SAFE_INTEGER))
        // Round-tripping through a double must be lossless.
        expect(BigInt(Number(limit))).toBe(limit)
      }
    }
  })

  // Overage entitlement is per-plan DATA (`Plan.allowsOverage`), not inferred
  // from the key. The column defaults to false, so this pins the intent for
  // every seeded tier: the signup default must NOT be able to self-grant
  // unmetered ingest, and every other tier must, deliberately. A new tier added
  // to PLAN_SEEDS without a considered value trips this.
  it('grants overage to exactly the non-default tiers', async () => {
    if (!dbUp) return
    const plans = await prisma.plan.findMany({ select: { key: true, allowsOverage: true } })
    const entitlement = Object.fromEntries(plans.map((p) => [p.key, p.allowsOverage]))

    expect(entitlement).toMatchObject({
      free: false,
      pro: true,
      enterprise: true,
      unlimited: true,
    })
  })

  // — the entitlement registry is keyed by `Plan.key`, a plain
  // String column. A tier that reaches the database without a `PLAN_FEATURES`
  // row resolves to `noFeatures()` and fails CLOSED for every org on it, in
  // production, silently. Assert parity against what is actually SEEDED, not
  // just against the in-code `PLAN_SEEDS` array.
  it('gives every seeded plan a complete PLAN_FEATURES row', async () => {
    if (!dbUp) return
    const plans = await prisma.plan.findMany({ select: { key: true } })
    expect(plans.length).toBeGreaterThan(0)

    const keys = featureKeys()
    for (const { key } of plans) {
      expect(isPlanKey(key), `unknown plan key ${key}`).toBe(true)
      if (!isPlanKey(key)) continue
      const features = PLAN_FEATURES[key]
      expect(Object.keys(features).sort(), `plan ${key}`).toEqual([...keys].sort())
      for (const feature of keys) {
        expect(typeof features[feature], `${key}.${feature}`).toBe('boolean')
      }
    }
  })

  // Every gated surface must be denied on the signup default tier, else the
  // gate is decorative. `support` joins sqlExplorer + surveys here.
  it('denies every enforced feature on the seeded free tier', async () => {
    if (!dbUp) return
    const free = await prisma.plan.findUniqueOrThrow({ where: { key: 'free' } })
    expect(isPlanKey(free.key)).toBe(true)
    for (const feature of ENFORCED_FEATURES) {
      expect(PLAN_FEATURES.free[feature], `free.${feature}`).toBe(false)
    }
    expect(PLAN_FEATURES.free.support).toBe(false)
    expect(PLAN_FEATURES.pro.support).toBe(true)
  })

  it('seeds the unlimited tier well above enterprise', async () => {
    if (!dbUp) return
    const [enterprise, unlimited] = await Promise.all([
      prisma.plan.findUniqueOrThrow({ where: { key: 'enterprise' } }),
      prisma.plan.findUniqueOrThrow({ where: { key: 'unlimited' } }),
    ])

    expect(unlimited.maxEventsPerMonth).toBeGreaterThan(enterprise.maxEventsPerMonth)
    expect(unlimited.maxFlagCallsPerMonth).toBeGreaterThan(enterprise.maxFlagCallsPerMonth)
    expect(unlimited.maxSeats).toBeGreaterThan(enterprise.maxSeats)
    expect(unlimited.maxFlags).toBeGreaterThan(enterprise.maxFlags)
  })
})

describe('seed:plans entrypoint (prod-safe)', () => {
  // Run the real entrypoint as a subprocess — that is exactly how the prod
  // migrate task invokes it, and it is the only way to prove the demo seed
  // does not ride along on the import of `seed.ts`.
  it('seeds plans + backfills orgs without creating any demo fixtures', async () => {
    if (!dbUp) return
    const org = await createPlanlessOrg()

    const demoUserBefore = await prisma.user.count({ where: { email: DEMO_USER_EMAIL } })
    const demoOrgBefore = await prisma.org.count({ where: { slug: DEMO_ORG_SLUG } })

    const script = fileURLToPath(new URL('./seed.plans.ts', import.meta.url))
    const { stdout } = await execFileAsync('pnpm', ['exec', 'tsx', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      // Inherits DATABASE_URL, which vitest.config.ts has pointed at TEST_DATABASE_URL.
      env: process.env,
    })

    expect(stdout).toContain('plans seeded')
    expect(stdout).toContain('org plan backfill')

    // 1. The four reference plans exist.
    const plans = await prisma.plan.findMany({ select: { key: true } })
    expect(plans.map((p) => p.key).sort()).toEqual(['enterprise', 'free', 'pro', 'unlimited'])

    // 2. The planless org was repaired by the entrypoint itself.
    const repaired = await prisma.org.findUniqueOrThrow({ where: { id: org.id } })
    expect(repaired.planId).not.toBeNull()

    // 3. No demo fixtures leaked in — `seed.ts`'s `main()` stayed dormant.
    expect(await prisma.user.count({ where: { email: DEMO_USER_EMAIL } })).toBe(demoUserBefore)
    expect(await prisma.org.count({ where: { slug: DEMO_ORG_SLUG } })).toBe(demoOrgBefore)
  }, 60_000)
})
