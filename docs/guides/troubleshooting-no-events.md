# Troubleshooting: no events showing up

Follow these checks in order. Each one narrows down where events stop on their way:

```
your app  ->  capture  ->  queue (NATS)  ->  ingest  ->  ClickHouse  ->  dashboard
```

Commands run from the install directory on your server.

## 1. Test the endpoint without an SDK

```bash
curl -i https://YOUR_CLICKROOM_HOST/capture/v1/capture \
  -H "Authorization: Bearer ckw_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{"batch":[{"event":"test_event","distinct_id":"me","properties":{"hello":"world"}}]}'
```

| Result | Meaning | Fix |
|---|---|---|
| `202 Accepted` | Capture took the event | Go to step 3 |
| Connection refused, timeout, or a certificate or `502` error | The request never reached capture | Check DNS, the proxy and `docker compose ps`. Open `https://YOUR_CLICKROOM_HOST/capture/health`: it should say `ok`. The proxy must send `/capture/*` to the capture service. |
| `401` | The key is missing, mistyped, revoked, or not a write key | Copy the key again from **Setup** or **API Keys** |
| `400` | Invalid JSON, an empty `batch`, an empty `distinct_id`, or an event that breaks a strict schema (the body then lists `errors`) | Fix the body; for schema errors see step 6 |
| `413` | More than 100 events in the batch, or a body over 1 MiB | Send smaller batches |
| `429` | Rate limit for the project | Slow down or ask the operator to raise the limit. SDKs retry automatically. |
| `503` | The queue is full or unavailable | `docker compose logs capture nats ingest`; check disk with `df -h` |

## 2. Check the SDK setup

Open the browser developer tools on your site.

- **Console.** `[clickroom] init() needs an api_host` means `api_host` is missing and the SDK is
  disabled. Set `api_host: 'https://YOUR_CLICKROOM_HOST/capture'`. It must include `/capture` when
  you use the standard single-domain install.
- **Network.** Filter by `capture`. You should see `POST .../v1/capture` with status `202`.
  - No request at all: `init` never ran, or runs before the SDK loaded, or the page is served from
    a place with a Content Security Policy that blocks your host (allow it in `script-src` and
    `connect-src`).
  - Request blocked or failed: an ad blocker or privacy extension may block analytics calls. Test in
    a private window with extensions off. Serving Clickroom from your own domain, as the standard
    install does, helps.
  - Mixed content error: the page is `https` but `api_host` is `http`. Use `https`.
- **Key.** Make sure you used a **write** key (`ckw_live_...`), not a read key.
- **Node.** Short scripts and serverless handlers exit before the buffer flushes. Call
  `await clickroom.shutdown()` (or `flush()`) before the process ends. Also check that `host` is set.
- **React Native.** Call `await clickroom.init()` before `capture`, and make sure `host` is a public
  HTTPS URL; a phone cannot reach `localhost` on your server. Calls made before `init` resolves are
  dropped with a console warning.

## 3. Check the dashboard is looking in the right place

- The project selector (top of the sidebar) must be the project the key belongs to.
- Clear filters on **Events**, and widen the date range.
- A very new event can take a few seconds to appear.

## 4. Check the pipeline on the server

```bash
docker compose ps
docker compose logs --tail=100 capture
docker compose logs --tail=100 ingest
docker compose logs --tail=100 clickhouse
```

- `ingest` must be running and not crash-looping. It writes events to ClickHouse in batches.
- If `ingest` is stopped, capture still answers `202` and events wait in the queue (up to 72
  hours by default), then appear when `ingest` is back.
- Low disk or memory is a common cause; see the [self-host troubleshooting](../self-host/troubleshooting.md).

You can also confirm directly in ClickHouse:

```bash
docker compose exec clickhouse clickhouse-client --query \
  "SELECT count() FROM events WHERE timestamp > now() - INTERVAL 1 HOUR"
```

## 5. Events arrive but pages look empty

- **Web Analytics** needs `$pageview` events. They come from the browser SDK with
  `capture_pageview` on (default). Server events have no URL.
- **Users** shows ids from `identify`/`distinctId`. If you never identify, visitors appear under
  random anonymous ids.
- **Funnels** need every step to use the same `distinct_id`.

## 6. Events are rejected by a schema

If you set an event's enforcement to **Strict** in [Data management](data-management.md), events
that miss a required property or use the wrong type are rejected, and capture answers `400` for
the whole batch. The response lists the event index, name and violations, and the SDKs print them with `console.warn`. Fix the sender
or switch the event to **Warn**.

## 7. Feature flags always return false

- The flag must be turned on in the **same environment** as the key you use.
- Browser: flags load asynchronously; use `onFeatureFlags`.
- Node: flags need a **read key** (`readKey`) in addition to the write key.
- The flag key is case-sensitive.

## Still stuck?

Collect the output of `docker compose ps`, the relevant logs (with keys removed) and the curl
result from step 1, and ask on the project issue tracker. See also
[self-host troubleshooting](../self-host/troubleshooting.md).
