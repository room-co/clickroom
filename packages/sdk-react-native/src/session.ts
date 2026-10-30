// @clickroom/sdk-react-native — session id manager, modeled on packages/sdk-js/src/session.ts but
// simplified for a single-process mobile app: no window id, no cross-tab reconcile, no clone
// check (those all exist because a browser origin can have many tabs sharing one localStorage;
// a mobile app is one process).

const IDLE_MS = 30 * 60 * 1000
const MAX_MS = 24 * 60 * 60 * 1000

const SID_KEY = 'ckrm_sid'

export interface SessionStore {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

export interface SessionManager {
  /** Current session id, rotating first if idle/expired.
   * @param readOnly - a passive read: does not bump last-activity and does not idle-rotate
   *   (the MAX_MS cap still applies). */
  getSessionId(readOnly?: boolean): string
  /** Forget the current session — the next read starts a fresh one. */
  reset(): void
}

interface StoredSession {
  id: string
  start: number
  last: number
}

export interface SessionDeps {
  now: () => number
  store: SessionStore
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

export function createSessionManager({ now, store, genId }: SessionDeps): SessionManager {
  let session: StoredSession | null = null

  const loadSession = (): StoredSession | null => {
    if (session) return session
    return parse(store.get(SID_KEY))
  }

  const shouldRotate = (s: StoredSession | null, t: number, readOnly: boolean): boolean => {
    if (!s) return true
    if (t - s.start > MAX_MS) return true
    if (readOnly) return false
    return t - s.last > IDLE_MS
  }

  return {
    getSessionId(readOnly = false): string {
      const t = now()
      const current = loadSession()
      const next = shouldRotate(current, t, readOnly)
        ? { id: genId(), start: t, last: t }
        : { ...(current as StoredSession), last: readOnly ? (current as StoredSession).last : t }
      session = next
      store.set(SID_KEY, JSON.stringify(next))
      return next.id
    },

    reset(): void {
      session = null
      store.remove(SID_KEY)
    },
  }
}
