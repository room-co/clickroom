// @clickroom/sdk-js — session id + window id.
//
// Two ids, two scopes — mirrors posthog-js (`packages/browser/src/sessionid.ts`):
//
//   session id (`ckrm_sid`, localStorage)   — one *visit*, shared by every tab on
//     the origin, rotated when every tab has gone idle past IDLE_MS or the session
//     outlives the MAX_MS hard cap.
//   window id  (`ckrm_wid`, sessionStorage) — one *tab* within that visit.
//     sessionStorage is per-tab and survives reloads, so it is the natural home for
//     it. It is also *copied* into a duplicated tab, hence the `primary_window_exists`
//     clone check below.
//
// The in-memory tuple is the source of truth; storage is a write-through cache that
// must never throw out. With storage unavailable (private browsing, disabled storage,
// embedded webview) this degrades to one stable id per page load — not a fresh id per
// event, which is what the sessionStorage-only implementation used to do.

/** Idle window: once every tab has been silent this long, the next event starts a fresh session. */
const IDLE_MS = 30 * 60 * 1000
/** Hard cap: a single session never lives longer than this, even if continuously active. */
const MAX_MS = 24 * 60 * 60 * 1000

/** localStorage — origin-wide, shared across tabs. */
const SID_KEY = 'ckrm_sid'
/** sessionStorage — per tab. */
const WID_KEY = 'ckrm_wid'
/** sessionStorage — set while a tab is live, cleared on beforeunload. Absent after a reload,
 * present in a duplicated tab (sessionStorage is cloned) — that asymmetry is the clone check. */
const PRIMARY_WINDOW_KEY = 'ckrm_primary_window_exists'

interface StoredSession {
  /** Session id. */
  id: string
  /** Epoch ms the session started (for the MAX_MS cap). */
  start: number
  /** Epoch ms of the last captured activity (for the IDLE_MS rotation). */
  last: number
}

export interface SessionManager {
  /** Current session id, rotating first if idle/expired.
   * @param readOnly - a passive read: does not bump last-activity and does not idle-rotate
   *   (the MAX_MS cap still applies). Use for reads that are not user activity. */
  getSessionId(readOnly?: boolean): string
  /** Current window (tab) id. Stable for the life of the tab, fresh in a duplicated tab. */
  getWindowId(): string
  /** Forget the current session *and* window — the next read starts fresh ones. */
  reset(): void
  /** Clear the primary-window flag. Callers wire this to `beforeunload` so that a reload
   * (flag absent) keeps its window id while a tab clone (flag present) gets a new one. */
  clearPrimaryWindow(): void
}

export interface SessionDeps {
  /** Epoch ms clock (injectable for tests). */
  now: () => number
  /** localStorage accessor — holds the session id (SSR-safe; returns null when unavailable). */
  storage: () => Storage | null
  /** sessionStorage accessor — holds the window id. Omit/return null to fall back to memory. */
  sessionStorage?: () => Storage | null
  /** New id generator (shares the SDK's uuid helper). */
  genId: () => string
}

const parse = (raw: string | null): StoredSession | null => {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    if (
      v &&
      typeof v === 'object' &&
      typeof v.id === 'string' &&
      typeof v.start === 'number' &&
      typeof v.last === 'number'
    ) {
      return v as StoredSession
    }
  } catch {
    // fall through — treat as no session
  }
  return null
}

export function createSessionManager({
  now,
  storage,
  sessionStorage,
  genId,
}: SessionDeps): SessionManager {
  // ---- source of truth ---------------------------------------------------
  let session: StoredSession | null = null
  let windowId: string | null = null
  // The clone check runs once per manager, on the first window-id read.
  let windowResolved = false

  // ---- storage plumbing (best-effort; never throws) -----------------------

  const readStored = (): StoredSession | null => {
    try {
      return parse(storage()?.getItem(SID_KEY) ?? null)
    } catch {
      return null
    }
  }

  const save = (s: StoredSession): void => {
    try {
      storage()?.setItem(SID_KEY, JSON.stringify(s))
    } catch {
      // ignore — memory stays authoritative
    }
  }

  const tabStore = (): Storage | null => {
    try {
      return sessionStorage?.() ?? null
    } catch {
      return null
    }
  }

  const tabGet = (key: string): string | null => {
    try {
      return tabStore()?.getItem(key) ?? null
    } catch {
      return null
    }
  }

  const tabSet = (key: string, value: string): void => {
    try {
      tabStore()?.setItem(key, value)
    } catch {
      // ignore
    }
  }

  const tabRemove = (key: string): void => {
    try {
      tabStore()?.removeItem(key)
    } catch {
      // ignore
    }
  }

  // ---- session helpers ---------------------------------------------------

  /** Reconcile memory with what any sibling tab last wrote. Storage is shared
   * (localStorage), so the freshest `last` wins — that is the cross-tab idle
   * hardening: an idle tab sees an active sibling's activity, and a tab that
   * missed a rotation adopts the sibling's new id instead of minting a third. */
  const loadSession = (): StoredSession | null => {
    const persisted = readStored()
    if (!persisted) return session
    if (!session) return persisted
    if (persisted.id === session.id) {
      return {
        id: session.id,
        start: Math.min(session.start, persisted.start),
        last: Math.max(session.last, persisted.last),
      }
    }
    // Ids diverged — a sibling rotated. Whichever saw activity most recently wins.
    return persisted.last >= session.last ? persisted : session
  }

  const shouldRotate = (s: StoredSession | null, t: number, readOnly: boolean): boolean => {
    if (!s) return true
    if (t - s.start > MAX_MS) return true
    // A passive read must not rotate the session out from under an idle-but-live tab.
    if (readOnly) return false
    return t - s.last > IDLE_MS
  }

  /** The current session — the reconciled one when it's still alive, a brand-new one otherwise. */
  const adoptOrRotate = (t: number, readOnly: boolean): StoredSession => {
    const merged = loadSession()
    if (merged && !shouldRotate(merged, t, readOnly)) return merged
    return { id: genId(), start: t, last: t }
  }

  // ---- window helpers ----------------------------------------------------

  /** sessionStorage is copied into a duplicated tab / `window.open`, so a stored window id
   * alone doesn't prove ownership. The primary-window flag is cleared on `beforeunload`:
   *   id + no flag  → reload of this tab, keep the id.
   *   id + flag     → the source tab is still live, this is a clone → mint a fresh id. */
  const resolveWindowId = (): string => {
    if (!windowResolved) {
      windowResolved = true
      const existing = tabGet(WID_KEY)
      const cloned = tabGet(PRIMARY_WINDOW_KEY) !== null
      if (existing && !cloned) windowId = existing
      tabSet(PRIMARY_WINDOW_KEY, '1')
    }
    if (!windowId) {
      windowId = genId()
      tabSet(WID_KEY, windowId)
    }
    return windowId
  }

  const rotateWindowId = (): void => {
    windowId = null
    tabRemove(WID_KEY)
  }

  // ---- public ------------------------------------------------------------

  return {
    getSessionId(readOnly = false): string {
      const t = now()
      const previousId = session?.id ?? null
      const merged = adoptOrRotate(t, readOnly)
      const next = readOnly ? merged : { ...merged, last: t }
      // Persist a rotation even on a read-only call — otherwise the fresh id is
      // regenerated on the next read. Only the activity bump is read-only-gated.
      if (!readOnly || next.id !== previousId) save(next)
      session = next
      // A new visit gets a new window. Skipped on the very first read of a page load
      // (previousId === null) so a reload keeps the window id it restored from sessionStorage.
      if (previousId !== null && next.id !== previousId) rotateWindowId()
      return next.id
    },

    getWindowId(): string {
      return resolveWindowId()
    },

    reset(): void {
      session = null
      try {
        storage()?.removeItem(SID_KEY)
      } catch {
        // ignore
      }
      rotateWindowId()
    },

    clearPrimaryWindow(): void {
      tabRemove(PRIMARY_WINDOW_KEY)
    },
  }
}
