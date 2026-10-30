# @clickroom/sdk-js

Browser SDK for clickroom — autocapture, batched event transport, and feature flags.
Ships two ways: a **CDN `<script>` snippet** for plain HTML pages and an **npm ESM
package** for bundled apps.

## Install

### Option A — CDN snippet (recommended for websites)

Paste this into your page `<head>`. It installs a queued stub immediately, loads the
real bundle asynchronously, and replays any calls made before load:

<!-- Generated from packages/sdk-js/loader.js via `pnpm build` (dist/loader.min.js) — don't hand-edit this stub line, regenerate it instead. -->
```html
<script>
  "use strict";(()=>{(function(a,c){var s="https://YOUR_CAPTURE_HOST",l=!1,p="/static/clickroom.js",n=["init","capture","identify","reset","isFeatureEnabled","getFeatureFlag","onFeatureFlags"];if(a.clickroom&&a.clickroom.__loaded__)return;var r=a.clickroom||{};r._q=r._q||[],r.__stub__=!0;function _(e){return function(){var t=Array.prototype.slice.call(arguments);r._q.push([e,t]),e==="init"&&(t[1]&&t[1].api_host&&(s=t[1].api_host),v())}}var i;for(i=0;i<n.length;i++)r[n[i]]=_(n[i]);a.clickroom=r;function f(){var e=a.clickroom,t,o,u;if(!(!e||e.__stub__))for(t=0;t<r._q.length;t++)o=r._q[t][0],u=r._q[t][1],typeof e[o]=="function"&&e[o].apply(e,u)}function v(){if(!l){l=!0;var e=c.createElement("script");e.type="text/javascript",e.async=!0,e.src=s.replace(/\/$/,"")+p,e.onload=f;var t=c.getElementsByTagName("script")[0];t&&t.parentNode?t.parentNode.insertBefore(e,t):c.head.appendChild(e)}}})(window,document);})();

  clickroom.init('ckw_live_xxx', { api_host: 'https://your-host', autocapture: true })
</script>
```

Set `api_host` in the `init` call to your capture host (see below); the script
is injected on the first `init()` using that `api_host`. The readable source is [`loader.js`](./loader.js).

### Option B — npm

```sh
pnpm add @clickroom/sdk-js
```

```ts
import clickroom, { init, capture } from '@clickroom/sdk-js'

init('ckw_live_xxx', { api_host: 'https://your-host', autocapture: true })
capture('signup_started', { plan: 'pro' })
// or via the default singleton:
clickroom.capture('signup_completed')
```

## Quickstart

```ts
import clickroom from '@clickroom/sdk-js'

clickroom.init('ckw_live_xxx', {
  api_host: 'https://your-host',
  autocapture: true, // auto-track clicks, submits, and SPA pageviews
  capture_pageview: true,
})
```

### Choosing `api_host`

There is no default host. Pass `api_host` pointing at your capture endpoint:

- **Self-hosted**: your own URL, e.g. `https://clickroom.example.com/capture` (single-domain
  install) or `https://capture.example.com`.
- **Clickroom Cloud**: `https://capture.clickroom.co` (exported as `CLICKROOM_CLOUD_HOST`).

When the SDK is loaded from `{api_host}/static/clickroom.js` (the script-tag install above), it
infers its host from that script's own URL, so `init(key)` works with no `api_host`. With the npm
install, omitting `api_host` logs a warning and the SDK stays disabled.

Events are batched (flushed by size/interval) and POSTed to `{api_host}/v1/capture` as
`{ batch: EventPayload[] }`. A `beforeunload` beacon flushes the remaining queue.

### Error handling

If the server rejects a batch outright (HTTP 4xx — e.g. a schema-invalid event under strict
validation), the SDK does **not** retry: retrying a request the server will never accept would
just waste the retry budget and delay delivery of everything behind it. The batch is dropped and
the failure is surfaced via `console.warn`, including the response body (e.g. `{ accepted, errors
}`) when the server returns one, so you can see which event/property failed validation. Network
errors and 5xx responses are unaffected — the SDK retries those with its existing bounded
exponential backoff.

## Public API

| Method | Signature | Description |
| --- | --- | --- |
| `init` | `init(writeKey, options?)` | Initialise the SDK. `options`: `api_host`, `autocapture`, `capture_pageview`. |
| `capture` | `capture(event, properties?)` | Enqueue a custom event. |
| `identify` | `identify(distinctId, properties?)` | Associate the current session with a user id. |
| `reset` | `reset()` | Clear the current identity / anonymous id. |
| `isFeatureEnabled` | `isFeatureEnabled(key): boolean` | Whether a boolean flag is on. |
| `getFeatureFlag` | `getFeatureFlag(key): string \| boolean \| undefined` | Flag value (multivariate). |
| `onFeatureFlags` | `onFeatureFlags(cb)` | Subscribe to flag updates. |

All of the above are available both as named exports and as methods on the default
`clickroom` singleton (and on `window.clickroom` when loaded via the CDN bundle).

## Feature flags

Flag methods (`isFeatureEnabled` / `getFeatureFlag` / `onFeatureFlags`) are fully
implemented: flags are fetched from `{api_host}/v1/flags` (with a cheap `{api_host}/v1/flags/version`
check ahead of it to skip the full fetch when nothing changed), evaluated, cached in
`localStorage`, and re-fetched on `identify()` or via the optional
`feature_flag_poll_interval`.

## Support widget

Opt-in (`support` is off by default — an existing embed fetches zero extra bytes). When enabled,
`init()` fetches + caches the form config from `GET /v1/support`, gates each form on its linked
flag, and builds the support client. There are three shapes, and they differ **only** in where the
UI mounts — **identity, event context, form analytics and realtime replies are wired identically in
every mode.** The tracking story does not change between the FAB and an inline page.

**1. Default FAB — unchanged.** `support: true` behaves exactly as before: it auto-mounts the
floating launcher. This is byte-identical to prior releases; nothing about `support: true` changed.

```js
clickroom.init('WRITE_KEY', { support: true })
// normalises to { enabled: true, mode: 'launcher' }
```

**2. Page-only (`mode: 'manual'`).** Build the client but mount nothing — you place the support
surface yourself as a full page. Nothing auto-mounts; no FAB.

```js
clickroom.init('WRITE_KEY', { support: { enabled: true, mode: 'manual' } })
```

React — extend the existing `<ClickroomSupport>` with `mode="inline"`:

```tsx
import { ClickroomSupport } from '@clickroom/sdk-js/react'

// e.g. a /support route
<ClickroomSupport mode="inline" />
```

Vanilla (Vue / Svelte / Angular / plain JS) — `clickroom.support.mount()` returns the same
`SupportRenderHandle` (`open()` / `close()` / `refresh()` / `destroy()`). Call `destroy()` on route
leave so a route change doesn't leak the host:

```js
const handle = clickroom.support.mount({
  el: '#support',          // HTMLElement | selector string
  mode: 'inline',          // 'inline' (default) fills the container | 'launcher'
  view: 'home',            // 'home' (default) | 'search' | 'bot' | 'new' | 'tickets' | 'thread'
  home: 'search',          // 'search' (default) | 'conversations' — the home surface's posture
  // formId, ticketId, onTicketOpen, onTicketCreated optional
})
// on unmount:
handle?.destroy()
```

`view` picks the opening surface: `'home'` is the search-first landing, `'search'` the docs search,
`'bot'` the AI assistant, `'new'` a fresh conversation, `'tickets'` the conversation list, and
`'thread'` a single thread (implied when you pass `ticketId` without a `view`). `home` only affects
the `'home'` surface, and falls back to `'conversations'` automatically when the form has no docs
source connected. The same `view` / `home` props exist on `<ClickroomSupport mode="inline" />`.

`clickroom.support.open()` / `.close()` drive the support surface from a customer's own "Help" nav
item — the one you mounted via `mount()` if there is one, otherwise the auto-mounted FAB. Both are
no-ops when support is off or nothing is mounted.

**3. Both (`mode: 'both'`).** Auto-mount the FAB **and** allow manual mounts — a FAB on marketing
pages plus a full page at `/support`.

```js
clickroom.init('WRITE_KEY', { support: { enabled: true, mode: 'both' } })
```

`mode` gates exactly one thing — whether the FAB auto-mounts. `'launcher'` (default) and `'both'`
auto-mount it; `'manual'` does not. Config fetch, flag gating, the ticket-token store, the
`recentEvents` context ring, the realtime subscription and every `$support_*` event are the same
across all three.

## Build

```sh
pnpm --filter @clickroom/sdk-js build
```

Outputs to `dist/`:

- `clickroom.js` — minified IIFE CDN bundle (entry `src/global.ts`, exposes `window.clickroom`)
- `index.js` — ESM entry for npm consumers (entry `src/index.ts`)
- `index.d.ts` — type declarations (`tsc --emitDeclarationOnly`)
- `*.js.map` — source maps

Build pipeline: [`esbuild.config.mjs`](./esbuild.config.mjs) then `tsc` for types.

## Demo

[`demo/index.html`](./demo/index.html) is a manual / Playwright test page. Build first,
then open it (or serve the package dir) and watch batched `202`s in the Network tab.
