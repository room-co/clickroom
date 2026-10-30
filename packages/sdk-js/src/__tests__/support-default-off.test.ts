// `support: false` is the default, and the default has to cost ZERO bytes.
//
// The whole opt-in argument is that an existing embed is byte-for-byte unaffected earlier.
// Nothing else asserts that: `initSupport` is only reachable through one `if (state.config.support)`
// branch in `init()`, and a stray call site (or a `DEFAULT_CONFIG` typo flipping the default) would
// silently start every customer page fetching `/v1/support`. This drives the REAL `init()` against
// a mocked fetch so it pins the network behaviour, not just the config constant.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let fetchMock: ReturnType<typeof vi.fn>

const makeStorage = (): Storage => {
  const map = new Map<string, string>()
  return {
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
  } as Storage
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const urls = (): string[] => fetchMock.mock.calls.map(([url]) => String(url))
const supportCalls = (): string[] => urls().filter((u) => u.includes('/v1/support'))

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('window', { addEventListener: () => {} } as unknown as Window)
  vi.stubGlobal('localStorage', makeStorage())
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ flags: {}, version: 1, forms: [] }),
  }))
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const loadSdk = async () => await import('../index')

describe('support is off by default', () => {
  it('init() with no options never touches /v1/support', async () => {
    const sdk = await loadSdk()
    sdk.default.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()

    expect(supportCalls()).toEqual([])
    expect(sdk.getSupportClient()).toBeNull()
  })

  it('init({ surveys: true }) alone still never touches /v1/support', async () => {
    const sdk = await loadSdk()
    sdk.default.init('wk_test', { api_host: 'https://capture.clickroom.co', surveys: true })
    await settle()

    expect(supportCalls()).toEqual([])
    expect(sdk.getSupportClient()).toBeNull()
  })

  it('capturing events with support off does not build a client or a context ring', async () => {
    const sdk = await loadSdk()
    sdk.default.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()
    sdk.default.capture('checkout_failed', { plan: 'pro' })
    await settle()

    expect(supportCalls()).toEqual([])
    expect(sdk.getSupportClient()).toBeNull()
  })

  it('init({ support: true }) DOES fetch the config — the flag is what flips it on', async () => {
    const sdk = await loadSdk()
    sdk.default.init('wk_test', { api_host: 'https://capture.clickroom.co', support: true })
    await settle()

    expect(supportCalls()).toHaveLength(1)
    expect(supportCalls()[0]).toBe('https://capture.clickroom.co/v1/support')
    expect(sdk.getSupportClient()).not.toBeNull()
  })
})

// ---- `support: boolean | SupportOptions` ---------------------
//
// `support` grew from a boolean into `{ enabled, mode }`. Two things have to stay true no matter
// what shape the caller passes:
//   * `enabled: false` (or absent, or `support: false`) keeps the zero-byte path zero-byte — the
//     normaliser is the ONLY thing standing between a `{ mode: 'both' }` typo and every customer
//     page fetching `/v1/support`;
//   * `mode` gates the auto-mount and NOTHING else, so `'manual'` and `'both'` fetch the config and
//     build the client exactly like `'launcher'` does. A `mode` check that leaked into the
//     `initSupport` call would silently break `useSupportForms()` / `support.mount()` for every
//     host page that renders support itself.
// The DOM half of the acceptance check (which modes append a launcher host to `<body>`) lives in
// `support-render.test.ts` — this file runs in the node environment, where there is no `document`
// for a host to be appended to and the assertion would be vacuous.
describe('support: { enabled, mode } config shapes', () => {
  it('support: false is the same zero-byte path as omitting it', async () => {
    const sdk = await loadSdk()
    sdk.default.init('wk_test', { api_host: 'https://capture.clickroom.co', support: false })
    await settle()

    expect(supportCalls()).toEqual([])
    expect(sdk.getSupportClient()).toBeNull()
  })

  it('support: { enabled: false } makes zero /v1/support calls and leaves the client null', async () => {
    const sdk = await loadSdk()
    sdk.default.init('wk_test', {
      api_host: 'https://capture.clickroom.co',
      support: { enabled: false },
    })
    await settle()

    expect(supportCalls()).toEqual([])
    expect(sdk.getSupportClient()).toBeNull()
  })

  it('enabled: false wins over any mode — { enabled: false, mode: "both" } still fetches nothing', async () => {
    const sdk = await loadSdk()
    sdk.default.init('wk_test', {
      api_host: 'https://capture.clickroom.co',
      support: { enabled: false, mode: 'both' },
    })
    await settle()

    expect(supportCalls()).toEqual([])
    expect(sdk.getSupportClient()).toBeNull()
  })

  it('mode: "manual" DOES fetch the config — the host page needs it to render', async () => {
    const sdk = await loadSdk()
    sdk.default.init('wk_test', {
      api_host: 'https://capture.clickroom.co',
      support: { enabled: true, mode: 'manual' },
    })
    await settle()

    expect(supportCalls()).toHaveLength(1)
    expect(supportCalls()[0]).toBe('https://capture.clickroom.co/v1/support')
    expect(sdk.getSupportClient()).not.toBeNull()
  })

  it('mode: "both" fetches and builds a client, exactly like the launcher default', async () => {
    const sdk = await loadSdk()
    sdk.default.init('wk_test', {
      api_host: 'https://capture.clickroom.co',
      support: { enabled: true, mode: 'both' },
    })
    await settle()

    expect(supportCalls()).toHaveLength(1)
    expect(supportCalls()[0]).toBe('https://capture.clickroom.co/v1/support')
    expect(sdk.getSupportClient()).not.toBeNull()
  })

  it('{ enabled: true } with no mode is the launcher default — same fetch as support: true', async () => {
    const sdk = await loadSdk()
    sdk.default.init('wk_test', {
      api_host: 'https://capture.clickroom.co',
      support: { enabled: true },
    })
    await settle()

    expect(supportCalls()).toHaveLength(1)
    expect(sdk.getSupportClient()).not.toBeNull()
  })
})

describe('LIB_VERSION', () => {
  it('is stamped on every event and matches package.json (CLAUDE.md lockstep rule)', async () => {
    const pkg = (await import('../../package.json')) as unknown as {
      default: { version: string }
      version?: string
    }
    const sdk = await loadSdk()
    sdk.default.init('wk_test', { api_host: 'https://capture.clickroom.co' })
    await settle()
    // Fill the transport buffer so it flushes (FLUSH_SIZE is 20).
    for (let i = 0; i < 20; i += 1) sdk.default.capture('probe')
    await settle()

    const captureCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/v1/capture'))
    const body = JSON.parse(String((captureCall?.[1] as RequestInit).body)) as {
      batch: Array<{ properties: Record<string, unknown> }>
    }
    const expected = pkg.version ?? pkg.default.version
    expect(expected).toBe('0.10.0')
    expect(body.batch[0].properties.$lib_version).toBe(expected)
  })
})
