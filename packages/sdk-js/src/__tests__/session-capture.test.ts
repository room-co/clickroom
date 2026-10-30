// Wiring: every captured event carries both `$session_id` (origin-wide,
// localStorage) and `$window_id` (per tab, sessionStorage). Drives the real
// singleton index with a mocked transport so we inspect exactly what
// captureInternal enqueues — same shape as identify.test.ts / transport.test.ts.

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

// Storage stub backed by a caller-owned Map, so two "tabs" can share one
// localStorage map while holding separate sessionStorage maps.
const storageOver = (map: Map<string, string>): Storage =>
  ({
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v))
    },
    removeItem: (k: string) => {
      map.delete(k)
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    clear: () => map.clear(),
    get length() {
      return map.size
    },
  }) as Storage

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const stubEnv = (localMap: Map<string, string>, sessionMap: Map<string, string>) => {
  vi.stubGlobal('window', { addEventListener: () => {} } as unknown as Window)
  vi.stubGlobal('localStorage', storageOver(localMap))
  vi.stubGlobal('sessionStorage', storageOver(sessionMap))
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ flags: {} }) })) as unknown as typeof fetch,
  )
}

const loadSdk = async () => (await import('../index')).default

const eventNamed = (name: string): EventPayload => {
  const ev = captured.find((e) => e.event === name)
  if (!ev) throw new Error(`no captured event named ${name}`)
  return ev
}

beforeEach(() => {
  captured.length = 0
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('capture path: $session_id + $window_id', () => {
  it('a captured event carries both $session_id and $window_id', async () => {
    stubEnv(new Map(), new Map())
    const ck = await loadSdk()
    ck.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()

    ck.capture('thing_happened')
    await settle()

    const ev = eventNamed('thing_happened')
    expect(typeof ev.properties?.$session_id).toBe('string')
    expect(ev.properties?.$session_id).toBeTruthy()
    expect(typeof ev.properties?.$window_id).toBe('string')
    expect(ev.properties?.$window_id).toBeTruthy()
    expect(ev.properties?.$window_id).not.toBe(ev.properties?.$session_id)
  })

  it('two tabs sharing localStorage emit the same $session_id and different $window_id', async () => {
    // Tab A: fresh localStorage + its own sessionStorage.
    const sharedLocal = new Map<string, string>()
    stubEnv(sharedLocal, new Map())
    const tabA = await loadSdk()
    tabA.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()
    tabA.capture('from_tab_a')
    await settle()

    // Tab B: a second SDK instance over the *same* localStorage (origin-wide)
    // but a fresh sessionStorage (a different tab).
    vi.unstubAllGlobals()
    vi.resetModules()
    stubEnv(sharedLocal, new Map())
    const tabB = await loadSdk()
    tabB.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()
    tabB.capture('from_tab_b')
    await settle()

    const a = eventNamed('from_tab_a').properties as Record<string, unknown>
    const b = eventNamed('from_tab_b').properties as Record<string, unknown>

    expect(b.$session_id).toBe(a.$session_id) // one visit
    expect(b.$window_id).not.toBe(a.$window_id) // two tabs
  })
})
