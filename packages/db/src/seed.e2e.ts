/**
 * Seed an isolated e2e test database (Playwright groundwork).
 *
 * Mirrors seed.ts's shape (bootstrapOrg for org/membership/environments/system
 * taxonomy, @clickroom/auth for API key hashing) but targets a *separate*
 * database — point DATABASE_URL at the e2e DB before running this, never at
 * dev/prod. Idempotent: upserts by natural keys (org slug, user email, ApiKey
 * keyHash) so re-running never crashes on unique constraints.
 *
 * Creates:
 *   - org `e2e` / project `E2E`  — a normal org for happy-path e2e specs, with
 *     one fixed write key (known test vector, also asserted against in
 *     services/capture/src/auth.rs) and one fixed read key.
 *   - org `e2e-limited` / project `E2E-LIMITED` — same shape, but with
 *     `maxEventsPerMonthOverride` set very low (2) so an e2e spec can drive it
 *     over quota deterministically. This column is the per-org override that
 *     `effectiveLimits()` (packages/db/src/limits.ts) resolves ahead of the
 *     org's plan tier — see apps/api/src/trpc/routers/usage.router.ts and the
 *     equivalent unit test in apps/api/src/test/usage.test.ts.
 *   - org `e2e-overage` / project `E2E-OVERAGE` — same low-limit shape as
 *     `e2e-limited`, but dedicated to `overage-policy.spec.ts`,
 *     which live-mutates its org's `overagePolicy` ('block' <-> 'allow').
 *     Kept as its own org (not sharing `e2e-limited`) so that mutation can
 *     never race `schema-and-limits.spec.ts`'s quota-gating test, which
 *     assumes `e2e-limited` stays on the seeded 'block' default — Playwright
 *     runs different spec files concurrently by default
 *     (`fullyParallel: true`), and `test.describe.configure({mode:'serial'})`
 *     only serializes tests within one file, not across files sharing state.
 *   - org `e2e-surveys` / project `E2E-SURVEYS` — the only e2e org on the `pro`
 *     plan (all others are `free`). `surveys` is an ENFORCED feature that is OFF
 *     on `free` (packages/db/src/plan-registry.ts), so surveys-exposure.spec.ts
 *     seeds surveys through the real `surveys.create`/`surveys.update` tRPC
 *     procedures authenticated as THIS org — the entitlement gate would 403 the
 *     free orgs. Kept isolated so the shared org's `free` quotas stay untouched.
 *
 * Run: `pnpm --filter @clickroom/db seed:e2e` (DATABASE_URL must point at the
 * e2e database, not dev/prod).
 */
import { hashApiKey } from '@clickroom/auth'
import { hash } from '@node-rs/argon2'
import { bootstrapOrg } from './bootstrap.js'
import { newId, prisma } from './client.js'

const E2E_ORG_SLUG = 'e2e'
const E2E_ORG_NAME = 'E2E Test Org'
const E2E_USER_EMAIL = 'e2e@clickroom.dev'
const E2E_USER_NAME = 'E2E Test Admin'
const E2E_PASSWORD = 'e2e-test-pw-2026'
const E2E_PROJECT_NAME = 'E2E'

// Known test vector — also asserted in services/capture/src/auth.rs
// (`hash_matches_clickroom_auth_sha256`), so capture-rs's key lookup and this
// seed always agree on the same plaintext/hash pair.
const E2E_WRITE_KEY_PLAINTEXT = 'ckw_live_a2987d751bd5c7ed4c7d9d603a1dc1b5fb910a5fd82cce3d'
const E2E_READ_KEY_PLAINTEXT = 'ckr_live_e2e0000000000000000000000000000000000000000'

// Read-only-role membership in the `e2e` org (prep) — a
// second seeded user with `OrgRole.viewer` (`projects:read` only, no
// `projects:manage` — see packages/auth/src/permissions.ts), reused by
// permission-gate specs instead of every spec faking a role. Scoped tightly
// to this one membership row, not a broader RBAC feature.
const E2E_VIEWER_USER_EMAIL = 'e2e-viewer@clickroom.dev'
const E2E_VIEWER_USER_NAME = 'E2E Viewer'
const E2E_VIEWER_PASSWORD = 'e2e-viewer-test-pw-2026'

const E2E_LIMITED_ORG_SLUG = 'e2e-limited'
const E2E_LIMITED_ORG_NAME = 'E2E Limited Org'
const E2E_LIMITED_USER_EMAIL = 'e2e-limited@clickroom.dev'
const E2E_LIMITED_USER_NAME = 'E2E Limited Admin'
const E2E_LIMITED_PASSWORD = 'e2e-limited-test-pw-2026'
const E2E_LIMITED_PROJECT_NAME = 'E2E-LIMITED'
const E2E_LIMITED_WRITE_KEY_PLAINTEXT = 'ckw_live_e2elimited00000000000000000000000000000000000'

// Deliberately tiny so an e2e spec can send 3+ events and assert the quota
// gate rejects the overage — see maxEventsPerMonthOverride in
// packages/db/prisma/schema.prisma / effectiveLimits() in packages/db/src/limits.ts.
const E2E_LIMITED_MAX_EVENTS_PER_MONTH = 2n

// Dedicated org for overage-policy.spec.ts — see the module doc
// comment above for why this can't just reuse `e2e-limited`.
const E2E_OVERAGE_ORG_SLUG = 'e2e-overage'
const E2E_OVERAGE_ORG_NAME = 'E2E Overage Org'
const E2E_OVERAGE_USER_EMAIL = 'e2e-overage@clickroom.dev'
const E2E_OVERAGE_USER_NAME = 'E2E Overage Admin'
const E2E_OVERAGE_PASSWORD = 'e2e-overage-test-pw-2026'
const E2E_OVERAGE_PROJECT_NAME = 'E2E-OVERAGE'
const E2E_OVERAGE_WRITE_KEY_PLAINTEXT = 'ckw_live_e2eoverage0000000000000000000000000000000'
const E2E_OVERAGE_MAX_EVENTS_PER_MONTH = 2n

// Dedicated org on the `pro` plan for surveys-exposure.spec.ts. `surveys` is an
// ENFORCED feature that is OFF on `free` (packages/db/src/plan-registry.ts), so
// the shared `e2e`/`e2e-limited`/`e2e-overage` orgs (all `free`) can't drive the
// real `surveys.create`/`surveys.update` product path — it 403s on the
// `feature:surveys` entitlement gate. This org is on `pro` (surveys ON) so the
// spec can seed surveys through the SAME tRPC procedures the dashboard uses.
// Kept as its own org (not a plan bump on `e2e`) so the shared org's `free`
// quotas keep feeding schema-and-limits.spec.ts unchanged.
const E2E_SURVEYS_ORG_SLUG = 'e2e-surveys'
const E2E_SURVEYS_ORG_NAME = 'E2E Surveys Org'
const E2E_SURVEYS_USER_EMAIL = 'e2e-surveys@clickroom.dev'
const E2E_SURVEYS_USER_NAME = 'E2E Surveys Admin'
const E2E_SURVEYS_PASSWORD = 'e2e-surveys-test-pw-2026'
const E2E_SURVEYS_PROJECT_NAME = 'E2E-SURVEYS'
const E2E_SURVEYS_WRITE_KEY_PLAINTEXT = 'ckw_live_e2esurveys0000000000000000000000000000000'

/** Full secret shown once; never persisted (single source of truth in @clickroom/auth). */
type GeneratedKey = { token: string; keyHash: string; keyPrefix: string }

interface SeedOrgInput {
  orgSlug: string
  orgName: string
  userEmail: string
  userName: string
  password: string
  projectName: string
}

interface SeedOrgResult {
  orgId: string
  orgSlug: string
  projectId: string
  projectName: string
  productionEnvId: string
  userEmail: string
}

/**
 * Upsert the user, then bootstrap the org (if absent) via the shared helper so
 * this matches the exact shape signup/seed.ts create, and finally rename the
 * bootstrap-created "Default" project to `projectName` (bootstrapOrg doesn't
 * take a project name param — it's shared with the signup flow).
 */
async function seedOrgAndProject(input: SeedOrgInput): Promise<SeedOrgResult> {
  const passwordHash = await hash(input.password)
  const user = await prisma.user.upsert({
    where: { email: input.userEmail },
    update: {},
    create: {
      id: newId(),
      email: input.userEmail,
      name: input.userName,
      passwordHash,
    },
  })

  let org = await prisma.org.findUnique({ where: { slug: input.orgSlug } })
  if (!org) {
    const result = await prisma.$transaction((tx) =>
      bootstrapOrg(tx, { orgName: input.orgName, slug: input.orgSlug, userId: user.id }),
    )
    org = await prisma.org.findUniqueOrThrow({ where: { id: result.org.id } })
  }

  let project = await prisma.project.findFirstOrThrow({
    where: { orgId: org.id },
  })
  if (project.name !== input.projectName) {
    project = await prisma.project.update({
      where: { id: project.id },
      data: { name: input.projectName },
    })
  }

  const productionEnv = await prisma.environment.findFirstOrThrow({
    where: { projectId: project.id, key: 'production' },
  })

  return {
    orgId: org.id,
    orgSlug: org.slug,
    projectId: project.id,
    projectName: project.name,
    productionEnvId: productionEnv.id,
    userEmail: user.email,
  }
}

/**
 * Upsert an ApiKey by `keyHash` (not `id`) so re-running the seed against a
 * key whose plaintext is fixed never hits the unique constraint on keyHash.
 */
async function seedApiKey(
  projectId: string,
  environmentId: string,
  type: 'write' | 'read',
  plaintext: string,
  label: string,
): Promise<GeneratedKey> {
  const keyHash = hashApiKey(plaintext)
  const keyPrefix = plaintext.slice(0, 16)
  await prisma.apiKey.upsert({
    where: { keyHash },
    update: {},
    create: {
      id: newId(),
      projectId,
      keyHash,
      keyPrefix,
      type,
      environmentId,
      label,
    },
  })
  return { token: plaintext, keyHash, keyPrefix }
}

/**
 * Upsert a user and give them a `viewer`-role `OrgMembership` in an existing
 * org. Separate from `seedOrgAndProject` (which always creates an
 * `org_admin` membership via `bootstrapOrg`) — this is additive, for a
 * *second* user in the same org with a lower role.
 */
async function seedViewerMembership(input: {
  orgId: string
  userEmail: string
  userName: string
  password: string
}): Promise<void> {
  const passwordHash = await hash(input.password)
  const user = await prisma.user.upsert({
    where: { email: input.userEmail },
    update: {},
    create: {
      id: newId(),
      email: input.userEmail,
      name: input.userName,
      passwordHash,
    },
  })

  await prisma.orgMembership.upsert({
    where: { orgId_userId: { orgId: input.orgId, userId: user.id } },
    update: { role: 'viewer' },
    create: { id: newId(), orgId: input.orgId, userId: user.id, role: 'viewer' },
  })
}

async function main() {
  // ── Plan tiers must exist for effectiveLimits()/bootstrapOrg's planId
  //    lookup to resolve — reuse the same 'free' key seed.ts creates, but
  //    don't duplicate seed.ts's plan-seeding logic here; this script assumes
  //    the e2e database has already run the base `prisma migrate` + is fine
  //    with orgs having no plan (bootstrapOrg tolerates planId=null; overrides
  //    still apply per effectiveLimits' fallback-to-0 semantics).
  const freePlan = await prisma.plan.upsert({
    where: { key: 'free' },
    update: {},
    create: {
      id: newId(),
      key: 'free',
      name: 'Free',
      maxSeats: 3,
      maxFlags: 5,
      maxEventsPerMonth: 10_000n,
      maxFlagCallsPerMonth: 50_000n,
    },
  })
  await prisma.org.updateMany({
    where: {
      planId: null,
      slug: { in: [E2E_ORG_SLUG, E2E_LIMITED_ORG_SLUG, E2E_OVERAGE_ORG_SLUG] },
    },
    data: { planId: freePlan.id },
  })

  // ── `pro` plan — mirrors seed.ts's PLAN_SEEDS `pro` entry (not run in e2e).
  //    Required so `e2e-surveys` can resolve to a plan whose `surveys` feature
  //    is ON + ENFORCED (packages/db/src/plan-registry.ts) — the only way the
  //    real `surveys.create`/`surveys.update` entitlement gate lets seeding
  //    through. `e2e-surveys` is linked to this plan explicitly below (it is
  //    NOT in the free-plan updateMany above).
  const proPlan = await prisma.plan.upsert({
    where: { key: 'pro' },
    update: {},
    create: {
      id: newId(),
      key: 'pro',
      name: 'Pro',
      maxSeats: 20,
      maxFlags: 50,
      maxEventsPerMonth: 1_000_000n,
      maxFlagCallsPerMonth: 5_000_000n,
      allowsOverage: true,
    },
  })

  // ── Org 1: `e2e` — normal org for happy-path specs ───────────────────────
  const e2eOrg = await seedOrgAndProject({
    orgSlug: E2E_ORG_SLUG,
    orgName: E2E_ORG_NAME,
    userEmail: E2E_USER_EMAIL,
    userName: E2E_USER_NAME,
    password: E2E_PASSWORD,
    projectName: E2E_PROJECT_NAME,
  })
  const e2eWriteKey = await seedApiKey(
    e2eOrg.projectId,
    e2eOrg.productionEnvId,
    'write',
    E2E_WRITE_KEY_PLAINTEXT,
    'E2E write key',
  )
  const e2eReadKey = await seedApiKey(
    e2eOrg.projectId,
    e2eOrg.productionEnvId,
    'read',
    E2E_READ_KEY_PLAINTEXT,
    'E2E read key',
  )
  await seedViewerMembership({
    orgId: e2eOrg.orgId,
    userEmail: E2E_VIEWER_USER_EMAIL,
    userName: E2E_VIEWER_USER_NAME,
    password: E2E_VIEWER_PASSWORD,
  })

  // ── Org 2: `e2e-limited` — low maxEventsPerMonthOverride for over-limit specs ──
  const e2eLimitedOrg = await seedOrgAndProject({
    orgSlug: E2E_LIMITED_ORG_SLUG,
    orgName: E2E_LIMITED_ORG_NAME,
    userEmail: E2E_LIMITED_USER_EMAIL,
    userName: E2E_LIMITED_USER_NAME,
    password: E2E_LIMITED_PASSWORD,
    projectName: E2E_LIMITED_PROJECT_NAME,
  })
  await prisma.org.update({
    where: { id: e2eLimitedOrg.orgId },
    data: { maxEventsPerMonthOverride: E2E_LIMITED_MAX_EVENTS_PER_MONTH },
  })
  const e2eLimitedWriteKey = await seedApiKey(
    e2eLimitedOrg.projectId,
    e2eLimitedOrg.productionEnvId,
    'write',
    E2E_LIMITED_WRITE_KEY_PLAINTEXT,
    'E2E-LIMITED write key',
  )

  // ── Org 3: `e2e-overage` — dedicated org for overage-policy.spec.ts's live
  //    overagePolicy mutation (see module doc comment) ─────────────────────
  const e2eOverageOrg = await seedOrgAndProject({
    orgSlug: E2E_OVERAGE_ORG_SLUG,
    orgName: E2E_OVERAGE_ORG_NAME,
    userEmail: E2E_OVERAGE_USER_EMAIL,
    userName: E2E_OVERAGE_USER_NAME,
    password: E2E_OVERAGE_PASSWORD,
    projectName: E2E_OVERAGE_PROJECT_NAME,
  })
  await prisma.org.update({
    where: { id: e2eOverageOrg.orgId },
    data: { maxEventsPerMonthOverride: E2E_OVERAGE_MAX_EVENTS_PER_MONTH },
  })
  const e2eOverageWriteKey = await seedApiKey(
    e2eOverageOrg.projectId,
    e2eOverageOrg.productionEnvId,
    'write',
    E2E_OVERAGE_WRITE_KEY_PLAINTEXT,
    'E2E-OVERAGE write key',
  )

  // ── Org 4: `e2e-surveys` — on the `pro` plan so surveys-exposure.spec.ts can
  //    drive the real surveys.create/update tRPC path (surveys ON + ENFORCED) ─
  const e2eSurveysOrg = await seedOrgAndProject({
    orgSlug: E2E_SURVEYS_ORG_SLUG,
    orgName: E2E_SURVEYS_ORG_NAME,
    userEmail: E2E_SURVEYS_USER_EMAIL,
    userName: E2E_SURVEYS_USER_NAME,
    password: E2E_SURVEYS_PASSWORD,
    projectName: E2E_SURVEYS_PROJECT_NAME,
  })
  // Link to `pro` explicitly (bootstrapOrg leaves planId null, and the free
  // updateMany above deliberately excludes this org). Idempotent — sets the
  // planId on every re-seed regardless of prior value.
  await prisma.org.update({
    where: { id: e2eSurveysOrg.orgId },
    data: { planId: proPlan.id },
  })
  const e2eSurveysWriteKey = await seedApiKey(
    e2eSurveysOrg.projectId,
    e2eSurveysOrg.productionEnvId,
    'write',
    E2E_SURVEYS_WRITE_KEY_PLAINTEXT,
    'E2E-SURVEYS write key',
  )

  // ── Report ──────────────────────────────────────────────────────────────
  console.log('\n✓ e2e seed complete\n')
  console.log(`  org:        ${e2eOrg.orgSlug} (${e2eOrg.orgId})`)
  console.log(`  user:       ${e2eOrg.userEmail}  password: ${E2E_PASSWORD}`)
  console.log(`  project:    ${e2eOrg.projectName} (${e2eOrg.projectId})`)
  console.log(`  write key:  ${e2eWriteKey.token}`)
  console.log(`  read key:   ${e2eReadKey.token}`)
  console.log(
    `  viewer:     ${E2E_VIEWER_USER_EMAIL}  password: ${E2E_VIEWER_PASSWORD} (role: viewer)`,
  )
  console.log()
  console.log(`  org:        ${e2eLimitedOrg.orgSlug} (${e2eLimitedOrg.orgId})`)
  console.log(`  user:       ${e2eLimitedOrg.userEmail}  password: ${E2E_LIMITED_PASSWORD}`)
  console.log(`  project:    ${e2eLimitedOrg.projectName} (${e2eLimitedOrg.projectId})`)
  console.log(`  maxEventsPerMonthOverride: ${E2E_LIMITED_MAX_EVENTS_PER_MONTH}`)
  console.log(`  write key:  ${e2eLimitedWriteKey.token}`)
  console.log()
  console.log(`  org:        ${e2eOverageOrg.orgSlug} (${e2eOverageOrg.orgId})`)
  console.log(`  user:       ${e2eOverageOrg.userEmail}  password: ${E2E_OVERAGE_PASSWORD}`)
  console.log(`  project:    ${e2eOverageOrg.projectName} (${e2eOverageOrg.projectId})`)
  console.log(`  maxEventsPerMonthOverride: ${E2E_OVERAGE_MAX_EVENTS_PER_MONTH}`)
  console.log(`  write key:  ${e2eOverageWriteKey.token}`)
  console.log()
  console.log(`  org:        ${e2eSurveysOrg.orgSlug} (${e2eSurveysOrg.orgId})  plan: pro`)
  console.log(`  user:       ${e2eSurveysOrg.userEmail}  password: ${E2E_SURVEYS_PASSWORD}`)
  console.log(`  project:    ${e2eSurveysOrg.projectName} (${e2eSurveysOrg.projectId})`)
  console.log(`  write key:  ${e2eSurveysWriteKey.token}`)
  console.log()
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
