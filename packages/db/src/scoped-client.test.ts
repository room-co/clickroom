import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from './client.js'
import { createScopedClient } from './scoped-client.js'

// ---------------------------------------------------------------------------
// Behavioral proof that $extends auto-injection actually isolates tenants.
//
// Runs against the live seeded DB (Postgres :5432, database `clickroom`, one
// demo org + one Default project). Skips gracefully when the DB is unreachable
// so the pure completeness test still passes in infra-less CI.
// ---------------------------------------------------------------------------

let dbUp = false
let orgId = ''
let projectId = ''

beforeAll(async () => {
  try {
    const project = await prisma.project.findFirst({ orderBy: { createdAt: 'asc' } })
    if (project) {
      dbUp = true
      orgId = project.orgId
      projectId = project.id
    }
  } catch {
    dbUp = false
  }
})

afterAll(async () => {
  try {
    await prisma.$disconnect()
  } catch {
    // ignore — DB may never have connected
  }
})

describe('createScopedClient auto-injection (live DB)', () => {
  it('org-scoped: returns the seeded project for the matching org', async () => {
    if (!dbUp) return
    const scoped = createScopedClient(prisma, { orgId, projectId })
    const rows = await scoped.project.findMany()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((p) => p.orgId === orgId)).toBe(true)
    expect(rows.some((p) => p.id === projectId)).toBe(true)
  })

  it('org-scoped: returns [] for a nonexistent org', async () => {
    if (!dbUp) return
    const scoped = createScopedClient(prisma, {
      orgId: 'nonexistent',
      projectId: 'nonexistent',
    })
    expect(await scoped.project.findMany()).toEqual([])
  })

  it('project-scoped: returns [] for a nonexistent project', async () => {
    if (!dbUp) return
    const scoped = createScopedClient(prisma, {
      orgId: 'nonexistent',
      projectId: 'nonexistent',
    })
    expect(await scoped.featureFlag.findMany()).toEqual([])
    expect(await scoped.apiKey.findMany()).toEqual([])
  })

  it('project-scoped: only returns rows for the scoped project', async () => {
    if (!dbUp) return
    const scoped = createScopedClient(prisma, { orgId, projectId })
    const keys = await scoped.apiKey.findMany()
    expect(keys.every((k) => k.projectId === projectId)).toBe(true)
  })

  it('fail-closed: querying a project-scoped model without projectId throws', async () => {
    if (!dbUp) return
    const scoped = createScopedClient(prisma, { orgId })
    await expect(scoped.featureFlag.findMany()).rejects.toThrow(/project-scoped/)
  })
})
