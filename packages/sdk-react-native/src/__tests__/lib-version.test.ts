import { describe, expect, it } from 'vitest'
import pkg from '../../package.json'
import { LIB_VERSION } from '../index'

describe('LIB_VERSION', () => {
  it('matches package.json version', () => {
    expect(LIB_VERSION).toBe(pkg.version)
  })
})
