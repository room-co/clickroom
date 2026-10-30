// Poll/refresh hook for feature flags: `feature_flag_poll_interval` (opt-in
// setInterval) and `refreshFeatureFlags()` (manual trigger) both re-fetch via
// the same `onFeatureFlags` listener path `identify()` already used. Verifies
// long-lived singleton clients (the exact gap flagged by "sdk-js
// streaming deferred" note) can now see dashboard flag changes.
//
// Every refresh (poll tick / refreshFeatureFlags() / identify())
// now goes through a cheap `GET /flags/version` check first, and only pays
// for the full `POST /flags` (eval + `$feature_flag_called` exposure) when
// the version actually changed. The mock below distinguishes the two request
// shapes (GET .../flags/version vs POST .../flags) and tracks separate
// counters so tests can assert on the new, cheaper call shape without losing
// precision vs. the old single `fetchCalls` counter.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventPayload } from '../types'

vi.mock('../transport', () => ({
  createTransport: () => ({
    enqueue: (_e: EventPayload) => {},
    flush: () => {},
    teardown: () => {},
  }),
}))

type FlagResult = { enabled: boolean; variant: string | null; payload: unknown }
let flagMap: Record<string, FlagResult> = {}
let flagVersion = 1
let versionCalls = 0
let fetchCalls = 0

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

// Version-gating adds an extra network hop (GET .../flags/version) ahead of
// the full fetch, deepening the microtask chain between kicking off a
// refresh and `onFeatureFlags` listeners observing its result. Using fake
// timers' own microtask-draining (`advanceTimersByTimeAsync(0)`) instead of a
// fixed number of chained `.then()`s keeps this robust regardless of chain
// depth.
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  flagMap = {}
  flagVersion = 1
  versionCalls = 0
  fetchCalls = 0
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubGlobal('window', {} as unknown as Window)
  vi.stubGlobal('localStorage', makeStorage())
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (String(url).endsWith('/flags/version') && method === 'GET') {
        versionCalls += 1
        return { ok: true, json: async () => ({ version: flagVersion }) }
      }
      fetchCalls += 1
      return { ok: true, json: async () => ({ flags: flagMap }) }
    }) as unknown as typeof fetch,
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const loadSdk = async () => {
  const mod = await import('../index')
  return mod.default
}

describe('feature_flag_poll_interval', () => {
  it('does not poll when unset (prior fetch-once-on-demand behavior)', async () => {
    const ck = await loadSdk()
    ck.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()
    expect(versionCalls).toBe(1) // the init-time version check...
    expect(fetchCalls).toBe(1) // ...which is a first check, so it always fetches

    await vi.advanceTimersByTimeAsync(60_000)
    expect(versionCalls).toBe(1)
    expect(fetchCalls).toBe(1)
  })

  it('an unchanged version across poll ticks skips the full fetch (and exposure) entirely', async () => {
    const ck = await loadSdk()
    const seen: Record<string, boolean | string>[] = []
    ck.onFeatureFlags((flags) => seen.push(flags))

    ck.init('wk_test', {
      api_host: 'https://capture.clickroom.co',
      feature_flag_poll_interval: 10_000,
    })
    await settle()
    expect(versionCalls).toBe(1)
    expect(fetchCalls).toBe(1) // first check always fetches, establishing lastVersion

    // flagVersion is unchanged for both of the following ticks.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(versionCalls).toBe(2) // cheap version check still happens every tick
    expect(fetchCalls).toBe(1) // ...but no full POST /flags since version didn't change

    await vi.advanceTimersByTimeAsync(10_000)
    expect(versionCalls).toBe(3)
    expect(fetchCalls).toBe(1)
  })

  it('a changed version between ticks re-fetches and onFeatureFlags listeners see updated values', async () => {
    const ck = await loadSdk()
    const seen: Record<string, boolean | string>[] = []
    ck.onFeatureFlags((flags) => seen.push(flags))

    ck.init('wk_test', {
      api_host: 'https://capture.clickroom.co',
      feature_flag_poll_interval: 10_000,
    })
    await settle()
    expect(fetchCalls).toBe(1)

    flagMap = { 'ask-ai-enabled': { enabled: true, variant: null, payload: null } }
    flagVersion = 2
    await vi.advanceTimersByTimeAsync(10_000)
    expect(versionCalls).toBe(2)
    expect(fetchCalls).toBe(2)
    expect(seen[seen.length - 1]).toEqual({ 'ask-ai-enabled': true })

    // Unchanged version on this tick — no extra full fetch.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(versionCalls).toBe(3)
    expect(fetchCalls).toBe(2)

    flagMap = { 'ask-ai-enabled': { enabled: false, variant: null, payload: null } }
    flagVersion = 3
    await vi.advanceTimersByTimeAsync(10_000)
    expect(versionCalls).toBe(4)
    expect(fetchCalls).toBe(3)
    expect(seen[seen.length - 1]).toEqual({})
  })

  it('clamps a sub-minimum interval up to the floor', async () => {
    const ck = await loadSdk()
    ck.init('wk_test', { api_host: 'https://capture.clickroom.co', feature_flag_poll_interval: 1 })
    await settle()
    expect(fetchCalls).toBe(1)

    // Below the 5s floor — must NOT have fired yet.
    await vi.advanceTimersByTimeAsync(4_999)
    expect(versionCalls).toBe(1)

    flagVersion = 2
    await vi.advanceTimersByTimeAsync(1)
    expect(versionCalls).toBe(2)
    expect(fetchCalls).toBe(2)
  })

  it('stopFeatureFlagPolling() halts further polling (both version checks and full fetches)', async () => {
    const ck = await loadSdk()
    ck.init('wk_test', {
      api_host: 'https://capture.clickroom.co',
      feature_flag_poll_interval: 10_000,
    })
    await settle()
    expect(fetchCalls).toBe(1)

    flagVersion = 2
    await vi.advanceTimersByTimeAsync(10_000)
    expect(versionCalls).toBe(2)
    expect(fetchCalls).toBe(2)

    ck.stopFeatureFlagPolling()
    flagVersion = 3
    await vi.advanceTimersByTimeAsync(60_000)
    expect(versionCalls).toBe(2)
    expect(fetchCalls).toBe(2)
  })
})

describe('refreshFeatureFlags()', () => {
  it('manually re-fetches and notifies listeners without waiting for a poll tick', async () => {
    const ck = await loadSdk()
    const seen: Record<string, boolean | string>[] = []
    ck.onFeatureFlags((flags) => seen.push(flags))

    ck.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()
    expect(fetchCalls).toBe(1)

    flagMap = { 'ask-ai-enabled': { enabled: true, variant: null, payload: null } }
    flagVersion = 2
    ck.refreshFeatureFlags()
    await settle()

    expect(versionCalls).toBe(2)
    expect(fetchCalls).toBe(2)
    expect(seen[seen.length - 1]).toEqual({ 'ask-ai-enabled': true })
  })

  it('is a no-op full fetch when the version has not changed since the last refresh', async () => {
    const ck = await loadSdk()
    ck.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()
    expect(fetchCalls).toBe(1)

    // Same version — a manual refresh should still ping the version endpoint
    // but must not pay for a full fetch/exposure.
    ck.refreshFeatureFlags()
    await settle()

    expect(versionCalls).toBe(2)
    expect(fetchCalls).toBe(1)
  })
})
