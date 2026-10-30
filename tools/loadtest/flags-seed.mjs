#!/usr/bin/env node
// Seed / teardown helper for the feature-flag load test (flags-run.sh + flags-load.js).
//
// `setup`  — creates a dedicated throwaway bench PROJECT under the first Org, mints a
//            fixed write + read key, inserts 3 representative flags (boolean %, multivariate,
//            property-targeted), and writes the Redis `flags:def:<pid>` blob EXACTLY as the
//            Control plane would so capture-rs
//            serves them from cache off the Postgres hot path. Prints env for the runner.
// `teardown` — deletes the bench project's flags + keys + project row and drops its Redis blob.
//
// Isolated to a bench project so the load test never pollutes a real project's flag list.
// Pure Node ESM, deps resolved from the workspace store (pg + ioredis), matching e2e conventions.

import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const ROOT = new URL('../../', import.meta.url).pathname
const require = createRequire(`${ROOT}apps/api/`)
const pgPath = require.resolve('pg', { paths: [`${ROOT}apps/api`, `${ROOT}packages/db`, ROOT] })
const redisPath = require.resolve('ioredis', { paths: [`${ROOT}apps/api`, ROOT] })
const { Client } = require(pgPath)
const Redis = require(redisPath)

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://clickroom:clickroom@localhost:5433/clickroom'
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380'
const WRITE_TOKEN = process.env.TOKEN ?? 'ckw_live_flagloadtest0000000000000000'
const READ_TOKEN = process.env.READ_TOKEN ?? 'ckr_live_flagloadtest0000000000000000'
const PROJECT_ID = '01FLAGLOADTESTPROJECT000000'
const PROJECT_NAME = '[loadtest] flag-eval bench'

const sha256 = (t) => createHash('sha256').update(t).digest('hex')
const mode = process.argv[2]
const envOut = (() => {
  const i = process.argv.indexOf('--env-out')
  return i >= 0 ? process.argv[i + 1] : null
})()

// The flags under load. Each exercises a distinct eval path.
const FLAGS = [
  {
    key: 'lt-boolean-50',
    name: 'loadtest boolean 50%',
    active: true,
    filters: { groups: [{ properties: [], rollout_percentage: 50, variant: null }] },
  },
  {
    key: 'lt-multivariate',
    name: 'loadtest multivariate',
    active: true,
    filters: {
      groups: [{ properties: [], rollout_percentage: 100, variant: null }],
      multivariate: {
        variants: [
          { key: 'control', rollout_percentage: 34 },
          { key: 'test', rollout_percentage: 33 },
          { key: 'holdout', rollout_percentage: 33 },
        ],
      },
      payloads: { control: { c: 'blue' }, test: { c: 'green' }, holdout: { c: 'gray' } },
    },
  },
  {
    key: 'lt-targeted-pro',
    name: 'loadtest targeted plan=pro',
    active: true,
    filters: {
      groups: [
        {
          properties: [{ key: 'plan', operator: 'exact', value: 'pro' }],
          rollout_percentage: 100,
          variant: null,
        },
      ],
    },
  },
]

async function buildBlob(pg) {
  const r = await pg.query(
    `SELECT key, active, filters, version FROM "FeatureFlag" WHERE "projectId"=$1 AND "deletedAt" IS NULL`,
    [PROJECT_ID],
  )
  const flags = r.rows.map((f) => ({
    key: f.key,
    active: f.active,
    filters: f.filters,
    version: f.version,
  }))
  const version = flags.reduce((s, f) => s + f.version, 0)
  return { version, flags }
}

async function setup(pg, redis) {
  const org = await pg.query(`SELECT id FROM "Org" ORDER BY "createdAt" ASC LIMIT 1`)
  if (!org.rows.length) throw new Error('no Org in Postgres — seed the control plane first')
  const orgId = org.rows[0].id

  await pg.query(
    `INSERT INTO "Project"(id,"orgId",name,"createdAt","updatedAt") VALUES($1,$2,$3,now(),now())
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name`,
    [PROJECT_ID, orgId, PROJECT_NAME],
  )

  const mintKey = async (token, type) => {
    await pg.query(
      `INSERT INTO "ApiKey"(id,"projectId","keyHash","keyPrefix",type,scopes,env,label,"createdAt")
       VALUES($1,$2,$3,$4,$5::"ApiKeyType",'{}','production'::"ApiKeyEnv",$6,now())
       ON CONFLICT ("keyHash") DO NOTHING`,
      [
        `flkey_${type}_${randomUUID().replace(/-/g, '')}`,
        PROJECT_ID,
        sha256(token),
        token.slice(0, 16),
        type,
        'flag-loadtest',
      ],
    )
  }
  await mintKey(WRITE_TOKEN, 'write')
  await mintKey(READ_TOKEN, 'read')

  for (const f of FLAGS) {
    await pg.query(
      `INSERT INTO "FeatureFlag"(id,"projectId",key,name,active,filters,version,"createdAt","updatedAt")
       VALUES($1,$2,$3,$4,$5,$6::jsonb,1,now(),now())
       ON CONFLICT ("projectId",key) DO UPDATE SET filters=EXCLUDED.filters, active=EXCLUDED.active, "version"="FeatureFlag".version+1, "updatedAt"=now(), "deletedAt"=NULL`,
      [
        `flag_${randomUUID().replace(/-/g, '')}`,
        PROJECT_ID,
        f.key,
        f.name,
        f.active,
        JSON.stringify(f.filters),
      ],
    )
  }

  const blob = await buildBlob(pg)
  await redis.set(`flags:def:${PROJECT_ID}`, JSON.stringify(blob), 'EX', 86400)

  const env = [
    `TOKEN=${WRITE_TOKEN}`,
    `READ_TOKEN=${READ_TOKEN}`,
    `PROJECT_ID=${PROJECT_ID}`,
    `FLAG_KEYS=${FLAGS.map((f) => f.key).join(',')}`,
  ].join('\n')
  if (envOut) writeFileSync(envOut, `${env}\n`)
  console.log(
    `seeded project=${PROJECT_ID} flags=${FLAGS.length} blob.version=${blob.version} (write+read keys minted)`,
  )
  console.error(env) // stderr so shell can `eval` if desired without mixing with stdout log
}

async function teardown(pg, redis) {
  await pg.query(`DELETE FROM "FeatureFlag" WHERE "projectId"=$1`, [PROJECT_ID])
  await pg.query(`DELETE FROM "ApiKey" WHERE "projectId"=$1`, [PROJECT_ID])
  await pg.query(`DELETE FROM "Project" WHERE id=$1`, [PROJECT_ID])
  await redis.del(`flags:def:${PROJECT_ID}`)
  console.log(`teardown: removed bench project ${PROJECT_ID} (flags + keys + redis blob)`)
}

const pg = new Client({ connectionString: DATABASE_URL })
const redis = new Redis(REDIS_URL)
try {
  await pg.connect()
  if (mode === 'setup') await setup(pg, redis)
  else if (mode === 'teardown') await teardown(pg, redis)
  else {
    console.error('usage: flags-seed.mjs <setup|teardown> [--env-out FILE]')
    process.exitCode = 2
  }
} catch (e) {
  console.error('flags-seed ERROR', e)
  process.exitCode = 1
} finally {
  await pg.end()
  redis.disconnect()
}
