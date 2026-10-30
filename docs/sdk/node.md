# Node SDK

Package `@clickroom/sdk-node` (MIT licence). Server-side event capture and local feature flag
evaluation for Node 22 and newer. There is no autocapture on the server: you send events yourself.

## Install

```bash
npm install @clickroom/sdk-node
# or: pnpm add @clickroom/sdk-node
```

## What you need

- A **write key** (`ckw_live_...`) to send events.
- A **read key** (`ckr_live_...`) if you evaluate feature flags. Keep it on the server.
- Your capture address, `https://YOUR_CLICKROOM_HOST/capture`.

Create keys under sidebar **API Keys** ([guide](../guides/api-keys.md)). Use keys for the same
environment as the flags you want to read.

## Set up the client

```ts
import { ClickroomClient } from '@clickroom/sdk-node'

export const clickroom = new ClickroomClient({
  writeKey: process.env.CLICKROOM_WRITE_KEY!,
  readKey: process.env.CLICKROOM_READ_KEY, // only needed for feature flags
  host: 'https://YOUR_CLICKROOM_HOST/capture', // required
})
```

Create one client per process and reuse it. The constructor throws if `host` is missing.

| Option | Default | Meaning |
|---|---|---|
| `writeKey` | required | Project write key |
| `readKey` | none | Project read key, required for flag methods |
| `host` | required | Capture address |
| `flushAt` | 20 | Send a batch once this many events are queued |
| `flushInterval` | 10000 | Send queued events at least this often (ms) |
| `maxRetries` | 5 | Retries per failed batch before it is dropped |
| `flagPollInterval` | 30000 | How often flag definitions are refreshed (ms) |

## Capture events

```ts
clickroom.capture({
  distinctId: user.id, // required: the server has no remembered identity
  event: 'checkout_completed',
  properties: { plan: 'pro', amount: 49 },
  // timestamp: new Date()  // optional, defaults to now
})
```

`distinctId` must be the same id the browser uses after `identify`, so server and browser events
join up on one user.

## Identify users

```ts
clickroom.identify({
  distinctId: user.id,
  properties: { email: user.email, plan: 'pro' },
})
```

This sets user properties (shown on the user's page and usable in flag targeting).

## Feature flags

Flags are evaluated inside your process. The client downloads flag definitions with the read key
and refreshes them every `flagPollInterval`. Evaluation uses the same hashing as the browser and the
server, so a user gets the same result everywhere. No network call happens per check.

```ts
const enabled = clickroom.isFeatureEnabled('new-checkout-flow', user.id, { plan: user.plan })
const variant = clickroom.getFeatureFlag('checkout-copy', user.id) // true | false | 'beta' ...
const payload = clickroom.getFeatureFlagPayload('max-seats', user.id)
const all = clickroom.getAllFlags(user.id) // { key: { enabled, variant, payload } }
```

The third argument is the user's properties for targeting rules (`plan`, `email`, ...). Pass the same
properties you set with `identify`. Flag methods throw if you did not provide a `readKey`.

Local flag checks in the Node SDK do not record `$feature_flag_called` exposures. Experiments
count exposures, so for an experiment decided on the server either evaluate the flag with the
[HTTP API](http-api.md#evaluate-flags) (`POST /v1/flags` records exposures for flags with **Track
exposures** on) or read the flag in the browser.

## Flush and shut down

Events are buffered. The client flushes on size and on a timer, and flushes on `SIGTERM`, `SIGINT`
and `beforeExit`. In short-lived code (scripts, serverless handlers) wait for the flush yourself:

```ts
await clickroom.shutdown() // flushes, then stops timers
// or, keeping the client alive:
await clickroom.flush()
```

If a request fails with a network error, `429` or `5xx`, the client retries with backoff. A `4xx`
other than `429`, such as a strict-schema rejection, is not retried: the batch is dropped and the
reason is logged with `console.warn`.

## Example: Express middleware

```ts
app.post('/checkout', async (req, res) => {
  const order = await createOrder(req.user)
  clickroom.capture({
    distinctId: req.user.id,
    event: 'checkout_completed',
    properties: { order_id: order.id, total: order.total },
  })
  res.json(order)
})
```
