# Feature flags

A feature flag is a switch you control from the dashboard and read in your code. Use flags to ship
code before you release it, roll a change out to a percentage of users, or give a feature to
specific people.

## Create a flag

1. Sidebar **Feature Flags**, then **New Flag**.
2. **Key.** The name your code will use, for example `new-checkout-flow`. Keys are case-sensitive
   and cannot change later, so choose something stable.
3. **Name** (optional) is a human-readable label. **Tags** (optional) are comma separated, for
   example `ui, beta`.
4. **Type.** One of:
   - `boolean`: on or off. Set the **initial rollout** with the slider (0 to 100 percent).
   - `string`: several named values, for example `control` and `beta`. Add the values and pick a
     default.
   - `number`: several labelled numeric values (for example `small` = 10, `large` = 50).
5. **Environment.** The flag is created in one environment. See below for copying it to others.
6. Optionally switch on **Track exposures** (see [Exposure tracking](#exposure-tracking)).
7. Click **Create flag**.

## Environments

The flag list has a tab for each environment of the project. A flag lives in one environment:
`new-checkout-flow` in `production` and `new-checkout-flow` in `development` are separate flags
with their own on/off switch and targeting. Create the flag again in the other environment, or build
it in `development` first and mirror it into `production` when you are ready.

The API key you use in code decides which environment's flags you get. A `development` write key
returns the `development` flags.

## Turn a flag on or off

Use the toggle on the flag row in the list or in the header of the flag page. When a flag is off,
every user gets `false`, whatever its targeting says.

## The flag page

Click a flag to open it. It has three tabs:

- **Metrics**: evaluations over time, how many came back true or false, the most common users and
  the split of values. Data appears once your code reads the flag with exposure tracking on.
- **Targeting**: who gets what (below).
- **History**: who changed the flag and when.

## Targeting rules

Open the **Targeting** tab. Rules are evaluated in order, and the first rule that matches decides.
Use the arrows to reorder. Click **Add rule** to add one.

A rule has:

- **Conditions**: zero or more property checks. All of them must match (AND). Leave it empty to
  match everyone. Each condition is a property name, an operator and a value. Operators are
  **equals**, **is not**, **contains**, **greater than**, **less than** and **is set**.
- **Rollout**: the percentage of matching users the rule applies to.
- **Serve** (boolean flags) or **value** (string and number flags): what matching users receive.

The last row, **to all other users**, is the default for anyone no rule caught. Click **Save
rules** (or **Save targeting**) to apply. Changes reach SDKs within about 30 seconds on servers, and
on the next flag refresh in browsers (see [Browser SDK](../sdk/browser.md#feature-flags)).

The properties a rule can test are the **user properties** you pass with `identify` (browser and
React Native) or `personProperties` (Node), plus `distinct_id` itself. To give a feature to one
person, add an **equals** rule on `distinct_id` or on `email`.

Example: beta for staff plus ten percent of everyone else

1. Rule 1: `email` **contains** `@yourcompany.com`, rollout 100, serve **true**.
2. Rule 2: no conditions, rollout 10, serve **true**.
3. Default (all other users): **false**.

One detail of rollout matters: a user who matches a rule but falls outside its rollout percentage is
served `false` and stops there. They do **not** continue to later rules or to the default. For
example, a rule with no conditions at 10 percent means the other 90 percent get `false`, and any
rule below it never runs (the page greys such rows out). Put narrow rules first and a broad
percentage rule last.

Rollout is deterministic. The same user always lands in the same bucket for a given flag, so
raising a rollout from 10 to 20 percent keeps the first 10 percent and adds more users. See
[how flag evaluation works](../explanation/flag-evaluation.md).

## Use a flag in code

### Browser

```ts
import clickroom from '@clickroom/sdk-js'

clickroom.init('ckw_live_xxx', { api_host: 'https://YOUR_CLICKROOM_HOST/capture' })

// Safe to call any time; returns false until flags have loaded.
if (clickroom.isFeatureEnabled('new-checkout-flow')) {
  showNewCheckout()
}

// Re-render when flags arrive or change.
clickroom.onFeatureFlags((flags) => {
  render(flags['new-checkout-flow'])
})

// String and number flags
const variant = clickroom.getFeatureFlag('checkout-copy') // 'control' | 'beta' | false
const payload = clickroom.getFeatureFlagPayload('max-seats') // the value of a number flag
```

Call `identify()` after login so rules that depend on user properties are re-evaluated for the
signed-in user.

### Node

```ts
import { ClickroomClient } from '@clickroom/sdk-node'

const clickroom = new ClickroomClient({
  writeKey: process.env.CLICKROOM_WRITE_KEY!,
  readKey: process.env.CLICKROOM_READ_KEY, // required for flags
  host: 'https://YOUR_CLICKROOM_HOST/capture',
})

if (clickroom.isFeatureEnabled('new-checkout-flow', user.id, { plan: user.plan })) {
  // ...
}
```

The Node SDK downloads flag definitions with the read key and evaluates them in your process, so a
flag check costs no network call. Always pass the user's id.

### React Native

```ts
const enabled = clickroom.isFeatureEnabled('new-checkout-flow')
```

Details and the `useFeatureFlag` hook are in the [React Native guide](../sdk/react-native.md).

### Any language

Send `POST https://YOUR_CLICKROOM_HOST/capture/v1/flags`. See the [HTTP API](../sdk/http-api.md).

## Exposure tracking

When **Track exposures** is on, each first read of the flag by a user records a
`$feature_flag_called` event. That powers the Metrics tab and [experiments](experiments.md). It is
off by default so that plain on/off gates, which servers may check thousands of times, do not create
extra events or count as users. Turn it on for flags you want to measure. You cannot turn it off
while a running experiment uses the flag.

## Delete a flag

Open the flag, choose **Delete flag**, and confirm. Remove the flag from your code first. A deleted
flag reads as `false`.

## Related

- [Experiments](experiments.md)
- [How flag evaluation works](../explanation/flag-evaluation.md)
- [API keys](api-keys.md)
