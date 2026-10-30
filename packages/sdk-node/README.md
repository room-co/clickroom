# @clickroom/sdk-node

Server-side event capture + local feature-flag evaluation for Node 22+. No autocapture — there's no
DOM to observe server-side, so events are explicit `capture`/`identify` calls.

```ts
import { ClickroomClient } from '@clickroom/sdk-node'

const clickroom = new ClickroomClient({
  writeKey: process.env.CLICKROOM_WRITE_KEY!,
  readKey: process.env.CLICKROOM_READ_KEY, // optional, required for feature flags
  // Required — there is no default. Self-hosted: your capture URL (single-domain installs:
  // `https://clickroom.example.com/capture`). Clickroom Cloud: `https://capture.clickroom.co`.
  host: process.env.CLICKROOM_HOST!,
})

clickroom.capture({
  distinctId: user.id, // required — no client-side persisted identity on the server
  event: 'checkout_completed',
  properties: { plan: 'pro', amount: 49 },
})

clickroom.identify({ distinctId: user.id, properties: { email: user.email, plan: 'pro' } })

if (clickroom.isFeatureEnabled('new-checkout', user.id, { plan: 'pro' })) {
  // ...
}
```

## Flags

Flags are evaluated **locally**: the client polls `GET /v1/flag-definitions` (requires `readKey`) on
`flagPollInterval` (default 30s) and evaluates in-process using the same SHA1 hash as the
browser SDK and the Rust evaluator — guaranteed identical results for the same `distinct_id`.

## Error handling

`capture()`/`identify()` events are batched and POSTed to `{host}/v1/capture`. If the server
rejects a batch outright (HTTP 4xx other than 429, e.g. a schema-invalid event under strict
validation), the client does **not** retry — retrying a request the server will never accept
would just waste the retry budget. The batch is dropped and the failure is surfaced via
`console.warn`, including the response body (e.g. `{ accepted, errors }`) when the server returns
one. Network errors, `429` (rate limiting), and `5xx` responses are unaffected — the client
retries those with its existing bounded exponential backoff (`maxRetries`, default 5).

## Shutdown

The client buffers events and flushes on size (`flushAt`, default 20) or interval (`flushInterval`,
default 10s). It registers `SIGTERM`/`SIGINT`/`beforeExit` handlers to flush on process exit. In
short-lived scripts (e.g. serverless handlers, CLI tools), call `await clickroom.shutdown()`
explicitly before the process exits to guarantee delivery.
