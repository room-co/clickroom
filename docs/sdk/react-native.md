# React Native SDK

Package `@clickroom/sdk-react-native` (MIT licence). Analytics and feature flags for React Native
and Expo apps. It is plain JavaScript with no native modules. It has no autocapture, surveys or
support widget; you send events yourself.

## Install

```bash
npm install @clickroom/sdk-react-native

# Recommended: lets the anonymous id, session and cached flags survive app restarts
npm install @react-native-async-storage/async-storage
```

Without AsyncStorage (and without your own storage adapter) the SDK keeps everything in memory, so
each app launch looks like a new anonymous user.

## What you need

- A **write key** (`ckw_live_...`). Create it under sidebar **API Keys**
  ([guide](../guides/api-keys.md)). Write keys are safe to ship inside an app.
- A public HTTPS capture address: `https://YOUR_CLICKROOM_HOST/capture`. A phone cannot reach
  `localhost` on your server. Do not put a read key in a mobile app.

## Set up

```ts
import { ClickroomClient } from '@clickroom/sdk-react-native'

export const clickroom = new ClickroomClient({
  writeKey: 'ckw_live_xxx',
  host: 'https://YOUR_CLICKROOM_HOST/capture', // required
})

// Call once at startup, and wait for it before sending events.
await clickroom.init()
```

`init()` loads saved state, restores the anonymous id and starts the first flag fetch. Calls to
`capture`, `screen` or `identify` before `init()` finishes do not throw; they log a warning and the
event is dropped.

| Option | Default | Meaning |
|---|---|---|
| `writeKey` | required | Project write key |
| `host` | required | Capture address |
| `flushAt` | 20 | Send a batch once this many events are queued |
| `flushInterval` | 10000 | Send queued events at least this often (ms) |
| `maxRetries` | 5 | Retries per failed batch |
| `flagPollInterval` | 30000 | Background flag re-check (ms) |
| `storage` | AsyncStorage if installed | A storage adapter, for example MMKV |
| `appVersion`, `appBuild` | none | Added to every event |

## Send events

```ts
clickroom.screen('Checkout') // sends $screen with $screen_name: 'Checkout'
clickroom.capture('checkout_completed', { plan: 'pro', amount: 49 })
```

Every event also carries device information (OS, OS version, screen size, locale), the SDK name and
version, and a `$session_id`.

## Identify users

```ts
clickroom.identify(user.id, { email: user.email, plan: 'pro' })

// on logout
clickroom.reset() // new anonymous id, session and flag cache
```

Use the same id you use in the browser and on your server so one person's activity joins up. See
[Identity and sessions](../explanation/identity-and-sessions.md).

## Feature flags

```ts
if (clickroom.isFeatureEnabled('new-checkout-flow')) {
  /* ... */
}
const variant = clickroom.getFeatureFlag('checkout-copy')
const payload = clickroom.getFeatureFlagPayload('max-seats')
clickroom.onFeatureFlags((flags) => {
  /* flags changed */
})
clickroom.refreshFeatureFlags()
```

Flags are evaluated on your server for the current user (a `POST /v1/flags` call with the write
key), never inside the app, because evaluating locally would need a read key. The last result is
cached in storage, so flags are available immediately at launch, and a cheap version check avoids
re-downloading unchanged flags. Targeting by user property works with the properties you pass to
`identify`.

## React hooks

```tsx
import { ClickroomProvider, useFeatureFlag } from '@clickroom/sdk-react-native/react'

export default function App() {
  return (
    <ClickroomProvider client={clickroom}>
      <Home />
    </ClickroomProvider>
  )
}

function Home() {
  const enabled = useFeatureFlag('new-checkout-flow')
  return enabled ? <NewCheckout /> : <OldCheckout />
}
```

The module also exports `useClickroom()` (returns the client) and `useFeatureFlagPayload(key)`.

## Offline behavior

Events are batched and sent to `{host}/v1/capture`. The queue is saved to storage, so events
recorded offline, or before the app was killed, are sent on the next launch. At most 1000 events
are kept; the oldest are dropped first. Network errors, `429` and `5xx` responses are retried with
backoff (honoring `Retry-After`). `400`, `401`, `402` and `413` responses are permanent: the batch is
dropped and a warning is logged.

The client also flushes when the app goes to the background.

## Shut down

```ts
await clickroom.flush() // send what is queued now
await clickroom.shutdown() // flush and stop timers (tests, background tasks)
```

## Custom storage

Pass any object with async `getItem`, `setItem` and `removeItem` (optionally `getAllKeys`) as
`storage`, for example a wrapper around MMKV.
