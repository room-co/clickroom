// `api_host` has no hardcoded default: events POSTed to a baked-in cloud host would
// silently leak a self-hoster's data to the wrong place, and the transport swallows send failures.
// Drives the REAL transport against a mocked fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const CAPTURE_HOST = 'https://capture.clickroom.co'

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

// The transport has no public flush(); it drains when the buffer hits FLUSH_SIZE (20) or on its
// 3s interval. Filling the buffer is deterministic — no fake timers to fight with the flags fetch.
const FLUSH_SIZE = 20

const captureCalls = (): string[] =>
  fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/v1/capture'))

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('window', {} as unknown as Window)
  vi.stubGlobal('localStorage', makeStorage())
  fetchMock = vi.fn(async () => ({ ok: true, status: 202, json: async () => ({ accepted: 1 }) }))
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const loadSdk = async () => (await import('../index')).default

describe('api_host resolution', () => {
  it('refuses to start (warns, sends nothing) when no api_host is available', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ck = await loadSdk()
    ck.init('wk_test')
    await settle()
    for (let i = 0; i < FLUSH_SIZE; i++) ck.capture('probe')
    await settle()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('api_host'))
    expect(captureCalls()).toHaveLength(0)
    warn.mockRestore()
  })

  it('POSTs to an explicit api_host', async () => {
    const ck = await loadSdk()
    ck.init('wk_test', { api_host: 'https://capture.example.com' })
    await settle()
    for (let i = 0; i < FLUSH_SIZE; i++) ck.capture('probe')
    await settle()

    const urls = captureCalls()
    expect(urls.length).toBeGreaterThan(0)
    expect(urls[0]).toContain('https://capture.example.com/v1/capture')
  })

  it('uses the host inferred from the CDN bundle script URL when api_host is omitted', async () => {
    const mod = await import('../index')
    mod.__setInferredApiHost('https://selfhost.example.com/capture')
    mod.default.init('wk_test')
    await settle()
    for (let i = 0; i < FLUSH_SIZE; i++) mod.default.capture('probe')
    await settle()

    expect(captureCalls()[0]).toContain('https://selfhost.example.com/capture/v1/capture')
  })

  it('exposes the documented cloud host constant', async () => {
    const mod = await import('../index')
    expect(mod.CLICKROOM_CLOUD_HOST).toBe(CAPTURE_HOST)
  })
})
