export interface ClickroomNodeOptions {
  /** Project write key — required for `/capture`. */
  writeKey: string
  /** Project read key — required for local flag evaluation (`GET /flag-definitions`). */
  readKey?: string
  /** Capture host — required, e.g. `https://clickroom.example.com/capture` (self-host) or `https://capture.clickroom.co` (Cloud). */
  host: string
  /** Flush the event buffer once it reaches this many events. Default 20. */
  flushAt?: number
  /** Flush the event buffer on this interval (ms). Default 10_000. */
  flushInterval?: number
  /** Max retry attempts per failed batch before it is dropped. Default 5. */
  maxRetries?: number
  /** Poll interval (ms) for `GET /flag-definitions`. Default 30_000. */
  flagPollInterval?: number
}

export interface EventPayload {
  event: string
  distinct_id: string
  timestamp?: string
  properties?: Record<string, unknown>
}

export interface CaptureArgs {
  distinctId: string
  event: string
  properties?: Record<string, unknown>
  timestamp?: Date | string
}

export interface IdentifyArgs {
  distinctId: string
  properties: Record<string, unknown>
}
