# Core concepts

A short glossary of the ideas the rest of the docs rely on.

## Organization and projects

An **organization** is your workspace: it owns the members, the single sign-on settings, and the AI
provider key. It contains one or more **projects**.

A **project** is the unit of data. Events, users, flags, experiments, insights, surveys and
segments all belong to one project. Data from different projects never mixes. Use one project per
product or site. Switch projects with the selector at the top of the sidebar.

## Environments

Every project has **environments**, by default `production` (the default one) and `development`.
You can add more (for example `staging`) in **Settings**, **Environments**, **New environment**. The
key of an environment is lowercase letters, digits and hyphens and cannot be changed afterwards.

Environments separate:

- **API keys.** Each key belongs to one environment.
- **Feature flags.** The same flag key can have a different on/off state and targeting in each
  environment. The flag list has a tab per environment.

Analytics views (events, users, funnels, insights) are per project. Events are not split by
environment in the explorers. If you need fully separate data, for example a test site that must not
pollute production numbers, use a separate project.

## Events

An **event** is something that happened: a page was viewed, a button was clicked, a purchase
completed. Each event has:

| Field | Meaning |
|---|---|
| `event` | The name, for example `checkout_completed` |
| `distinct_id` | Who did it (see below) |
| `timestamp` | When it happened (the SDKs set this for you) |
| `properties` | A JSON object of extra details, for example `{ "plan": "pro" }` |

Names that start with `$` are reserved for events Clickroom creates itself:

| Event | Created when |
|---|---|
| `$pageview` | A page is loaded or the URL changes in a single-page app |
| `$autocapture` | A click, form submit or input change is captured automatically |
| `$identify` | `identify` is called |
| `$feature_flag_called` | A flag is read in code and the flag has exposure tracking on |
| `$screen` | `screen()` is called in the React Native SDK |
| `$survey_*`, `$support_*` | Survey and support widget activity |

Pick your own event names in `snake_case` and keep them stable: funnels and insights match on the
exact name.

## Properties

Properties are the key/value details on an event. The browser SDK adds many automatically, such as
`$current_url`, `$pathname`, `$host`, `$referrer`, `$screen_width`, `$session_id`, `$lib` and
`$lib_version`, and UTM and channel information. You add your own as the second argument of
`capture`.

Properties you set with `identify` describe the **user** rather than one event. Use them for traits
such as `email` or `plan`.

## Users and distinct ids

A **distinct id** is the string that says which user an event belongs to.

- In the browser and in React Native the SDK first makes a random anonymous id and stores it on the
  device.
- When you call `identify('user-123')`, later events use your id, and Clickroom links the earlier
  anonymous activity to it.
- On a server you always pass `distinctId` yourself.

Use a stable internal id such as a database id. Avoid using an email address as the id if it can
change. The **Users** page lists distinct ids with their activity. Clickroom has no separate
"person" record to maintain: users are built from events. See
[Identity and sessions](../explanation/identity-and-sessions.md).

## Sessions

A **session** is one visit. The browser SDK stamps a `$session_id` on every event. A new session
starts after 30 minutes with no activity in any tab, or after 24 hours at most. The same session is
shared by all tabs of one browser. Sessions drive the Sessions tab on a user and web analytics
numbers such as bounce rate.

## Feature flags, experiments and segments

- A **feature flag** is a switch you control from the dashboard and read in code. See
  [Feature flags](feature-flags.md).
- An **experiment** splits users between variants of a flag and measures a metric. See
  [Experiments](experiments.md).
- A **segment** is a saved group of users defined by traits and behavior. See
  [Users and segments](users-and-segments.md).

## Keys

- A **write key** (`ckw_live_...`) sends events and fetches flag values. Safe in client code.
- A **read key** (`ckr_live_...`) reads flag definitions for local evaluation on servers. Keep it
  secret.

See [API keys](api-keys.md).

## Roles

Members of an organization have one of three roles: **Admin**, **Member** or **Viewer**. See
[Team and access](team-and-access.md).
