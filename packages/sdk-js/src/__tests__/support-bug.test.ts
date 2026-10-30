// sdk-js support bug capture.
//
// The load-bearing property of this module is that it is *non-destructive*:
// every wrapper calls through, returns/rethrows exactly what the original
// produced, and only un-patches on teardown when it is still the outermost
// patcher. Those are the cases this file guards hardest — a regression there
// breaks a customer's page, not ours.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUG_PAYLOAD_BUDGET_BYTES, createBugCapture, redactText, redactUrl } from '../support-bug'

const API_HOST = 'https://capture.clickroom.test'

interface FakeWindow {
  fetch?: unknown
  XMLHttpRequest?: unknown
  addEventListener: (type: string, handler: (event: unknown) => void) => void
  removeEventListener: (type: string, handler: (event: unknown) => void) => void
  innerWidth?: number
  innerHeight?: number
  screen?: { width: number; height: number }
}

const makeWindow = (over: Partial<FakeWindow> = {}): FakeWindow => ({
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  ...over,
})

const makeCapture = (now?: () => number) =>
  createBugCapture({ getApiHost: () => API_HOST, ...(now ? { now } : {}) })

describe('redactText', () => {
  it('redacts Bearer and Basic credentials', () => {
    expect(redactText('Authorization: Bearer abc123.def-456')).toBe(
      'Authorization: Bearer [redacted]',
    )
    expect(redactText('basic QWxhZGRpbjpvcGVu')).toBe('basic [redacted]')
  })

  it('redacts a JWT anywhere in the text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dBjftJeZ4CVPmB92K27u'
    expect(redactText(`failed with ${jwt} oops`)).toBe('failed with [redacted] oops')
  })

  it('redacts token / key / password style key-value pairs', () => {
    expect(redactText('password: hunter2')).toBe('password: [redacted]')
    expect(redactText('api_key=abc123')).toBe('api_key=[redacted]')
    expect(redactText('access_token=zzz&keep=me')).toBe('access_token=[redacted]&keep=me')
  })

  it('leaves innocuous text alone and is safe on empty input', () => {
    expect(redactText('TypeError: x is not a function')).toBe('TypeError: x is not a function')
    expect(redactText('')).toBe('')
  })
})

describe('redactUrl', () => {
  it('redacts secret-looking query params, keeping the rest', () => {
    expect(redactUrl('https://app.test/a?token=abc&page=2')).toBe(
      'https://app.test/a?token=[redacted]&page=2',
    )
    expect(redactUrl('https://app.test/a?apiKey=abc')).toBe('https://app.test/a?apiKey=[redacted]')
    expect(redactUrl('https://app.test/a?password=hunter2')).toBe(
      'https://app.test/a?password=[redacted]',
    )
  })

  it('redacts a JWT that appears as a non-obvious param value', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dBjftJeZ4CVPmB92K27u'
    expect(redactUrl(`https://app.test/cb?id=${jwt}`)).toBe('https://app.test/cb?id=[redacted]')
  })

  it('never throws on relative or malformed input', () => {
    expect(redactUrl('/v1/things?secret=x')).toBe('/v1/things?secret=[redacted]')
    expect(redactUrl('not a url at all')).toBe('not a url at all')
    expect(redactUrl('')).toBe('')
  })

  it('truncates to 2048 chars', () => {
    expect(redactUrl(`https://app.test/${'a'.repeat(4000)}`).length).toBe(2048)
  })
})

describe('no-DOM posture', () => {
  it('install() and snapshotEnvironment() are no-ops without a window', () => {
    expect(typeof window).toBe('undefined')
    const capture = makeCapture()
    expect(() => capture.install()).not.toThrow()
    expect(capture.snapshotEnvironment()).toEqual({})
    expect(capture.buildBugReport().environment).toBeUndefined()
    expect(() => capture.destroy()).not.toThrow()
  })
})

describe('snapshotEnvironment', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('mirrors baseProperties + timezone', () => {
    vi.stubGlobal(
      'window',
      makeWindow({ innerWidth: 800, innerHeight: 600, screen: { width: 1440, height: 900 } }),
    )
    vi.stubGlobal('location', { href: 'https://app.test/page?token=abc' })
    vi.stubGlobal('document', { referrer: 'https://ref.test/from' })
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      language: 'en-GB',
    })

    const env = makeCapture().snapshotEnvironment()
    expect(env.url).toBe('https://app.test/page?token=[redacted]')
    expect(env.referrer).toBe('https://ref.test/from')
    expect(env.viewportWidth).toBe(800)
    expect(env.viewportHeight).toBe(600)
    expect(env.screenWidth).toBe(1440)
    expect(env.screenHeight).toBe(900)
    expect(env.browser).toBe('Chrome')
    expect(env.browserVersion).toBe('120')
    expect(env.os).toBe('macOS')
    expect(env.deviceType).toBe('Desktop')
    expect(env.locale).toBe('en-GB')
    expect(typeof env.timezone).toBe('string')
    // `.strict()` on the zod side — no undefined-valued keys may survive.
    expect(Object.values(env).every((v) => v !== undefined)).toBe(true)
  })
})

describe('console wrapper', () => {
  let realConsole: Console

  beforeEach(() => {
    realConsole = globalThis.console
    vi.stubGlobal('window', makeWindow())
  })

  afterEach(() => {
    globalThis.console = realConsole
    vi.unstubAllGlobals()
  })

  const stubConsole = () => {
    const fake = {
      error: vi.fn(() => 'error-return'),
      warn: vi.fn(() => 'warn-return'),
    }
    vi.stubGlobal('console', fake)
    return fake
  }

  it('passes args through and returns the original return value', () => {
    const fake = stubConsole()
    // Patching mutates the console object in place, so grab the original first.
    const originalError = fake.error
    const capture = makeCapture()
    capture.install()

    const err = new Error('boom')
    const returned = console.error('failed', 42, err)

    expect(returned).toBe('error-return')
    expect(originalError).toHaveBeenCalledWith('failed', 42, err)
    expect(console.warn('careful')).toBe('warn-return')

    const report = capture.buildBugReport()
    expect(report.consoleErrors).toHaveLength(2)
    expect(report.consoleErrors?.[0]).toMatchObject({
      level: 'error',
      message: 'failed 42 Error: boom',
    })
    expect(report.consoleErrors?.[1]).toMatchObject({ level: 'warn', message: 'careful' })
    capture.destroy()
  })

  it('redacts and truncates the recorded message', () => {
    stubConsole()
    const capture = makeCapture()
    capture.install()
    console.error(`auth failed for token=abc123 ${'x'.repeat(3000)}`)
    const entry = capture.buildBugReport().consoleErrors?.[0]
    expect(entry?.message).toContain('token=[redacted]')
    expect(entry?.message.length).toBe(2000)
    capture.destroy()
  })

  it('does not break console.error when recording throws', () => {
    const fake = stubConsole()
    const originalError = fake.error
    const capture = makeCapture(() => {
      throw new Error('clock exploded')
    })
    capture.install()

    expect(() => console.error('still works')).not.toThrow()
    expect(console.error('again')).toBe('error-return')
    expect(originalError).toHaveBeenCalledWith('still works')
    capture.destroy()
  })

  it('caps the ring at 20, keeping the newest', () => {
    stubConsole()
    const capture = makeCapture()
    capture.install()
    for (let i = 0; i < 25; i++) console.error(`entry-${i}`)

    const entries = capture.buildBugReport().consoleErrors ?? []
    expect(entries).toHaveLength(20)
    expect(entries[0]?.message).toBe('entry-5')
    expect(entries[19]?.message).toBe('entry-24')
    capture.destroy()
  })

  it('destroy() restores the originals', () => {
    const fake = stubConsole()
    const originalError = fake.error
    const originalWarn = fake.warn
    const capture = makeCapture()
    capture.install()
    expect(console.error).not.toBe(originalError)
    capture.destroy()
    expect(console.error).toBe(originalError)
    expect(console.warn).toBe(originalWarn)
  })

  it('destroy() leaves a third-party re-patch intact', () => {
    stubConsole()
    const capture = makeCapture()
    capture.install()

    const ours = console.error
    const thirdParty = vi.fn((...args: unknown[]) =>
      (ours as (...a: unknown[]) => unknown)(...args),
    )
    globalThis.console.error = thirdParty as unknown as Console['error']

    capture.destroy()
    expect(console.error).toBe(thirdParty)
  })

  it('serialises 20 fat console entries under the 24KB budget', () => {
    stubConsole()
    const capture = makeCapture()
    capture.install()
    for (let i = 0; i < 20; i++) console.error(`${i}-${'y'.repeat(2500)}`)

    const report = capture.buildBugReport()
    expect(JSON.stringify(report).length).toBeLessThan(BUG_PAYLOAD_BUDGET_BYTES)
    expect(report.consoleErrors?.length).toBeGreaterThan(0)
    expect(report.consoleErrors?.length).toBeLessThan(20)
    // Trimming drops the OLDEST — the newest entry survives.
    const kept = report.consoleErrors ?? []
    expect(kept[kept.length - 1]?.message.startsWith('19-')).toBe(true)
    capture.destroy()
  })
})

describe('fetch wrapper', () => {
  let win: FakeWindow

  beforeEach(() => {
    win = makeWindow()
    vi.stubGlobal('window', win)
  })

  afterEach(() => vi.unstubAllGlobals())

  let originalFetch: unknown

  const install = (impl: (input: unknown, init?: unknown) => Promise<unknown>) => {
    originalFetch = vi.fn(impl)
    win.fetch = originalFetch
    const capture = makeCapture()
    capture.install()
    return capture
  }

  it('records nothing on a 200 and resolves with the identical Response', async () => {
    const response = { status: 200 }
    const capture = install(async () => response)

    const got = await (win.fetch as (i: unknown) => Promise<unknown>)('https://api.test/ok')
    expect(got).toBe(response)
    expect(capture.buildBugReport().networkErrors).toBeUndefined()
    capture.destroy()
  })

  it('records a 500 and still resolves with the identical Response', async () => {
    const response = { status: 500 }
    const capture = install(async () => response)

    const got = await (win.fetch as (i: unknown, init?: unknown) => Promise<unknown>)(
      'https://api.test/boom?token=abc',
      { method: 'post' },
    )
    expect(got).toBe(response)

    const entry = capture.buildBugReport().networkErrors?.[0]
    expect(entry).toMatchObject({
      method: 'POST',
      url: 'https://api.test/boom?token=[redacted]',
      status: 500,
    })
    expect(typeof entry?.durationMs).toBe('number')
    capture.destroy()
  })

  it('records a rejection and rethrows the identical error', async () => {
    const failure = new Error('network down')
    const capture = install(async () => {
      throw failure
    })

    await expect(
      (win.fetch as (i: unknown) => Promise<unknown>)('https://api.test/x'),
    ).rejects.toBe(failure)

    expect(capture.buildBugReport().networkErrors?.[0]).toMatchObject({
      status: null,
      url: 'https://api.test/x',
      error: 'Error: network down',
    })
    capture.destroy()
  })

  it('reads the URL and method off a Request-like input', async () => {
    const capture = install(async () => ({ status: 503 }))
    await (win.fetch as (i: unknown) => Promise<unknown>)({
      url: 'https://api.test/req',
      method: 'PUT',
    })
    expect(capture.buildBugReport().networkErrors?.[0]).toMatchObject({
      method: 'PUT',
      url: 'https://api.test/req',
      status: 503,
    })
    capture.destroy()
  })

  it('skips our own apiHost so a failing ticket POST cannot feed back', async () => {
    const capture = install(async () => ({ status: 500 }))
    await (win.fetch as (i: unknown) => Promise<unknown>)(`${API_HOST}/v1/support/tickets`)
    expect(capture.buildBugReport().networkErrors).toBeUndefined()
    capture.destroy()
  })

  it('caps the ring at 20, keeping the newest', async () => {
    const capture = install(async () => ({ status: 500 }))
    for (let i = 0; i < 25; i++) {
      await (win.fetch as (i: unknown) => Promise<unknown>)(`https://api.test/${i}`)
    }
    const entries = capture.buildBugReport().networkErrors ?? []
    expect(entries).toHaveLength(20)
    expect(entries[0]?.url).toBe('https://api.test/5')
    expect(entries[19]?.url).toBe('https://api.test/24')
    capture.destroy()
  })

  it('destroy() restores window.fetch', () => {
    const capture = install(async () => ({ status: 200 }))
    capture.install() // idempotent
    expect(win.fetch).not.toBe(originalFetch)
    capture.destroy()
    expect(win.fetch).toBe(originalFetch)
  })

  it('destroy() leaves a third-party re-patch intact', () => {
    const capture = install(async () => ({ status: 200 }))
    const thirdParty = vi.fn()
    win.fetch = thirdParty
    capture.destroy()
    expect(win.fetch).toBe(thirdParty)
  })

  it('removes its error listeners on destroy', () => {
    const capture = install(async () => ({ status: 200 }))
    expect(win.addEventListener).toHaveBeenCalledWith('error', expect.any(Function))
    expect(win.addEventListener).toHaveBeenCalledWith('unhandledrejection', expect.any(Function))
    capture.destroy()
    expect(win.removeEventListener).toHaveBeenCalledTimes(2)
  })
})

describe('XMLHttpRequest wrapper', () => {
  class FakeXhr {
    status = 0
    private handlers: Record<string, Array<() => void>> = {}
    addEventListener(type: string, handler: () => void) {
      const bucket = this.handlers[type] ?? []
      bucket.push(handler)
      this.handlers[type] = bucket
    }
    open(_method: string, _url: string) {}
    send() {}
    finish(status: number) {
      this.status = status
      for (const h of this.handlers.loadend ?? []) h()
    }
  }

  afterEach(() => vi.unstubAllGlobals())

  it('records failed requests and restores the prototype on destroy', () => {
    const win = makeWindow({ XMLHttpRequest: FakeXhr })
    vi.stubGlobal('window', win)
    const proto = FakeXhr.prototype as unknown as Record<string, unknown>
    const originalOpen = proto.open
    const originalSend = proto.send

    const capture = makeCapture()
    capture.install()
    expect(proto.open).not.toBe(originalOpen)

    const xhr = new FakeXhr()
    xhr.open('delete', 'https://api.test/thing?secret=s3cret')
    xhr.send()
    xhr.finish(404)

    // A request that never reached a status records `status: null`.
    const failed = new FakeXhr()
    failed.open('GET', 'https://api.test/offline')
    failed.send()
    failed.finish(0)

    const entries = capture.buildBugReport().networkErrors ?? []
    expect(entries[0]).toMatchObject({
      method: 'DELETE',
      url: 'https://api.test/thing?secret=[redacted]',
      status: 404,
    })
    expect(entries[1]).toMatchObject({ status: null, error: 'network error' })

    capture.destroy()
    expect(proto.open).toBe(originalOpen)
    expect(proto.send).toBe(originalSend)
  })
})
