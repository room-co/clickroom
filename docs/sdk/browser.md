# Browser SDK

Package `@clickroom/sdk-js` (MIT licence). It captures pageviews and clicks automatically, sends
custom events in batches, tracks sessions, evaluates feature flags, and can show surveys and the
support widget.

You can add it two ways: a script snippet for plain websites, or the npm package for bundled apps.
Both talk to the capture service of your Clickroom install.

## What you need

- Your write key (`ckw_live_...`): sidebar **API Keys**, or the **Setup** page. See
  [API keys](../guides/api-keys.md).
- Your capture address: `https://YOUR_CLICKROOM_HOST/capture`. This is the `api_host`.

`api_host` is required for the npm package. There is no built-in default, and without it the SDK
logs a warning and stays disabled.

## Option A: script snippet (websites)

Open sidebar **Setup**, tab **HTML**, and copy the snippet into your page `<head>`. It already has
your write key and host. It installs a small stub, loads the full SDK from your own server
(`https://YOUR_CLICKROOM_HOST/capture/static/clickroom.js`) asynchronously, and replays any calls
made before it loaded.

If you prefer a plain script tag, this is equivalent:

```html
<script src="https://YOUR_CLICKROOM_HOST/capture/static/clickroom.js"></script>
<script>
  clickroom.init('ckw_live_xxx') // host inferred from the script's own address
</script>
```

When the SDK is loaded from `.../static/clickroom.js` it works out its own `api_host`, so you can
omit it. Passing `api_host` explicitly always wins.

## Option B: npm

```bash
npm install @clickroom/sdk-js
# or: pnpm add @clickroom/sdk-js
```

```ts
import clickroom from '@clickroom/sdk-js'

clickroom.init('ckw_live_xxx', {
  api_host: 'https://YOUR_CLICKROOM_HOST/capture',
  autocapture: true,
  capture_pageview: true,
})

clickroom.capture('signup_started', { plan: 'pro' })
```

Named exports (`init`, `capture`, `identify`, `reset`, ...) are also available. The SDK is safe to
import in server-rendered code: `init` does nothing outside a browser.

## Initialization options

`clickroom.init(writeKey, options)`. All options are optional except `api_host` for npm.

| Option | Default | Meaning |
|---|---|---|
| `api_host` | none | Your capture address, `https://YOUR_CLICKROOM_HOST/capture` |
| `autocapture` | `true` | Capture clicks, form submits and input changes, and SPA page navigations |
| `capture_pageview` | `true` | Send `$pageview` on load and, with autocapture on, on every route change. Set `false` to send no automatic pageviews |
| `feature_flag_poll_interval` | off | Re-fetch flags every N ms (minimum 5000) so long-lived pages see dashboard changes |
| `surveys` | `false` | Fetch and show [surveys](../guides/surveys.md) |
| `survey_poll_interval` | 300000 | How often to check for new surveys (ms, minimum 30000, 0 = off) |
| `support` | `false` | Turn on the [support widget](#support-widget). `true`, or `{ enabled, mode }` |
| `support_poll_interval` | 300000 | How often to refresh support form config (ms) |

Calling `init` twice does nothing the second time.

## Methods

| Method | What it does |
|---|---|
| `capture(event, properties?)` | Send a custom event |
| `identify(distinctId, properties?)` | Tell Clickroom who the visitor is and set user properties |
| `reset()` | Forget the current identity (call on logout) |
| `isFeatureEnabled(key)` | `true` when the flag is on for this user |
| `getFeatureFlag(key)` | The flag value: `true`, `false` or a string variant |
| `getFeatureFlagPayload(key)` | The payload of a string or number flag, or `null` |
| `onFeatureFlags(callback)` | Run `callback(flags)` when flags are loaded or change |
| `refreshFeatureFlags()` | Fetch flags again now |
| `stopFeatureFlagPolling()`, `stopSurveyPolling()`, `stopSupportPolling()` | Stop the background refreshes |
| `support.mount(options)`, `support.open()`, `support.close()` | Control the support widget |

### Capture events

```ts
clickroom.capture('checkout_completed', { plan: 'pro', amount: 49 })
```

Use `snake_case` names and keep them stable. Properties can be strings, numbers, booleans, arrays or
nested objects. Every event is also stamped with `$current_url`, `$pathname`, `$host`, `$referrer`,
screen and viewport size, `$session_id`, `$window_id`, UTM and channel information, `$lib` and
`$lib_version`.

Events are queued and sent in batches (when the queue reaches a size or after a short interval) to
`{api_host}/v1/capture`. Remaining events are flushed when the page unloads. Network errors and
server errors are retried with backoff. If the server rejects a batch with a `4xx` (for example a
[strict schema](../guides/data-management.md)), the SDK does not retry, drops the batch and logs the
reason with `console.warn`.

### Identify users

Visitors start as anonymous: the SDK makes a random id and keeps it in the browser's local storage.
When a user logs in or signs up, call `identify`:

```ts
clickroom.identify('user_8421', { email: 'ada@example.com', plan: 'pro' })
```

- Use your own stable user id. The second argument sets user properties, which show on the user's
  page and can be used in flag targeting.
- Events after the call use that id. Clickroom links the earlier anonymous activity to it.
- `identify` also re-evaluates feature flags for the user.
- Call it again whenever properties change, and on each page load for logged-in users.

When the user logs out:

```ts
clickroom.reset()
```

`reset` creates a new anonymous id and a new session, and clears cached flags, so the next person on
a shared device is not mixed with the previous one.

## Autocapture

With `autocapture: true` the SDK listens for `click`, `submit` and `change` events and sends them as
`$autocapture` events. Each one carries the element and its ancestors (tag, `id`, `class`, link
`href`, visible text and `data-*` attributes) in `elements_chain`. The SDK attributes a click to the
nearest "interesting" element: `a`, `button`, `input`, `select`, `textarea`, `label`, or anything with
a `role`, an `onclick`, or a `data-ch-capture` attribute.

It also sends `$pageview` on load and on every single-page-app navigation: `pushState`,
`replaceState`, back/forward and hash changes. You do not need router integration.

To exclude parts of the page, add the class `ch-no-capture` or the attribute `data-ch-no-capture` to
an element. Nothing inside it is captured. Do this for anything sensitive, because autocapture
records visible text.

Turn autocapture off with `autocapture: false` to send only your own events. If you keep
`capture_pageview: true`, the first pageview is still sent, but single-page-app route changes are
not, so send those yourself:

```ts
clickroom.capture('$pageview')
```

## Sessions

The SDK stamps `$session_id` and `$window_id` on every event. A session is shared by all tabs of the
browser and ends after 30 minutes with no activity, or 24 hours at most. `$window_id` identifies the
tab. `reset()` starts a new session. Web analytics and the Sessions tab on a user are based on these
ids. See [Identity and sessions](../explanation/identity-and-sessions.md).

## Consent and privacy

The SDK has no built-in opt-out switch or consent banner. To respect consent, only call `init`
after the visitor agrees (or before consent, call it with `autocapture: false` and
`capture_pageview: false` and capture nothing). To remove a person's data later, use **Delete user
data** on their page under **Users**. See the [FAQ](../guides/faq.md).

The SDK stores its state in `localStorage` and `sessionStorage` under keys that start with `ckrm_`.
It does not set cookies.

## Feature flags

```ts
if (clickroom.isFeatureEnabled('new-checkout-flow')) {
  /* ... */
}

clickroom.onFeatureFlags((flags) => {
  // flags: { 'new-checkout-flow': true, 'checkout-copy': 'beta', ... }
})
```

Flags are fetched from your server on `init` and again on `identify`, cached in local storage, and
evaluated on the server for the current user. A cheap version check avoids downloading flags that
have not changed. Until the first response arrives, `isFeatureEnabled` returns `false`, so use
`onFeatureFlags` for anything that must wait.

Reading a flag records a `$feature_flag_called` event once per flag and value, but only for flags
that have **Track exposures** switched on. See [Feature flags](../guides/feature-flags.md).

## React

The package ships React helpers at `@clickroom/sdk-js/react`: hooks for surveys
(`useActiveSurveys`, `useSurvey`, `captureSurveyResponse`) and support
(`useSupportForms`, `useSupportForm`, `useSupportTickets`, `submitSupportTicket`) and the
`<ClickroomSupport />` component. Core tracking and flags use the same `clickroom` object; call
`init` once at startup, for example in your app entry file or a top-level effect.

## Support widget

Opt in with `support`. It adds a help button that lets customers send a message or report a bug,
configured under sidebar **Support** (see [Support widget and bug reports](../guides/support-widget.md)).

```ts
// Floating button (default)
clickroom.init('ckw_live_xxx', { api_host, support: true })

// Build the client, mount nothing: you place it yourself
clickroom.init('ckw_live_xxx', { api_host, support: { enabled: true, mode: 'manual' } })

// Floating button and manual mounts
clickroom.init('ckw_live_xxx', { api_host, support: { enabled: true, mode: 'both' } })
```

Mount it inside your own page:

```tsx
import { ClickroomSupport } from '@clickroom/sdk-js/react'

<ClickroomSupport mode="inline" />
```

```js
const handle = clickroom.support.mount({
  el: '#support', // element or selector
  mode: 'inline', // 'inline' fills the container, 'launcher' is a button
  view: 'home',   // 'home' | 'search' | 'bot' | 'new' | 'tickets' | 'thread'
})
// when leaving the page
handle?.destroy()
```

`clickroom.support.open()` and `.close()` open and close the widget, for example from your own "Help"
link. Mode only changes where the widget mounts; identity, event context and analytics work the same
in every mode.

## Versions

Every event carries `$lib_version`. Use it in **Events** to confirm which clients picked up a new
release. If you upgrade from a release older than 0.10.0 and relied on a default host, add
`api_host` explicitly.
