import { describe, expect, it, vi } from 'vitest'
import { createStore } from '../storage'
import type { StorageAdapter } from '../types'

function fakeAdapter(): StorageAdapter & { backing: Map<string, string> } {
  const backing = new Map<string, string>()
  return {
    backing,
    getItem: async (key: string) => backing.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      backing.set(key, value)
    },
    removeItem: async (key: string) => {
      backing.delete(key)
    },
    getAllKeys: async () => Array.from(backing.keys()),
  }
}

describe('createStore', () => {
  it('get/set are synchronous against the mirror after hydrate()', async () => {
    const adapter = fakeAdapter()
    const store = createStore(adapter)
    await store.hydrate()

    store.set('ckrm_did', 'abc')
    expect(store.get('ckrm_did')).toBe('abc')
  })

  it('hydrate() over a null adapter never throws and starts empty', async () => {
    const store = createStore(null)
    await expect(store.hydrate()).resolves.toBeUndefined()
    expect(store.get('anything')).toBeNull()

    // and set/get still work in-memory
    store.set('k', 'v')
    expect(store.get('k')).toBe('v')
  })

  it('hydrate() over an undefined adapter never throws and starts empty', async () => {
    const store = createStore(undefined)
    await expect(store.hydrate()).resolves.toBeUndefined()
    expect(store.get('anything')).toBeNull()
  })

  it('restores previously-written keys on hydrate()', async () => {
    const adapter = fakeAdapter()
    adapter.backing.set('ckrm_did', 'restored-id')
    adapter.backing.set('ckrm_rn_keys', JSON.stringify(['ckrm_did']))

    const store = createStore(adapter)
    await store.hydrate()
    expect(store.get('ckrm_did')).toBe('restored-id')
  })

  it('an adapter whose setItem rejects does not throw synchronously or leak an unhandled rejection', async () => {
    let rejections = 0
    const handler = () => {
      rejections += 1
    }
    process.on('unhandledRejection', handler)

    const adapter: StorageAdapter = {
      getItem: vi.fn().mockResolvedValue(null),
      setItem: vi.fn().mockRejectedValue(new Error('write failed')),
      removeItem: vi.fn().mockResolvedValue(undefined),
    }
    const store = createStore(adapter)
    await store.hydrate()

    expect(() => store.set('k', 'v')).not.toThrow()

    // Let the debounced write-behind (250ms) fire and its rejection settle.
    await new Promise((r) => setTimeout(r, 400))

    process.removeListener('unhandledRejection', handler)
    expect(rejections).toBe(0)
  })

  it("clearPrefix('ckrm_') removes only prefixed keys", async () => {
    const adapter = fakeAdapter()
    const store = createStore(adapter)
    await store.hydrate()

    store.set('ckrm_did', 'a')
    store.set('ckrm_sid', 'b')
    store.set('other_key', 'c')

    store.clearPrefix('ckrm_')

    expect(store.get('ckrm_did')).toBeNull()
    expect(store.get('ckrm_sid')).toBeNull()
    expect(store.get('other_key')).toBe('c')
  })
})
