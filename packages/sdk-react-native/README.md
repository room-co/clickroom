# @clickroom/sdk-react-native

Analytics + feature flags for React Native / Expo apps. Pure JS/TS, no native modules. v0.1 scope
is analytics and flags only — no surveys, no support widget, no autocapture (see
`packages/sdk-js` for those, browser-only).

## Install

```sh
npm install @clickroom/sdk-react-native
# optional but recommended — lets state survive an app restart
npm install @react-native-async-storage/async-storage
```

`react`, `react-native`, and `@react-native-async-storage/async-storage` are all optional peer
dependencies. Without AsyncStorage installed (and without a custom `storage` adapter passed in),
the client falls back to in-memory-only storage: distinct id, session, and flag cache all reset on
every app restart.

## Usage

`init()` is async — hydrate storage, restore the persisted anon distinct id, and kick off the
first flag fetch before the app starts relying on cached state:

```ts
import { ClickroomClient } from '@clickroom/sdk-react-native'

export const clickroom = new ClickroomClient({
  writeKey: process.env.CLICKROOM_WRITE_KEY!,
  // Required — there is no default. Self-hosted: your capture URL (single-domain installs:
  // `https://clickroom.example.com/capture`). Clickroom Cloud: `https://capture.clickroom.co`.
  host: process.env.CLICKROOM_HOST!,
})

await clickroom.init()

clickroom.capture('checkout_completed', { plan: 'pro', amount: 49 })
clickroom.screen('Checkout') // captures `$screen` with `{ $screen_name: 'Checkout' }`
clickroom.identify(user.id, { email: user.email, plan: 'pro' })

if (clickroom.isFeatureEnabled('new-checkout')) {
  // ...
}

clickroom.reset() // e.g. on logout — mints a fresh anon distinct id, clears cached flags/session
```

A `capture()`/`screen()`/`identify()` call made before `init()` resolves does **not** throw — it
warns via `console.warn` and drops the event, since a mistimed call must not crash a mobile app.

### React

```tsx
import { ClickroomProvider, useFeatureFlag } from '@clickroom/sdk-react-native/react'

function App() {
  return (
    <ClickroomProvider client={clickroom}>
      <Screen />
    </ClickroomProvider>
  )
}

function Screen() {
  const enabled = useFeatureFlag('new-checkout')
  // ...
}
```

## Feature flags

Flags are evaluated **remotely** — `POST /v1/flags` with the write key, never locally. Local
evaluation (like `@clickroom/sdk-node`) needs a read key, and a read key must never be embedded in
a shipped app binary. The client caches the last-fetched flag map to storage so flags are
available immediately at cold start, before the first network round-trip resolves, and does a
cheap `GET /v1/flags/version` check before paying for a full re-fetch.

## Offline / queueing

Events are batched (`flushAt`, default 20; `flushInterval`, default 10s) and POSTed to
`{host}/v1/capture`. The buffer is mirrored to storage on every enqueue, so events queued while the
app is offline (or killed before a flush completes) are recovered and sent on the next launch.
Buffered + queued events are capped at 1000, dropping the oldest first. Network errors, `429`, and
`5xx` responses retry with bounded exponential backoff (`maxRetries`, default 5, honoring
`Retry-After` on 429). `400`, `401`, `402`, and `413` are permanent failures — the batch is dropped
and surfaced via `console.warn`, never retried.

## Shutdown

Call `await clickroom.shutdown()` in short-lived contexts (tests, background tasks) to drain the
buffer and stop timers. In a normal app lifecycle this generally isn't needed — the client also
flushes when the app moves to background/inactive (`AppState`).

## Custom storage

Pass any object implementing the `StorageAdapter` interface (`getItem`/`setItem`/`removeItem`,
optionally `getAllKeys`) via `storage` in the constructor options — e.g. an MMKV wrapper — instead
of the AsyncStorage default.
