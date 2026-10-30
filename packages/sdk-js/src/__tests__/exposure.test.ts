// Feature-flag EXPOSURE tracking ($feature_flag_called).
// Drives the singleton index with a mocked transport so we can inspect the
// exact events captureInternal enqueues, plus a mocked /flags fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventPayload } from '../types'

// Events the (mocked) transport receives, in order.
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

// The flag map the mocked /flags endpoint returns. `track` gates
// whether a client-side read of the flag emits a `$feature_flag_called`
// exposure — absent/false = silent (operational gate), true = under measurement.
type FlagResult = {
  enabled: boolean
  variant: string | null
  payload: unknown
  track?: boolean
}
let flagMap: Record<string, FlagResult> = {}

const makeStorage = (): Storage => {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      m.set(k, String(v))
    },
    removeItem: (k: string) => {
      m.delete(k)
    },
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    clear: () => m.clear(),
    get length() {
      return m.size
    },
  } as Storage
}

// Let all queued microtasks (the flags fetch chain) settle.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

// Exposure events only.
const exposures = (): EventPayload[] => captured.filter((e) => e.event === '$feature_flag_called')

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

describe('$feature_flag_called exposure', () => {
  it('emits ONE event with correct key + stringified boolean response', async () => {
    flagMap = { beta: { enabled: true, variant: null, payload: null, track: true } }
    const ck = await loadSdk()
    ck.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()

    expect(ck.isFeatureEnabled('beta')).toBe(true)

    const ev = exposures()
    expect(ev).toHaveLength(1)
    expect(ev[0].properties?.$feature_flag).toBe('beta')
    expect(ev[0].properties?.$feature_flag_response).toBe('true')
  })

  it('stringifies a variant response from getFeatureFlag', async () => {
    flagMap = { exp: { enabled: true, variant: 'control', payload: null, track: true } }
    const ck = await loadSdk()
    ck.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()

    expect(ck.getFeatureFlag('exp')).toBe('control')

    const ev = exposures()
    expect(ev).toHaveLength(1)
    expect(ev[0].properties?.$feature_flag).toBe('exp')
    expect(ev[0].properties?.$feature_flag_response).toBe('control')
  })

  it('dedups: second read of same (key,response) does NOT emit again', async () => {
    flagMap = { beta: { enabled: true, variant: null, payload: null, track: true } }
    const ck = await loadSdk()
    ck.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()

    ck.isFeatureEnabled('beta')
    ck.isFeatureEnabled('beta')
    ck.getFeatureFlag('beta') // same (key,response) pair -> still deduped

    expect(exposures()).toHaveLength(1)
  })

  it('re-emits when the response changes for the same key', async () => {
    flagMap = { exp: { enabled: true, variant: 'a', payload: null, track: true } }
    const ck = await loadSdk()
    ck.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()

    ck.getFeatureFlag('exp') // 'a'
    flagMap = { exp: { enabled: true, variant: 'b', payload: null, track: true } }
    // identify triggers a re-fetch (and re-arms). New pair -> new emit.
    ck.identify('user-1')
    await settle()
    ck.getFeatureFlag('exp') // 'b'

    const ev = exposures()
    const responses = ev.map((e) => e.properties?.$feature_flag_response)
    expect(responses).toContain('a')
    expect(responses).toContain('b')
  })

  it('emits nothing when read before flags load', async () => {
    flagMap = { beta: { enabled: true, variant: null, payload: null, track: true } }
    const ck = await loadSdk()
    ck.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    // NOTE: no settle() — flags fetch has not resolved yet.

    expect(ck.isFeatureEnabled('beta')).toBe(false)
    expect(ck.getFeatureFlag('beta')).toBe(false)
    expect(exposures()).toHaveLength(0)
  })

  it('reset() re-arms emission (emits again after reset)', async () => {
    flagMap = { beta: { enabled: true, variant: null, payload: null, track: true } }
    const ck = await loadSdk()
    ck.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()

    ck.isFeatureEnabled('beta')
    expect(exposures()).toHaveLength(1)
    ck.isFeatureEnabled('beta')
    expect(exposures()).toHaveLength(1) // deduped

    ck.reset() // clears dedup set + flagsLoaded
    ck.identify('user-2') // reload flags (flagsLoaded -> true again)
    await settle()

    ck.isFeatureEnabled('beta')
    expect(exposures()).toHaveLength(2) // re-armed -> emits again
  })

  it('does NOT emit for payload-only reads', async () => {
    flagMap = { paid: { enabled: true, variant: 'v1', payload: { plan: 'pro' }, track: true } }
    const ck = await loadSdk()
    ck.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()

    ck.getFeatureFlagPayload('paid')

    expect(exposures()).toHaveLength(0)
  })
})

// Exposure emission is gated on the flag's `track` boolean carried in
// the server flag blob. Untracked operational gates must stay silent; only
// flags under measurement (experiments) mint `$feature_flag_called`.
describe('$feature_flag_called track gate', () => {
  it('does NOT emit for a track:false flag read via getFeatureFlag', async () => {
    flagMap = { 'ask-ai-enabled': { enabled: true, variant: null, payload: null, track: false } }
    const ck = await loadSdk()
    ck.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()

    // Value read still works…
    expect(ck.getFeatureFlag('ask-ai-enabled')).toBe(true)
    expect(ck.isFeatureEnabled('ask-ai-enabled')).toBe(true)
    // …but no exposure is minted for the untracked gate.
    expect(exposures()).toHaveLength(0)
  })

  it('treats an absent track (legacy blob) as false — no exposure', async () => {
    flagMap = { 'teams-integration-enabled': { enabled: true, variant: null, payload: null } }
    const ck = await loadSdk()
    ck.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()

    expect(ck.getFeatureFlag('teams-integration-enabled')).toBe(true)
    expect(exposures()).toHaveLength(0)
  })

  it('emits once per (key, response) for a track:true flag, dedup intact', async () => {
    flagMap = { exp: { enabled: true, variant: 'control', payload: null, track: true } }
    const ck = await loadSdk()
    ck.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()

    ck.getFeatureFlag('exp')
    ck.getFeatureFlag('exp') // same (key,response) -> deduped
    ck.isFeatureEnabled('exp') // still same key; response 'control' vs true differ but…

    // Two distinct responses for one key: 'control' (getFeatureFlag) and 'true'
    // (isFeatureEnabled) — each emits once, and repeats are deduped.
    const responses = exposures().map((e) => e.properties?.$feature_flag_response)
    expect(responses).toEqual(['control', 'true'])
  })

  it('only the tracked flag emits when a tracked and an untracked flag are read', async () => {
    flagMap = {
      exp: { enabled: true, variant: null, payload: null, track: true },
      'sso-enabled': { enabled: true, variant: null, payload: null, track: false },
    }
    const ck = await loadSdk()
    ck.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()

    ck.isFeatureEnabled('sso-enabled') // untracked gate -> silent
    ck.isFeatureEnabled('exp') // tracked -> emits

    const ev = exposures()
    expect(ev).toHaveLength(1)
    expect(ev[0].properties?.$feature_flag).toBe('exp')
  })
})
