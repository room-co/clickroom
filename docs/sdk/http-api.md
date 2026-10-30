# HTTP capture API

Use these endpoints to send events or evaluate flags from a language without an SDK. All paths are
under `https://YOUR_CLICKROOM_HOST/capture`.

## Authentication

Send your project key as a bearer token:

```
Authorization: Bearer ckw_live_xxx
```

or as a query parameter, `?token=ckw_live_xxx` (used by browser beacons). Event capture and flag
evaluation use a **write** key. Downloading flag definitions uses a **read** key. A missing, wrong
or revoked key returns `401`. See [API keys](../guides/api-keys.md).

## Capture events

`POST /capture/v1/capture`

```bash
curl -i https://YOUR_CLICKROOM_HOST/capture/v1/capture \
  -H "Authorization: Bearer ckw_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "batch": [
      {
        "event": "checkout_completed",
        "distinct_id": "user_8421",
        "timestamp": "2026-03-01T10:00:00.000Z",
        "properties": { "plan": "pro", "amount": 49 }
      }
    ]
  }'
```

| Field | Required | Notes |
|---|---|---|
| `batch` | yes | 1 to 100 events |
| `batch[].event` | yes | Event name |
| `batch[].distinct_id` | yes | The user id |
| `batch[].timestamp` | no | ISO 8601 UTC. Defaults to the time the server receives it |
| `batch[].properties` | no | JSON object |

The request body can be at most 1 MiB.

Responses:

| Status | Meaning |
|---|---|
| `202` | Accepted and queued. Body: `{ "accepted": <count>, "errors": [] }` |
| `400` | Invalid JSON, empty batch, or an event that breaks a strict schema. For schema errors the body is `{ "accepted": 0, "errors": [{ "index", "event", "violations": [...] }] }` |
| `401` | Bad or missing key |
| `402` | A usage quota was exceeded (does not apply to self-hosted installs) |
| `413` | More than 100 events or a body over 1 MiB |
| `429` | Rate limited; honor the `Retry-After` header |
| `503` | The queue is full or unavailable; retry later |

The endpoint allows cross-origin requests from any website, so browsers can call it directly.

## Evaluate flags

`POST /capture/v1/flags` with a write key.

```bash
curl https://YOUR_CLICKROOM_HOST/capture/v1/flags \
  -H "Authorization: Bearer ckw_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{ "distinct_id": "user_8421", "person_properties": { "plan": "pro" } }'
```

Response:

```json
{
  "flags": {
    "new-checkout-flow": { "enabled": true, "variant": null, "payload": null, "track": false },
    "checkout-copy": { "enabled": true, "variant": "beta", "payload": "beta", "track": true }
  }
}
```

Every flag of the key's environment is returned, including those that are off. For flags with
`track: true` (**Track exposures** on), the call records an exposure for that user.

`GET /capture/v1/flags/version` with a write key returns a version marker that changes when flags
change, so clients can skip a full download. SDKs use it.

## Download flag definitions

`GET /capture/v1/flag-definitions` with a **read** key returns the environment's flag definitions
(`{ "flags": [{ "key", "active", "filters" }], "version": N }`) for local evaluation, as the Node SDK
does. See [How flag evaluation works](../explanation/flag-evaluation.md).

## Surveys and support configuration

`GET /capture/v1/surveys` and `GET /capture/v1/support` return the active survey and support form
configuration for a write key. They are used by the browser SDK; you normally do not call them
yourself.

## Health check

`GET /capture/health` returns `ok` when the capture service is running.

## SDK script

`GET /capture/static/clickroom.js` serves the browser SDK bundle.
