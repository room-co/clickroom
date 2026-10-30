/**
 * Seed the plan tiers (`free` / `pro` / `enterprise`) and backfill any org left
 * without one.
 *
 * Plans are reference data, not fixtures: every environment — prod included —
 * needs the rows to exist, because quota enforcement joins against them. When
 * the table is empty an org resolves to `planId = NULL`, and the capture
 * service's quota check fails closed to a limit of 0 (`services/capture/src/
 * quota.rs`, `.unwrap_or(0)`) — every event is rejected with a 402 "quota
 * exceeded". That is exactly what happened on the first prod deploy: migrations
 * ran, `seed.ts` never did, and `seed.dogfood.ts`'s enterprise pin silently
 * no-op'd because `findUnique({key:'enterprise'})` returned null.
 *
 * Seeding the plans alone is not enough: `bootstrapOrg` only
 * attaches a plan at creation time, so any org that predates the rows keeps
 * `planId=NULL` and stays at limit 0 — the same 402 — until it is backfilled.
 * `backfillOrgPlans` therefore rides along here rather than only in `seed.ts`'s
 * demo `main()`, which never runs in prod.
 *
 * Both steps are pure idempotent upserts/backfills (upsert on `Plan.key`;
 * `updateMany` over `planId: null` only), so this is safe to run unattended on
 * every deploy — it is invoked by the migrate task in the deploy pipeline.
 *
 * `seed.ts`'s `main()` also creates a demo user and API keys, so it must never
 * be run against prod. This entrypoint is the safe subset.
 *
 * Run: `DATABASE_URL=... pnpm --filter @clickroom/db seed:plans`
 */
import { prisma } from './client.js'
import { backfillOrgPlans, seedPlans } from './seed.js'

async function main() {
  await seedPlans()
  const plans = await prisma.plan.findMany({ select: { key: true, name: true } })
  console.log(`✓ plans seeded (${plans.length}): ${plans.map((p) => p.key).join(', ')}`)

  const backfilled = await backfillOrgPlans()
  console.log(`✓ org plan backfill: ${backfilled} org(s) had planId=NULL and now have 'free'`)
}

main()
  .then(async () => {
    await prisma.$disconnect()
  })
  .catch(async (err) => {
    console.error(err)
    await prisma.$disconnect()
    process.exit(1)
  })
