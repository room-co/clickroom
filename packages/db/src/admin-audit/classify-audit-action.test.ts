import { describe, expect, it } from 'vitest'
import {
  ACTIONS_BY_CATEGORY,
  type AuditCategory,
  classifyAuditAction,
} from './classify-audit-action.js'

const CATEGORIES: AuditCategory[] = ['destructive', 'billing', 'impersonation', 'routine']

describe('classifyAuditAction / ACTIONS_BY_CATEGORY round-trip', () => {
  it('ACTIONS_BY_CATEGORY covers all four categories, even if some are empty', () => {
    expect(Object.keys(ACTIONS_BY_CATEGORY).sort()).toEqual([...CATEGORIES].sort())
  })

  it('every action listed under a category classifies back to that same category', () => {
    for (const category of CATEGORIES) {
      for (const action of ACTIONS_BY_CATEGORY[category]) {
        expect(classifyAuditAction(action), `${action} should classify as ${category}`).toBe(
          category,
        )
      }
    }
  })

  it('every action string appears in exactly one category bucket', () => {
    const seen = new Map<string, AuditCategory>()
    for (const category of CATEGORIES) {
      for (const action of ACTIONS_BY_CATEGORY[category]) {
        expect(
          seen.has(action),
          `${action} appears in both ${seen.get(action)} and ${category}`,
        ).toBe(false)
        seen.set(action, category)
      }
    }
  })

  it('known destructive/billing/impersonation actions are not accidentally routine', () => {
    expect(classifyAuditAction('org.suspend')).toBe('destructive')
    expect(classifyAuditAction('org.unsuspend')).toBe('destructive')
    expect(classifyAuditAction('org.setPlan')).toBe('billing')
    expect(classifyAuditAction('org.setLimitOverrides')).toBe('billing')
    expect(classifyAuditAction('org.setOveragePolicy')).toBe('billing')
    expect(classifyAuditAction('impersonate.start')).toBe('impersonation')
    expect(classifyAuditAction('impersonate.stop')).toBe('impersonation')
  })

  it('an unknown action string defaults to routine', () => {
    expect(classifyAuditAction('totally.unknown.action')).toBe('routine')
    expect(classifyAuditAction('')).toBe('routine')
    expect(classifyAuditAction('org.doSomethingNew')).toBe('routine')
  })

  it('never throws on malformed input', () => {
    // classifyAuditAction is typed as (action: string), but per its own doc
    // comment it must be total/defensive at the adapter boundary — verify
    // odd-but-still-string inputs don't throw.
    expect(() => classifyAuditAction('   ')).not.toThrow()
    expect(() => classifyAuditAction('a'.repeat(500))).not.toThrow()
  })
})
