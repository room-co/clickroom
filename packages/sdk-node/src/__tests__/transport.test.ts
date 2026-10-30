import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTransport } from '../transport'

const baseOpts = {
  host: 'https://i.example.com',
  writeKey: 'ckw_test',
  flushAt: 3,
  flushInterval: 60_000,
  maxRetries: 2,
}

describe('sdk-node transport', () => {
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
    const t = createTransport(baseOpts)

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
    const t = createTransport({ ...baseOpts, flushAt: 250 })

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
    const t = createTransport({ ...baseOpts, flushAt: 1 })

    t.enqueue({ event: 'a', distinct_id: 'u1' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await t.shutdown()
  })

  it('drops a batch after exhausting maxRetries', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, headers: new Headers() })
    const t = createTransport({ ...baseOpts, flushAt: 1, maxRetries: 1 })

    t.enqueue({ event: 'a', distinct_id: 'u1' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2)) // initial + 1 retry
    await t.shutdown()
  })

  it('a 400 response is not retried and is surfaced via console.warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers(),
      json: async () => ({ accepted: 0, errors: ['event: unknown property "foo"'] }),
    })
    const t = createTransport({ ...baseOpts, flushAt: 1, maxRetries: 3 })

    t.enqueue({ event: 'a', distinct_id: 'u1' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await t.shutdown()

    // No retry attempted beyond the initial request.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('400')
    expect(warnSpy.mock.calls[0][1]).toMatchObject({ accepted: 0 })

    warnSpy.mockRestore()
  })

  it('still retries on 500 responses (existing behavior preserved)', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, headers: new Headers() })
      .mockResolvedValueOnce({ ok: true, status: 202, headers: new Headers() })
    const t = createTransport({ ...baseOpts, flushAt: 1, maxRetries: 2 })

    t.enqueue({ event: 'a', distinct_id: 'u1' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await t.shutdown()
  })

  it('shutdown drains any pending buffer', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 202, headers: new Headers() })
    const t = createTransport({ ...baseOpts, flushAt: 100 })

    t.enqueue({ event: 'a', distinct_id: 'u1' })
    t.enqueue({ event: 'b', distinct_id: 'u1' })
    expect(fetchMock).not.toHaveBeenCalled()

    await t.shutdown()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).batch).toHaveLength(2)
  })
})
