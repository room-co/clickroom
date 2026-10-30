# Identity and sessions

How Clickroom decides which events belong to which person, and which events belong to one visit.

## Distinct ids

Every event has a `distinct_id`. Clickroom does not keep a separate "person" table that you edit;
users are derived from the events and the links between ids.

- **Anonymous id.** The browser and React Native SDKs create a random id on first run and save it
  (browser `localStorage`, key `ckrm_did`; React Native storage). Until you identify the user, all
  events use it.
- **Identified id.** When you call `identify('user_8421', traits)`, the SDK switches to that id and
  sends a `$identify` event. That event carries the traits (`$set`) and, if the id changed, the
  previous anonymous id (`$anon_distinct_id`). Clickroom records the link between the two ids in its
  `person_distinct_ids` table, so activity before and after login belongs to one user.
- **Server ids.** The Node SDK and the HTTP API have no memory. You pass the id on each call. Use the
  same id you passed to `identify` in the browser.

### Good practice

- Use a stable id from your own database, not an email address that can change.
- Call `identify` as soon as you know who the user is, on every device and app they use.
- Call `reset()` on logout so the next person on that device starts clean.
- Do not identify two different people with the same id.

### Merging

Linking anonymous and identified ids happens when `identify` is called with a different id than the
current one. Once linked, user pages and counts treat them as one person. Deleting a user's data
removes all ids linked to them.

## User properties

Properties passed to `identify` describe the user (`email`, `plan`, ...). They appear on the user's
**Properties** tab and are the inputs for [flag targeting rules](../guides/feature-flags.md) and
[segment](../guides/users-and-segments.md) trait conditions.

## Sessions

The browser SDK keeps two ids:

| Id | Property | Scope |
|---|---|---|
| Session id | `$session_id` | One visit, shared by every tab of the browser |
| Window id | `$window_id` | One tab within the visit |

A session ends when every tab has been idle for 30 minutes, or after 24 hours, whichever comes
first. The next event then starts a new session. A duplicated tab gets its own window id. `reset()`
starts a new session. The session id is kept in `localStorage` under `ckrm_sid`, so it survives
reloads and is shared across tabs; if storage is unavailable (private browsing, embedded webviews),
the SDK falls back to one id per page load.

Server SDK events have no session id.

## What Clickroom stores in the browser

All keys start with `ckrm_` and live in `localStorage` or `sessionStorage`: the anonymous id, the
session id, the window id and the flag cache. No cookies are set by the SDK.
