# Experiments

An experiment splits users between two or more variants and measures which variant does better on a
metric you choose. Experiments are built on feature flags: the experiment creates a flag, your code
reads the flag to decide what to show, and Clickroom measures what each group does afterwards.

## Create an experiment

1. Sidebar **Experiments**, then create a new experiment.
2. **Experiment name**, for example `New onboarding flow`. **Hypothesis** and **Description** are
   optional.
3. **Variants.** The default is `control` and `test`, 50 percent each. Click **Add variant** for
   more. Each variant has a key (the value your code will see) and a traffic percentage. You need
   at least two variants. Variants can only be edited while the experiment is a draft.
4. **Primary metric**: the number the experiment is judged on. See below.
5. Optionally add **secondary metrics** to watch side effects.
6. Click **Create experiment**.

Creating an experiment also creates a feature flag named like `exp-new-onboarding-flow-a1b2c3`. You
will find it under **Feature Flags**. It is a string flag whose values are your variant keys.

## Metric types

| Type | You choose | It measures |
|---|---|---|
| **Funnel** | 2 to 8 steps (events, optional property filters) and a time window | The share of users who completed every step |
| **Mean** | An event and a numeric property such as `amount` | The average of that property per user |
| **Ratio** | A numerator event and a denominator event | Numerator events divided by denominator events, per user |
| **Retention** | A return event and a number of days | The share of users who came back and did the event within that many days |

## Use the experiment in code

Read the flag and branch on the variant. Use the flag key shown on the **Feature Flags** page.

```ts
const variant = clickroom.getFeatureFlag('exp-new-onboarding-flow-a1b2c3')

if (variant === 'test') {
  showNewOnboarding()
} else {
  showOldOnboarding() // 'control', or false when flags have not loaded
}
```

Reading the flag records a `$feature_flag_called` event. That event is how Clickroom knows a user
was **exposed** to a variant, and only exposed users are counted. Make sure the code that reads
the flag runs for every user who should be in the experiment, and that you send the events your
metric needs (for example the final step of a funnel) with the same `distinct_id`. Call `identify`
after login so the same person keeps the same variant across devices.

The bucketing is deterministic per user, so a user keeps their variant for the whole experiment.

## Launch, stop, restart

Open the experiment from the list to edit it.

- **Launch** (from draft): turns the linked flag on, makes sure exposure tracking is on, and starts
  collecting data.
- **Stop** (while running): ends the experiment and moves it to complete.
- **Restart** (from complete): starts collecting again and clears the previous end date.
- **View results**: available while running and after it completes.

Deleting an experiment does not delete its flag.

## Read the results

Open **View results**. For each variant you see how many users were exposed, the metric value, an
uplift versus control, a 95 percent credible interval, and the chance that the variant is the best
one. Clickroom uses a Bayesian model. A variant is declared the **winner** only when its chance to
be best reaches 95 percent. Below that you may see a note that a variant is trending, or a "not
enough data yet" message.

Tips:

- Let the experiment run until each variant has a meaningful number of exposures. Early results
  swing a lot.
- Do not change the variants or traffic split once users are exposed.
- If results say nothing was recorded, check that your code reads the flag and that exposure events
  are arriving (see [Troubleshooting](troubleshooting-no-events.md)).

## Related

- [Feature flags](feature-flags.md)
- [Product analytics](product-analytics.md)
