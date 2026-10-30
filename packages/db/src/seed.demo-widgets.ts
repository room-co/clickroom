/**
 * Seed 15 demo dashboard widgets (5 insight types × 3 density tiers) for the
 * project owned by `demo@clickroom.local`, so every widget rendering variant can be
 * visually validated on the Product-analytics Board.
 *
 * Idempotent: re-running reuses existing "Demo: <Type>" insights and skips
 * widgets that already exist for a given (insightId, w, h) combination.
 *
 * Run: `pnpm --filter @clickroom/db exec tsx src/seed.demo-widgets.ts`
 */
import { fileURLToPath } from 'node:url'
import type { Prisma } from '@prisma/client'

// Load the monorepo-root .env (two levels up) so DATABASE_URL is available even
// when a command doesn't export it, mirroring prisma.config.ts. `dotenv` isn't a
// direct dependency of this package, so use Node's built-in loader instead — it
// only sets vars that aren't already in process.env, matching dotenv's behavior.
try {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)))
} catch {
  // .env is optional (e.g. DATABASE_URL already exported in the environment).
}

// `import` statements are hoisted in ESM, so a static import of `./client.js`
// (which reads process.env.DATABASE_URL at module-init time) would run before
// the loadEnvFile() call above. Use a dynamic import to force ordering.
const { newId, prisma } = await import('./client.js')

const DEMO_USER_EMAIL = 'demo@clickroom.local'

type InsightType = 'trend' | 'users' | 'funnel' | 'retention' | 'breakdown'

interface InsightSeed {
  type: InsightType
  label: string
  config: Prisma.InputJsonValue
}

interface WidgetTierSpec {
  x: number
  y: number
  w: number
  h: number
}

/** Build the 5 demo insight specs (name + config) sharing a single 30-day range. */
function buildInsightSeeds(): InsightSeed[] {
  const range = {
    from: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    to: new Date().toISOString(),
  }

  return [
    {
      type: 'trend',
      label: 'Demo: Trend',
      config: { type: 'trend', event: '$pageview', interval: 'day', range },
    },
    {
      type: 'users',
      label: 'Demo: Active users',
      config: { type: 'users', window: 'week', range },
    },
    {
      type: 'funnel',
      label: 'Demo: Funnel',
      config: {
        type: 'funnel',
        steps: [
          { event: '$pageview', filters: [] },
          { event: 'click', filters: [] },
        ],
        window: 86_400,
        range,
      },
    },
    {
      type: 'retention',
      label: 'Demo: Retention',
      config: { type: 'retention', range },
    },
    {
      type: 'breakdown',
      label: 'Demo: Breakdown',
      config: { type: 'breakdown', dimension: 'referring_domain', event: '$pageview', range },
    },
  ]
}

/**
 * Resolve which project to seed into: prefer the user's project that already
 * has at least one non-deleted Insight (the "active" board), otherwise fall
 * back to the first project found across all of the user's memberships.
 */
async function resolveProject(userId: string) {
  const memberships = await prisma.orgMembership.findMany({
    where: { userId },
    select: { orgId: true },
  })
  if (memberships.length === 0) return null

  const orgIds = memberships.map((m) => m.orgId)
  const projects = await prisma.project.findMany({ where: { orgId: { in: orgIds } } })
  if (projects.length === 0) return null

  for (const project of projects) {
    const hasInsight = await prisma.insight.findFirst({
      where: { projectId: project.id, deletedAt: null },
      select: { id: true },
    })
    if (hasInsight) return project
  }

  return projects[0]
}

/** Find an existing "Demo: <Type>" insight for the project, or create it. */
async function ensureInsight(
  projectId: string,
  createdBy: string,
  seed: InsightSeed,
): Promise<{ id: string; created: boolean }> {
  const existing = await prisma.insight.findFirst({
    where: { projectId, deletedAt: null, name: seed.label },
    select: { id: true },
  })
  if (existing) return { id: existing.id, created: false }

  const insight = await prisma.insight.create({
    data: {
      id: newId(),
      projectId,
      name: seed.label,
      type: seed.type,
      config: seed.config,
      createdBy,
      tags: ['demo'],
    },
  })
  return { id: insight.id, created: true }
}

/** Create the widget for (insightId, x, y, w, h) unless one already exists with the same insight + size. */
async function ensureWidget(
  projectId: string,
  createdBy: string,
  insightId: string,
  spec: WidgetTierSpec,
): Promise<boolean> {
  const existing = await prisma.dashboardWidget.findFirst({
    where: { projectId, insightId, deletedAt: null, w: spec.w, h: spec.h },
    select: { id: true },
  })
  if (existing) return false

  await prisma.dashboardWidget.create({
    data: {
      id: newId(),
      projectId,
      insightId,
      x: spec.x,
      y: spec.y,
      w: spec.w,
      h: spec.h,
      createdBy,
    },
  })
  return true
}

/** Compute the 3 density-tier widget specs (compact/standard/detailed) for one insight's 2-row band. */
function widgetSpecsForBand(rowATop: number): WidgetTierSpec[] {
  const rowBTop = rowATop + 5
  return [
    { x: 0, y: rowATop, w: 3, h: 5 }, // compact
    { x: 3, y: rowATop, w: 5, h: 5 }, // standard
    { x: 0, y: rowBTop, w: 8, h: 6 }, // detailed
  ]
}

async function main() {
  const user = await prisma.user.findUnique({ where: { email: DEMO_USER_EMAIL } })
  if (!user) {
    console.error(`No user found with email ${DEMO_USER_EMAIL} — aborting, nothing seeded.`)
    process.exit(1)
    return
  }

  const project = await resolveProject(user.id)
  if (!project) {
    console.error(
      `User ${DEMO_USER_EMAIL} has no org membership with a project — aborting, nothing seeded.`,
    )
    process.exit(1)
    return
  }
  console.log(`Resolved project: ${project.name} (${project.id})`)

  // ── Ensure the 5 demo insights exist ─────────────────────────────────────
  const insightSeeds = buildInsightSeeds()
  const insightsByType = new Map<InsightType, string>()
  let insightsCreated = 0
  let insightsReused = 0

  for (const seed of insightSeeds) {
    const { id, created } = await ensureInsight(project.id, user.id, seed)
    insightsByType.set(seed.type, id)
    if (created) {
      insightsCreated += 1
    } else {
      insightsReused += 1
    }
    console.log(`  insight ${seed.label}: ${created ? 'created' : 'reused'} (${id})`)
  }

  // ── Compute baseY strictly below existing widgets ────────────────────────
  const existingWidgets = await prisma.dashboardWidget.findMany({
    where: { projectId: project.id, deletedAt: null },
    select: { y: true, h: true },
  })
  const baseY = existingWidgets.reduce((max, w) => Math.max(max, w.y + w.h), 0)
  console.log(`Base Y offset for new widgets: ${baseY}`)

  // ── Create the 15 widgets (5 insights × 3 density tiers), skipping dupes ─
  let widgetsCreated = 0
  let widgetsSkipped = 0

  for (const [i, seed] of insightSeeds.entries()) {
    const insightId = insightsByType.get(seed.type)
    if (!insightId) continue

    const rowATop = baseY + i * 11
    const specs = widgetSpecsForBand(rowATop)

    for (const spec of specs) {
      const created = await ensureWidget(project.id, user.id, insightId, spec)
      if (created) {
        widgetsCreated += 1
      } else {
        widgetsSkipped += 1
      }
      console.log(
        `  widget ${seed.type} (${spec.w}x${spec.h}) @ (${spec.x},${spec.y}): ${
          created ? 'created' : 'skipped (exists)'
        }`,
      )
    }
  }

  console.log('\n✓ Seed summary')
  console.log(`  insights: ${insightsCreated} created, ${insightsReused} reused`)
  console.log(`  widgets:  ${widgetsCreated} created, ${widgetsSkipped} skipped`)
  console.log(`  total widgets touched: ${widgetsCreated + widgetsSkipped}`)
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
