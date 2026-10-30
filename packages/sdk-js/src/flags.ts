// @clickroom/sdk-js — canonical feature-flag evaluation + remote fetch cache.
// Semantics are the SHARED SOURCE OF TRUTH. Any deviation
// breaks SDK<->server parity (AC-5/6/7). Keep byte-for-byte agreement with Rust + tRPC.

import { sha1 } from './sha1'

// ---- filter data model --------------------------------------------

export type FlagOperator = 'exact' | 'is_not' | 'icontains' | 'gt' | 'lt' | 'is_set'

export interface PropFilter {
  key: string
  operator: FlagOperator
  value: unknown
}

export interface Group {
  properties: PropFilter[]
  rollout_percentage: number
  variant?: string | null
  /** Boolean served to a matched, in-rollout user. Absent means `true`. */
  serve?: boolean
}

export interface Variant {
  key: string
  rollout_percentage: number
}

export interface Multivariate {
  variants: Variant[]
}

export interface Filters {
  groups: Group[]
  multivariate?: Multivariate
  payloads?: Record<string, unknown>
}

export interface Flag {
  key: string
  active: boolean
  filters: Filters
}

export interface FlagResult {
  enabled: boolean
  variant: string | null
  payload: unknown
  /**
   * Per-flag exposure-tracking gate. Carried in the server flag blob
   * as JSON field `track`. When false/absent, a client-side read must NOT emit a
   * `$feature_flag_called` exposure — operational gates stay silent; only flags
   * under measurement (experiments) track. Absent is treated as false.
   */
  track?: boolean
}

// ---- hash ----------------------------------------------------------

// 15 hex f's == 1152921504606846975. Built via BigInt(string) rather than a `…n`
// literal so the es2018 CDN bundle target accepts it (identical numeric value).
const HASH_DENOM = Number(BigInt('0xfffffffffffffff'))

/** Deterministic bucket in [0,1] — CLOSED, the numerator can reach the denominator:
 * int(sha1(key+"."+distinctId+salt)[0:15]) / 0xFFFFFFFFFFFFFFF. */
export function hashFlag(key: string, distinctId: string, salt: string): number {
  const hex = sha1(`${key}.${distinctId}${salt}`)
  // BigInt (not parseInt) — 15 hex chars is up to 60 bits, beyond 2^53 precision.
  const n = Number(BigInt(`0x${hex.slice(0, 15)}`))
  return n / HASH_DENOM
}

/**
 * Rollout membership for a bucket produced by `hashFlag`.
 *
 * The endpoint guards are not redundant with the `<` compare: `hashFlag` divides by
 * 0xFFFFFFFFFFFFFFF, a value the numerator can actually reach, so buckets live in the
 * CLOSED range [0,1] — not [0,1). Without the `>= 100` guard, the max-hash user would be
 * excluded from a 100% rollout; without the `<= 0` guard, the zero-hash user would still
 * be let into a 0% rollout under a non-strict compare. In between, the compare is strict
 * so a boundary bucket belongs to the next slice (matching `pickVariant`).
 */
export function inRollout(bucket: number, rolloutPercentage: number): boolean {
  if (rolloutPercentage <= 0) return false
  if (rolloutPercentage >= 100) return true
  return bucket < rolloutPercentage / 100
}

// ---- operators -----------------------------------------------------

/** actual = person_properties[key]; value = filter value. */
export function propMatch(op: FlagOperator, actual: unknown, value: unknown): boolean {
  switch (op) {
    case 'exact':
      return String(actual) === String(value)
    case 'is_not':
      return String(actual) !== String(value)
    case 'icontains':
      return actual != null && String(actual).toLowerCase().includes(String(value).toLowerCase())
    case 'gt':
      return actual != null && Number(actual) > Number(value)
    case 'lt':
      return actual != null && Number(actual) < Number(value)
    case 'is_set':
      return actual !== undefined && actual !== null
    default:
      return false
  }
}

const groupMatches = (props: PropFilter[], pp: Record<string, unknown>): boolean => {
  for (const p of props) {
    if (!propMatch(p.operator, pp[p.key], p.value)) return false
  }
  return true
}

const pickVariant = (flag: Flag, distinctId: string): string | null => {
  const variants = flag.filters.multivariate?.variants ?? []
  const f = hashFlag(flag.key, distinctId, 'variant')
  let cumulative = 0
  for (const v of variants) {
    cumulative += v.rollout_percentage / 100
    if (f < cumulative) return v.key // strict <
  }
  return variants.length > 0 ? variants[variants.length - 1].key : null
}

// ---- evaluate ------------------------------------------------------

/** First matching group wins; in-group-off stops (no fallthrough). */
export function evaluate(
  flag: Flag,
  distinctId: string,
  personProps: Record<string, unknown> = {},
): FlagResult {
  if (!flag.active) return { enabled: false, variant: null, payload: null }

  const filters = flag.filters ?? { groups: [] }
  for (const group of filters.groups ?? []) {
    if (!groupMatches(group.properties ?? [], personProps)) continue

    if (inRollout(hashFlag(flag.key, distinctId, ''), group.rollout_percentage)) {
      // Group pinned to serve OFF (boolean default groups) — stop, no fallthrough.
      if (group.serve === false) return { enabled: false, variant: null, payload: null }
      const variant = filters.multivariate ? pickVariant(flag, distinctId) : (group.variant ?? null)
      const payload = variant != null ? (filters.payloads?.[variant] ?? null) : null
      return { enabled: true, variant, payload }
    }
    // In-group but rolled out off — stop, no fallthrough.
    return { enabled: false, variant: null, payload: null }
  }

  return { enabled: false, variant: null, payload: null }
}

// ---- remote fetch cache client -----------------------------------------

const FLAGS_STORAGE_KEY = 'ckrm_flags'

export type FlagMap = Record<string, FlagResult>

export interface FlagsResponse {
  flags: FlagMap
}

const safeLocalStorage = (): Storage | null => {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

export interface FlagClientDeps {
  getApiHost: () => string
  getWriteKey: () => string
  getDistinctId: () => string
  getPersonProperties: () => Record<string, unknown>
}

export interface FlagClient {
  /** In-memory cache of the last evaluated flags (or restored from localStorage). */
  getCache(): FlagMap
  isFeatureEnabled(key: string): boolean
  getFeatureFlag(key: string): boolean | string
  getFeatureFlagPayload(key: string): unknown
  /** Fetch + cache flags for the current distinct id/props. Never throws. */
  fetchFlags(): Promise<FlagMap>
  /**
   * Cheap version check (GET `{apiHost}/flags/version`) before paying for a
   * full `fetchFlags()`. Only calls `fetchFlags()` (and updates the stored
   * `lastVersion`) when the returned version differs from the last one seen
   * — or on the very first check. Network/parse failure on the version check
   * fails open (treated as "changed") and falls through to a full fetch,
   * matching this client's existing never-throw/best-effort tolerance.
   * Never throws.
   */
  checkVersionAndMaybeFetch(force?: boolean): Promise<{ changed: boolean; flags: FlagMap }>
  /** Drop the in-memory + persisted cache. */
  clear(): void
}

export function createFlagClient(deps: FlagClientDeps): FlagClient {
  let cache: FlagMap = restoreCache()

  function restoreCache(): FlagMap {
    try {
      const raw = safeLocalStorage()?.getItem(FLAGS_STORAGE_KEY)
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
      safeLocalStorage()?.setItem(FLAGS_STORAGE_KEY, JSON.stringify(map))
    } catch {
      // ignore quota / disabled storage
    }
  }

  let lastVersion: number | undefined

  const buildUrl = (): string => {
    const base = deps.getApiHost().replace(/\/+$/, '')
    return `${base}/v1/flags`
  }

  const buildVersionUrl = (): string => {
    const base = deps.getApiHost().replace(/\/+$/, '')
    return `${base}/v1/flags/version`
  }

  const fetchFlags = async (): Promise<FlagMap> => {
    try {
      if (typeof fetch !== 'function') return cache
      const res = await fetch(buildUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${deps.getWriteKey()}`,
        },
        body: JSON.stringify({
          distinct_id: deps.getDistinctId(),
          person_properties: deps.getPersonProperties(),
        }),
      })
      if (!res.ok) return cache // fall back to existing cache
      const data = (await res.json()) as FlagsResponse
      const flags = data?.flags
      if (flags && typeof flags === 'object') {
        cache = flags
        persist(cache)
      }
      return cache
    } catch {
      // Network / parse failure — keep whatever cache we have (incl. localStorage).
      return cache
    }
  }

  // `force` bypasses the version gate. Flags are evaluated server-side against
  // the caller's person_properties, so the cache is only valid for the identity
  // it was fetched under. When distinct id / person props change (identify,
  // reset), the version is unchanged but the cached result is stale — the caller
  // must force a refetch under the new identity. See flag-identity.test.ts.
  const checkVersionAndMaybeFetch = async (
    force = false,
  ): Promise<{ changed: boolean; flags: FlagMap }> => {
    let changed = true
    let newVersion: number | undefined

    try {
      if (typeof fetch === 'function') {
        const res = await fetch(buildVersionUrl(), {
          method: 'GET',
          headers: {
            authorization: `Bearer ${deps.getWriteKey()}`,
          },
        })
        if (res.ok) {
          const data = (await res.json()) as { version?: number }
          newVersion = data?.version
          changed = lastVersion === undefined || newVersion !== lastVersion
        }
        // !res.ok — fail open, `changed` stays true (default).
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
    fetchFlags,
    checkVersionAndMaybeFetch,
    clear: () => {
      cache = {}
      try {
        safeLocalStorage()?.removeItem(FLAGS_STORAGE_KEY)
      } catch {
        // ignore
      }
    },
  }
}
