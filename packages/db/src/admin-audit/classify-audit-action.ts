/**
 * Pure classifier for `AdminAuditLog.action` strings into the four `/audit`
 * filter buckets. Total/defensive per CLAUDE.md's adapter-layer rule: never throws,
 * unknown or malformed actions default to `'routine'`.
 *
 * `ACTIONS_BY_CATEGORY` is the inverse of `ACTION_CATEGORY` and is exported so the router
 * can translate a category filter into a DB-level `action: { in: [...] }` clause without
 * hand duplicating the mapping (keeps pagination/count DB-accurate and the two directions
 * in sync).
 */

export type AuditCategory = 'destructive' | 'billing' | 'impersonation' | 'routine'

const ACTION_CATEGORY: Record<string, AuditCategory> = {
  'org.suspend': 'destructive',
  'org.unsuspend': 'destructive',
  'org.setPlan': 'billing',
  'org.setLimitOverrides': 'billing',
  'org.setOveragePolicy': 'billing',
  'org.setMemberRole': 'routine',
  'impersonate.start': 'impersonation',
  'impersonate.stop': 'impersonation',
  'admin.login.succeeded': 'routine',
  'admin.login.failed': 'routine',
  'admin.login.locked': 'routine',
  'admin.2fa.enrollment_started': 'routine',
  'admin.2fa.enrolled': 'routine',
  'admin.2fa.verify_failed': 'routine',
  'admin.2fa.recovery_code_used': 'routine',
  'admin.2fa.recovery_codes_regenerated': 'routine',
  'admin.create': 'routine',
  'admin.unlock': 'routine',
  'admin.2fa.reset': 'routine',
}

export function classifyAuditAction(action: string): AuditCategory {
  return ACTION_CATEGORY[action] ?? 'routine'
}

function buildActionsByCategory(): Record<AuditCategory, string[]> {
  const result: Record<AuditCategory, string[]> = {
    destructive: [],
    billing: [],
    impersonation: [],
    routine: [],
  }
  for (const [action, category] of Object.entries(ACTION_CATEGORY)) {
    result[category].push(action)
  }
  return result
}

/** Inverse lookup: category -> known action strings. `routine` here only lists the explicit
 * knowns above — an `action: { in: ACTIONS_BY_CATEGORY.routine }` filter is therefore NOT used
 * for the routine bucket by the router (it also has to catch unrecognized actions); the router
 * derives "all minus known non-routine" instead. */
export const ACTIONS_BY_CATEGORY: Record<AuditCategory, string[]> = buildActionsByCategory()
