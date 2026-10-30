import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from './password.js'

describe('password', () => {
  it('hash is not the plaintext and is an argon2id PHC string', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash).not.toBe('correct horse battery staple')
    expect(hash.startsWith('$argon2id$')).toBe(true)
  })

  it('verifies the correct password', async () => {
    const hash = await hashPassword('s3cret-pw')
    expect(await verifyPassword(hash, 's3cret-pw')).toBe(true)
  })

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('s3cret-pw')
    expect(await verifyPassword(hash, 'wrong-pw')).toBe(false)
  })

  it('returns false for a garbage hash instead of throwing', async () => {
    expect(await verifyPassword('not-a-real-hash', 'anything')).toBe(false)
  })
})
