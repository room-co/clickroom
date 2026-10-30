import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId, prisma } from '../client.js'

// ---------------------------------------------------------------------------
// — `FeatureFlag.track` column + backfill.
//
// The migration (20260715000000_add_feature_flag_track) adds `track` defaulting
// to false and backfills `track = true` for every flag referenced by an
// experiment, joining Experiment."featureFlagId" -> FeatureFlag."id". This test
// proves both halves against the live test Postgres (TEST_DATABASE_URL):
//   - a plain flag defaults to track = false
//   - a flag an experiment links to gets track = true after the backfill JOIN
//
// Skips gracefully when the DB is unreachable, matching scoped-client.test.ts /
// seed.plans.test.ts.
// ---------------------------------------------------------------------------

let dbUp = false
const orgId = newId()
const projectId = newId()
const envId = newId()
const plainFlagId = newId()
const expFlagId = newId()
const experimentId = newId()

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`
    dbUp = true
  } catch {
    dbUp = false
    return
  }

  await prisma.org.create({
    data: { id: orgId, name: `Track ${orgId}`, slug: `track-${orgId.toLowerCase()}` },
  })
  await prisma.project.create({
    data: { id: projectId, orgId, name: 'Track test project' },
  })
  await prisma.environment.create({
    data: { id: envId, projectId, key: 'production', name: 'Production' },
  })

  // Two flags: one plain (operational gate), one that an experiment references.
  await prisma.featureFlag.create({
    data: { id: plainFlagId, projectId, key: 'plain-gate', environmentId: envId, filters: {} },
  })
  await prisma.featureFlag.create({
    data: { id: expFlagId, projectId, key: 'exp-flag', environmentId: envId, filters: {} },
  })
  await prisma.experiment.create({
    data: {
      id: experimentId,
      projectId,
      name: 'Track test experiment',
      featureFlagId: expFlagId,
      status: 'running',
      variants: [{ key: 'control', rolloutPercentage: 50 }],
      primaryMetric: {},
      secondaryMetrics: [],
      createdBy: 'test',
    },
  })
})

afterAll(async () => {
  try {
    if (dbUp) {
      await prisma.experiment.deleteMany({ where: { projectId } })
      await prisma.featureFlag.deleteMany({ where: { projectId } })
      await prisma.environment.deleteMany({ where: { projectId } })
      await prisma.project.deleteMany({ where: { id: projectId } })
      await prisma.org.deleteMany({ where: { id: orgId } })
    }
    await prisma.$disconnect()
  } catch {
    // ignore — DB may never have connected
  }
})

describe('FeatureFlag.track column + experiment backfill (live DB)', () => {
  it('a plain flag defaults to track = false', async () => {
    if (!dbUp) return
    const plain = await prisma.featureFlag.findUniqueOrThrow({ where: { id: plainFlagId } })
    expect(plain.track).toBe(false)
  })

  it('backfill sets track = true only for experiment-linked flags', async () => {
    if (!dbUp) return

    // Re-run the migration's backfill statement against the fixtures created
    // after the migration ran. Verifies the Experiment -> FeatureFlag JOIN.
    await prisma.$executeRawUnsafe(`
      UPDATE "FeatureFlag" AS f
      SET "track" = true
      FROM "Experiment" AS e
      WHERE e."featureFlagId" = f."id"
    `)

    const [plain, exp] = await Promise.all([
      prisma.featureFlag.findUniqueOrThrow({ where: { id: plainFlagId } }),
      prisma.featureFlag.findUniqueOrThrow({ where: { id: expFlagId } }),
    ])

    expect(exp.track).toBe(true)
    expect(plain.track).toBe(false)
  })
})
