import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from '../storage'
import { createTransport } from '../transport'

const baseHost = 'https://i.example.com'

const makeOpts = (overrides: Partial<Parameters<typeof createTransport>[0]> = {}) => ({
  host: baseHost,
  writeKey: 'ckw_test',
  flushAt: 3,
  flushInterval: 60_000,
  maxRetries: 2,
  store: createStore(null),
  ...overrides,
})

describe('sdk-react-native transport', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('flushes automatically once the buffer reaches flushAt', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 202, headers: new Headers() })
    const t = createTransport(makeOpts())

    t.enqueue({ event: 'a', distinct_id: 'u1' })
    t.enqueue({ event: 'b', distinct_id: 'u1' })
    expect(fetchMock).not.toHaveBeenCalled()
    t.enqueue({ event: 'c', distinct_id: 'u1' })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://i.example.com/v1/capture')
    expect(init.headers.authorization).toBe('Bearer ckw_test')
    const body = JSON.parse(init.body)
    expect(body.batch).toHaveLength(3)

    await t.shutdown()
  })

  it('chunks batches to the 100-event contract cap', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 202, headers: new Headers() })
    const t = createTransport(makeOpts({ flushAt: 250 }))

    for (let i = 0; i < 220; i += 1) {
      t.enqueue({ event: 'e', distinct_id: `u${i}` })
    }
    await t.flush()

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const sizes = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).batch.length)
    expect(sizes.sort((a, b) => a - b)).toEqual([20, 100, 100])
  })

  it('retries on 429 honoring Retry-After, then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '0' }),
      })
      .mockResolvedValueOnce({ ok: true, status: 202, headers: new Headers() })
    const t = createTransport(makeOpts({ flushAt: 1 }))

    t.enqueue({ event: 'a', distinct_id: 'u1' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await t.shutdown()
  })

  it('drops a batch after exhausting maxRetries on 500', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValue({ ok: false, status: 500, headers: new Headers() })
    const t = createTransport(makeOpts({ flushAt: 1, maxRetries: 1 }))

    t.enqueue({ event: 'a', distinct_id: 'u1' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2)) // initial + 1 retry
    await t.shutdown()
    warnSpy.mockRestore()
  })

  it('a 400 response warns once and is never retried', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers(),
      json: async () => ({ accepted: 0, errors: ['event: unknown property "foo"'] }),
    })
    const t = createTransport(makeOpts({ flushAt: 1, maxRetries: 3 }))

    t.enqueue({ event: 'a', distinct_id: 'u1' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await t.shutdown()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('400')
    warnSpy.mockRestore()
  })

  it('still retries on 500 responses', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, headers: new Headers() })
      .mockResolvedValueOnce({ ok: true, status: 202, headers: new Headers() })
    const t = createTransport(makeOpts({ flushAt: 1, maxRetries: 2 }))

    t.enqueue({ event: 'a', distinct_id: 'u1' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await t.shutdown()
  })

  it('shutdown drains any pending buffer', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 202, headers: new Headers() })
    const t = createTransport(makeOpts({ flushAt: 100 }))

    t.enqueue({ event: 'a', distinct_id: 'u1' })
    t.enqueue({ event: 'b', distinct_id: 'u1' })
    expect(fetchMock).not.toHaveBeenCalled()

    await t.shutdown()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).batch).toHaveLength(2)
  })

  for (const status of [401, 402, 413]) {
    it(`a ${status} response warns once and is never retried`, async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      fetchMock.mockResolvedValue({
        ok: false,
        status,
        headers: new Headers(),
        json: async () => ({ error: 'nope' }),
      })
      const t = createTransport(makeOpts({ flushAt: 1, maxRetries: 3 }))

      t.enqueue({ event: 'a', distinct_id: 'u1' })
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      await t.shutdown()

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      warnSpy.mockRestore()
    })
  }

  it('the 1000-event cap drops the oldest events first', async () => {
    // flushAt set higher than the cap so enqueue never triggers an auto-flush.
    const t = createTransport(makeOpts({ flushAt: 10_000, flushInterval: 10_000_000 }))

    for (let i = 0; i < 1005; i += 1) {
      t.enqueue({ event: 'e', distinct_id: `u${i}` })
    }

    fetchMock.mockResolvedValue({ ok: true, status: 202, headers: new Headers() })
    await t.flush()

    const sent = fetchMock.mock.calls.flatMap(([, init]) => JSON.parse(init.body).batch)
    expect(sent).toHaveLength(1000)
    expect(sent[0].distinct_id).toBe('u5') // the first 5 (u0..u4) were dropped as oldest
    expect(sent[sent.length - 1].distinct_id).toBe('u1004')

    await t.shutdown()
  })

  it('a persisted queue survives a fresh transport instance over the same store', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {})) // never resolves — simulate a kill
    const sharedStore = createStore(null)
    const a = createTransport(makeOpts({ store: sharedStore, flushAt: 10_000 }))

    a.enqueue({ event: 'a', distinct_id: 'u1' })
    a.enqueue({ event: 'b', distinct_id: 'u1' })
    // a is never flushed/shutdown — simulating an app kill.

    fetchMock.mockReset()
    fetchMock.mockResolvedValue({ ok: true, status: 202, headers: new Headers() })
    const b = createTransport(makeOpts({ store: sharedStore, flushAt: 10_000 }))

    await b.flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.batch).toHaveLength(2)
    expect(body.batch.map((e: { event: string }) => e.event)).toEqual(['a', 'b'])

    await b.shutdown()
  })
})
