#!/usr/bin/env node
// Seed / teardown helper for schema-enforcement load testing (pump.mjs's
// --schema-pct traffic mix).
//
// `setup`    — resolves the project owning a given write key (same key you
//              already pass to pump.mjs/capture-load.js/run.sh via --key/TOKEN),
//              registers a `strict` event (`checkout_completed`, requiring
//              `order_id: String` + `amount: Numeric`) and a `warn` event
//              (`signup_started`, requiring `plan: String`), then writes the
//              `capture:schema:<project_id>` Redis blob EXACTLY as
//              apps/api's taxonomy.router.ts `syncSchemaCache` would (see
//              services/capture/src/schema.rs's doc comment for the wire
//              shape) so capture-rs enforces it without going through tRPC.
// `teardown` — removes only the two event names this script added from the
//              EventDefinition/PropertyDefinition/EventProperty tables and
//              from the Redis blob (never touches other events/schemas a
//              real project may already have configured).
//
// This mirrors flags-seed.mjs's approach: direct-to-Postgres/Redis, no tRPC
// client, no HTTP auth session — the taxonomy router requires a logged-in
// session (`requirePermission` + `scopedForProject`), which is unnecessary
// ceremony for a load-test seed script that already knows its project id via
// the write key it's handed. Pure Node ESM, deps resolved from the workspace
// store (pg + ioredis), same as flags-seed.mjs.
//
//   node tools/loadtest/schema-seed.mjs setup --key ckw_live_xxx
//   node tools/loadtest/schema-seed.mjs teardown --key ckw_live_xxx

import { createHash } from 'node:crypto'
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

const sha256 = (t) => createHash('sha256').update(t).digest('hex')

const parseArgs = (argv) => {
  const out = { mode: argv[0], key: process.env.TOKEN ?? null, projectId: null }
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--key') out.key = argv[++i]
    else if (argv[i] === '--project-id') out.projectId = argv[++i]
  }
  return out
}

// The two events under enforcement. Everything else load-tested (`$pageview`,
// `$autocapture`, `product_viewed`, `signup_completed`, `subscription_purchased`,
// misc events, ...) stays `enforcementMode: none` — unchanged baseline.
export const CHECKOUT_EVENT = 'checkout_completed'
export const SIGNUP_EVENT = 'signup_started'

const SCHEMA_DEFS = [
  {
    event: CHECKOUT_EVENT,
    mode: 'strict',
    properties: [
      { name: 'order_id', type: 'String', required: true },
      { name: 'amount', type: 'Numeric', required: true },
    ],
  },
  {
    event: SIGNUP_EVENT,
    mode: 'warn',
    properties: [{ name: 'plan', type: 'String', required: true }],
  },
]

async function resolveProjectId(pg, opts) {
  if (opts.projectId) return opts.projectId
  if (!opts.key) throw new Error('--key <writeKey> or --project-id <id> is required')
  const r = await pg.query('SELECT "projectId" FROM "ApiKey" WHERE "keyHash"=$1', [
    sha256(opts.key),
  ])
  if (!r.rows.length) {
    throw new Error(
      `no ApiKey found for --key (is it registered? run.sh/pump.mjs's own seed, or db seed, must create it first)`,
    )
  }
  return r.rows[0].projectId
}

const newId = () =>
  `sch_${createHash('sha1').update(`${Date.now()}${Math.random()}`).digest('hex').slice(0, 24)}`

async function upsertEventAndSchema(pg, projectId, def) {
  await pg.query(
    `INSERT INTO "EventDefinition"(id,"projectId",name,"enforcementMode","createdAt","updatedAt")
     VALUES($1,$2,$3,$4::"EnforcementMode",now(),now())
     ON CONFLICT ("projectId","name") DO UPDATE SET "enforcementMode"=EXCLUDED."enforcementMode", "updatedAt"=now()`,
    [newId(), projectId, def.event, def.mode],
  )
  for (const prop of def.properties) {
    await pg.query(
      `INSERT INTO "PropertyDefinition"(id,"projectId",name,scope,"propertyType","typeLocked","createdAt","updatedAt")
       VALUES($1,$2,$3,'event'::"PropertyScope",$4::"PropertyType",true,now(),now())
       ON CONFLICT ("projectId","name","scope") DO UPDATE SET "propertyType"=EXCLUDED."propertyType", "typeLocked"=true, "updatedAt"=now()`,
      [newId(), projectId, prop.name, prop.type],
    )
    await pg.query(
      `INSERT INTO "EventProperty"(id,"projectId","eventName","propertyName",required)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT ("projectId","eventName","propertyName") DO UPDATE SET required=EXCLUDED.required`,
      [newId(), projectId, def.event, prop.name, prop.required],
    )
  }
}

async function removeEventAndSchema(pg, projectId, def) {
  await pg.query(`DELETE FROM "EventProperty" WHERE "projectId"=$1 AND "eventName"=$2`, [
    projectId,
    def.event,
  ])
  await pg.query(`DELETE FROM "EventDefinition" WHERE "projectId"=$1 AND name=$2`, [
    projectId,
    def.event,
  ])
  // Property rows (order_id/amount/plan) are left in place — they may be
  // shared/observed by other events too, and PropertyDefinition rows are
  // harmless taxonomy metadata on their own (no enforcement effect without
  // an EventProperty link).
}

// Rebuilds `capture:schema:<project_id>` from whatever EventDefinition rows
// (with enforcementMode != 'none') + EventProperty + PropertyDefinition rows
// currently exist for the project — same shape apps/api's syncSchemaCache
// writes, so this never clobbers schemas this script didn't create.
async function syncSchemaCache(pg, redis, projectId) {
  const events = await pg.query(
    `SELECT name, "enforcementMode" FROM "EventDefinition" WHERE "projectId"=$1 AND "enforcementMode" != 'none'`,
    [projectId],
  )
  const links = await pg.query(
    `SELECT "eventName", "propertyName", required FROM "EventProperty" WHERE "projectId"=$1`,
    [projectId],
  )
  const props = await pg.query(
    `SELECT name, "propertyType" FROM "PropertyDefinition" WHERE "projectId"=$1 AND scope='event'`,
    [projectId],
  )
  const typeByName = new Map(props.rows.map((p) => [p.name, p.propertyType]))
  const linksByEvent = new Map()
  for (const l of links.rows) {
    const arr = linksByEvent.get(l.eventName) ?? []
    arr.push(l)
    linksByEvent.set(l.eventName, arr)
  }

  const schema = {}
  for (const e of events.rows) {
    const eventLinks = linksByEvent.get(e.name) ?? []
    const types = {}
    for (const l of eventLinks) {
      const t = typeByName.get(l.propertyName)
      if (t) types[l.propertyName] = t
    }
    schema[e.name] = {
      mode: e.enforcementMode,
      required: eventLinks.filter((l) => l.required).map((l) => l.propertyName),
      types,
    }
  }

  if (Object.keys(schema).length === 0) {
    await redis.del(`capture:schema:${projectId}`)
  } else {
    await redis.set(`capture:schema:${projectId}`, JSON.stringify(schema))
  }
  return schema
}

async function setup(pg, redis, opts) {
  const projectId = await resolveProjectId(pg, opts)
  for (const def of SCHEMA_DEFS) await upsertEventAndSchema(pg, projectId, def)
  const schema = await syncSchemaCache(pg, redis, projectId)
  console.log(`schema-seed: project=${projectId}`)
  for (const def of SCHEMA_DEFS) {
    console.log(
      `  ${def.event.padEnd(20)} mode=${def.mode.padEnd(6)} required=[${def.properties
        .filter((p) => p.required)
        .map((p) => p.name)
        .join(', ')}]`,
    )
  }
  console.log(`  capture:schema:${projectId} -> ${JSON.stringify(schema)}`)
  return projectId
}

async function teardown(pg, redis, opts) {
  const projectId = await resolveProjectId(pg, opts)
  for (const def of SCHEMA_DEFS) await removeEventAndSchema(pg, projectId, def)
  await syncSchemaCache(pg, redis, projectId)
  console.log(`schema-seed: teardown complete for project=${projectId}`)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.mode !== 'setup' && opts.mode !== 'teardown') {
    console.error('usage: schema-seed.mjs <setup|teardown> --key ckw_live_xxx | --project-id <id>')
    process.exitCode = 2
    return
  }
  const pg = new Client({ connectionString: DATABASE_URL })
  const redis = new Redis(REDIS_URL)
  try {
    await pg.connect()
    if (opts.mode === 'setup') await setup(pg, redis, opts)
    else await teardown(pg, redis, opts)
  } catch (e) {
    console.error('schema-seed ERROR', e)
    process.exitCode = 1
  } finally {
    await pg.end()
    redis.disconnect()
  }
}

// Only run when invoked directly (`node schema-seed.mjs ...`), not when
// imported by pump.mjs for the CHECKOUT_EVENT/SIGNUP_EVENT constants.
if (import.meta.url === `file://${process.argv[1]}`) await main()
