// @clickroom/sdk-js — batching transport with beacon + fetch fallback and bounded retry.

import type { ClickroomConfig, EventPayload } from './types'

const FLUSH_SIZE = 20
const BATCH_MAX = 100
const FLUSH_INTERVAL_MS = 3000

const RETRY_BASE_MS = 1000
const RETRY_CAP_MS = 30_000
const RETRY_MAX_EVENTS = 1000

export interface Transport {
  enqueue(event: EventPayload): void
  flush(useBeacon?: boolean): void
  teardown(): void
}

const isBrowser = (): boolean => typeof window !== 'undefined'

export function createTransport(
  getConfig: () => ClickroomConfig,
  getWriteKey: () => string,
): Transport {
  let buffer: EventPayload[] = []
  let retryBuffer: EventPayload[] = []
  let retryAttempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let interval: ReturnType<typeof setInterval> | null = null

  const buildUrl = (): string => {
    const { api_host } = getConfig()
    const base = api_host.replace(/\/+$/, '')
    return `${base}/v1/capture?token=${encodeURIComponent(getWriteKey())}`
  }

  const buildBody = (batch: EventPayload[]): string => JSON.stringify({ batch })

  const scheduleRetry = (): void => {
    if (retryTimer !== null || retryBuffer.length === 0) return
    const delay = Math.min(RETRY_BASE_MS * 2 ** retryAttempt, RETRY_CAP_MS)
    try {
      retryTimer = setTimeout(() => {
        retryTimer = null
        flush(false)
      }, delay)
    } catch {
      retryTimer = null
    }
  }

  const requeue = (batch: EventPayload[]): void => {
    // Re-queue oldest-first, dropping oldest when exceeding the cap.
    retryBuffer = retryBuffer.concat(batch)
    if (retryBuffer.length > RETRY_MAX_EVENTS) {
      retryBuffer = retryBuffer.slice(retryBuffer.length - RETRY_MAX_EVENTS)
    }
    retryAttempt = Math.min(retryAttempt + 1, 5)
    scheduleRetry()
  }

  const sendBeacon = (url: string, body: string): boolean => {
    try {
      if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
        return false
      }
      // `text/plain`, not `application/json`: sendBeacon() is *always*
      // credentialed (no opt-out) and a non-safelisted content-type makes it
      // a real cross-origin request subject to CORS credential checks —
      // servers that permissively echo `Access-Control-Allow-Origin: *` (or
      // any wildcard) get hard-rejected by the browser for a credentialed
      // request. `text/plain` keeps this a CORS-simple request, matching
      // posthog-js's same workaround. capture-rs parses the body as raw
      // bytes regardless of declared content-type, so this is a no-op
      // server-side.
      const blob = new Blob([body], { type: 'text/plain' })
      return navigator.sendBeacon(url, blob)
    } catch {
      return false
    }
  }

  // 4xx responses mean the server will never accept this batch as-is (e.g.
  // schema-invalid events) — retrying would just resend a request that's
  // permanently rejected. Surface it (matching the existing console.warn
  // idiom used elsewhere in this SDK — see index.ts's capture-before-init
  // warning) and drop the batch instead of requeuing it.
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

  const sendFetch = (url: string, body: string, batch: EventPayload[]): void => {
    try {
      if (typeof fetch !== 'function') {
        requeue(batch)
        return
      }
      fetch(url, {
        method: 'POST',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body,
      })
        .then((res) => {
          if (res.ok) {
            // Delivered — reset backoff.
            retryAttempt = 0
            if (retryBuffer.length > 0) scheduleRetry()
            return
          }
          if (res.status >= 500) {
            // Server-side/transient failure — retry with existing backoff.
            requeue(batch)
            return
          }
          // 4xx — permanent failure, do not retry.
          void reportRejection(res, batch)
        })
        .catch(() => {
          // Network error — retry with existing backoff.
          requeue(batch)
        })
    } catch {
      requeue(batch)
    }
  }

  function flush(useBeacon = false): void {
    if (!isBrowser()) {
      buffer = []
      return
    }
    // Drain pending + retry buffers into batches.
    const pending = retryBuffer.concat(buffer)
    buffer = []
    retryBuffer = []
    if (pending.length === 0) return

    try {
      const url = buildUrl()
      for (let i = 0; i < pending.length; i += BATCH_MAX) {
        const batch = pending.slice(i, i + BATCH_MAX)
        const body = buildBody(batch)
        if (useBeacon && sendBeacon(url, body)) continue
        if (useBeacon) {
          // Beacon unavailable during unload — best-effort fetch fallback.
          sendFetch(url, body, batch)
          continue
        }
        sendFetch(url, body, batch)
      }
    } catch {
      // Never throw from flush.
    }
  }

  const onVisibilityChange = (): void => {
    try {
      if (typeof document !== 'undefined' && document.hidden) flush(true)
    } catch {
      // ignore
    }
  }

  const onPageHide = (): void => {
    flush(true)
  }

  const enqueue = (event: EventPayload): void => {
    if (!isBrowser()) return
    try {
      buffer.push(event)
      if (buffer.length >= FLUSH_SIZE) flush(false)
    } catch {
      // ignore
    }
  }

  const teardown = (): void => {
    try {
      if (interval !== null) {
        clearInterval(interval)
        interval = null
      }
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', onPageHide)
        window.removeEventListener('beforeunload', onPageHide)
      }
    } catch {
      // ignore
    }
  }

  // Wire up timers + lifecycle listeners.
  if (isBrowser()) {
    try {
      interval = setInterval(() => flush(false), FLUSH_INTERVAL_MS)
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisibilityChange)
      }
      window.addEventListener('pagehide', onPageHide)
      window.addEventListener('beforeunload', onPageHide)
    } catch {
      // ignore
    }
  }

  return { enqueue, flush, teardown }
}
