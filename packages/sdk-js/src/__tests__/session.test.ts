import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { createSessionManager, type SessionManager } from '../session'

// Minimal in-memory Storage stub for the node test env. Used for both the
// localStorage (session id) and sessionStorage (window id) slots — the
// cross-tab tests share one instance for the former and hand each "tab" its
// own instance of the latter, which is exactly the browser's topology.
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => map.delete(k),
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
  } as Storage
}

const IDLE_MS = 30 * 60 * 1000
const MAX_MS = 24 * 60 * 60 * 1000

const SID_KEY = 'ckrm_sid'
const WID_KEY = 'ckrm_wid'
const PRIMARY_WINDOW_KEY = 'ckrm_primary_window_exists'

describe('createSessionManager', () => {
  let store: Storage
  let clock: number
  let ids: number
  let mgr: SessionManager

  beforeEach(() => {
    store = memoryStorage()
    clock = 1_000_000
    ids = 0
    mgr = createSessionManager({
      now: () => clock,
      storage: () => store,
      genId: () => `sess-${++ids}`,
    })
  })

  it('is stable across calls within one session', () => {
    const first = mgr.getSessionId()
    clock += 5 * 60 * 1000 // 5 min later, still active
    expect(mgr.getSessionId()).toBe(first)
    expect(first).toBe('sess-1')
  })

  it('persists the session to storage', () => {
    const id = mgr.getSessionId()
    const raw = store.getItem(SID_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw as string)
    expect(parsed.id).toBe(id)
    expect(parsed.start).toBe(1_000_000)
  })

  it('rotates after the idle window', () => {
    const first = mgr.getSessionId()
    clock += IDLE_MS + 1 // idle past the timeout
    const second = mgr.getSessionId()
    expect(second).not.toBe(first)
    expect(second).toBe('sess-2')
  })

  it('does NOT rotate right at the idle boundary while active', () => {
    const first = mgr.getSessionId()
    clock += IDLE_MS // exactly the window, activity resets last
    expect(mgr.getSessionId()).toBe(first)
  })

  it('rotates after the 24h hard cap even when continuously active', () => {
    const first = mgr.getSessionId()
    // Stay active in sub-idle steps until past the max cap.
    for (let elapsed = 0; elapsed <= MAX_MS; elapsed += IDLE_MS) {
      clock += IDLE_MS
      mgr.getSessionId()
    }
    const capped = mgr.getSessionId()
    expect(capped).not.toBe(first)
  })

  it('starts a fresh session after reset()', () => {
    const first = mgr.getSessionId()
    mgr.reset()
    expect(store.getItem(SID_KEY)).toBeNull()
    const second = mgr.getSessionId()
    expect(second).not.toBe(first)
  })

  it('reset() rotates the window id as well as the session id', () => {
    const tab = memoryStorage()
    const m = createSessionManager({
      now: () => clock,
      storage: () => store,
      sessionStorage: () => tab,
      genId: () => `id-${++ids}`,
    })
    const sid = m.getSessionId()
    const wid = m.getWindowId()

    m.reset()

    expect(m.getSessionId()).not.toBe(sid)
    expect(m.getWindowId()).not.toBe(wid)
  })

  // ---- readOnly reads -----------------------------------------------------

  it('a readOnly read does NOT extend the idle clock', () => {
    const first = mgr.getSessionId()
    // Four passive reads spanning 40 min — none of them is activity.
    for (let i = 0; i < 4; i++) {
      clock += 10 * 60 * 1000
      expect(mgr.getSessionId(true)).toBe(first)
    }
    // 40 min since the last *activity* → the next real read must rotate.
    expect(mgr.getSessionId()).not.toBe(first)
  })

  it('a readOnly read does NOT rotate on idle, but DOES rotate past the max cap', () => {
    const first = mgr.getSessionId()

    clock += IDLE_MS + 1
    expect(mgr.getSessionId(true)).toBe(first) // idle: passive read keeps it

    clock = 1_000_000 + MAX_MS + 1
    const capped = mgr.getSessionId(true)
    expect(capped).not.toBe(first) // max age: the cap still applies
    // The rotation is persisted even though the read was passive, so it is not
    // re-minted on every subsequent read.
    expect(mgr.getSessionId(true)).toBe(capped)
  })
})

// ---- cross-tab (the point of the shared session id) ------------------------------------

describe('createSessionManager cross-tab', () => {
  let local: Storage // one origin-wide localStorage, shared by both "tabs"
  let tabA: Storage // per-tab sessionStorage
  let tabB: Storage
  let clock: number
  let ids: number
  let a: SessionManager
  let b: SessionManager

  beforeEach(() => {
    local = memoryStorage()
    tabA = memoryStorage()
    tabB = memoryStorage()
    clock = 1_000_000
    ids = 0
    const genId = () => `id-${++ids}`
    a = createSessionManager({
      now: () => clock,
      storage: () => local,
      sessionStorage: () => tabA,
      genId,
    })
    b = createSessionManager({
      now: () => clock,
      storage: () => local,
      sessionStorage: () => tabB,
      genId,
    })
  })

  it('two tabs share one session id but get distinct window ids', () => {
    expect(b.getSessionId()).toBe(a.getSessionId())
    expect(a.getWindowId()).not.toBe(b.getWindowId())
    // and each window id is stable within its own tab
    expect(a.getWindowId()).toBe(a.getWindowId())
  })

  it('an idle tab does not rotate the session an active sibling is still using', () => {
    const first = a.getSessionId()
    expect(b.getSessionId()).toBe(first)

    clock += 20 * 60 * 1000
    a.getSessionId() // tab A is active; persists last = t0 + 20min

    clock += 20 * 60 * 1000 // tab B has now been silent for 40 min (> IDLE_MS)
    expect(b.getSessionId()).toBe(first) // A's persisted activity keeps it alive
    expect(ids).toBe(1) // exactly one session id ever generated
  })

  it('a tab that missed a sibling rotation adopts its id instead of minting a third', () => {
    const first = a.getSessionId()
    expect(b.getSessionId()).toBe(first)

    clock += IDLE_MS + 1
    const rotated = a.getSessionId() // A rotates
    expect(rotated).not.toBe(first)

    expect(b.getSessionId()).toBe(rotated) // B adopts, does not mint a third
    expect(ids).toBe(2) // exactly two session ids ever generated
  })

  it('when every tab is idle past the timeout the session rotates exactly once', () => {
    const first = a.getSessionId()
    b.getSessionId()

    clock += IDLE_MS + 1
    const fromA = a.getSessionId()
    const fromB = b.getSessionId()

    expect(fromA).not.toBe(first)
    expect(fromB).toBe(fromA) // both tabs converge on the same new session
    expect(ids).toBe(2)
  })
})

// ---- window id ------------------------------------------------------------

describe('createSessionManager window id', () => {
  let local: Storage
  let tab: Storage
  let clock: number
  let ids: number

  const make = (): SessionManager =>
    createSessionManager({
      now: () => clock,
      storage: () => local,
      sessionStorage: () => tab,
      genId: () => `id-${++ids}`,
    })

  beforeEach(() => {
    local = memoryStorage()
    tab = memoryStorage()
    clock = 1_000_000
    ids = 0
  })

  it('is stable across calls within a tab', () => {
    const mgr = make()
    const wid = mgr.getWindowId()
    expect(mgr.getWindowId()).toBe(wid)
    expect(tab.getItem(WID_KEY)).toBe(wid)
  })

  it('survives a reload — window id kept, primary-window flag absent', () => {
    const mgr = make()
    const wid = mgr.getWindowId()
    mgr.clearPrimaryWindow() // beforeunload
    expect(tab.getItem(PRIMARY_WINDOW_KEY)).toBeNull()

    // Same tab, same sessionStorage contents, new page load → same manager state.
    const reloaded = make()
    expect(reloaded.getWindowId()).toBe(wid)
  })

  it('mints a fresh window id in a duplicated tab (sessionStorage cloned with the flag set)', () => {
    const source = make()
    const wid = source.getWindowId()
    expect(tab.getItem(PRIMARY_WINDOW_KEY)).not.toBeNull()

    // A duplicated tab gets a *copy* of sessionStorage — window id AND the
    // primary-window flag, because the source tab never unloaded.
    const clonedTab = memoryStorage()
    clonedTab.setItem(WID_KEY, wid)
    clonedTab.setItem(PRIMARY_WINDOW_KEY, '1')
    const clone = createSessionManager({
      now: () => clock,
      storage: () => local,
      sessionStorage: () => clonedTab,
      genId: () => `id-${++ids}`,
    })

    const cloneWid = clone.getWindowId()
    expect(cloneWid).not.toBe(wid)
    expect(clonedTab.getItem(WID_KEY)).toBe(cloneWid)
  })

  it('rotates when the session rotates', () => {
    const mgr = make()
    mgr.getSessionId()
    const wid = mgr.getWindowId()

    clock += IDLE_MS + 1
    mgr.getSessionId() // new session

    expect(mgr.getWindowId()).not.toBe(wid)
  })

  it('falls back to an in-memory window id when sessionStorage is unavailable', () => {
    const mgr = createSessionManager({
      now: () => clock,
      storage: () => local,
      sessionStorage: () => null,
      genId: () => `id-${++ids}`,
    })
    const wid = mgr.getWindowId()
    expect(wid).toBeTruthy()
    expect(mgr.getWindowId()).toBe(wid)
  })
})

// ---- storage failure (regression guard for bug A) -----------------
//
// With storage unavailable the manager must degrade to ONE stable id per page
// load. The old sessionStorage-only implementation minted a fresh id on every
// single call, so every event became its own session.

describe('createSessionManager with unusable storage', () => {
  let clock: number
  let genId: Mock<() => string>

  beforeEach(() => {
    clock = 1_000_000
    let n = 0
    genId = vi.fn<() => string>(() => `sess-${++n}`)
  })

  const assertStableAcross = (mgr: SessionManager): void => {
    const first = mgr.getSessionId()
    for (let i = 0; i < 10; i++) {
      clock += 60 * 1000 // active — well inside the idle window
      expect(mgr.getSessionId()).toBe(first)
    }
    expect(genId).toHaveBeenCalledTimes(1)
  }

  it('returns a stable id when there is no storage at all', () => {
    assertStableAcross(createSessionManager({ now: () => clock, storage: () => null, genId }))
  })

  it('returns a stable id when setItem throws', () => {
    const throwingSet = {
      ...memoryStorage(),
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    } as unknown as Storage
    assertStableAcross(
      createSessionManager({ now: () => clock, storage: () => throwingSet, genId }),
    )
  })

  it('returns a stable id when getItem throws', () => {
    const throwingGet = {
      ...memoryStorage(),
      getItem: () => {
        throw new Error('SecurityError')
      },
    } as unknown as Storage
    assertStableAcross(
      createSessionManager({ now: () => clock, storage: () => throwingGet, genId }),
    )
  })
})
