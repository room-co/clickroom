// `host` is required: no hardcoded cloud default. An explicit host must be honoured.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClickroomClient } from '../index'
import type { DeviceInfo } from '../types'

const device: DeviceInfo = { os: 'ios', screenWidth: 390, screenHeight: 844 }

describe('default host (react native)', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/v1/flags/version')) {
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({}) }
      }
      if (String(url).includes('/v1/flags')) {
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({ flags: {} }) }
      }
      return { ok: true, status: 202, headers: new Headers(), json: async () => ({ accepted: 1 }) }
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('throws when no host option is given (no hardcoded default)', () => {
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the required type
      () => new ClickroomClient({ writeKey: 'wk_test', flushAt: 1, device } as any),
    ).toThrow(/host/)
  })

  it('POSTs to the explicit host', async () => {
    const client = new ClickroomClient({
      writeKey: 'wk_test',
      flushAt: 1,
      host: 'https://capture.example.com',
      device,
    })
    await client.init()
    client.capture('probe')

    await vi.waitFor(() => {
      const captureCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/v1/capture'),
      )
      expect(captureCalls.length).toBeGreaterThan(0)
    })

    const captureCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/v1/capture'))
    expect(captureCall?.[0]).toBe('https://capture.example.com/v1/capture')

    await client.shutdown()
  })
})
