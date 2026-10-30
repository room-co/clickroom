// @clickroom/sdk-js — support bug-report capture.
//
// Collects the three things a support agent always ends up asking for by hand:
// the reporter's environment, the console errors that preceded the report, and
// the network requests that failed. Instrumentation is installed eagerly by
// `initSupport` when a form opts in via `definition.tracking.bugContext`
// (default OFF), because the interesting errors happen *before* the user
// decides to file a bug.
//
// Non-negotiables :
//   - every wrapper CALLS THROUGH and returns / rethrows exactly what the
//     original produced. Recording lives in its own try/catch so a bug in here
//     can never break the host page.
//   - `destroy()` restores a patched function ONLY if we are still the
//     outermost patcher — if a third party patched after us, ours stays in
//     place (removing it would delete *their* wrapper).
//   - listeners (`addEventListener`) only, never `window.onerror = …`.
//   - zero imports beyond the local, dependency-free `device.ts`: this file is
//     bundled into a CDN script.
//
// The payload shape below is hand-mirrored in two other places — the zod
// schema in `packages/trpc-router/src/trpc/routers/support.schema.ts` (which
// pins itself against these types with a `satisfies` guard) and the Rust
// sanitizer in `services/capture/src/support/bug.rs`. Keep all three in sync.

import { parseDevice } from './device'

// ---- payload types (mirror of `supportBugReportSchema`) -----------------

export interface BugEnvironment {
  url?: string
  referrer?: string
  viewportWidth?: number
  viewportHeight?: number
  screenWidth?: number
  screenHeight?: number
  browser?: string
  browserVersion?: string
  os?: string
  deviceType?: string
  locale?: string
  timezone?: string
}

export interface BugConsoleEntry {
  level: 'error' | 'warn'
  message: string
  timestamp: string
  /** "file:line:col" when the runtime gave us one. */
  source?: string
}

export interface BugNetworkEntry {
  method: string
  url: string
  /** null = rejected/aborted — the request never reached a status. */
  status: number | null
  durationMs?: number
  timestamp: string
  error?: string
}

export interface SupportBugReport {
  capturedAt: string
  environment?: BugEnvironment
  consoleErrors?: BugConsoleEntry[]
  networkErrors?: BugNetworkEntry[]
}

// ---- limits -------------------------------------------------------------

export const BUG_CONSOLE_LIMIT = 20
export const BUG_NETWORK_LIMIT = 20

const MESSAGE_MAX = 2000
const SOURCE_MAX = 512
const URL_MAX = 2048
const METHOD_MAX = 10
const ERROR_MAX = 512
const ARG_MAX = 500
const MAX_ARGS = 10

/**
 * Serialised-payload ceiling. Deliberately below capture-rs's 32KB cap so the
 * server limit is a backstop and never the normal path — the endpoint 400s on
 * overflow, and a dropped console line beats a dropped ticket.
 */
export const BUG_PAYLOAD_BUDGET_BYTES = 24 * 1024

const REDACTED = '[redacted]'

// ---- redaction (pure, unit-tested independently) ------------------------
//
// Client-side redaction is UX and bandwidth: it keeps obvious secrets out of
// the ticket a human will read. The server redacts again. Never rely
// on either alone.

const SENSITIVE_WORDS = [
  'token',
  'key',
  'secret',
  'password',
  'passwd',
  'pwd',
  'auth',
  'session',
  'credential',
  'signature',
  'sig',
  'jwt',
]

const isSensitiveKey = (key: string): boolean => {
  const k = key.toLowerCase()
  return SENSITIVE_WORDS.some((w) => k.includes(w))
}

// `Bearer <token>` / `Basic <token>` in any free text.
const BEARER_RE = /\b(bearer|basic)\s+[A-Za-z0-9\-._~+/]+=*/gi
// A JWT anywhere (header segment always starts `eyJ`).
const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g
// `apiKey=…`, `password: …` and friends in free text. The lookahead keeps an
// already-redacted value — and the `Bearer`/`Basic` scheme word BEARER_RE just
// stripped the token from — from being re-matched.
const KV_RE =
  /\b([A-Za-z0-9_-]*(?:token|secret|password|passwd|pwd|apikey|api_key|auth|credential)[A-Za-z0-9_-]*)(\s*[=:]\s*)(?!\[redacted|bearer\b|basic\b)("?)([^\s"'&,;]+)\3/gi

/** Redact obvious secrets from arbitrary text. Pure. */
export function redactText(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return ''
  let out = input
  out = out.replace(BEARER_RE, (_m, scheme: string) => `${scheme} ${REDACTED}`)
  out = out.replace(JWT_RE, REDACTED)
  out = out.replace(KV_RE, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`)
  return out
}

/**
 * Redact secret-looking query/fragment parameters from a URL, then run the
 * free-text pass over what is left (catches secrets in the path). Pure, and
 * never throws on a relative or malformed URL — no `new URL()`.
 */
export function redactUrl(url: string): string {
  if (typeof url !== 'string' || url.length === 0) return ''
  const masked = url.replace(/([?&#])([^=&#]+)=([^&#]*)/g, (match, sep: string, key: string) =>
    isSensitiveKey(key) ? `${sep}${key}=${REDACTED}` : match,
  )
  return truncate(redactText(masked), URL_MAX)
}

// ---- small helpers ------------------------------------------------------

const truncate = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s)

const finiteInt = (v: unknown): number | undefined => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined
  return Math.round(v)
}

const pushCapped = <T>(ring: T[], entry: T, limit: number): void => {
  ring.push(entry)
  while (ring.length > limit) ring.shift()
}

const isErrorLike = (v: unknown): v is Error => {
  if (v === null || typeof v !== 'object') return false
  const e = v as { name?: unknown; message?: unknown }
  return typeof e.message === 'string' && typeof e.name === 'string'
}

// ---- environment (mirror of `baseProperties`, index.ts:192-221) ---------

/**
 * Best-effort environment snapshot. Every access is `typeof`-guarded and the
 * whole body sits in one try/catch returning `{}` — same SSR/no-DOM posture as
 * `baseProperties`. The only field that is not already collected for events is
 * `timezone` (`Intl` throws in locked-down runtimes, hence its own try/catch).
 */
export function snapshotEnvironment(): BugEnvironment {
  if (typeof window === 'undefined') return {}
  const env: BugEnvironment = {}
  try {
    if (typeof location !== 'undefined' && location.href) env.url = redactUrl(location.href)
    if (typeof document !== 'undefined' && document.referrer) {
      env.referrer = redactUrl(document.referrer)
    }
    if (window.screen) {
      env.screenHeight = finiteInt(window.screen.height)
      env.screenWidth = finiteInt(window.screen.width)
    }
    env.viewportHeight = finiteInt(window.innerHeight)
    env.viewportWidth = finiteInt(window.innerWidth)
    if (typeof navigator !== 'undefined') {
      const device = parseDevice(navigator.userAgent, navigator.language)
      if (device.$browser) env.browser = device.$browser
      if (device.$browser_version) env.browserVersion = device.$browser_version
      if (device.$os) env.os = device.$os
      if (device.$device_type) env.deviceType = device.$device_type
      if (device.$lang) env.locale = device.$lang
    }
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (tz) env.timezone = truncate(tz, 64)
    } catch {
      // locked-down runtime — skip
    }
  } catch {
    return {}
  }
  // Drop keys that resolved to undefined so the payload stays `.strict()`-clean.
  for (const key of Object.keys(env) as (keyof BugEnvironment)[]) {
    if (env[key] === undefined) delete env[key]
  }
  return env
}

// ---- console argument formatting ---------------------------------------

const stringifyArg = (arg: unknown): { text: string; source?: string } => {
  if (typeof arg === 'string') return { text: arg }
  if (arg === undefined) return { text: 'undefined' }
  if (arg === null) return { text: 'null' }
  if (typeof arg === 'number' || typeof arg === 'boolean' || typeof arg === 'bigint') {
    return { text: String(arg) }
  }
  if (isErrorLike(arg)) {
    const stack = typeof arg.stack === 'string' ? arg.stack : ''
    // Skip the leading "Name: message" line, keep the first 3 frames.
    const frames = stack
      .split('\n')
      .slice(1, 4)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' | ')
    return { text: `${arg.name}: ${arg.message}`, source: frames || undefined }
  }
  try {
    const json = JSON.stringify(arg)
    return { text: typeof json === 'string' ? truncate(json, ARG_MAX) : String(arg) }
  } catch {
    return { text: '[unserialisable]' }
  }
}

/** Depth- and length-bounded serialisation of a `console.*` argument list. */
const formatArgs = (args: unknown[]): { message: string; source?: string } => {
  const parts: string[] = []
  let source: string | undefined
  for (const arg of args.slice(0, MAX_ARGS)) {
    const out = stringifyArg(arg)
    parts.push(out.text)
    if (!source && out.source) source = out.source
  }
  return { message: parts.join(' '), source }
}

// ---- deps ---------------------------------------------------------------

export interface BugCaptureDeps {
  /**
   * Absolute origin (or origin + prefix) of the Clickroom API, e.g.
   * `https://capture.clickroom.co`. Any request whose resolved URL starts with
   * this string is NOT recorded — otherwise a failing ticket POST records
   * itself and a 4xx storm feeds back into the ring.
   */
  getApiHost: () => string
  /** Clock override, for tests. Defaults to `Date.now`. */
  now?: () => number
}

export interface BugCapture {
  /** Patch console/network and attach error listeners. Idempotent; no-op with no DOM. */
  install(): void
  /** Restore everything we are still the outermost patcher of, and clear the rings. */
  destroy(): void
  /** Best-effort environment snapshot; `{}` with no DOM. */
  snapshotEnvironment(): BugEnvironment
  /** Assemble the payload, trimming oldest entries until it fits the budget. */
  buildBugReport(): SupportBugReport
}

// A loosely-typed view of `window` — we assign to `fetch` and read
// `XMLHttpRequest`, both of which the DOM lib types too tightly for a wrapper.
interface MutableWindow {
  fetch?: unknown
  XMLHttpRequest?: unknown
  addEventListener?: (type: string, handler: (event: unknown) => void) => void
  removeEventListener?: (type: string, handler: (event: unknown) => void) => void
}

type UnknownFn = (...args: unknown[]) => unknown

interface Patch {
  target: Record<string, unknown>
  key: string
  original: unknown
  wrapped: unknown
}

const getWindow = (): MutableWindow | undefined =>
  typeof window === 'undefined' ? undefined : (window as unknown as MutableWindow)

// ---- factory ------------------------------------------------------------

export function createBugCapture(deps: BugCaptureDeps): BugCapture {
  const now = deps.now ?? (() => Date.now())
  const consoleRing: BugConsoleEntry[] = []
  const networkRing: BugNetworkEntry[] = []
  const patches: Patch[] = []
  let listeners: Array<{ type: string; handler: (event: unknown) => void }> = []
  let installed = false

  const iso = (): string => new Date(now()).toISOString()

  const recordConsole = (level: 'error' | 'warn', message: string, source?: string): void => {
    const entry: BugConsoleEntry = {
      level,
      message: truncate(redactText(message), MESSAGE_MAX),
      timestamp: iso(),
    }
    if (source) entry.source = truncate(redactText(source), SOURCE_MAX)
    pushCapped(consoleRing, entry, BUG_CONSOLE_LIMIT)
  }

  /** True when the URL belongs to us (`/v1/support*`, `/v1/capture`, …). */
  const isOwnTraffic = (url: string): boolean => {
    try {
      const host = deps.getApiHost()
      return typeof host === 'string' && host.length > 0 && url.startsWith(host)
    } catch {
      return false
    }
  }

  const recordNetwork = (input: {
    method: string
    url: string
    status: number | null
    startedAt: number
    error?: string
  }): void => {
    if (isOwnTraffic(input.url)) return
    const entry: BugNetworkEntry = {
      method: truncate(String(input.method || 'GET').toUpperCase(), METHOD_MAX),
      url: redactUrl(input.url),
      status: input.status,
      timestamp: iso(),
    }
    const duration = finiteInt(now() - input.startedAt)
    if (duration !== undefined) entry.durationMs = duration
    if (input.error) entry.error = truncate(redactText(input.error), ERROR_MAX)
    pushCapped(networkRing, entry, BUG_NETWORK_LIMIT)
  }

  // -- console ------------------------------------------------------------

  const patchConsoleMethod = (level: 'error' | 'warn'): void => {
    const host = globalThis.console as unknown as Record<string, unknown> | undefined
    if (!host || typeof host[level] !== 'function') return
    const original = host[level] as UnknownFn
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      try {
        const { message, source } = formatArgs(args)
        recordConsole(level, message, source)
      } catch {
        // never break the host
      }
      return original.apply(this, args)
    }
    host[level] = wrapped
    patches.push({ target: host, key: level, original, wrapped })
  }

  // -- error listeners ----------------------------------------------------

  const addListener = (
    win: MutableWindow,
    type: string,
    handler: (event: unknown) => void,
  ): void => {
    if (typeof win.addEventListener !== 'function') return
    win.addEventListener(type, handler)
    listeners.push({ type, handler })
  }

  const onErrorEvent = (event: unknown): void => {
    try {
      const e = event as {
        message?: unknown
        filename?: unknown
        lineno?: unknown
        colno?: unknown
      }
      const message = typeof e?.message === 'string' ? e.message : 'Uncaught error'
      const file = typeof e?.filename === 'string' ? e.filename : ''
      const source = file ? `${file}:${e?.lineno ?? 0}:${e?.colno ?? 0}` : undefined
      recordConsole('error', message, source)
    } catch {
      // never break the host
    }
  }

  const onRejectionEvent = (event: unknown): void => {
    try {
      const reason = (event as { reason?: unknown })?.reason
      const { message, source } = formatArgs([reason])
      recordConsole('error', `Unhandled rejection: ${message}`, source)
    } catch {
      // never break the host
    }
  }

  // -- fetch --------------------------------------------------------------

  const resolveRequestUrl = (input: unknown): string => {
    try {
      if (typeof input === 'string') return input
      if (input && typeof input === 'object') {
        const url = (input as { url?: unknown }).url
        if (typeof url === 'string') return url
      }
      return String(input)
    } catch {
      return ''
    }
  }

  const resolveMethod = (input: unknown, init: unknown): string => {
    try {
      const fromInit = (init as { method?: unknown } | undefined)?.method
      if (typeof fromInit === 'string') return fromInit
      if (input && typeof input === 'object') {
        const m = (input as { method?: unknown }).method
        if (typeof m === 'string') return m
      }
    } catch {
      // fall through
    }
    return 'GET'
  }

  const patchFetch = (win: MutableWindow): void => {
    const originalFetch = win.fetch
    if (typeof originalFetch !== 'function') return
    const original = originalFetch as UnknownFn
    const wrapped = function (this: unknown, input: unknown, init?: unknown): unknown {
      let startedAt = 0
      let url = ''
      let method = 'GET'
      try {
        startedAt = now()
        url = resolveRequestUrl(input)
        method = resolveMethod(input, init)
      } catch {
        // recording metadata must never block the request
      }
      const result = original.call(this === undefined ? win : this, input, init)
      if (!result || typeof (result as Promise<unknown>).then !== 'function') return result
      return (result as Promise<unknown>).then(
        (res) => {
          try {
            const status = (res as { status?: unknown })?.status
            if (typeof status === 'number' && status >= 400) {
              recordNetwork({ method, url, status, startedAt })
            }
          } catch {
            // never break the host
          }
          return res // identical Response reference
        },
        (err) => {
          try {
            recordNetwork({ method, url, status: null, startedAt, error: String(err) })
          } catch {
            // never break the host
          }
          throw err // identical error, never swallowed
        },
      )
    }
    win.fetch = wrapped
    patches.push({
      target: win as unknown as Record<string, unknown>,
      key: 'fetch',
      original,
      wrapped,
    })
  }

  // -- XMLHttpRequest -----------------------------------------------------

  interface XhrMeta {
    method: string
    url: string
    startedAt: number
    recorded?: boolean
  }
  const META_KEY = '__ckrmBugMeta'

  const patchXhr = (win: MutableWindow): void => {
    const Xhr = win.XMLHttpRequest as { prototype?: Record<string, unknown> } | undefined
    const proto = Xhr?.prototype
    if (!proto || typeof proto.open !== 'function' || typeof proto.send !== 'function') return

    const originalOpen = proto.open as UnknownFn
    const openWrapped = function (this: unknown, ...args: unknown[]): unknown {
      try {
        const meta: XhrMeta = {
          method: typeof args[0] === 'string' ? args[0] : 'GET',
          url: typeof args[1] === 'string' ? args[1] : String(args[1] ?? ''),
          startedAt: now(),
        }
        ;(this as Record<string, unknown>)[META_KEY] = meta
      } catch {
        // never break the host
      }
      return originalOpen.apply(this, args)
    }
    proto.open = openWrapped
    patches.push({ target: proto, key: 'open', original: originalOpen, wrapped: openWrapped })

    const originalSend = proto.send as UnknownFn
    const sendWrapped = function (this: unknown, ...args: unknown[]): unknown {
      try {
        const self = this as Record<string, unknown> & {
          addEventListener?: (t: string, h: () => void) => void
          status?: number
        }
        const meta = self[META_KEY] as XhrMeta | undefined
        if (meta && typeof self.addEventListener === 'function') {
          // `loadend` fires for success, error, timeout and abort alike; a
          // status of 0 means the request never reached one.
          self.addEventListener('loadend', () => {
            try {
              if (meta.recorded) return
              const status = typeof self.status === 'number' ? self.status : 0
              if (status === 0) {
                meta.recorded = true
                recordNetwork({ ...meta, status: null, error: 'network error' })
              } else if (status >= 400) {
                meta.recorded = true
                recordNetwork({ ...meta, status })
              }
            } catch {
              // never break the host
            }
          })
        }
      } catch {
        // never break the host
      }
      return originalSend.apply(this, args)
    }
    proto.send = sendWrapped
    patches.push({ target: proto, key: 'send', original: originalSend, wrapped: sendWrapped })
  }

  // -- payload ------------------------------------------------------------

  const serialisedLength = (report: SupportBugReport): number => {
    try {
      return JSON.stringify(report).length
    } catch {
      return 0
    }
  }

  /** Drop oldest entries (largest ring first) until the payload fits. */
  const trimToBudget = (report: SupportBugReport): SupportBugReport => {
    while (serialisedLength(report) >= BUG_PAYLOAD_BUDGET_BYTES) {
      const consoleCount = report.consoleErrors?.length ?? 0
      const networkCount = report.networkErrors?.length ?? 0
      if (consoleCount === 0 && networkCount === 0) break
      if (consoleCount >= networkCount) {
        report.consoleErrors?.shift()
        if (report.consoleErrors?.length === 0) delete report.consoleErrors
      } else {
        report.networkErrors?.shift()
        if (report.networkErrors?.length === 0) delete report.networkErrors
      }
    }
    return report
  }

  const buildBugReport = (): SupportBugReport => {
    const report: SupportBugReport = { capturedAt: iso() }
    const environment = snapshotEnvironment()
    if (Object.keys(environment).length > 0) report.environment = environment
    if (consoleRing.length > 0) report.consoleErrors = consoleRing.slice()
    if (networkRing.length > 0) report.networkErrors = networkRing.slice()
    return trimToBudget(report)
  }

  // -- lifecycle ----------------------------------------------------------

  const install = (): void => {
    if (installed) return
    const win = getWindow()
    if (!win) return // SSR / no DOM — nothing to patch
    installed = true
    try {
      patchConsoleMethod('error')
      patchConsoleMethod('warn')
      addListener(win, 'error', onErrorEvent)
      addListener(win, 'unhandledrejection', onRejectionEvent)
      patchFetch(win)
      patchXhr(win)
    } catch {
      // partial install is fine — destroy() unwinds whatever landed
    }
  }

  const destroy = (): void => {
    const win = getWindow()
    for (const patch of patches.splice(0, patches.length).reverse()) {
      try {
        // Restore ONLY if we are still the outermost patcher. If a third party
        // wrapped us afterwards, restoring here would delete *their* wrapper.
        if (patch.target[patch.key] === patch.wrapped) {
          patch.target[patch.key] = patch.original
        }
      } catch {
        // never break the host
      }
    }
    if (win && typeof win.removeEventListener === 'function') {
      for (const { type, handler } of listeners) {
        try {
          win.removeEventListener(type, handler)
        } catch {
          // never break the host
        }
      }
    }
    listeners = []
    consoleRing.length = 0
    networkRing.length = 0
    installed = false
  }

  return { install, destroy, snapshotEnvironment, buildBugReport }
}
