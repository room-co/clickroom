// @clickroom/sdk-react-native — remote flag evaluation, mirroring the `createFlagClient` half of
// packages/sdk-js/src/flags.ts (its remote-fetch-cache client, not the local `evaluate()` — flags
// are ALWAYS evaluated server-side here, see the plan's "Key decisions": a write key must never
// evaluate flags locally, since that needs a read key which must never ship in an app binary).

import type { FlagMap, FlagResult } from '@clickroom/sdk-js/eval'
import type { Store } from './storage'

const FLAGS_STORAGE_KEY = 'ckrm_flags'

export interface FlagClientDeps {
  host: string
  writeKey: string
  getDistinctId(): string
  getPersonProperties(): Record<string, unknown>
  store: Store
}

export interface FlagClient {
  getCache(): FlagMap
  isFeatureEnabled(key: string): boolean
  getFeatureFlag(key: string): boolean | string
  getFeatureFlagPayload(key: string): unknown
  checkVersionAndMaybeFetch(force?: boolean): Promise<{ changed: boolean; flags: FlagMap }>
  clear(): void
}

export function createFlagClient(deps: FlagClientDeps): FlagClient {
  let cache: FlagMap = restoreCache()
  let lastVersion: number | undefined

  function restoreCache(): FlagMap {
    try {
      const raw = deps.store.get(FLAGS_STORAGE_KEY)
      if (!raw) return {}
      const parsed = JSON.parse(raw) as FlagMap
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // ignore corrupt cache
    }
    return {}
  }

  const persist = (map: FlagMap): void => {
    try {
      deps.store.set(FLAGS_STORAGE_KEY, JSON.stringify(map))
    } catch {
      // ignore
    }
  }

  const buildUrl = (): string => `${deps.host.replace(/\/+$/, '')}/v1/flags`
  const buildVersionUrl = (): string => `${deps.host.replace(/\/+$/, '')}/v1/flags/version`

  const fetchFlags = async (): Promise<FlagMap> => {
    try {
      if (typeof fetch !== 'function') return cache
      const res = await fetch(buildUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${deps.writeKey}`,
        },
        body: JSON.stringify({
          distinct_id: deps.getDistinctId(),
          person_properties: deps.getPersonProperties(),
        }),
      })
      if (!res.ok) return cache
      const data = (await res.json()) as { flags?: FlagMap }
      const flags = data?.flags
      if (flags && typeof flags === 'object') {
        cache = flags
        persist(cache)
      }
      return cache
    } catch {
      return cache
    }
  }

  const checkVersionAndMaybeFetch = async (
    force = false,
  ): Promise<{ changed: boolean; flags: FlagMap }> => {
    let changed = true
    let newVersion: number | undefined

    try {
      if (typeof fetch === 'function') {
        const res = await fetch(buildVersionUrl(), {
          method: 'GET',
          headers: { authorization: `Bearer ${deps.writeKey}` },
        })
        if (res.ok) {
          const data = (await res.json()) as { version?: number }
          newVersion = data?.version
          changed = lastVersion === undefined || newVersion !== lastVersion
        }
      }
    } catch {
      // Network / parse failure — fail open, `changed` stays true.
    }

    if (!force && !changed) return { changed: false, flags: cache }

    const flags = await fetchFlags()
    if (newVersion !== undefined) lastVersion = newVersion
    return { changed: true, flags }
  }

  return {
    getCache: () => cache,
    isFeatureEnabled: (key) => cache[key]?.enabled ?? false,
    getFeatureFlag: (key) => {
      const r = cache[key]
      if (!r?.enabled) return false
      return r.variant != null ? r.variant : true
    },
    getFeatureFlagPayload: (key) => cache[key]?.payload ?? null,
    checkVersionAndMaybeFetch,
    clear: () => {
      cache = {}
      try {
        deps.store.remove(FLAGS_STORAGE_KEY)
      } catch {
        // ignore
      }
    },
  }
}

export type { FlagMap, FlagResult }
