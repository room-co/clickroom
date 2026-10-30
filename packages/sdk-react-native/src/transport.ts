// @clickroom/sdk-react-native — batching transport (POST /v1/capture), bounded exponential-backoff
// retry. Mirrors packages/sdk-node/src/transport.ts's retry classification (read that file first),
// extended with a store-backed persisted overflow queue so events survive an app kill between
// enqueue and flush, and a hard cap on total buffered+queued events.

import type { Store } from './storage'
import type { EventPayload } from './types'

const BATCH_MAX = 100 // contracts/capture-api.md: <=100 events/batch
const MAX_BUFFERED_EVENTS = 1000 // drop-oldest cap, mirrors sdk-js's RETRY_MAX_EVENTS
const MAX_CHUNK_BYTES = 1_000_000 // never send a request guaranteed to 413

const RETRY_BASE_MS = 1000
const RETRY_CAP_MS = 30_000

const QUEUE_KEY = 'ckrm_queue'

export interface TransportOptions {
  host: string
  writeKey: string
  flushAt: number
  flushInterval: number
  maxRetries: number
  store: Store
}

export interface Transport {
  enqueue(event: EventPayload): void
  flush(): Promise<void>
  shutdown(): Promise<void>
}

export function createTransport(opts: TransportOptions): Transport {
  const persisted = loadQueue(opts.store)
  let buffer: EventPayload[] = persisted
  let interval: ReturnType<typeof setInterval> | null = null

  const url = `${opts.host.replace(/\/+$/, '')}/v1/capture`

  const persistBuffer = (): void => {
    try {
      opts.store.set(QUEUE_KEY, JSON.stringify(buffer))
    } catch {
      // never let a persistence failure crash a capture call
    }
  }

  const reportRejection = async (res: Response, batch: EventPayload[]): Promise<void> => {
    let detail: unknown
    try {
      detail = await res.json()
    } catch {
      // Non-JSON or empty body — surface status only.
    }
    console.warn(
      `[clickroom] capture() batch rejected by server (HTTP ${res.status}); dropping ${batch.length} event(s)`,
      detail,
    )
  }

  const sendBatch = async (batch: EventPayload[]): Promise<void> => {
    let attempt = 0
    for (;;) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${opts.writeKey}`,
          },
          body: JSON.stringify({ batch }),
        })
        if (res.ok) return
        if (res.status === 429 || res.status >= 500) {
          if (attempt >= opts.maxRetries) {
            console.warn(
              `[clickroom] capture() batch dropped after ${opts.maxRetries} retries (HTTP ${res.status})`,
            )
            return
          }
          const retryAfter = Number(res.headers.get('retry-after'))
          const delay =
            Number.isFinite(retryAfter) && retryAfter >= 0
              ? retryAfter * 1000
              : Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS)
          await new Promise((r) => setTimeout(r, delay))
          attempt += 1
          continue
        }
        if (res.status === 401) {
          console.warn(
            '[clickroom] capture() got HTTP 401 — check that `writeKey` is a valid write key',
          )
          return
        }
        if (res.status === 402 || res.status === 413) {
          await reportRejection(res, batch)
          return
        }
        // 4xx other than 429/401/402/413 — permanent failure, do not retry.
        await reportRejection(res, batch)
        return
      } catch {
        if (attempt >= opts.maxRetries) {
          console.warn(`[clickroom] capture() batch dropped after ${opts.maxRetries} retries`)
          return
        }
        const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS)
        await new Promise((r) => setTimeout(r, delay))
        attempt += 1
      }
    }
  }

  const chunkBatches = (events: EventPayload[]): EventPayload[][] => {
    const chunks: EventPayload[][] = []
    for (let i = 0; i < events.length; i += BATCH_MAX) {
      const chunk = events.slice(i, i + BATCH_MAX)
      if (JSON.stringify({ batch: chunk }).length > MAX_CHUNK_BYTES) {
        if (chunk.length === 1) {
          console.warn('[clickroom] dropping a single event that exceeds the size guard')
          continue
        }
        // Split oversized chunk further, single-event at a time, dropping any that still
        // exceed the guard on its own.
        for (const event of chunk) {
          if (JSON.stringify({ batch: [event] }).length > MAX_CHUNK_BYTES) {
            console.warn('[clickroom] dropping a single event that exceeds the size guard')
            continue
          }
          chunks.push([event])
        }
        continue
      }
      chunks.push(chunk)
    }
    return chunks
  }

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return
    const pending = buffer
    buffer = []
    persistBuffer()
    const chunks = chunkBatches(pending)
    await Promise.all(chunks.map(sendBatch))
    // Whatever's left in `buffer` at this point was enqueued *during* the flush — persist it
    // so an app kill mid-flush doesn't lose it.
    persistBuffer()
  }

  const enqueue = (event: EventPayload): void => {
    buffer.push(event)
    if (buffer.length > MAX_BUFFERED_EVENTS) {
      buffer = buffer.slice(buffer.length - MAX_BUFFERED_EVENTS)
    }
    persistBuffer()
    if (buffer.length >= opts.flushAt) void flush()
  }

  const shutdown = async (): Promise<void> => {
    if (interval !== null) {
      clearInterval(interval)
      interval = null
    }
    await flush()
  }

  interval = setInterval(() => void flush(), opts.flushInterval)
  interval.unref?.() // no-op in RN's JS engine; harmless, keeps this portable to Node tests

  return { enqueue, flush, shutdown }
}

function loadQueue(store: Store): EventPayload[] {
  try {
    const raw = store.get(QUEUE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as EventPayload[]) : []
  } catch {
    return []
  }
}
