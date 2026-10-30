import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClickroomClient } from '../index'
import type { DeviceInfo } from '../types'

const device: DeviceInfo = { os: 'ios', screenWidth: 390, screenHeight: 844 }

function flagsPayload(flags: Record<string, unknown>) {
  return { ok: true, status: 200, headers: new Headers(), json: async () => ({ flags }) }
}

describe('$feature_flag_called exposure gating', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const captureBodies = () =>
    fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/v1/capture'))
      .flatMap(([, init]) => JSON.parse(init.body).batch)

  it('fires only for flags with track: true, once per (key, response)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/v1/flags/version')) {
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({}) }
      }
      if (String(url).includes('/v1/flags')) {
        return flagsPayload({
          tracked: { enabled: true, variant: null, payload: null, track: true },
          untracked: { enabled: true, variant: null, payload: null, track: false },
        })
      }
      return { ok: true, status: 202, headers: new Headers(), json: async () => ({ accepted: 1 }) }
    })

    const client = new ClickroomClient({
      host: 'https://capture.example.com',
      writeKey: 'wk',
      flushAt: 1,
      device,
    })
    await client.init()
    // Let the fire-and-forget flag fetch from init() resolve.
    await vi.waitFor(() => expect(client.isFeatureEnabled('tracked')).toBe(true))

    client.isFeatureEnabled('tracked')
    client.isFeatureEnabled('tracked')
    client.isFeatureEnabled('untracked')

    await vi.waitFor(() => {
      const exposures = captureBodies().filter((e) => e.event === '$feature_flag_called')
      expect(exposures.length).toBe(1)
    })

    const exposures = captureBodies().filter((e) => e.event === '$feature_flag_called')
    expect(exposures[0].properties.$feature_flag).toBe('tracked')
    expect(exposures.some((e) => e.properties.$feature_flag === 'untracked')).toBe(false)

    await client.shutdown()
  })

  it('clears the dedup set on identify()', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/v1/flags/version')) {
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({}) }
      }
      if (String(url).includes('/v1/flags')) {
        return flagsPayload({
          tracked: { enabled: true, variant: null, payload: null, track: true },
        })
      }
      return { ok: true, status: 202, headers: new Headers(), json: async () => ({ accepted: 1 }) }
    })

    const client = new ClickroomClient({
      host: 'https://capture.example.com',
      writeKey: 'wk',
      flushAt: 1,
      device,
    })
    await client.init()
    await vi.waitFor(() => expect(client.isFeatureEnabled('tracked')).toBe(true))

    await vi.waitFor(() => {
      expect(captureBodies().filter((e) => e.event === '$feature_flag_called').length).toBe(1)
    })

    client.identify('user-1')
    await vi.waitFor(() => expect(captureBodies().some((e) => e.event === '$identify')).toBe(true))

    client.isFeatureEnabled('tracked')

    await vi.waitFor(() => {
      expect(captureBodies().filter((e) => e.event === '$feature_flag_called').length).toBe(2)
    })

    await client.shutdown()
  })
})
