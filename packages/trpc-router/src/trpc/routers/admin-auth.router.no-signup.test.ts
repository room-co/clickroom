import { describe, expect, it } from 'vitest'
import { adminAuthRouter } from './admin-auth.router.js'

/**
 * Ported from the reference implementation's `admin-auth.router.no-signup.test.ts`. Admins are
 * CLI-provisioned only (`pnpm --filter @clickroom/db admin:create`); there is no signup/register
 * procedure anywhere on this router, and there must never be one.
 */
describe('adminAuthRouter', () => {
  it('exposes no public signup/register procedure — admins are CLI-provisioned only', () => {
    const procedureNames = Object.keys(adminAuthRouter._def.procedures ?? {})
    for (const forbidden of ['signUp', 'signup', 'register', 'create']) {
      expect(procedureNames).not.toContain(forbidden)
    }
  })
})
