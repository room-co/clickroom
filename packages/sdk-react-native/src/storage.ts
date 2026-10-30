// @clickroom/sdk-react-native — sync-mirrored, async-write-behind store over a StorageAdapter.
//
// AsyncStorage (and friends) are async; the rest of this SDK wants synchronous reads (sessions,
// flag cache, distinct id) the way sdk-js gets them from `localStorage`. `hydrate()` loads the
// adapter into an in-memory `Map` once at `init()`; every read after that is synchronous against
// the mirror, and every write updates the mirror synchronously then fire-and-forgets a debounced
// persist. A null/undefined adapter (no AsyncStorage installed, no `storage` option passed)
// degrades to in-memory-only — state just doesn't survive an app restart, never throws.

import type { StorageAdapter } from './types'

const KEY_INDEX = 'ckrm_rn_keys'
const DEBOUNCE_MS = 250

export interface Store {
  hydrate(): Promise<void>
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
  clearPrefix(prefix: string): void
}

export function createStore(adapter: StorageAdapter | null | undefined): Store {
  const mirror = new Map<string, string>()
  const knownKeys = new Set<string>()
  let pendingIndexWrite: ReturnType<typeof setTimeout> | null = null
  const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>()

  const persistIndex = (): void => {
    if (!adapter) return
    if (pendingIndexWrite) clearTimeout(pendingIndexWrite)
    pendingIndexWrite = setTimeout(() => {
      pendingIndexWrite = null
      adapter.setItem(KEY_INDEX, JSON.stringify(Array.from(knownKeys))).catch(() => {
        // fire-and-forget — never let a rejected adapter write throw uncaught
      })
    }, DEBOUNCE_MS)
  }

  const trackKey = (key: string): void => {
    if (knownKeys.has(key)) return
    knownKeys.add(key)
    persistIndex()
  }

  const untrackKey = (key: string): void => {
    if (!knownKeys.has(key)) return
    knownKeys.delete(key)
    persistIndex()
  }

  const hydrate = async (): Promise<void> => {
    if (!adapter) return
    try {
      let keys: string[] | undefined
      if (adapter.getAllKeys) {
        keys = await adapter.getAllKeys()
      } else {
        const raw = await adapter.getItem(KEY_INDEX)
        keys = raw ? (JSON.parse(raw) as string[]) : []
      }
      for (const key of keys ?? []) {
        if (key === KEY_INDEX) continue
        const value = await adapter.getItem(key)
        if (value !== null) {
          mirror.set(key, value)
          knownKeys.add(key)
        }
      }
    } catch {
      // Corrupt index / adapter failure — start with an empty mirror, never throw.
    }
  }

  const get = (key: string): string | null => mirror.get(key) ?? null

  const set = (key: string, value: string): void => {
    mirror.set(key, value)
    trackKey(key)
    if (!adapter) return
    const existing = pendingWrites.get(key)
    if (existing) clearTimeout(existing)
    pendingWrites.set(
      key,
      setTimeout(() => {
        pendingWrites.delete(key)
        adapter.setItem(key, value).catch(() => {
          // fire-and-forget
        })
      }, DEBOUNCE_MS),
    )
  }

  const remove = (key: string): void => {
    mirror.delete(key)
    untrackKey(key)
    const existing = pendingWrites.get(key)
    if (existing) clearTimeout(existing)
    pendingWrites.delete(key)
    if (!adapter) return
    adapter.removeItem(key).catch(() => {
      // fire-and-forget
    })
  }

  const clearPrefix = (prefix: string): void => {
    for (const key of Array.from(mirror.keys())) {
      if (key.startsWith(prefix)) remove(key)
    }
  }

  return { hydrate, get, set, remove, clearPrefix }
}
