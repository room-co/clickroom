// @clickroom/sdk-node — server-side event capture + local flag evaluation.
// No autocapture (no DOM to observe server-side) — capture/identify are explicit, distinct_id
// is required per call (no client-side persisted identity like the browser SDK).

import type { FlagResult } from '@clickroom/sdk-js/eval'
import { createFlagPoller, type FlagPoller } from './flags'
import { createTransport, type Transport } from './transport'
import type { CaptureArgs, ClickroomNodeOptions, IdentifyArgs } from './types'

const DEFAULT_FLUSH_AT = 20
const DEFAULT_FLUSH_INTERVAL = 10_000
const DEFAULT_MAX_RETRIES = 5
const DEFAULT_FLAG_POLL_INTERVAL = 30_000

export class ClickroomClient {
  private readonly transport: Transport
  private readonly flagPoller: FlagPoller | null
  private shuttingDown = false
  private readonly onSignal: () => void

  constructor(opts: ClickroomNodeOptions) {
    // No default host: a baked-in cloud host would send a self-hoster's events to the
    // wrong place. Fail loudly at construction rather than dropping events silently.
    if (!opts.host) {
      throw new Error(
        '[clickroom] `host` is required (your self-hosted capture URL, or https://capture.clickroom.co for Clickroom Cloud).',
      )
    }
    const host = opts.host
    this.transport = createTransport({
      host,
      writeKey: opts.writeKey,
      flushAt: opts.flushAt ?? DEFAULT_FLUSH_AT,
      flushInterval: opts.flushInterval ?? DEFAULT_FLUSH_INTERVAL,
      maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
    })

    this.flagPoller = opts.readKey
      ? createFlagPoller({
          host,
          readKey: opts.readKey,
          pollInterval: opts.flagPollInterval ?? DEFAULT_FLAG_POLL_INTERVAL,
        })
      : null
    void this.flagPoller?.refresh()

    this.onSignal = () => {
      void this.shutdown()
    }
    process.once('SIGTERM', this.onSignal)
    process.once('SIGINT', this.onSignal)
    process.once('beforeExit', this.onSignal)
  }

  capture(args: CaptureArgs): void {
    this.transport.enqueue({
      event: args.event,
      distinct_id: args.distinctId,
      timestamp: toIso(args.timestamp),
      properties: args.properties,
    })
  }

  identify(args: IdentifyArgs): void {
    this.transport.enqueue({
      event: '$identify',
      distinct_id: args.distinctId,
      properties: { $set: args.properties },
    })
  }

  isFeatureEnabled(
    key: string,
    distinctId: string,
    personProperties?: Record<string, unknown>,
  ): boolean {
    return this.requireFlags().getFlag(key, distinctId, personProperties).enabled
  }

  getFeatureFlag(
    key: string,
    distinctId: string,
    personProperties?: Record<string, unknown>,
  ): boolean | string {
    const result = this.requireFlags().getFlag(key, distinctId, personProperties)
    return result.variant ?? result.enabled
  }

  getFeatureFlagPayload(
    key: string,
    distinctId: string,
    personProperties?: Record<string, unknown>,
  ): unknown {
    return this.requireFlags().getFlag(key, distinctId, personProperties).payload
  }

  getAllFlags(
    distinctId: string,
    personProperties?: Record<string, unknown>,
  ): Record<string, FlagResult> {
    return this.requireFlags().getAllFlags(distinctId, personProperties)
  }

  async flush(): Promise<void> {
    await this.transport.flush()
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    process.removeListener('SIGTERM', this.onSignal)
    process.removeListener('SIGINT', this.onSignal)
    process.removeListener('beforeExit', this.onSignal)
    this.flagPoller?.shutdown()
    await this.transport.shutdown()
  }

  private requireFlags(): FlagPoller {
    if (!this.flagPoller) {
      throw new Error('@clickroom/sdk-node: flags require `readKey` in ClickroomClient options')
    }
    return this.flagPoller
  }
}

const toIso = (ts?: Date | string): string | undefined => {
  if (ts === undefined) return undefined
  return typeof ts === 'string' ? ts : ts.toISOString()
}

export type { FlagResult } from '@clickroom/sdk-js/eval'
export type { CaptureArgs, ClickroomNodeOptions, IdentifyArgs } from './types'
