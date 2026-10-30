import { Prisma } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import {
  INTENTIONALLY_UNSCOPED,
  ORG_TENANT_MODELS,
  PROJECT_TENANT_MODELS,
} from './scoped-client.js'

// ---------------------------------------------------------------------------
// Completeness guard for tenant isolation.
//
// Every Prisma model that carries an `orgId` OR `projectId` column must be
// DELIBERATELY classified as ORG-scoped (ORG_TENANT_MODELS), PROJECT-scoped
// (PROJECT_TENANT_MODELS), or intentionally unscoped (INTENTIONALLY_UNSCOPED).
// This closes the default-open gap: a future model with a tenant column can no
// longer be added without a conscious choice about its scoping.
//
// NOTE: `Org` is scoped by its own `id` (id == the tenant orgId) and carries
// neither `orgId` nor `projectId`, so it is NOT a "tenant-column" model here.
// It is handled explicitly in createScopedClient and is intentionally exempt
// from this test.
// ---------------------------------------------------------------------------

/** Lowercase names of every Prisma model with a scalar `orgId` or `projectId` field. */
function tenantColumnModelNames(): string[] {
  return Prisma.dmmf.datamodel.models
    .filter((model) =>
      model.fields.some((field) => field.name === 'orgId' || field.name === 'projectId'),
    )
    .map((model) => model.name.toLowerCase())
}

const UNSCOPED_KEYS = new Set(Object.keys(INTENTIONALLY_UNSCOPED))

describe('scoped models completeness', () => {
  it('classifies every tenant-column model as exactly one of org/project/unscoped', () => {
    const models = tenantColumnModelNames()
    expect(models.length).toBeGreaterThan(0)

    const unclassified: string[] = []
    const doubleClassified: string[] = []

    for (const name of models) {
      const groups = [
        ORG_TENANT_MODELS.has(name),
        PROJECT_TENANT_MODELS.has(name),
        UNSCOPED_KEYS.has(name),
      ].filter(Boolean).length
      if (groups === 0) unclassified.push(name)
      if (groups > 1) doubleClassified.push(name)
    }

    expect(
      unclassified,
      unclassified
        .map(
          (name) =>
            `Model "${name}" has an orgId/projectId column but is in none of ORG_TENANT_MODELS, PROJECT_TENANT_MODELS, or INTENTIONALLY_UNSCOPED. Add it to one (see packages/db/src/scoped-client.ts).`,
        )
        .join('\n'),
    ).toEqual([])

    expect(
      doubleClassified,
      doubleClassified
        .map(
          (name) =>
            `Model "${name}" is in more than one classification set. It must be in exactly one (see packages/db/src/scoped-client.ts).`,
        )
        .join('\n'),
    ).toEqual([])
  })

  it('has no stale INTENTIONALLY_UNSCOPED entries (every key is a real tenant-column model)', () => {
    const models = new Set(tenantColumnModelNames())
    const stale = Object.keys(INTENTIONALLY_UNSCOPED).filter((name) => !models.has(name))

    expect(
      stale,
      stale
        .map(
          (name) =>
            `INTENTIONALLY_UNSCOPED has "${name}" but no Prisma model with that name carries an orgId/projectId column (typo or stale exemption?).`,
        )
        .join('\n'),
    ).toEqual([])
  })

  it('the three classification sets are pairwise disjoint', () => {
    const org = [...ORG_TENANT_MODELS]
    const project = [...PROJECT_TENANT_MODELS]

    const orgProject = org.filter((n) => PROJECT_TENANT_MODELS.has(n))
    const orgUnscoped = org.filter((n) => UNSCOPED_KEYS.has(n))
    const projectUnscoped = project.filter((n) => UNSCOPED_KEYS.has(n))

    expect(orgProject, `ORG ∩ PROJECT: ${orgProject.join(', ')}`).toEqual([])
    expect(orgUnscoped, `ORG ∩ UNSCOPED: ${orgUnscoped.join(', ')}`).toEqual([])
    expect(projectUnscoped, `PROJECT ∩ UNSCOPED: ${projectUnscoped.join(', ')}`).toEqual([])
  })
})
