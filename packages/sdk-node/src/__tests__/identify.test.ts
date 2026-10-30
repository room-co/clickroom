import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClickroomClient } from '../index'

describe('ClickroomClient capture/identify', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202, headers: new Headers() })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('capture() enqueues the event with distinct_id + properties', async () => {
    const client = new ClickroomClient({
      writeKey: 'ckw_test',
      host: 'https://i.example.com',
      flushAt: 1,
    })
    client.capture({ distinctId: 'u1', event: 'checkout_completed', properties: { plan: 'pro' } })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.batch[0]).toMatchObject({
      event: 'checkout_completed',
      distinct_id: 'u1',
      properties: { plan: 'pro' },
    })

    await client.shutdown()
  })

  it('identify() emits $identify with $set person properties', async () => {
    const client = new ClickroomClient({
      writeKey: 'ckw_test',
      host: 'https://i.example.com',
      flushAt: 1,
    })
    client.identify({ distinctId: 'u1', properties: { email: 'a@b.com', plan: 'pro' } })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.batch[0]).toMatchObject({
      event: '$identify',
      distinct_id: 'u1',
      properties: { $set: { email: 'a@b.com', plan: 'pro' } },
    })

    await client.shutdown()
  })

  it('flag reads throw a clear error when readKey is not configured', () => {
    const client = new ClickroomClient({
      host: 'https://capture.example.com',
      writeKey: 'ckw_test',
      flushAt: 1,
    })
    expect(() => client.isFeatureEnabled('flag', 'u1')).toThrow(/readKey/)
  })
})
