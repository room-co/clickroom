# Surveys

Surveys show a short popover in your web app and collect answers: satisfaction (CSAT), effort
(CES), net promoter score (NPS) or anything you write. Surveys work in the browser SDK only.

## Turn on surveys in the SDK

Surveys are off by default so pages that do not use them fetch nothing extra. Enable them in
`init`:

```ts
clickroom.init('ckw_live_xxx', {
  api_host: 'https://YOUR_CLICKROOM_HOST/capture',
  surveys: true,
})
```

The SDK fetches the active surveys, shows the matching one when its trigger fires, and records
`$survey_shown`, `$survey_dismissed` and `$survey_sent` events. It re-checks for new surveys
every 5 minutes by default (`survey_poll_interval`, minimum 30000 ms), so a survey you publish
reaches open pages without a reload.

## Create a survey

1. Sidebar **Surveys**, then **New survey**.
2. Enter a name, for example `Post-checkout CSAT`, and pick a **Template**: **CSAT**, **CES**,
   **NPS** or **Start from scratch**.
3. In the builder, edit the sections:
   - **Questions.** Add, reorder and remove questions. Types are **Rating** (scale of 5, 7 or 10,
     shown as numbers, emoji or stars, with optional low/high labels), **Open** text, **Single
     choice**, **Multiple choice** and **Link** (a button that opens a URL).
   - **Display / Position.** Bottom right, bottom left or center.
   - **Appearance.** Background and text colors and the thank-you message.
   - **Triggers.** When to show it (below).
   - **Frequency.** **Once** per user, **Always**, or every N days.
4. **Live preview** shows the result as you edit. Save.

### Triggers

A survey appears when its conditions are met. You can combine:

- **Events**: show after the user triggers one of the listed events, optionally filtered by event
  properties.
- **URL match**: only on pages whose URL matches, for example `/pricing`.
- **Selector**: show when the user clicks an element that matches a CSS selector, for example
  `.upgrade-button`.
- **Delay**: wait this many milliseconds first.

### Audience

Each survey has a linked feature flag. By default it is shown to everyone who matches the triggers.
Use the **Advanced targeting** link in the Audience section to open the flag and narrow it by user
properties or a rollout percentage. See [Feature flags](feature-flags.md).

## Activate, pause, archive

A new survey is a draft. Click **Activate** to start showing it, **Pause** to stop (it returns to
draft), or archive it when you are done.

## Read results

Open a survey and choose **View results**. You see how many people it was **Shown** to, how many
**Responded**, the response rate, a **Question breakdown** per question, open-text answers
(searchable), and **Response rate by segment** if you have [segments](users-and-segments.md).

## Related

- [Browser SDK](../sdk/browser.md)
- [Feature flags](feature-flags.md)
