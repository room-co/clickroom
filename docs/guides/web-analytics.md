# Web analytics

Sidebar **Web Analytics** gives a traffic report for a website: who visited, which pages they
viewed, where they came from and what devices they used. It is built from the `$pageview` events
that the [browser SDK](../sdk/browser.md) sends, so it works with no extra setup once the SDK is on
your site with `capture_pageview` on (the default).

## What you see

- **Summary cards.** Visitors, Pageviews and Sessions for the selected period.
- **Visitors over time.** A chart with a selectable interval.
- **Top paths.** The most viewed pages, with visitors, views and bounce rate per path.
- **Sources.** Where visits come from, grouped by **Channel** (for example direct, search, social)
  or **UTM source**.
- **Devices.** Split by **Device**, **Browser** or **OS**.
- **Active hours.** When during the week your visitors are active.
- **Retention.** A weekly cohort table showing how many visitors return in later weeks.

## Filter

- Use the date range control in the page header.
- Use the **All hosts** selector to look at one domain only. This helps when the same project
  receives traffic from several hostnames, such as `www.example.com` and `app.example.com`.

## How the numbers are defined

- A **visitor** is a distinct user id seen in the period.
- A **session** follows the browser SDK's session rules: 30 minutes of inactivity ends a session,
  and a session lasts at most 24 hours. See [Identity and sessions](../explanation/identity-and-sessions.md).
- Channel and UTM information is read from the page URL and referrer at the start of each session.
  Campaign links need `utm_source`, `utm_medium` and `utm_campaign` query parameters.

## If the page is empty

- Check that **Events** shows `$pageview` events. If not, see
  [Troubleshooting](troubleshooting-no-events.md).
- Server-side events (Node SDK) carry no URL, so they do not appear here.
- Single-page apps are covered: the SDK records a `$pageview` on every route change.

## Related

- [Product analytics](product-analytics.md) for custom breakdowns and funnels
- [Dashboards](dashboards.md)
