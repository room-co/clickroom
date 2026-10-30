import { useEffect } from 'react'
import { getToken } from '@/lib/auth'
import { getApiOrigin } from '@/lib/runtime-config'
import { trpc } from '@/lib/trpc'

const MAX_RETRIES = 5
const BASE_RETRY_DELAY_MS = 1_000

/**
 * Subscribes to `/flags/stream?projectId=` and invalidates the flags
 * queries on every message — same invalidate calls already used after this
 * client's own mutations, no new cache-update path. Auth here is header-based
 * (`Authorization: Bearer`), matching the rest of the app, so this can't use
 * the native `EventSource` (no custom headers) — it reads the SSE body via
 * `fetch` + a stream reader instead, re-implementing just enough of the SSE
 * framing (`data: ...\n\n`) to parse messages.
 *
 * Best-effort: a dropped connection retries with backoff (capped) and
 * self-heals on the next successful reconnect; a permanently unreachable API
 * just means this client polls only via its own mutations, same as before
 * this hook existed.
 */
export function useFlagsStream(projectId: string | undefined): void {
  const utils = trpc.useUtils()

  useEffect(() => {
    if (!projectId) return

    const controller = new AbortController()
    let retries = 0
    let stopped = false

    async function connect() {
      const token = getToken()
      if (!token) return

      try {
        const res = await fetch(
          `${getApiOrigin()}/flags/stream?projectId=${encodeURIComponent(projectId as string)}`,
          {
            headers: { authorization: `Bearer ${token}` },
            signal: controller.signal,
          },
        )
        if (!res.ok || !res.body) throw new Error(`flags stream: ${res.status}`)

        retries = 0
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (!stopped) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          const frames = buffer.split('\n\n')
          buffer = frames.pop() ?? ''
          for (const frame of frames) {
            if (!frame.startsWith('data:')) continue
            await Promise.all([utils.flags.list.invalidate(), utils.flags.get.invalidate()])
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return
        if (err instanceof DOMException && err.name === 'AbortError') return
      }

      if (stopped || controller.signal.aborted || retries >= MAX_RETRIES) return
      retries += 1
      setTimeout(connect, BASE_RETRY_DELAY_MS * 2 ** (retries - 1))
    }

    connect()

    return () => {
      stopped = true
      controller.abort()
    }
  }, [projectId, utils])
}
