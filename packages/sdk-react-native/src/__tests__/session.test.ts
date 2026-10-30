import { beforeEach, describe, expect, it } from 'vitest'
import { createSessionManager, type SessionManager, type SessionStore } from '../session'

function memoryStore(): SessionStore {
  const map = new Map<string, string>()
  return {
    get: (k: string) => map.get(k) ?? null,
    set: (k: string, v: string) => {
      map.set(k, v)
    },
    remove: (k: string) => {
      map.delete(k)
    },
  }
}

const IDLE_MS = 30 * 60 * 1000
const MAX_MS = 24 * 60 * 60 * 1000

describe('createSessionManager (react native)', () => {
  let store: SessionStore
  let clock: number
  let ids: number
  let mgr: SessionManager

  beforeEach(() => {
    store = memoryStore()
    clock = 1_000_000
    ids = 0
    mgr = createSessionManager({
      now: () => clock,
      store,
      genId: () => `sess-${++ids}`,
    })
  })

  it('is stable within IDLE_MS', () => {
    const first = mgr.getSessionId()
    clock += 5 * 60 * 1000
    expect(mgr.getSessionId()).toBe(first)
  })

  it('rotates after IDLE_MS of inactivity', () => {
    const first = mgr.getSessionId()
    clock += IDLE_MS + 1
    const second = mgr.getSessionId()
    expect(second).not.toBe(first)
  })

  it('rotates at MAX_MS regardless of activity', () => {
    const first = mgr.getSessionId()
    for (let elapsed = 0; elapsed <= MAX_MS; elapsed += IDLE_MS) {
      clock += IDLE_MS
      mgr.getSessionId()
    }
    expect(mgr.getSessionId()).not.toBe(first)
  })

  it('a readOnly read never rotates on idle', () => {
    const first = mgr.getSessionId()
    clock += IDLE_MS + 1
    expect(mgr.getSessionId(true)).toBe(first)
  })

  it('a readOnly read still respects the MAX_MS hard cap', () => {
    const first = mgr.getSessionId()
    clock = 1_000_000 + MAX_MS + 1
    const capped = mgr.getSessionId(true)
    expect(capped).not.toBe(first)
  })

  it('reset() starts a fresh session', () => {
    const first = mgr.getSessionId()
    mgr.reset()
    const second = mgr.getSessionId()
    expect(second).not.toBe(first)
  })

  it('has no window id concept', () => {
    expect((mgr as unknown as { getWindowId?: unknown }).getWindowId).toBeUndefined()
  })
})
