import { newId, prisma } from '@clickroom/db'
import { appRouter } from '@clickroom/trpc-router'
import { redis } from '@clickroom/trpc-router/lib/redis.js'
import type { FlagBlob } from '@clickroom/trpc-router/trpc/routers/flags.cache.js'
import type { FlagFilters } from '@clickroom/trpc-router/trpc/routers/flags.router.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authService, callAs, cleanupOrg, cleanupUser, makeCtx } from './helpers.js'

const suffix = Date.now().toString(36)
const createdUserIds: string[] = []
const createdOrgIds: string[] = []

let adminUserId: string
let orgId: string
let projectId: string

// A valid boolean flag filters blob: one targeted group + one
// everyone group. No `multivariate` -> boolean flag.
const booleanFilters: FlagFilters = {
  groups: [
    {
      properties: [{ key: 'plan', operator: 'exact', value: 'pro' }],
      rollout_percentage: 100,
      variant: null,
    },
    { properties: [], rollout_percentage: 30, variant: null },
  ],
}

beforeAll(async () => {
  // The shared ioredis client is lazyConnect with enableOfflineQueue=false, so
  // the app connects it on boot. Tests read/write the blob directly, so connect
  // explicitly (the rebuild path swallows write errors and would mask a miss).
  if (redis.status !== 'ready' && redis.status !== 'connecting') {
    await redis.connect()
  }

  const s = await authService.signup({
    email: `flags-admin-${suffix}@test.invalid`,
    password: 'password123',
    orgName: `Flags Org ${suffix}`,
  })
  adminUserId = s.user.id
  orgId = s.org!.id
  createdUserIds.push(adminUserId)
  createdOrgIds.push(orgId)

  const project = await prisma.project.findFirstOrThrow({ where: { orgId } })
  projectId = project.id

  // bootstrapOrg only seeds `production` + `development` — this
  // suite also exercises a `staging` env, so create it explicitly as a real
  // `Environment` row (custom environments are no longer a fixed enum).
  await prisma.environment.create({
    data: { id: newId(), projectId, key: 'staging', name: 'Staging' },
  })

  // This suite creates well more flags than the free plan's lifetime cap
  // (quota enforcement) — override it high so flag-count assertions
  // here are exercising flag CRUD, not the quota gate (covered separately by
  // quota.test.ts).
  await prisma.org.update({ where: { id: orgId }, data: { maxFlagsOverride: 1000 } })
})

afterAll(async () => {
  for (const oid of createdOrgIds) await cleanupOrg(oid)
  for (const uid of createdUserIds) await cleanupUser(uid)
  for (const env of ['production', 'staging', 'development']) {
    await redis.del(`flags:def:${projectId}:${env}`)
  }
  await redis.quit()
  await prisma.$disconnect()
})

function callerFor(userId: string, orgForToken: string) {
  return appRouter.createCaller(
    makeCtx({ tokenPayload: { sub: userId, sessionId: 'test', orgId: orgForToken } }),
  )
}

const admin = () => ({ userId: adminUserId, orgId, orgRole: 'org_admin' as const })

async function readBlob(
  pid: string,
  env: 'production' | 'staging' | 'development' = 'production',
): Promise<FlagBlob | null> {
  const raw = await redis.get(`flags:def:${pid}:${env}`)
  return raw ? (JSON.parse(raw) as FlagBlob) : null
}

describe('flags.create', () => {
  it('creates a valid flag and writes Redis blob', async () => {
    const caller = callerFor(adminUserId, orgId)
    const flag = await callAs(admin(), () =>
      caller.flags.create({
        projectId,
        key: 'boolean-30',
        name: 'Boolean 30',
        active: true,
        filters: booleanFilters,
      }),
    )
    expect(flag).toMatchObject({ key: 'boolean-30', active: true, version: 1 })

    const blob = await readBlob(projectId, 'production')
    expect(blob).not.toBeNull()
    expect(blob?.version).toBe(1)
    expect(blob?.flags).toHaveLength(1)
    expect(blob?.flags[0]).toMatchObject({ key: 'boolean-30', active: true, version: 1 })
    expect(blob?.flags[0].filters).toEqual(booleanFilters)
  })

  it('rejects invalid filters (unknown operator)', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () =>
        caller.flags.create({
          projectId,
          key: 'bad-operator',
          active: true,
          filters: {
            groups: [
              {
                properties: [{ key: 'x', operator: 'regex', value: 'y' }],
                rollout_percentage: 50,
                variant: null,
              },
            ],
          },
          // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid input
        } as any),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('rejects invalid filters (rollout out of range)', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () =>
        caller.flags.create({
          projectId,
          key: 'bad-rollout',
          active: true,
          filters: { groups: [{ properties: [], rollout_percentage: 150, variant: null }] },
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('rejects a non-boolean `serve`', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () =>
        caller.flags.create({
          projectId,
          key: 'bad-serve',
          active: true,
          filters: {
            groups: [
              // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid input
              { properties: [], rollout_percentage: 100, variant: null, serve: 'yes' as any },
            ],
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('round-trips a boolean flag that serves false to a cohort and true by default', async () => {
    const caller = callerFor(adminUserId, orgId)
    const flag = await callAs(admin(), () =>
      caller.flags.create({
        projectId,
        key: 'serve-kill-switch',
        active: true,
        filters: {
          kind: 'boolean',
          groups: [
            {
              properties: [{ key: 'plan', operator: 'exact', value: 'internal' }],
              rollout_percentage: 100,
              variant: null,
              serve: false,
            },
            { properties: [], rollout_percentage: 100, variant: null, serve: true },
          ],
        },
      }),
    )
    // `serve` must survive the strict zod schema and the Json column intact —
    // the Rust evaluator reads it straight off the cached blob.
    const filters = flag.filters as { groups: { serve?: boolean }[] }
    expect(filters.groups.map((g) => g.serve)).toEqual([false, true])
  })

  it('rejects a duplicate (projectId, key) with CONFLICT', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () =>
        caller.flags.create({
          projectId,
          key: 'boolean-30',
          active: true,
          filters: booleanFilters,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('accepts a multivariate flag with payloads', async () => {
    const caller = callerFor(adminUserId, orgId)
    const flag = await callAs(admin(), () =>
      caller.flags.create({
        projectId,
        key: 'multivariate-ab',
        active: false,
        filters: {
          groups: [{ properties: [], rollout_percentage: 100, variant: null }],
          multivariate: {
            variants: [
              { key: 'control', rollout_percentage: 50 },
              { key: 'test', rollout_percentage: 50 },
            ],
          },
          payloads: { control: { color: 'blue' }, test: { color: 'green' } },
        },
      }),
    )
    expect(flag.key).toBe('multivariate-ab')
  })
})

describe('flags.list / get', () => {
  it('lists non-deleted flags ordered by key', async () => {
    const caller = callerFor(adminUserId, orgId)
    const rows = await callAs(admin(), () => caller.flags.list({ projectId, env: 'production' }))
    expect(rows.map((r) => r.key)).toEqual(['boolean-30', 'multivariate-ab', 'serve-kill-switch'])
  })

  it('get returns the flag; NOT_FOUND for missing key', async () => {
    const caller = callerFor(adminUserId, orgId)
    const flag = await callAs(admin(), () =>
      caller.flags.get({ projectId, key: 'boolean-30', env: 'production' }),
    )
    expect(flag.key).toBe('boolean-30')
    await expect(
      callAs(admin(), () => caller.flags.get({ projectId, key: 'nope', env: 'production' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('flags.update / toggle / delete', () => {
  it('update bumps version and rebuilds the cache', async () => {
    const caller = callerFor(adminUserId, orgId)
    const created = await callAs(admin(), () =>
      caller.flags.get({ projectId, key: 'boolean-30', env: 'production' }),
    )
    const updated = await callAs(admin(), () =>
      caller.flags.update({
        projectId,
        id: created.id,
        patch: {
          name: 'Renamed',
          filters: { groups: [{ properties: [], rollout_percentage: 10, variant: null }] },
        },
      }),
    )
    expect(updated.version).toBe(created.version + 1)
    expect(updated.name).toBe('Renamed')

    const blob = await readBlob(projectId, 'production')
    const entry = blob?.flags.find((f) => f.key === 'boolean-30')
    expect(entry?.version).toBe(2)
  })

  it('update on a missing id throws NOT_FOUND', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.flags.update({ projectId, id: 'nope', patch: { name: 'x' } })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('toggle flips active, bumps version, and reflects in the blob', async () => {
    const caller = callerFor(adminUserId, orgId)
    const flag = await callAs(admin(), () =>
      caller.flags.get({ projectId, key: 'multivariate-ab', env: 'production' }),
    )
    const toggled = await callAs(admin(), () =>
      caller.flags.toggle({ projectId, id: flag.id, active: true }),
    )
    expect(toggled.active).toBe(true)
    expect(toggled.version).toBe(flag.version + 1)

    const blob = await readBlob(projectId, 'production')
    expect(blob?.flags.find((f) => f.key === 'multivariate-ab')?.active).toBe(true)
  })

  it('soft delete hides from list and drops from the blob', async () => {
    const caller = callerFor(adminUserId, orgId)
    const flag = await callAs(admin(), () =>
      caller.flags.get({ projectId, key: 'multivariate-ab', env: 'production' }),
    )
    await callAs(admin(), () => caller.flags.delete({ projectId, id: flag.id }))

    const rows = await callAs(admin(), () => caller.flags.list({ projectId, env: 'production' }))
    expect(rows.map((r) => r.key)).not.toContain('multivariate-ab')

    const blob = await readBlob(projectId, 'production')
    expect(blob?.flags.map((f) => f.key)).not.toContain('multivariate-ab')

    // Deleted flag is gone from get too.
    await expect(
      callAs(admin(), () =>
        caller.flags.get({ projectId, key: 'multivariate-ab', env: 'production' }),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('flags cross-tenant isolation', () => {
  it('a caller in org A gets NOT_FOUND for org B project', async () => {
    const b = await authService.signup({
      email: `flags-tenant-b-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Flags Tenant B ${suffix}`,
    })
    createdUserIds.push(b.user.id)
    createdOrgIds.push(b.org!.id)
    const bProject = await prisma.project.findFirstOrThrow({ where: { orgId: b.org!.id } })

    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () => caller.flags.list({ projectId: bProject.id, env: 'production' })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('flags permissions', () => {
  it('a viewer may list but not create', async () => {
    const v = await authService.signup({
      email: `flags-viewer-${suffix}@test.invalid`,
      password: 'password123',
      orgName: `Flags Viewer Org ${suffix}`,
    })
    createdUserIds.push(v.user.id)
    createdOrgIds.push(v.org!.id)
    const vOrgId = v.org!.id
    const vProject = await prisma.project.findFirstOrThrow({ where: { orgId: vOrgId } })
    const viewer = { userId: v.user.id, orgId: vOrgId, orgRole: 'viewer' as const }
    const caller = callerFor(v.user.id, vOrgId)

    await expect(
      callAs(viewer, () => caller.flags.list({ projectId: vProject.id, env: 'production' })),
    ).resolves.toBeInstanceOf(Array)

    await expect(
      callAs(viewer, () =>
        caller.flags.create({
          projectId: vProject.id,
          key: 'nope',
          active: true,
          filters: booleanFilters,
        }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('flags env + tags', () => {
  it('round-trips env + tags through create -> get', async () => {
    const caller = callerFor(adminUserId, orgId)
    const flag = await callAs(admin(), () =>
      caller.flags.create({
        projectId,
        key: 'env-tags',
        active: true,
        env: 'staging',
        tags: ['alpha', 'beta'],
        filters: booleanFilters,
      }),
    )
    expect(flag).toMatchObject({ env: 'staging', tags: ['alpha', 'beta'] })

    const fetched = await callAs(admin(), () =>
      caller.flags.get({ projectId, key: 'env-tags', env: 'staging' }),
    )
    expect(fetched.env).toBe('staging')
    expect(fetched.tags).toEqual(['alpha', 'beta'])

    // Cache is partitioned per-env: this flag only shows up in staging's blob.
    const stagingBlob = await readBlob(projectId, 'staging')
    expect(stagingBlob?.flags.map((f) => f.key)).toContain('env-tags')
    const productionBlob = await readBlob(projectId, 'production')
    expect(productionBlob?.flags.map((f) => f.key)).not.toContain('env-tags')
  })

  it('defaults env to production and tags to [] when omitted', async () => {
    const caller = callerFor(adminUserId, orgId)
    const flag = await callAs(admin(), () =>
      caller.flags.create({
        projectId,
        key: 'env-tags-default',
        active: false,
        filters: booleanFilters,
      }),
    )
    expect(flag.env).toBe('production')
    expect(flag.tags).toEqual([])
  })

  it('update can change env and tags, moving the flag between cache partitions', async () => {
    const caller = callerFor(adminUserId, orgId)
    const created = await callAs(admin(), () =>
      caller.flags.get({ projectId, key: 'env-tags-default', env: 'production' }),
    )

    // Sanity: before the move, the flag lives in production's blob only.
    const beforeProd = await readBlob(projectId, 'production')
    expect(beforeProd?.flags.map((f) => f.key)).toContain('env-tags-default')

    const updated = await callAs(admin(), () =>
      caller.flags.update({
        projectId,
        id: created.id,
        patch: { env: 'development', tags: ['gamma'] },
      }),
    )
    expect(updated.env).toBe('development')
    expect(updated.tags).toEqual(['gamma'])

    // env is part of the unique key: the row moved partitions, so the cache
    // rebuild must touch both the old (production) and new (development) keys.
    const afterProd = await readBlob(projectId, 'production')
    expect(afterProd?.flags.map((f) => f.key)).not.toContain('env-tags-default')

    const afterDev = await readBlob(projectId, 'development')
    expect(afterDev?.flags.map((f) => f.key)).toContain('env-tags-default')
    expect(afterDev?.flags.find((f) => f.key === 'env-tags-default')?.filters).toBeDefined()
  })
})

describe('flags env partitioning (unique key now includes env)', () => {
  it('allows the same key in two different envs with no CONFLICT', async () => {
    const caller = callerFor(adminUserId, orgId)
    const prod = await callAs(admin(), () =>
      caller.flags.create({
        projectId,
        key: 'shared-key',
        active: true,
        env: 'production',
        filters: booleanFilters,
      }),
    )
    const staging = await callAs(admin(), () =>
      caller.flags.create({
        projectId,
        key: 'shared-key',
        active: false,
        env: 'staging',
        filters: booleanFilters,
      }),
    )
    expect(prod.env).toBe('production')
    expect(staging.env).toBe('staging')
    expect(prod.id).not.toBe(staging.id)

    // Same (projectId, key) but a third distinct env is still fine too.
    await expect(
      callAs(admin(), () =>
        caller.flags.create({
          projectId,
          key: 'shared-key',
          active: true,
          env: 'production',
          filters: booleanFilters,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('list(projectId, env) only returns rows for that env', async () => {
    const caller = callerFor(adminUserId, orgId)
    const prodRows = await callAs(admin(), () =>
      caller.flags.list({ projectId, env: 'production' }),
    )
    const stagingRows = await callAs(admin(), () =>
      caller.flags.list({ projectId, env: 'staging' }),
    )

    expect(prodRows.map((r) => r.key)).toContain('shared-key')
    expect(stagingRows.map((r) => r.key)).toContain('shared-key')

    // Each env's list only contains its own row for the shared key — not both.
    const prodEnvs = prodRows.filter((r) => r.key === 'shared-key').map((r) => r.env)
    const stagingEnvs = stagingRows.filter((r) => r.key === 'shared-key').map((r) => r.env)
    expect(prodEnvs).toEqual(['production'])
    expect(stagingEnvs).toEqual(['staging'])
  })
})

// Value-based (string/number) flags: `kind` is a pure UI-layer discriminator on
// `filters` (added to the .strict() Zod schema). No `multivariate` block is used
// — each group's `variant` directly picks the served value, mirroring the
// production `signup-mode` flag pattern. The evaluator ignores `kind` entirely,
// so these tests only cover the create/update/cache round-trip through the API.
describe('flags value-based (string/number) create', () => {
  it('creates a string value flag with kind + variant-pinned groups', async () => {
    const caller = callerFor(adminUserId, orgId)
    const stringFilters: FlagFilters = {
      kind: 'string',
      payloads: { open: 'open', request: 'request', disabled: 'disabled' },
      groups: [
        {
          properties: [{ key: 'email', operator: 'exact', value: 'vip@example.com' }],
          rollout_percentage: 100,
          variant: 'open',
        },
        { properties: [], rollout_percentage: 100, variant: 'disabled' },
      ],
    }
    const flag = await callAs(admin(), () =>
      caller.flags.create({
        projectId,
        key: 'signup-mode-string',
        active: true,
        filters: stringFilters,
      }),
    )
    expect(flag.key).toBe('signup-mode-string')

    const fetched = await callAs(admin(), () =>
      caller.flags.get({ projectId, key: 'signup-mode-string', env: 'production' }),
    )
    expect((fetched.filters as FlagFilters).kind).toBe('string')
    expect(fetched.filters).toEqual(stringFilters)

    const blob = await readBlob(projectId, 'production')
    const entry = blob?.flags.find((f) => f.key === 'signup-mode-string')
    expect(entry).toBeDefined()
    expect(entry?.filters).toEqual(stringFilters)
  })

  it('creates a number value flag and round-trips numeric payloads through Json', async () => {
    const caller = callerFor(adminUserId, orgId)
    const numberFilters: FlagFilters = {
      kind: 'number',
      payloads: { low: 10, high: 20 },
      groups: [
        {
          properties: [{ key: 'plan', operator: 'exact', value: 'enterprise' }],
          rollout_percentage: 100,
          variant: 'high',
        },
        { properties: [], rollout_percentage: 100, variant: 'low' },
      ],
    }
    const flag = await callAs(admin(), () =>
      caller.flags.create({
        projectId,
        key: 'rate-limit-tier',
        active: true,
        filters: numberFilters,
      }),
    )
    expect(flag.key).toBe('rate-limit-tier')

    const fetched = await callAs(admin(), () =>
      caller.flags.get({ projectId, key: 'rate-limit-tier', env: 'production' }),
    )
    const fetchedFilters = fetched.filters as FlagFilters
    expect(fetchedFilters.kind).toBe('number')
    expect(fetchedFilters.payloads).toEqual({ low: 10, high: 20 })
    expect(typeof fetchedFilters.payloads?.low).toBe('number')
    expect(typeof fetchedFilters.payloads?.high).toBe('number')
  })

  it('kind survives an update patch (boolean -> boolean with kind added)', async () => {
    const caller = callerFor(adminUserId, orgId)
    const created = await callAs(admin(), () =>
      caller.flags.create({
        projectId,
        key: 'kind-patch-test',
        active: true,
        filters: booleanFilters,
      }),
    )
    expect((created.filters as FlagFilters).kind).toBeUndefined()

    const updated = await callAs(admin(), () =>
      caller.flags.update({
        projectId,
        id: created.id,
        patch: {
          filters: {
            kind: 'boolean',
            groups: [
              {
                properties: [{ key: 'plan', operator: 'exact', value: 'pro' }],
                rollout_percentage: 100,
                variant: null,
              },
              { properties: [], rollout_percentage: 30, variant: null },
            ],
          },
        },
      }),
    )
    expect((updated.filters as FlagFilters).kind).toBe('boolean')

    const fetched = await callAs(admin(), () =>
      caller.flags.get({ projectId, key: 'kind-patch-test', env: 'production' }),
    )
    expect((fetched.filters as FlagFilters).kind).toBe('boolean')
  })

  it('still rejects a genuinely unknown filters key (kind is the only widened field)', async () => {
    const caller = callerFor(adminUserId, orgId)
    await expect(
      callAs(admin(), () =>
        caller.flags.create({
          projectId,
          key: 'unknown-key-rejected',
          active: true,
          filters: {
            groups: [{ properties: [], rollout_percentage: 100, variant: null }],
            someRandomKey: 'x',
            // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid input
          } as any,
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
