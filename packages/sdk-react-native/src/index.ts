// @clickroom/sdk-react-native — mobile client: explicit capture/screen/identify (no autocapture,
// no DOM to observe), persisted anon distinct id, remote flag evaluation (a write key must never
// evaluate flags locally — see README). Unlike sdk-js, capture()/identify() called before init()
// resolves WARN and no-op rather than throw — a mistimed call must not crash a mobile app.

import type { FlagMap } from '@clickroom/sdk-js/eval'
import { mobileDeviceProps } from './device'
import { createFlagClient, type FlagClient } from './flags'
import { createSessionManager, type SessionManager } from './session'
import { createStore, type Store } from './storage'
import { createTransport, type Transport } from './transport'
import type { ClickroomRNOptions, DeviceInfo } from './types'

const DEFAULT_FLUSH_AT = 20
const DEFAULT_FLUSH_INTERVAL = 10_000
const DEFAULT_MAX_RETRIES = 5
const DEFAULT_FLAG_POLL_INTERVAL = 30_000

const LIB_NAME = 'clickroom-react-native'
// Stamped on every event as `$lib_version` — keep in lockstep with package.json's `version`
// (see CLAUDE.md's sdk-js release note for why a drift here is dangerous: it shipped once,
// stamping a stale version made every event from that release look like a mystery third client).
export const LIB_VERSION = '0.1.0'

const DID_KEY = 'ckrm_did'
const STORAGE_PREFIX = 'ckrm_'

const generateId = (): string => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // fall through
  }
  return `ckrm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`
}

type FlagListener = (flags: Record<string, boolean | string>) => void

export class ClickroomClient {
  private readonly opts: ClickroomRNOptions
  private readonly host: string
  private readonly store: Store
  private transport!: Transport
  private session!: SessionManager
  private flagClient!: FlagClient
  private distinctId = ''
  private personProperties: Record<string, unknown> = {}
  private device: DeviceInfo | null = null
  private initialized = false
  private flagsLoaded = false
  private flagListeners: FlagListener[] = []
  private emittedFlagCalls = new Set<string>()
  private appStateUnsubscribe: (() => void) | null = null
  private flagPollId: ReturnType<typeof setInterval> | null = null

  constructor(opts: ClickroomRNOptions) {
    this.opts = opts
    // No default host: see sdk-node. Fail loudly instead of dropping events silently.
    if (!opts.host) {
      throw new Error(
        '[clickroom] `host` is required (your self-hosted capture URL, or https://capture.clickroom.co for Clickroom Cloud).',
      )
    }
    this.host = opts.host
    this.store = createStore(opts.storage)
  }

  async init(): Promise<void> {
    if (this.initialized) return
    await this.store.hydrate()

    this.distinctId = this.store.get(DID_KEY) ?? this.mintDistinctId()

    this.session = createSessionManager({
      now: () => Date.now(),
      store: this.store,
      genId: generateId,
    })

    this.transport = createTransport({
      host: this.host,
      writeKey: this.opts.writeKey,
      flushAt: this.opts.flushAt ?? DEFAULT_FLUSH_AT,
      flushInterval: this.opts.flushInterval ?? DEFAULT_FLUSH_INTERVAL,
      maxRetries: this.opts.maxRetries ?? DEFAULT_MAX_RETRIES,
      store: this.store,
    })

    this.flagClient = createFlagClient({
      host: this.host,
      writeKey: this.opts.writeKey,
      getDistinctId: () => this.distinctId,
      getPersonProperties: () => this.personProperties,
      store: this.store,
    })

    this.device = this.opts.device ?? (await this.resolveDevice())

    // Fire-and-forget — init() must resolve fast, not wait on the network.
    void this.refreshFlags(false)
    const pollInterval = this.opts.flagPollInterval ?? DEFAULT_FLAG_POLL_INTERVAL
    this.flagPollId = setInterval(() => void this.refreshFlags(false), pollInterval)
    this.flagPollId.unref?.()

    const subscribe = this.opts.onAppStateChange ?? (await this.resolveAppStateSubscriber())
    if (subscribe) {
      this.appStateUnsubscribe = subscribe((state) => {
        if (state === 'background' || state === 'inactive') void this.flush()
      })
    }

    this.initialized = true
  }

  private mintDistinctId(): string {
    const fresh = generateId()
    this.store.set(DID_KEY, fresh)
    return fresh
  }

  private async resolveDevice(): Promise<DeviceInfo | null> {
    try {
      const mod = await import('./platform/react-native')
      return mod.nativeDevice()
    } catch {
      return null
    }
  }

  private async resolveAppStateSubscriber(): Promise<
    ((cb: (state: 'active' | 'background' | 'inactive') => void) => () => void) | null
  > {
    try {
      const mod = await import('./platform/react-native')
      return mod.onAppStateChange
    } catch {
      return null
    }
  }

  private baseProperties(): Record<string, unknown> {
    const deviceProps = this.device
      ? mobileDeviceProps(this.device, {
          appVersion: this.opts.appVersion,
          appBuild: this.opts.appBuild,
        })
      : {}
    return {
      ...deviceProps,
      $lib: LIB_NAME,
      $lib_version: LIB_VERSION,
      $session_id: this.session.getSessionId(),
    }
  }

  private captureInternal(event: string, properties?: Record<string, unknown>): void {
    if (!this.initialized) {
      console.warn(`[clickroom] capture() called before init(); event "${event}" dropped`)
      return
    }
    this.transport.enqueue({
      event,
      distinct_id: this.distinctId,
      timestamp: new Date().toISOString(),
      properties: { ...this.baseProperties(), ...properties },
    })
  }

  capture(event: string, properties?: Record<string, unknown>): void {
    this.captureInternal(event, properties)
  }

  screen(name: string, properties?: Record<string, unknown>): void {
    this.captureInternal('$screen', { $screen_name: name, ...properties })
  }

  identify(distinctId: string, personProps?: Record<string, unknown>): void {
    if (!this.initialized) {
      console.warn('[clickroom] identify() called before init(); call dropped')
      return
    }
    const previousId = this.distinctId
    this.distinctId = distinctId
    this.store.set(DID_KEY, distinctId)
    if (personProps) this.personProperties = { ...this.personProperties, ...personProps }
    this.captureInternal('$identify', {
      $set: personProps ?? {},
      ...(previousId !== distinctId ? { $anon_distinct_id: previousId } : {}),
    })
    this.emittedFlagCalls.clear()
    void this.refreshFlags(true)
  }

  reset(): void {
    this.store.clearPrefix(STORAGE_PREFIX)
    this.distinctId = this.mintDistinctId()
    this.session?.reset()
    this.personProperties = {}
    this.flagsLoaded = false
    this.emittedFlagCalls.clear()
    this.flagClient?.clear()
  }

  private async refreshFlags(force: boolean): Promise<void> {
    try {
      const { flags } = await this.flagClient.checkVersionAndMaybeFetch(force)
      this.flagsLoaded = true
      this.fireFlagListeners(flags)
    } catch {
      // never throw from a background flag refresh
    }
  }

  private fireFlagListeners(flags: FlagMap): void {
    const flat = flatMap(flags)
    for (const cb of this.flagListeners) {
      try {
        cb(flat)
      } catch {
        // never let a listener crash the SDK
      }
    }
  }

  // Emit `$feature_flag_called` at most once per (key, response) since the last identify/reset —
  // and only for flags under measurement (`track: true`)..
  private maybeEmitFlagCall(key: string, response: boolean | string): void {
    try {
      if (!this.flagsLoaded) return
      if (!this.flagClient.getCache()[key]?.track) return
      const resp = String(response)
      const dedup = `${key}:${resp}`
      if (this.emittedFlagCalls.has(dedup)) return
      this.emittedFlagCalls.add(dedup)
      this.captureInternal('$feature_flag_called', {
        $feature_flag: key,
        $feature_flag_response: resp,
      })
    } catch {
      // never throw from a flag read
    }
  }

  isFeatureEnabled(key: string): boolean {
    const result = this.flagClient?.isFeatureEnabled(key) ?? false
    this.maybeEmitFlagCall(key, result)
    return result
  }

  getFeatureFlag(key: string): boolean | string {
    const result = this.flagClient?.getFeatureFlag(key) ?? false
    this.maybeEmitFlagCall(key, result)
    return result
  }

  getFeatureFlagPayload(key: string): unknown {
    return this.flagClient?.getFeatureFlagPayload(key) ?? null
  }

  onFeatureFlags(cb: (flags: Record<string, boolean | string>) => void): void {
    this.flagListeners.push(cb)
    if (this.flagsLoaded && this.flagClient) {
      try {
        cb(flatMap(this.flagClient.getCache()))
      } catch {
        // never let a listener crash the SDK
      }
    }
  }

  refreshFeatureFlags(): void {
    void this.refreshFlags(true)
  }

  async flush(): Promise<void> {
    await this.transport?.flush()
  }

  async shutdown(): Promise<void> {
    this.appStateUnsubscribe?.()
    this.appStateUnsubscribe = null
    if (this.flagPollId !== null) {
      clearInterval(this.flagPollId)
      this.flagPollId = null
    }
    await this.transport?.shutdown()
  }
}

function flatMap(flags: FlagMap): Record<string, boolean | string> {
  const out: Record<string, boolean | string> = {}
  for (const [key, result] of Object.entries(flags)) {
    out[key] = result.enabled ? (result.variant ?? true) : false
  }
  return out
}

export type { FlagResult } from '@clickroom/sdk-js/eval'
export type {
  CaptureArgs,
  ClickroomRNOptions,
  DeviceInfo,
  IdentifyArgs,
  StorageAdapter,
} from './types'
