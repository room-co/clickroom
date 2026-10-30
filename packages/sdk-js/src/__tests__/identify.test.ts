// identify() carries the outgoing (pre-identify) distinct id through as
// `properties.$anon_distinct_id` on the emitted `$identify` event.
// Drives the singleton index with a mocked transport so we can inspect the
// exact events captureInternal enqueues, plus a mocked /flags fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventPayload } from '../types'

const captured: EventPayload[] = []

vi.mock('../transport', () => ({
  createTransport: () => ({
    enqueue: (e: EventPayload) => {
      captured.push(e)
    },
    flush: () => {},
    teardown: () => {},
  }),
}))

type FlagResult = { enabled: boolean; variant: string | null; payload: unknown }
let flagMap: Record<string, FlagResult> = {}

let storageMap: Map<string, string>

const makeStorage = (): Storage => {
  storageMap = new Map<string, string>()
  return {
    getItem: (k: string) => (storageMap.has(k) ? (storageMap.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      storageMap.set(k, String(v))
    },
    removeItem: (k: string) => {
      storageMap.delete(k)
    },
    key: (i: number) => Array.from(storageMap.keys())[i] ?? null,
    clear: () => storageMap.clear(),
    get length() {
      return storageMap.size
    },
  } as Storage
}

// Let all queued microtasks (the flags fetch chain) settle.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const identifies = (): EventPayload[] => captured.filter((e) => e.event === '$identify')

beforeEach(() => {
  captured.length = 0
  flagMap = {}
  vi.resetModules()
  vi.stubGlobal('window', {} as unknown as Window)
  vi.stubGlobal('localStorage', makeStorage())
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ flags: flagMap }),
    })) as unknown as typeof fetch,
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const loadSdk = async () => {
  const mod = await import('../index')
  return mod.default
}

describe('identify() $anon_distinct_id', () => {
  it('attaches the pre-identify (anon) distinct id when it differs', async () => {
    const ck = await loadSdk()
    ck.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()

    // The anon id minted by init() and persisted under the did storage key.
    const anonId = storageMap.get('ckrm_did')
    expect(anonId).toBeTruthy()

    ck.identify('u1', { plan: 'pro' })
    await settle()

    const ev = identifies()
    expect(ev).toHaveLength(1)
    expect(ev[0].distinct_id).toBe('u1')
    expect(ev[0].properties?.$anon_distinct_id).toBe(anonId)
    expect(ev[0].properties?.$set).toEqual({ plan: 'pro' })
  })

  it('does NOT attach $anon_distinct_id on a same-id identify() (trait-only update)', async () => {
    const ck = await loadSdk()
    ck.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()

    ck.identify('u1', { plan: 'pro' })
    await settle()
    ck.identify('u1', { plan: 'enterprise' })
    await settle()

    const ev = identifies()
    expect(ev).toHaveLength(2)
    expect(ev[0].properties?.$anon_distinct_id).toBeTruthy()
    expect(ev[1].properties?.$anon_distinct_id).toBeUndefined()
    expect(ev[1].properties?.$set).toEqual({ plan: 'enterprise' })
  })

  // The anonymous → identified transition is the *same visit*.
  // posthog-js keeps the session across identify() and only rotates on reset();
  // locking it in so nobody "fixes" it later.
  it('does NOT rotate the session id (the anon → identified transition is one visit)', async () => {
    const ck = await loadSdk()
    ck.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()

    ck.capture('before')
    await settle()
    ck.identify('u1')
    await settle()
    ck.capture('after')
    await settle()

    const sid = (name: string) =>
      captured.find((e) => e.event === name)?.properties?.$session_id as string | undefined

    expect(sid('before')).toBeTruthy()
    expect(sid('$identify')).toBe(sid('before'))
    expect(sid('after')).toBe(sid('before'))
  })
})
