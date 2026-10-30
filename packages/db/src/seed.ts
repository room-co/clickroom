/**
 * Seed the Clickroom config store.
 *
 * Creates a demo org (via the shared `bootstrapOrg` helper — same starter shape
 * as signup), an org_admin user, and one write + one read ApiKey. Idempotent:
 * re-running upserts the user and skips bootstrap/keys that already exist, so it
 * never crashes on re-run.
 *
 * Run: `pnpm --filter @clickroom/db seed`
 */
import { pathToFileURL } from 'node:url'
import { generateApiKey } from '@clickroom/auth'
import { hash } from '@node-rs/argon2'
import { bootstrapOrg } from './bootstrap.js'
import { newId, prisma } from './client.js'
import { defaultPlanKey } from './limits.js'
import { enforceSelfHostPlans } from './self-host-plans.js'

const DEMO_ORG_SLUG = 'demo'
const DEMO_ORG_NAME = 'Demo Org'
const DEMO_USER_EMAIL = 'demo@clickroom.dev'
const DEMO_USER_NAME = 'Demo Admin'
const DEMO_PASSWORD = 'clickroom-demo'
const DEFAULT_PROJECT_NAME = 'Default'

/** Full secret shown once; never persisted (single source of truth in @clickroom/auth). */
type GeneratedKey = ReturnType<typeof generateApiKey>

interface PlanSeed {
  key: string
  name: string
  maxSeats: number
  maxFlags: number
  maxEventsPerMonth: bigint
  maxFlagCallsPerMonth: bigint
  /** May an org on this tier self-enable `overagePolicy = allow`? Only true where someone is billed for the excess. */
  allowsOverage: boolean
}

// Usage tracking + quotas. Enterprise uses a very large (but
// finite) BigInt rather than an actual "unlimited" sentinel, since the
// column is NOT NULL and effectively-unlimited is easier to reason about
// than a magic value.
//
// Every limit here must stay under 2^53. The monthly limits are read back as
// IEEE doubles twice over — `tonumber(ARGV[2])` in capture-rs's Lua counter
// script (services/capture/src/quota.rs) and `Number(limits.maxEventsPerMonth)`
// in usage.router.ts — so an i64-sized value would silently lose precision on
// both hops. `seed.plans.test.ts` enforces this.
// Exported so `plan-registry.test.ts` can assert PLAN_FEATURES covers exactly
// these keys — a fifth tier seeded without a features row must fail a test, not
// production.
export const PLAN_SEEDS: PlanSeed[] = [
  {
    key: 'free',
    name: 'Free',
    maxSeats: 3,
    maxFlags: 5,
    maxEventsPerMonth: 10_000n,
    maxFlagCallsPerMonth: 50_000n,
    allowsOverage: false,
  },
  {
    key: 'pro',
    name: 'Pro',
    maxSeats: 20,
    maxFlags: 50,
    maxEventsPerMonth: 1_000_000n,
    maxFlagCallsPerMonth: 5_000_000n,
    allowsOverage: true,
  },
  {
    key: 'enterprise',
    name: 'Enterprise',
    maxSeats: 1_000,
    maxFlags: 10_000,
    maxEventsPerMonth: 1_000_000_000_000n,
    maxFlagCallsPerMonth: 1_000_000_000_000n,
    allowsOverage: true,
  },
  // Not a sellable tier — the internal escape hatch for first-party orgs
  // (Clickroom's own dogfooding), which must never be throttled by a
  // quota that exists to price customers. Assign it with `set-org-plan.ts`.
  {
    key: 'unlimited',
    name: 'Unlimited',
    maxSeats: 1_000_000,
    maxFlags: 1_000_000,
    maxEventsPerMonth: 1_000_000_000_000_000n,
    maxFlagCallsPerMonth: 1_000_000_000_000_000n,
    allowsOverage: true,
  },
]

/**
 * Upsert the plan tiers on `key` — idempotent, safe to re-run on every seed.
 *
 * Exported because plans are reference data every environment needs, prod
 * included, while the rest of this file's `main()` creates demo fixtures that
 * must never touch prod. `seed.plans.ts` is the prod-safe entrypoint.
 */
export async function seedPlans() {
  for (const plan of PLAN_SEEDS) {
    await prisma.plan.upsert({
      where: { key: plan.key },
      update: {
        name: plan.name,
        maxSeats: plan.maxSeats,
        maxFlags: plan.maxFlags,
        maxEventsPerMonth: plan.maxEventsPerMonth,
        maxFlagCallsPerMonth: plan.maxFlagCallsPerMonth,
        // Also on `update`, not just `create`: the migration adds this column
        // with DEFAULT false, so every pre-existing row (prod's pro/enterprise/
        // unlimited included) lands unentitled and is re-granted here. The
        // deploy runs `prisma migrate deploy` then `seed:plans` in the same
        // task, so the two always move together.
        allowsOverage: plan.allowsOverage,
      },
      create: {
        id: newId(),
        key: plan.key,
        name: plan.name,
        maxSeats: plan.maxSeats,
        maxFlags: plan.maxFlags,
        maxEventsPerMonth: plan.maxEventsPerMonth,
        maxFlagCallsPerMonth: plan.maxFlagCallsPerMonth,
        allowsOverage: plan.allowsOverage,
      },
    })
  }
}

/**
 * Backfill: orgs created before the Plan model existed (or any org that
 * otherwise lost its planId) get the `free` plan. `bootstrapOrg` only
 * attaches a plan on creation, so pre-existing orgs need this one-time
 * catch-up — idempotent, safe to re-run every seed.
 *
 * Exported for the same reason as `seedPlans`: a `planId=NULL` org resolves to
 * a limit of 0 through `effectiveLimits`' fail-closed fallback and 402s every
 * event and flag call, so prod needs this to run on every deploy too — it does,
 * via `seed.plans.ts`. Returns the number of orgs repaired so callers can
 * report it.
 */
export async function backfillOrgPlans(): Promise<number> {
  const planKey = defaultPlanKey()
  const defaultPlan = await prisma.plan.findUniqueOrThrow({ where: { key: planKey } })
  const { count } = await prisma.org.updateMany({
    where: { planId: null },
    data: { planId: defaultPlan.id },
  })
  if (count > 0) {
    console.log(`  backfilled planId=${planKey} on ${count} pre-existing org(s)`)
  }
  // self_host: also repair orgs stuck on `free`/overrides (capture's SQL fallback reads rows).
  const repaired = await enforceSelfHostPlans(prisma)
  if (repaired > 0) console.log(`  moved ${repaired} org(s) to the unlimited plan (self_host)`)
  return count + repaired
}

async function main() {
  // ── Plan tiers (free/pro/enterprise) ─────────────────────────────────────
  await seedPlans()
  await backfillOrgPlans()

  // ── User (org_admin) with Argon2id password hash ────────────────────────
  const passwordHash = await hash(DEMO_PASSWORD) // @node-rs/argon2 defaults to Argon2id
  const user = await prisma.user.upsert({
    where: { email: DEMO_USER_EMAIL },
    update: {},
    create: {
      id: newId(),
      email: DEMO_USER_EMAIL,
      name: DEMO_USER_NAME,
      passwordHash,
    },
  })

  // ── Org + admin membership + Default project + system taxonomy ──────────
  // Delegated to the shared bootstrap helper so seed and signup never drift.
  // Only bootstrap when the demo org is absent (keeps re-runs idempotent).
  let org = await prisma.org.findUnique({ where: { slug: DEMO_ORG_SLUG } })
  if (!org) {
    const result = await prisma.$transaction((tx) =>
      bootstrapOrg(tx, { orgName: DEMO_ORG_NAME, slug: DEMO_ORG_SLUG, userId: user.id }),
    )
    org = await prisma.org.findUniqueOrThrow({ where: { id: result.org.id } })
  }

  // ── Default project (created by bootstrap; look it up for key seeding) ───
  const project = await prisma.project.findFirstOrThrow({
    where: { orgId: org.id, name: DEFAULT_PROJECT_NAME },
  })

  // ── Environment (created by bootstrap; look it up for key seeding) ───────
  const productionEnv = await prisma.environment.findFirstOrThrow({
    where: { projectId: project.id, key: 'production' },
  })

  // ── API keys (create only if the project has none of that type) ─────────
  const [existingWrite, existingRead] = await Promise.all([
    prisma.apiKey.findFirst({ where: { projectId: project.id, type: 'write' } }),
    prisma.apiKey.findFirst({ where: { projectId: project.id, type: 'read' } }),
  ])

  let writeKeyToShow: GeneratedKey | null = null
  if (!existingWrite) {
    writeKeyToShow = generateApiKey('write')
    await prisma.apiKey.create({
      data: {
        id: newId(),
        projectId: project.id,
        keyHash: writeKeyToShow.keyHash,
        keyPrefix: writeKeyToShow.keyPrefix,
        type: 'write',
        environmentId: productionEnv.id,
        label: 'Default write key',
      },
    })
  }
  if (!existingRead) {
    const readKey = generateApiKey('read')
    await prisma.apiKey.create({
      data: {
        id: newId(),
        projectId: project.id,
        keyHash: readKey.keyHash,
        keyPrefix: readKey.keyPrefix,
        type: 'read',
        environmentId: productionEnv.id,
        label: 'Default read key',
      },
    })
  }

  // ── Report ──────────────────────────────────────────────────────────────
  console.log('\n✓ Seed complete')
  console.log(`  org:     ${org.slug} (${org.id})`)
  console.log(`  user:    ${user.email}  password: ${DEMO_PASSWORD}`)
  console.log(`  project: ${project.name} (${project.id})`)
  if (writeKeyToShow) {
    console.log('\n  ─────────────────────────────────────────────────────────')
    console.log('  WRITE API KEY (shown once — copy it now, it is not stored):')
    console.log(`  ${writeKeyToShow.token}`)
    console.log('  ─────────────────────────────────────────────────────────\n')
  } else {
    console.log(
      '\n  (write key already exists — plaintext not recoverable; rotate to reveal a new one)\n',
    )
  }
}

// Only run the demo seed when this file IS the process entrypoint. `seed.plans.ts`
// (the prod-safe entrypoint) imports `seedPlans`/`backfillOrgPlans` from here, and
// an unguarded top-level `main()` would run on that import — creating the demo org,
// demo user and API keys in prod, which is precisely what `seed.plans.ts` exists to
// avoid. Same guard keeps the module importable from vitest.
const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntrypoint) {
  main()
    .then(async () => {
      await prisma.$disconnect()
    })
    .catch(async (err) => {
      console.error(err)
      await prisma.$disconnect()
      process.exit(1)
    })
}
