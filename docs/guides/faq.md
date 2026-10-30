# FAQ

## Setup

**What do I put as `api_host`?**
`https://YOUR_CLICKROOM_HOST/capture`, where `YOUR_CLICKROOM_HOST` is the address of your dashboard.
The npm packages have no default host and will not send anything without one.

**Which key do I use where?**
A write key (`ckw_live_...`) in browsers, apps and servers for sending events. A read key
(`ckr_live_...`) only on servers that evaluate feature flags locally. See [API keys](api-keys.md).

**Is the write key a secret?**
No. It can only add events and ask for flag values, and it is visible in any website that uses it.
Treat the read key as a secret.

**Can I use one project for staging and production?**
You can use two [environments](concepts.md#environments), but they only separate keys and flags, not
analytics. Events from both land in the same project. Use a separate project if staging traffic must
not mix with production numbers.

**Do I need to send events from the server and the browser?**
No, either is enough. Use the server SDK for things the browser cannot see (payments, background
jobs) and make sure it uses the same `distinct_id` as the browser after `identify`.

## Events and users

**Why do I see `$autocapture` events with no useful name?**
Autocapture records raw clicks, form submits and changes with the element path. Use them in
breakdowns (**Clicked element text**), and send named events with `capture` for the actions that
matter. To stop autocapture on an element, give it the class `ch-no-capture` or the attribute
`data-ch-no-capture`; this applies to the element and everything inside it.

**How do I stop tracking a user who has not consented?**
The browser SDK has no built-in opt-out or consent API. Do not call `init` until the visitor has
consented, or leave `autocapture` and `capture_pageview` off and only capture what you are allowed
to. Delete data for a user from their page under **Users**.

**Is there session recording or replay?**
No. Clickroom does not record sessions as video. It tracks sessions as groups of events with a
session id. The support widget can attach recent events and console errors to a ticket.

**Does it support groups or companies?**
Not as a separate feature. Add a property such as `company_id` to events or to `identify` traits and
break down or filter on it.

**Why is the same person showing up twice?**
They were seen under an anonymous id and under their real id without linking. Call
`identify(userId)` as soon as the user is known, on every device. See
[Identity and sessions](../explanation/identity-and-sessions.md).

**Why does `$lib_version` say something I did not expect?**
Every browser event carries the SDK version in `$lib_version`. Check **Events** to see which version
a client runs.

## Feature flags

**Why is my flag false in the browser right after page load?**
Flags are fetched asynchronously. Use `onFeatureFlags` or check again after it fires.

**Do flag changes apply immediately?**
They apply to the next fetch. Servers poll every 30 seconds by default. The browser fetches on load
and on `identify`; set `feature_flag_poll_interval` (minimum 5000 ms) to poll while a page stays
open.

## Product

**Where is the SQL Explorer?**
It is in the sidebar. See [SQL Explorer](sql-explorer.md).

**Can I send emails (invites, resets)?**
No. There is no mail server. Invites are links you copy; password resets are done on the server. See
[Team and access](team-and-access.md).

**Does Clickroom send data to anyone?**
No. The server does not phone home. Ask AI sends your questions to the provider you configure.

**How do I upgrade or back up?**
See [upgrade](../self-host/upgrade.md) and [backup and restore](../self-host/backup-restore.md).
