import { describe, expect, it } from 'vitest'
import { resolveDogfoodPassword } from './dogfood-password.js'

describe('resolveDogfoodPassword', () => {
  it('uses DOGFOOD_ADMIN_PASSWORD when supplied', () => {
    expect(resolveDogfoodPassword({ DOGFOOD_ADMIN_PASSWORD: 'hunter2-long' })).toEqual({
      password: 'hunter2-long',
      generated: false,
    })
  })
  it('generates a unique strong password otherwise, never the old committed literal', () => {
    const a = resolveDogfoodPassword({})
    const b = resolveDogfoodPassword({ DOGFOOD_ADMIN_PASSWORD: '  ' })
    expect(a.generated && b.generated).toBe(true)
    expect(a.password.length).toBeGreaterThanOrEqual(20)
    expect(a.password).not.toBe(b.password)
    expect(a.password).not.toBe('clickroom-dogfood-2026')
  })
})
