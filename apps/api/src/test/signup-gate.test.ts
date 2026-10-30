import { newId, prisma } from '@clickroom/db'
import { appRouter } from '@clickroom/trpc-router'
import { cacheBust, cacheSetJson, redis } from '@clickroom/trpc-router/lib/redis.js'
import type { FlagBlob } from '@clickroom/trpc-router/trpc/routers/flags.cache.js'
import {
  resetSignupGateCache,
  SIGNUP_GATE_FLAG_KEY,
} from '@clickroom/trpc-router/trpc/routers/signup-gate.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { authService, cleanupOrg, cleanupUser, makeCtx, makeRes } from './helpers.js'

const suffix = Date.now().toString(36)

// The gate resolves its flag from the dogfood org's `Platform` project. Rather
// than depend on `seed:dogfood` having run, this suite stands up a throwaway org
// shaped like it and points `DOGFOOD_ORG_SLUG` at it.
const GATE_ENV = 'production'

let gateOrgId: string
let gateUserId: string
let gateProjectId: string
let gateEnvId: string
let cacheKey: string
const createdUserIds: string[] = []
const createdOrgIds: string[] = []
let originalOrgSlug: string | undefined

beforeAll(async () => {
  // The shared ioredis client is lazyConnect with enableOfflineQueue=false, so a
  // test process must connect it explicitly or every cacheSetJson silently no-ops.
  if (redis.status !== 'ready' && redis.status !== 'connecting') await redis.connect()

  const owner = await authService.signup({
    email: `gate-owner-${suffix}@test.invalid`,
    password: 'password123',
    orgName: `Gate Dogfood ${suffix}`,
  })
  gateUserId = owner.user.id
  gateOrgId = owner.org!.id

  const org = await prisma.org.findUniqueOrThrow({ where: { id: gateOrgId } })
  const project = await prisma.project.findFirstOrThrow({ where: { orgId: gateOrgId } })
  // The gate looks the project up by the dogfood name, not by "first project".
  await prisma.project.update({ where: { id: project.id }, data: { name: 'Platform' } })
  gateProjectId = project.id

  const env = await prisma.environment.findFirstOrThrow({
    where: { projectId: project.id, key: GATE_ENV },
  })
  gateEnvId = env.id

  cacheKey = `flags:def:${project.id}:${GATE_ENV}`
  originalOrgSlug = process.env.DOGFOOD_ORG_SLUG
  process.env.DOGFOOD_ORG_SLUG = org.slug
  process.env.DOGFOOD_FLAG_ENV = GATE_ENV
})

afterAll(async () => {
  await cacheBust(cacheKey)
  if (originalOrgSlug === undefined) delete process.env.DOGFOOD_ORG_SLUG
  else process.env.DOGFOOD_ORG_SLUG = originalOrgSlug
  delete process.env.DOGFOOD_FLAG_ENV

  for (const orgId of createdOrgIds) await cleanupOrg(orgId)
  for (const userId of createdUserIds) await cleanupUser(userId)
  await cleanupOrg(gateOrgId)
  await cleanupUser(gateUserId)
  await prisma.$disconnect()
  redis.disconnect()
})

beforeEach(async () => {
  // The resolved dogfood project is memoized process-wide; drop it so each case
  // re-reads the fixture it just wrote.
  resetSignupGateCache()
  // Both halves of the fixture are per-case: the Redis blob and the Postgres row
  // the cache-miss path falls back to.
  await cacheBust(cacheKey)
  await prisma.featureFlag.deleteMany({ where: { projectId: gateProjectId } })
})

const gateFilters = (rollout = 100) => ({
  kind: 'boolean',
  groups: [{ properties: [], rollout_percentage: rollout, variant: null }],
})

/** Writes a gate flag into the blob `signup-gate.ts` reads, matching capture's shape. */
async function writeGateFlagToCache(opts: { active: boolean; rollout?: number }): Promise<void> {
  const blob: FlagBlob = {
    version: 1,
    flags: [
      {
        key: SIGNUP_GATE_FLAG_KEY,
        active: opts.active,
        track: false,
        filters: gateFilters(opts.rollout),
        version: 1,
      },
    ],
  }
  await cacheSetJson(cacheKey, blob, 300)
}

/** Writes only the Postgres row — the shape the cache-miss fallback reads. */
async function writeGateFlagToDb(opts: { active: boolean; rollout?: number }): Promise<void> {
  await prisma.featureFlag.create({
    data: {
      id: newId(),
      projectId: gateProjectId,
      environmentId: gateEnvId,
      key: SIGNUP_GATE_FLAG_KEY,
      name: 'Signups gated',
      active: opts.active,
      filters: gateFilters(opts.rollout),
    },
  })
}

async function attemptSignup(label: string) {
  const caller = appRouter.createCaller(makeCtx({ res: makeRes() }))
  return caller.auth.signup({
    email: `gated-${label}-${suffix}@test.invalid`,
    password: 'password123',
    orgName: `Gated Org ${label} ${suffix}`,
  })
}

describe('auth.signup — internal-signups-gated flag', () => {
  it('rejects public signup with FORBIDDEN when the flag is on for everyone', async () => {
    await writeGateFlagToCache({ active: true, rollout: 100 })

    await expect(attemptSignup('blocked')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })

    const org = await prisma.org.findFirst({ where: { name: `Gated Org blocked ${suffix}` } })
    expect(org).toBeNull()
  })

  // The blob carries a 24h TTL and is only rewritten on a flag write, so a gate
  // that read Redis alone would reopen signups a day after being switched on.
  it('still rejects when the blob has expired but the flag row is active', async () => {
    await writeGateFlagToDb({ active: true, rollout: 100 })

    await expect(attemptSignup('dbonly')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })

    const org = await prisma.org.findFirst({ where: { name: `Gated Org dbonly ${suffix}` } })
    expect(org).toBeNull()
  })

  it('allows signup when the flag exists but is inactive', async () => {
    await writeGateFlagToCache({ active: false })

    const result = await attemptSignup('inactive')
    createdUserIds.push(result.user.id)
    createdOrgIds.push(result.org!.id)

    expect(result.org).toMatchObject({ name: `Gated Org inactive ${suffix}` })
  })

  it('prefers the blob over the row, so a fresh toggle-off is not overridden', async () => {
    await writeGateFlagToDb({ active: true, rollout: 100 })
    await writeGateFlagToCache({ active: false })

    const result = await attemptSignup('blobwins')
    createdUserIds.push(result.user.id)
    createdOrgIds.push(result.org!.id)

    expect(result.org).toMatchObject({ name: `Gated Org blobwins ${suffix}` })
  })

  it('fails open when the flag exists in neither Redis nor Postgres', async () => {
    const result = await attemptSignup('noflag')
    createdUserIds.push(result.user.id)
    createdOrgIds.push(result.org!.id)

    expect(result.org).toMatchObject({ name: `Gated Org noflag ${suffix}` })
  })

  it('fails open when the dogfood org does not exist', async () => {
    await writeGateFlagToCache({ active: true, rollout: 100 })
    process.env.DOGFOOD_ORG_SLUG = `missing-dogfood-${suffix}`
    resetSignupGateCache()

    try {
      const result = await attemptSignup('noorg')
      createdUserIds.push(result.user.id)
      createdOrgIds.push(result.org!.id)
      expect(result.org).toMatchObject({ name: `Gated Org noorg ${suffix}` })
    } finally {
      const org = await prisma.org.findUniqueOrThrow({ where: { id: gateOrgId } })
      process.env.DOGFOOD_ORG_SLUG = org.slug
    }
  })
})
