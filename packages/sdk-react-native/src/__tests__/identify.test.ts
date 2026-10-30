import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClickroomClient } from '../index'
import type { DeviceInfo, StorageAdapter } from '../types'

const device: DeviceInfo = { os: 'ios', screenWidth: 390, screenHeight: 844 }

function fakeStorage(): StorageAdapter {
  const map = new Map<string, string>()
  return {
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => {
      map.set(k, v)
    },
    removeItem: async (k) => {
      map.delete(k)
    },
    getAllKeys: async () => Array.from(map.keys()),
  }
}

function flagsResponse() {
  return { ok: true, status: 200, headers: new Headers(), json: async () => ({ flags: {} }) }
}

describe('ClickroomClient identify/reset (react native)', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/v1/flags')) return flagsResponse()
      return { ok: true, status: 202, headers: new Headers(), json: async () => ({ accepted: 1 }) }
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const captureBodies = () =>
    fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/v1/capture'))
      .flatMap(([, init]) => JSON.parse(init.body).batch)

  it('identify() with a NEW id carries $set and $anon_distinct_id', async () => {
    const client = new ClickroomClient({
      host: 'https://capture.example.com',
      writeKey: 'wk',
      flushAt: 1,
      device,
      storage: fakeStorage(),
    })
    await client.init()
    // Capture an anon event first so we know the anon id.
    client.capture('anon_event')
    await vi.waitFor(() => expect(captureBodies().length).toBeGreaterThan(0))
    const anonId = captureBodies()[0].distinct_id

    client.identify('user-123', { email: 'a@b.com' })

    await vi.waitFor(() => {
      const identifyEvent = captureBodies().find((e) => e.event === '$identify')
      expect(identifyEvent).toBeDefined()
    })
    const identifyEvent = captureBodies().find((e) => e.event === '$identify')
    expect(identifyEvent.properties.$set).toEqual({ email: 'a@b.com' })
    expect(identifyEvent.properties.$anon_distinct_id).toBe(anonId)

    await client.shutdown()
  })

  it('identify() with the SAME id omits $anon_distinct_id', async () => {
    const client = new ClickroomClient({
      host: 'https://capture.example.com',
      writeKey: 'wk',
      flushAt: 1,
      device,
      storage: fakeStorage(),
    })
    await client.init()
    client.identify('user-123', {})
    await vi.waitFor(() => {
      expect(captureBodies().some((e) => e.event === '$identify')).toBe(true)
    })

    fetchMock.mockClear()
    client.identify('user-123', { plan: 'pro' })

    await vi.waitFor(() => {
      expect(captureBodies().some((e) => e.event === '$identify')).toBe(true)
    })
    const identifyEvent = captureBodies().find((e) => e.event === '$identify')
    expect(identifyEvent.properties.$anon_distinct_id).toBeUndefined()

    await client.shutdown()
  })

  it('reset() mints a new anon id and a subsequent capture uses it', async () => {
    const client = new ClickroomClient({
      host: 'https://capture.example.com',
      writeKey: 'wk',
      flushAt: 1,
      device,
      storage: fakeStorage(),
    })
    await client.init()
    client.identify('user-123')
    await vi.waitFor(() => expect(captureBodies().length).toBeGreaterThan(0))

    client.reset()
    fetchMock.mockClear()

    client.capture('post_reset_event')
    await vi.waitFor(() => expect(captureBodies().length).toBeGreaterThan(0))
    const postResetId = captureBodies()[0].distinct_id
    expect(postResetId).not.toBe('user-123')

    await client.shutdown()
  })
})
