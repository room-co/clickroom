# Product analytics

This guide covers the pages that answer "what are people doing": the event stream, funnels, and the
insight builder (trends, active users, retention, breakdowns).

## Events explorer

Sidebar **Events** shows a real-time stream of incoming events for the project. Type in the filter
box to narrow by event name, user or URL. Click a row to open the event and see every property,
including the autocaptured element path for clicks.

Use it to check that instrumentation works and to understand exactly what your SDK sends.

## Funnels

A funnel measures how many users get through an ordered series of events, and where they drop off.

1. Sidebar **Funnels**, then create a new funnel.
2. Name it, for example `Trial to paid conversion`.
3. Add 2 to 8 steps. For each step choose an event, optionally add property conditions, and
   optionally give the step a short alias.
4. Choose the **Conversion window**: **1h**, **1d** or **7d**. A user must finish the steps within
   this time of starting.
5. A live preview shows each step's count and conversion percentage. Save the funnel.

Funnel steps are matched per user, in order. Make sure all steps use the same `distinct_id` (call
`identify` before the later steps in your flow, or the user will look like two people).

## Insights

Sidebar **Product analytics** is the library of saved insights. Filter it by **All insights**,
**My insights** or **Favorites**, and search by name.

Create one with **New insight**. Give it a name, optional description and tags, then pick a type:

| Type | Question it answers | Main settings |
|---|---|---|
| **Trend** | How often does an event happen over time? | An event (or all events), **Hourly** or **Daily** interval, date range, optional property filters |
| **Active users** | How many distinct users were active? | **Day (DAU)**, **Week (WAU)** or **Month (MAU)**, date range |
| **Funnel** | Where do users drop off? | Steps and conversion window, as above |
| **Retention** | Do users come back? | Date range, optionally a host and the number of weekly cohorts |
| **Breakdown** | What is the split of an event by a dimension? | An event, a dimension, date range, optional filters |

Breakdown dimensions are **Page path**, **Referring domain**, **Current URL**, **Clicked element
text** and **Clicked element link**. Together with autocapture this answers questions like "which
buttons get clicked most".

The preview updates as you edit, before you save. Click **Create insight** to save, and **Save
changes** when editing.

### Date ranges

Insights use a date range such as the last 24 hours, 7, 14 or 30 days. Saved insights that use a
relative range are recomputed against the current time every time they are opened, so "last 7
days" always means the last 7 days.

### Property filters

Filters on trends, breakdowns and funnel steps check event properties. Operators are **equals**,
**is not**, **contains**, **greater than**, **less than** and **is set**.

## Put an insight on your dashboard

From the library or from the insight page, choose **Add to dashboard**. See
[Dashboards](dashboards.md).

## Related

- [Web analytics](web-analytics.md) for page-level traffic reports
- [SQL Explorer](sql-explorer.md) when the builders are not enough
- [Data management](data-management.md) to keep event names tidy
