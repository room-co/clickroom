/**
 * Point an org at a plan tier: `Org.planId = Plan.id`, resolved by slug + key.
 *
 * The operator-run counterpart to `seed.plans.ts`. `bootstrapOrg` only attaches
 * a plan at org-creation time (always `free`) and no tRPC mutation can change
 * it afterwards, so moving an existing org between tiers is a script-only
 * action — this is that script, rather than hand-written UPDATE statements
 * against prod that leave no artifact and cannot be reviewed.
 *
 * Both lookups are strict: an unknown slug or plan key is an error, never an
 * implicit create. The update itself is a plain idempotent `planId` write — it
 * touches nothing else, and in particular leaves the per-org `*Override`
 * columns alone. Those still win over the plan (`effectiveLimits`), so the
 * before/after limits printed below are what actually gets enforced, not just
 * the new plan's face value.
 *
 * Redis: this writes Postgres only, and deliberately so — `packages/db` has no
 * Redis dependency and `writeQuotaLimitsMirror` lives a layer up in
 * `packages/trpc-router`. capture-rs's `usage:limits:<orgId>` mirror carries a
 * 300s TTL and a Postgres fallback (services/capture/src/quota.rs), so the hot
 * path converges on the new limits within five minutes with no cache bust. The
 * control-plane seat/flag gates read Postgres live and see the change at once.
 *
 * Run: `DATABASE_URL=... pnpm --filter @clickroom/db set-org-plan <org-slug> <plan-key>`
 */
import { prisma } from './client.js'
import { type EffectiveLimits, effectiveLimits } from './limits.js'

const USAGE = 'Usage: pnpm --filter @clickroom/db set-org-plan <org-slug> <plan-key>'

interface Args {
  orgSlug: string
  planKey: string
}

function parseArgs(argv: string[]): Args {
  const [orgSlug, planKey, ...rest] = argv
  if (!orgSlug || !planKey || rest.length > 0) {
    throw new Error(USAGE)
  }
  return { orgSlug, planKey }
}

/** Fail loudly on an unknown slug/key — never create anything implicitly. */
async function resolveOrg(slug: string) {
  const org = await prisma.org.findUnique({ where: { slug }, include: { plan: true } })
  if (!org) {
    const known = await prisma.org.findMany({ select: { slug: true }, orderBy: { slug: 'asc' } })
    throw new Error(
      `No org with slug '${slug}'. Known orgs: ${known.map((o) => o.slug).join(', ') || '(none)'}`,
    )
  }
  return org
}

async function resolvePlan(key: string) {
  const plan = await prisma.plan.findUnique({ where: { key } })
  if (!plan) {
    const known = await prisma.plan.findMany({ select: { key: true }, orderBy: { key: 'asc' } })
    throw new Error(
      `No plan with key '${key}'. Known plans: ${known.map((p) => p.key).join(', ') || '(none — run seed:plans first)'}`,
    )
  }
  return plan
}

function formatLimits(planKey: string | null, limits: EffectiveLimits): string {
  const parts = [
    `plan=${planKey ?? 'NONE'}`,
    `seats=${limits.maxSeats}`,
    `flags=${limits.maxFlags}`,
    `events/mo=${limits.maxEventsPerMonth}`,
    `flagCalls/mo=${limits.maxFlagCallsPerMonth}`,
    `overage=${limits.overagePolicy}`,
  ]
  return parts.join('  ')
}

/**
 * Which of the four limits are pinned by a per-org override, and so will keep
 * shadowing the new plan's value. Worth surfacing: an override left over from
 * an earlier incident is exactly the thing that makes a plan change look like
 * it did nothing.
 */
function shadowedByOverride(org: {
  maxSeatsOverride: number | null
  maxFlagsOverride: number | null
  maxEventsPerMonthOverride: bigint | null
  maxFlagCallsPerMonthOverride: bigint | null
}): string[] {
  return [
    org.maxSeatsOverride !== null ? 'maxSeats' : null,
    org.maxFlagsOverride !== null ? 'maxFlags' : null,
    org.maxEventsPerMonthOverride !== null ? 'maxEventsPerMonth' : null,
    org.maxFlagCallsPerMonthOverride !== null ? 'maxFlagCallsPerMonth' : null,
  ].filter((f): f is string => f !== null)
}

async function main() {
  const { orgSlug, planKey } = parseArgs(process.argv.slice(2))

  const org = await resolveOrg(orgSlug)
  const plan = await resolvePlan(planKey)

  const before = effectiveLimits(org, org.plan)
  console.log(`org: ${org.name} (${org.slug}, ${org.id})`)
  console.log(`  before: ${formatLimits(org.plan?.key ?? null, before)}`)

  if (org.planId === plan.id) {
    console.log(`  ✓ already on '${plan.key}' — nothing to do`)
    return
  }

  await prisma.org.update({ where: { id: org.id }, data: { planId: plan.id } })

  const after = effectiveLimits(org, plan)
  console.log(`  after:  ${formatLimits(plan.key, after)}`)

  const shadowed = shadowedByOverride(org)
  if (shadowed.length > 0) {
    console.log(
      `  ⚠ per-org override still wins over the plan for: ${shadowed.join(', ')} — ` +
        `clear the *Override column(s) on Org if the new plan's value should apply`,
    )
  }

  console.log(
    `  ℹ capture-rs reads monthly limits from the 'usage:limits:${org.id}' Redis mirror ` +
      `(300s TTL, Postgres fallback) — the hot path picks this up within 5 minutes. ` +
      `Seat/flag gates read Postgres live and are effective now.`,
  )
}

main()
  .then(async () => {
    await prisma.$disconnect()
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err)
    await prisma.$disconnect()
    process.exit(1)
  })
