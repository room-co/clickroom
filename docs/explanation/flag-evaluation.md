# How feature flag evaluation works

Understanding the rules makes rollouts predictable.

## Order of evaluation

A flag is a list of **rules** (called groups internally), each with conditions and a rollout
percentage, plus an on/off switch.

1. If the flag is switched off, everyone gets `false`.
2. Rules are checked top to bottom. The first rule whose conditions all match the user is the
   deciding rule.
3. Inside the deciding rule the user is bucketed (see below). If the bucket is inside the rollout
   percentage, the user gets that rule's value. If not, the user gets `false` and evaluation
   **stops**: later rules and the default are not tried.
4. If no rule matches, the user gets `false`. For boolean flags created in the dashboard, the last
   row ("to all other users") is a rule with no conditions, so it always matches.

Conditions test **user properties** (`plan`, `email`, ...) and `distinct_id`. Operators are equals,
is not, contains, greater than, less than and is set. A rule with no conditions matches everyone.

## Bucketing

A user is placed at a fixed point between 0 and 1 for each flag:

```
bucket = SHA1(flag_key + "." + distinct_id) -> first 15 hex digits -> integer / 0xFFFFFFFFFFFFFFF
```

The user is in the rollout when `bucket < rollout_percentage / 100`. Because the point depends only
on the flag key and the user id:

- the same user always gets the same answer for a flag;
- raising a rollout from 10 to 20 percent keeps everyone who was in and adds more;
- different flags bucket users independently, so being in the first 10 percent of one flag says
  nothing about another.

## Multivariate flags

String and number flags pick a value with a second hash that uses the extra suffix `variant`:

```
variant_bucket = SHA1(flag_key + "." + distinct_id + "variant") -> same conversion
```

The variants' percentages are added up in order; the first variant whose running total exceeds the
bucket wins. A rule can also be pinned to one specific value, which is how the dashboard builds
"if `plan` equals `pro`, serve `beta`".

Experiments use this: the experiment's variants become the flag's variants.

## Where evaluation happens

| SDK | Evaluated | Needs |
|---|---|---|
| Browser | On the server (`POST /v1/flags`), per user, cached in the page | Write key |
| React Native | On the server, cached on the device | Write key |
| Node | In your process from downloaded definitions | Read key |
| HTTP API | On the server | Write key |

All implementations use the same hashing, and automated tests keep them identical, so the browser
and your backend agree on the same user.

## Freshness

Each environment's flags are cached by the capture service and updated when you save a change. The
browser fetches on load, on `identify`, and every `feature_flag_poll_interval` if you set it. The
Node SDK and React Native SDK poll every 30 seconds by default.
