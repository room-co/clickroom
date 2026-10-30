// @clickroom/sdk-node — local flag evaluation: poll `GET /flag-definitions`, evaluate in-process
// with the shared hash (@clickroom/sdk-js/eval) for parity with the browser SDK + Rust.

import { evaluate, type Flag, type FlagResult } from '@clickroom/sdk-js/eval'

export interface FlagPollerOptions {
  host: string
  readKey: string
  pollInterval: number
}

export interface FlagPoller {
  getFlag(key: string, distinctId: string, personProperties?: Record<string, unknown>): FlagResult
  getAllFlags(
    distinctId: string,
    personProperties?: Record<string, unknown>,
  ): Record<string, FlagResult>
  refresh(): Promise<void>
  shutdown(): void
}

interface FlagDefinitionsResponse {
  flags: Flag[]
  version: number
}

export function createFlagPoller(opts: FlagPollerOptions): FlagPoller {
  let flags: Flag[] = []
  let interval: ReturnType<typeof setInterval> | null = null

  const url = `${opts.host.replace(/\/+$/, '')}/v1/flag-definitions`

  const refresh = async (): Promise<void> => {
    try {
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${opts.readKey}` },
      })
      if (!res.ok) return // keep last-known-good defs on failure
      const body = (await res.json()) as FlagDefinitionsResponse
      flags = body.flags ?? []
    } catch {
      // network/parse failure — keep whatever defs we already have
    }
  }

  const getFlag = (
    key: string,
    distinctId: string,
    personProperties: Record<string, unknown> = {},
  ): FlagResult => {
    const flag = flags.find((f) => f.key === key)
    if (!flag) return { enabled: false, variant: null, payload: null }
    return evaluate(flag, distinctId, personProperties)
  }

  const getAllFlags = (
    distinctId: string,
    personProperties: Record<string, unknown> = {},
  ): Record<string, FlagResult> => {
    const out: Record<string, FlagResult> = {}
    for (const flag of flags) {
      out[flag.key] = evaluate(flag, distinctId, personProperties)
    }
    return out
  }

  const shutdown = (): void => {
    if (interval !== null) {
      clearInterval(interval)
      interval = null
    }
  }

  interval = setInterval(() => void refresh(), opts.pollInterval)
  interval.unref?.()

  return { getFlag, getAllFlags, refresh, shutdown }
}
