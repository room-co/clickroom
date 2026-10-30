// Backfill a survey's linked FeatureFlag into EVERY project environment.
//
// A survey means "show to everyone", so its linked boolean flag must exist —
// and track the survey's active state — in every environment. Historically the
// survey router created the flag in ONE environment only (the project default),
// so surveys were never eligible for SDKs pointed at any other environment
// (capture's `/v1/flags` resolves flags per-environment by key). This script
// repairs existing data: for every non-deleted Survey it ensures a flag row per
// environment sharing the survey's linked key, with `active` matching the
// survey's status.
//
// Idempotent: creates only the missing env rows and only corrects `active`
// where it drifts. It does NOT rebuild the Redis flag cache — the caller must
// (e.g. re-save each survey, or run the cache-rebuild path) after this runs.
//
// Run:  DATABASE_URL=postgres://... node scripts/backfill-survey-flags.mjs
// (@clickroom/db resolves DATABASE_URL from env just like the seeds; build the
//  db package first if its dist is stale: `pnpm --filter @clickroom/db build`.)

import { newId, prisma } from '@clickroom/db'

// One always-eligible boolean group: 100% rollout, no property filters — matches
// SURVEY_FLAG_FILTERS in packages/trpc-router/src/trpc/routers/surveys.router.ts.
const SURVEY_FLAG_FILTERS = {
  groups: [{ properties: [], rollout_percentage: 100, variant: null }],
  kind: 'boolean',
}

async function main() {
  const surveys = await prisma.survey.findMany({ where: { deletedAt: null } })
  console.log(`Scanning ${surveys.length} non-deleted survey(s)…`)

  let created = 0
  let updated = 0
  let skipped = 0

  for (const survey of surveys) {
    // Resolve the linked flag's key from the survey's stored featureFlagId.
    const linkedFlag = await prisma.featureFlag.findFirst({
      where: { id: survey.featureFlagId, deletedAt: null },
      select: { key: true, name: true },
    })
    if (!linkedFlag) {
      console.warn(
        `  ! survey ${survey.id} ("${survey.name}") has no live linked flag (featureFlagId=${survey.featureFlagId}) — skipping`,
      )
      skipped++
      continue
    }

    const desiredActive = survey.status === 'active'
    const environments = await prisma.environment.findMany({
      where: { projectId: survey.projectId },
    })
    const existingRows = await prisma.featureFlag.findMany({
      where: { projectId: survey.projectId, key: linkedFlag.key, deletedAt: null },
    })
    const byEnvId = new Map(existingRows.map((r) => [r.environmentId, r]))

    for (const env of environments) {
      const row = byEnvId.get(env.id)
      if (!row) {
        await prisma.featureFlag.create({
          data: {
            id: newId(),
            projectId: survey.projectId,
            key: linkedFlag.key,
            name: linkedFlag.name ?? `${survey.name} (survey)`,
            active: desiredActive,
            track: false,
            environmentId: env.id,
            filters: SURVEY_FLAG_FILTERS,
          },
        })
        created++
        console.log(
          `  + created flag "${linkedFlag.key}" in env "${env.key}" (active=${desiredActive}) for survey "${survey.name}"`,
        )
      } else if (row.active !== desiredActive) {
        await prisma.featureFlag.update({
          where: { id: row.id },
          data: { active: desiredActive, version: { increment: 1 } },
        })
        updated++
        console.log(
          `  ~ corrected flag "${linkedFlag.key}" in env "${env.key}" active ${row.active} -> ${desiredActive} for survey "${survey.name}"`,
        )
      }
    }
  }

  console.log(
    `\nDone. Created ${created} flag row(s), corrected ${updated}, skipped ${skipped} survey(s).`,
  )
  if (created > 0 || updated > 0) {
    console.log('Remember to rebuild the Redis flag cache for affected projects/environments.')
  }
}

main()
  .then(async () => {
    await prisma.$disconnect()
  })
  .catch(async (err) => {
    console.error(err)
    await prisma.$disconnect()
    process.exitCode = 1
  })
