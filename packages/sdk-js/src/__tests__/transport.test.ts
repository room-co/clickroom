// sdk-js transport: /v1/capture endpoint + 4xx-vs-5xx retry semantics.
// 4xx means the server will never accept the batch as-is (e.g. schema-invalid
// events, coming with the capture hot-path's stricter validation) — retrying
// is pointless, so those batches are dropped and surfaced via console.warn
// instead of requeued. 5xx / network errors keep the existing backoff retry.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTransport } from '../transport'
import type { EventPayload } from '../types'

const makeEvent = (): EventPayload => ({
  event: 'a',
  distinct_id: 'u1',
  timestamp: new Date().toISOString(),
  properties: {},
})

describe('sdk-js transport', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.stubGlobal('window', {} as unknown as Window)
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const makeTransport = () =>
    createTransport(
      () => ({
        api_host: 'https://i.example.com',
        autocapture: false,
        capture_pageview: false,
        surveys: false,
        survey_poll_interval: 0,
        support: { enabled: false, mode: 'launcher' },
        support_poll_interval: 0,
      }),
      () => 'ckw_test',
    )

  it('posts batches to /v1/capture', () => {
    fetchMock.mockResolvedValue({ ok: true, status: 202, json: async () => ({}) })
    const t = makeTransport()
    t.enqueue(makeEvent())
    t.flush(false)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/v1/capture')
    t.teardown()
  })

  it('a 400 response is not retried and is surfaced via console.warn', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ accepted: 0, errors: ['event: unknown property "foo"'] }),
    })
    const t = makeTransport()
    t.enqueue(makeEvent())
    t.flush(false)

    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('400')
    expect(warnSpy.mock.calls[0][1]).toMatchObject({ accepted: 0 })

    // No requeue — later timer ticks (retry backoff + the flush interval)
    // must not trigger another fetch.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    warnSpy.mockRestore()
    t.teardown()
  })

  it('a 500 response is requeued and retried (existing behavior preserved)', async () => {
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({}) })
    const t = makeTransport()
    t.enqueue(makeEvent())
    t.flush(false)

    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    t.teardown()
  })
})
