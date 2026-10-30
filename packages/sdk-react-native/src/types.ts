// @clickroom/sdk-react-native — shared types for the React Native SDK.

export interface StorageAdapter {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
  /** Optional: list every key ever written. Used to seed `clearPrefix` reliably —
   *  RN AsyncStorage doesn't expose a uniform sync "get all keys" primitive, so
   *  `src/storage.ts` falls back to its own persisted key index when this is absent. */
  getAllKeys?(): Promise<string[]>
}

export interface DeviceInfo {
  os: 'ios' | 'android'
  osVersion?: string
  screenWidth: number
  screenHeight: number
  locale?: string
}

export interface ClickroomRNOptions {
  /** Project write key — required for `/capture` and `/flags`. */
  writeKey: string
  /** Capture host — required, e.g. `https://clickroom.example.com/capture` (self-host) or `https://capture.clickroom.co` (Cloud). */
  host: string
  /** Flush the event buffer once it reaches this many events. Default 20. */
  flushAt?: number
  /** Flush the event buffer on this interval (ms). Default 10_000. */
  flushInterval?: number
  /** Max retry attempts per failed batch before it is dropped. Default 5. */
  maxRetries?: number
  /** Poll interval (ms) for the background flag re-check. Default 30_000. */
  flagPollInterval?: number
  /** Storage adapter (e.g. AsyncStorage, MMKV). Defaults to
   *  `@react-native-async-storage/async-storage` if installed, else in-memory only. */
  storage?: StorageAdapter | null
  appVersion?: string
  appBuild?: string
  /** Injected device info — mainly for tests. Defaults to `./platform/react-native`'s
   *  `nativeDevice()`, resolved lazily so this package never hard-imports `react-native`. */
  device?: DeviceInfo
  /** Injected AppState subscriber — mainly for tests. Defaults to
   *  `./platform/react-native`'s `onAppStateChange`, resolved lazily. */
  onAppStateChange?: (cb: (state: 'active' | 'background' | 'inactive') => void) => () => void
}

// Wire shape POSTed to `/v1/capture` — identical to sdk-js/sdk-node's EventPayload.
export interface EventPayload {
  event: string
  distinct_id: string
  timestamp?: string
  properties?: Record<string, unknown>
}

// Distinct id is persisted on the client (like sdk-js), not passed per-call (unlike sdk-node) —
// so these mirror sdk-node's *Args shape minus `distinctId`, kept for parity/documentation even
// though `src/index.ts` takes positional args directly.
export interface CaptureArgs {
  event: string
  properties?: Record<string, unknown>
}

export interface IdentifyArgs {
  distinctId: string
  properties?: Record<string, unknown>
}
