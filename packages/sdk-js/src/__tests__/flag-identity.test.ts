// Regression: org-targeted flags must re-evaluate on identify().
//
// Flags are evaluated server-side against the caller's person_properties. The
// version gate keys only on the flag's server version, which does
// NOT change when the *caller* changes. So an org-targeted flag fetched
// anonymously at init() (empty person_properties → fallthrough group) stayed
// stuck at that value after identify() supplied `org_id`, because the version
// was unchanged and the refetch was skipped. The SSO/Ask-AI settings pages read
// `false` forever even though the flag served `true` for the org.
//
// Fix: identify() (and reset()) force a refetch that bypasses the version gate.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventPayload } from '../types'

vi.mock('../transport', () => ({
  createTransport: () => ({
    enqueue: (_e: EventPayload) => {},
    flush: () => {},
    teardown: () => {},
  }),
}))

// Server-side eval stand-in: `sso-enabled` serves true only when person
// properties carry the targeted org_id. Version stays constant across the whole
// test — the flag config never changes, only *who is asking* does.
const TARGET_ORG = 'cmp7pex6l0001ij01vp08xd7z'
const flagVersion = 1
let versionCalls = 0
let fetchCalls = 0
let lastPersonProps: Record<string, unknown> = {}

const evalFlags = (personProps: Record<string, unknown>) => {
  const orgMatches = personProps.org_id === TARGET_ORG
  return {
    'sso-enabled': { enabled: orgMatches, variant: null, payload: null },
  }
}

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

const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  versionCalls = 0
  fetchCalls = 0
  lastPersonProps = {}
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
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        person_properties?: Record<string, unknown>
      }
      lastPersonProps = body.person_properties ?? {}
      return { ok: true, json: async () => ({ flags: evalFlags(lastPersonProps) }) }
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

describe('identify() re-evaluates org-targeted flags', () => {
  it('refetches under the new identity even though the flag version is unchanged', async () => {
    const ck = await loadSdk()
    const seen: Record<string, boolean | string>[] = []
    ck.onFeatureFlags((flags) => seen.push(flags))

    ck.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()

    // Anonymous init fetched with empty props → org rule does not match.
    expect(fetchCalls).toBe(1)
    expect(lastPersonProps).toEqual({})
    expect(ck.isFeatureEnabled('sso-enabled')).toBe(false)

    // Same flag version — the pre-fix version gate would skip this fetch.
    ck.identify('user_1', { org_id: TARGET_ORG })
    await settle()

    expect(fetchCalls).toBe(2) // forced past the version gate
    expect(lastPersonProps).toEqual({ org_id: TARGET_ORG })
    expect(ck.isFeatureEnabled('sso-enabled')).toBe(true)
    expect(seen[seen.length - 1]).toEqual({ 'sso-enabled': true })
  })

  it('a manual refreshFeatureFlags() stays version-gated (no identity change)', async () => {
    const ck = await loadSdk()
    ck.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()
    expect(fetchCalls).toBe(1)

    // Identity unchanged and version unchanged — a manual refresh must not pay
    // for a full fetch. Guards against over-forcing regressing.
    ck.refreshFeatureFlags()
    await settle()
    expect(versionCalls).toBe(2)
    expect(fetchCalls).toBe(1)
  })
})
