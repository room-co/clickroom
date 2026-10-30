// @clickroom/sdk-node — batching transport (POST /capture), bounded exponential-backoff retry.
// Mirrors packages/sdk-js/src/transport.ts semantics, minus beacon/visibility (no DOM in Node).

import type { EventPayload } from './types'

const BATCH_MAX = 100 // contracts/capture-api.md: <=100 events/batch

export interface TransportOptions {
  host: string
  writeKey: string
  flushAt: number
  flushInterval: number
  maxRetries: number
}

export interface Transport {
  enqueue(event: EventPayload): void
  flush(): Promise<void>
  shutdown(): Promise<void>
}

const RETRY_BASE_MS = 1000
const RETRY_CAP_MS = 30_000

export function createTransport(opts: TransportOptions): Transport {
  let buffer: EventPayload[] = []
  let interval: ReturnType<typeof setInterval> | null = null

  const url = `${opts.host.replace(/\/+$/, '')}/v1/capture`

  // 4xx (other than 429, which is rate-limiting and retriable) means the
  // server will never accept this batch as-is (e.g. schema-invalid events) —
  // retrying is pointless. Surface it via console.warn (mirroring
  // packages/sdk-js/src/transport.ts's equivalent behavior) instead of
  // silently dropping it.
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
          if (attempt >= opts.maxRetries) return // drop after exhausting retries
          const retryAfter = Number(res.headers.get('retry-after'))
          const delay =
            Number.isFinite(retryAfter) && retryAfter >= 0
              ? retryAfter * 1000
              : Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS)
          await new Promise((r) => setTimeout(r, delay))
          attempt += 1
          continue
        }
        // 4xx other than 429 — permanent failure, do not retry.
        await reportRejection(res, batch)
        return
      } catch {
        if (attempt >= opts.maxRetries) return
        const delay = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS)
        await new Promise((r) => setTimeout(r, delay))
        attempt += 1
      }
    }
  }

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return
    const pending = buffer
    buffer = []
    const chunks: EventPayload[][] = []
    for (let i = 0; i < pending.length; i += BATCH_MAX) {
      chunks.push(pending.slice(i, i + BATCH_MAX))
    }
    await Promise.all(chunks.map(sendBatch))
  }

  const enqueue = (event: EventPayload): void => {
    buffer.push(event)
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
  interval.unref?.()

  return { enqueue, flush, shutdown }
}
