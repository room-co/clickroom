/**
 * Seed Clickroom's own internal "dogfood" org + project + write key.
 *
 * Mirrors seed.e2e.ts's shape (bootstrapOrg for org/membership/environments/
 * system taxonomy, @clickroom/auth for API key hashing, ApiKey.upsert by
 * `keyHash` for idempotent re-seeds) but provisions ONE org that Clickroom's
 * own `apps/web` build instruments itself with, not a suite of test fixtures.
 *
 * Two envs, one code path (`seedDogfoodOrg`), only the key strategy differs:
 *   - Dev:  org slug `clickroom-dev` / name "Clickroom", mode `'fixed'` — a
 *     deterministic fixed-plaintext write key so `make up`'s dev build always
 *     has a working `VITE_CLICKROOM_WRITE_KEY` out of the box. Safe to commit
 *     since it only ever points at a local/dev database.
 *   - Prod: org slug `clickroom`, mode `'generate'` — calls `generateApiKey
 *     ('write')` for a random key, prints it once to stdout, never persists
 *     the plaintext anywhere in the repo. Run this manually, once, against
 *     prod (`DOGFOOD_MODE=generate pnpm --filter @clickroom/db seed:dogfood`)
 *     and paste the printed token into the prod web deploy's
 *     `VITE_CLICKROOM_WRITE_KEY` env var. NOT wired into the default dev seed
 *     flow.
 *
 * Both branches reuse `bootstrapOrg` (org/admin membership/Default project/
 * Environments/system taxonomy/free plan) unchanged, then rename the
 * bootstrap-created "Default" project to "Platform" and upsert one admin user
 * by email — same idempotent pattern as seed.e2e.ts's `seedOrgAndProject`.
 *
 * Run: `pnpm --filter @clickroom/db seed:dogfood` (dev, `fixed` mode, default).
 */
import { generateApiKey, hashApiKey } from '@clickroom/auth'
import { hash } from '@node-rs/argon2'
import type { Prisma } from '@prisma/client'
import { bootstrapOrg } from './bootstrap.js'
import { newId, prisma } from './client.js'
import { assertFixedModeAllowed } from './dogfood-mode.js'
import { type DogfoodPassword, resolveDogfoodPassword } from './dogfood-password.js'

export type DogfoodMode = 'fixed' | 'generate'

const DOGFOOD_PROJECT_NAME = 'Platform'

interface DogfoodFunnelStep {
  event: string
  alias?: string
}
interface DogfoodFunnelDef {
  name: string
  window: number
  steps: DogfoodFunnelStep[]
}

const DOGFOOD_FUNNELS: DogfoodFunnelDef[] = [
  {
    name: 'Activation: Signup → Project → First Flag',
    window: 2_592_000, // 30d
    steps: [{ event: 'signup_completed' }, { event: 'project_created' }, { event: 'flag_created' }],
  },
  {
    name: 'Experiment Lifecycle: Create → Launch → Stop',
    window: 1_209_600, // 14d
    steps: [
      { event: 'experiment_created' },
      { event: 'experiment_launched' },
      { event: 'experiment_stopped' },
    ],
  },
  {
    name: 'Insight Adoption: Create → View → Add to Dashboard',
    window: 604_800, // 7d
    steps: [
      { event: 'insight_created' },
      { event: 'insight_viewed' },
      { event: 'dashboard_widget_added' },
    ],
  },
  {
    name: 'Segment Adoption: Create → Materialize',
    window: 604_800, // 7d
    steps: [{ event: 'segment_created' }, { event: 'segment_materialized' }],
  },
]

const DOGFOOD_DEV_ORG_SLUG = 'clickroom-dev'
const DOGFOOD_DEV_ORG_NAME = 'Clickroom'
const DOGFOOD_PROD_ORG_SLUG = 'clickroom'
const DOGFOOD_PROD_ORG_NAME = 'Clickroom'

// Admin identity. The email/name defaults are harmless. The password has NO committed
// default in any mode: it comes from DOGFOOD_ADMIN_PASSWORD or is generated and printed once
// (see ./dogfood-password.ts). Real deployments should supply it from SSM / a secret store.
const DOGFOOD_ADMIN_EMAIL = process.env.DOGFOOD_ADMIN_EMAIL ?? 'dogfood@clickroom.co'
const DOGFOOD_ADMIN_NAME = process.env.DOGFOOD_ADMIN_NAME ?? 'Clickroom Dogfood Admin'

// Fixed dev-only write key — deterministic so re-seeding a local/dev database
// never rotates it. Never used against prod; the `generate` mode below is the
// only path allowed there. Follows the same `ckw_live_<hex>` shape
// `generateApiKey('write')` produces (see packages/auth/src/apikey.ts).
const DOGFOOD_DEV_WRITE_KEY_PLAINTEXT = 'ckw_live_dogfooddev00000000000000000000000000000000'

/** Full secret shown once; never persisted (single source of truth in @clickroom/auth). */
type GeneratedKey = { token: string; keyHash: string; keyPrefix: string }

interface DogfoodOrgResult {
  orgId: string
  orgSlug: string
  projectId: string
  projectName: string
  productionEnvId: string
  adminEmail: string
  /** Plaintext only when generated for a newly created admin (print once); otherwise null. */
  generatedAdminPassword: string | null
  adminCreated: boolean
  writeKey: GeneratedKey
  funnelCount: number
  funnelNames: string[]
}

/**
 * Upsert the dogfood admin user, bootstrap the org if absent (matching
 * signup/seed.ts's shape via the shared `bootstrapOrg` helper), then rename
 * the bootstrap-created "Default" project to "Platform" (bootstrapOrg doesn't
 * take a project name param — it's shared with the signup flow).
 */
async function seedDogfoodOrgAndProject(
  orgSlug: string,
  orgName: string,
  adminPassword: DogfoodPassword,
): Promise<Omit<DogfoodOrgResult, 'writeKey' | 'funnelCount' | 'funnelNames'>> {
  const passwordHash = await hash(adminPassword.password)
  const existing = await prisma.user.findUnique({ where: { email: DOGFOOD_ADMIN_EMAIL } })
  const user = await prisma.user.upsert({
    where: { email: DOGFOOD_ADMIN_EMAIL },
    update: {},
    create: {
      id: newId(),
      email: DOGFOOD_ADMIN_EMAIL,
      name: DOGFOOD_ADMIN_NAME,
      passwordHash,
    },
  })

  let org = await prisma.org.findUnique({ where: { slug: orgSlug } })
  if (!org) {
    const result = await prisma.$transaction((tx) =>
      bootstrapOrg(tx, { orgName, slug: orgSlug, userId: user.id }),
    )
    org = await prisma.org.findUniqueOrThrow({ where: { id: result.org.id } })
  }

  // bootstrapOrg attaches the `free` plan by default — the dogfood org is
  // Clickroom's own dashboard traffic, not a real tenant subject to plan
  // limits, so pin it to `enterprise` (no true "unlimited" sentinel exists;
  // NOT NULL columns use enterprise's very-large-but-finite maxima instead —
  // see PLAN_SEEDS in seed.ts). Idempotent: no-ops once already pinned.
  // Throw rather than skip: an absent `enterprise` plan means the Plan table was
  // never seeded, which leaves planId NULL and makes capture's quota check fail
  // closed to a limit of 0 (every event -> 402). Silently no-op'ing here is what
  // hid exactly that on the first prod deploy. Run `seed:plans` first.
  const enterprisePlan = await prisma.plan.findUnique({ where: { key: 'enterprise' } })
  if (!enterprisePlan) {
    throw new Error(
      'no `enterprise` plan found — the Plan table is unseeded. Run `pnpm --filter @clickroom/db seed:plans` against this database first.',
    )
  }
  if (org.planId !== enterprisePlan.id) {
    org = await prisma.org.update({ where: { id: org.id }, data: { planId: enterprisePlan.id } })
  }

  let project = await prisma.project.findFirstOrThrow({
    where: { orgId: org.id },
  })
  if (project.name !== DOGFOOD_PROJECT_NAME) {
    project = await prisma.project.update({
      where: { id: project.id },
      data: { name: DOGFOOD_PROJECT_NAME },
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
    adminEmail: user.email,
    adminCreated: !existing,
    generatedAdminPassword: !existing && adminPassword.generated ? adminPassword.password : null,
  }
}

/**
 * Upsert an ApiKey by `keyHash` (not `id`) so re-running the seed against a
 * fixed-plaintext key never hits the unique constraint on `keyHash`.
 */
async function upsertWriteKey(
  projectId: string,
  environmentId: string,
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
      type: 'write',
      environmentId,
      label,
    },
  })
  return { token: plaintext, keyHash, keyPrefix }
}

/**
 * Idempotent find-or-create of a dogfood Funnel by `(projectId, name)` — the
 * `Funnel` table has no unique constraint on name, so query first (matching
 * seed.demo-widgets.ts's `ensureInsight` pattern). Re-seeding with an edited
 * registry entry updates `window`/`steps` in place rather than duplicating.
 */
async function upsertDogfoodFunnel(projectId: string, def: DogfoodFunnelDef): Promise<void> {
  const steps = def.steps.map((s) => ({
    event: s.event,
    ...(s.alias ? { alias: s.alias } : {}),
    filters: [],
  })) as unknown as Prisma.InputJsonValue

  const existing = await prisma.funnel.findFirst({
    where: { projectId, name: def.name, deletedAt: null },
  })
  if (existing) {
    await prisma.funnel.update({ where: { id: existing.id }, data: { window: def.window, steps } })
  } else {
    await prisma.funnel.create({
      data: { id: newId(), projectId, name: def.name, window: def.window, steps },
    })
  }
}

/**
 * Provision Clickroom's own internal dogfood org/project/write-key. One code
 * path serves both dev and prod — only the key-generation strategy differs:
 *   - `'fixed'`  → deterministic plaintext, safe to re-seed (dev).
 *   - `'generate'` → random `generateApiKey('write')` token, printed once,
 *     never persisted as plaintext anywhere (prod, run manually).
 */
export async function seedDogfoodOrg(
  mode: DogfoodMode,
  adminPassword: DogfoodPassword = resolveDogfoodPassword(),
): Promise<DogfoodOrgResult> {
  assertFixedModeAllowed(mode)
  const orgSlug = mode === 'fixed' ? DOGFOOD_DEV_ORG_SLUG : DOGFOOD_PROD_ORG_SLUG
  const orgName = mode === 'fixed' ? DOGFOOD_DEV_ORG_NAME : DOGFOOD_PROD_ORG_NAME

  const orgAndProject = await seedDogfoodOrgAndProject(orgSlug, orgName, adminPassword)

  // Seed Clickroom's own key-flow funnels into this project — applies to
  // both modes so a manual prod run provisions them too (
  // follow-up plan: seed dogfood funnels).
  for (const def of DOGFOOD_FUNNELS) {
    await upsertDogfoodFunnel(orgAndProject.projectId, def)
  }

  let writeKey: GeneratedKey
  if (mode === 'fixed') {
    writeKey = await upsertWriteKey(
      orgAndProject.projectId,
      orgAndProject.productionEnvId,
      DOGFOOD_DEV_WRITE_KEY_PLAINTEXT,
      'Dogfood write key (dev, fixed)',
    )
  } else {
    // Prod path: only generate+attach a new key if this project has no write
    // key yet — re-running against prod must never rotate/replace the key
    // the live web deploy is already configured with.
    const existing = await prisma.apiKey.findFirst({
      where: { projectId: orgAndProject.projectId, type: 'write' },
    })
    if (existing) {
      writeKey = { token: '', keyHash: existing.keyHash, keyPrefix: existing.keyPrefix }
    } else {
      const generated = generateApiKey('write')
      await prisma.apiKey.create({
        data: {
          id: newId(),
          projectId: orgAndProject.projectId,
          keyHash: generated.keyHash,
          keyPrefix: generated.keyPrefix,
          type: 'write',
          environmentId: orgAndProject.productionEnvId,
          label: 'Dogfood write key (prod, generated)',
        },
      })
      writeKey = generated
    }
  }

  return {
    ...orgAndProject,
    writeKey,
    funnelCount: DOGFOOD_FUNNELS.length,
    funnelNames: DOGFOOD_FUNNELS.map((f) => f.name),
  }
}

function printReport(mode: DogfoodMode, result: DogfoodOrgResult) {
  console.log(`\n✓ dogfood seed complete (mode: ${mode})\n`)
  console.log(`  org:        ${result.orgSlug} (${result.orgId})`)
  console.log(`  project:    ${result.projectName} (${result.projectId})`)
  // A generated password is shown exactly once, here; a supplied one is never echoed.
  const shownPassword = result.generatedAdminPassword
    ? `${result.generatedAdminPassword}  (generated — shown once, store it now)`
    : result.adminCreated
      ? '<from DOGFOOD_ADMIN_PASSWORD>'
      : '<unchanged — admin already existed>'
  console.log(`  admin:      ${result.adminEmail}  password: ${shownPassword}`)
  console.log(`  funnels:    ${result.funnelCount} (${result.funnelNames.join(', ')})`)
  if (result.writeKey.token) {
    console.log('\n  ─────────────────────────────────────────────────────────')
    console.log('  WRITE API KEY (shown once — copy it now, it is not stored):')
    console.log(`  ${result.writeKey.token}`)
    console.log('  ─────────────────────────────────────────────────────────')
    console.log('  Set this as VITE_CLICKROOM_WRITE_KEY in the corresponding web build env.\n')
  } else {
    console.log(
      '\n  (write key already exists — plaintext not recoverable; rotate to reveal a new one)\n',
    )
  }
}

async function main() {
  // Dev seed runs by default (`pnpm --filter @clickroom/db seed:dogfood`) so
  // local/dev builds always have a working dogfood write key out of the box.
  // The prod `generate` path is opt-in via DOGFOOD_MODE=generate — run once,
  // manually, against a prod DATABASE_URL. Never wired into the default dev
  // flow (see module doc comment / task.
  const mode: DogfoodMode = process.env.DOGFOOD_MODE === 'generate' ? 'generate' : 'fixed'
  const result = await seedDogfoodOrg(mode, resolveDogfoodPassword())
  printReport(mode, result)
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
