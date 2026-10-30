# Support widget and bug reports

The support widget adds a help button to your web app. Customers use it to send a message or report
a bug, you answer from an inbox in the dashboard, and replies appear back in the widget. It is part
of the browser SDK and is off until you turn it on.

## Create a support form

1. Sidebar **Support**, then **New support form**.
2. Give it a name, such as `In-app help`, and pick a **Template**: a contact form, a bug report, or
   blank.
3. In the builder, set up:
   - **Channel.** A contact form or a bug report. (An "AI answer bot" channel is shown as coming
     soon; the widget treats it as a contact form.)
   - **Fields.** Short text, long text, dropdown, email and file upload, each with a label and a
     required flag.
   - **Layout, position and appearance.** Launcher, slide-out, modal or inline; bottom right,
     bottom left or center; colors, launcher icon and size, greeting and thank-you text. A **Live
     preview** shows the result.
   - **User context.** What to attach to each ticket automatically, such as the user's identity,
     recent events, active feature flags and page URL.
   - **Bug context** (bug reports). Console errors, failed network requests and environment
     details captured around the report.
   - **Routing.** Where new tickets are sent. See [Webhooks](#webhooks).
4. Save, then activate the form.

## Show the widget in your app

Turn it on in the SDK:

```ts
clickroom.init('ckw_live_xxx', {
  api_host: 'https://YOUR_CLICKROOM_HOST/capture',
  support: true, // floating launcher button
})
```

To place the widget yourself instead of using the floating button (for example on a `/support`
page), use `support: { enabled: true, mode: 'manual' }` and mount it. React has a
`<ClickroomSupport mode="inline" />` component. All options and examples are in the
[browser SDK guide](../sdk/browser.md#support-widget).

Call `clickroom.identify(userId, { email })` for signed-in users so tickets are tied to a person.

File attachments need object storage, which is an optional part of the install; see [optional features](../self-host/optional-features.md).

## Work the inbox

Open a form and choose its inbox (**Open inbox**). You can:

- Filter tickets by status (open, pending, resolved, closed) and severity, and sort the list.
- Open a ticket to read the conversation, the attached user context and (for bugs) console
  errors, failed requests and environment.
- Type a reply and send it; it shows up in the customer's widget.
- Mark the ticket resolved, or reopen it.

The form page also shows ticket volume, volume by category and type, open tickets and median first
reply.

## Webhooks

To forward tickets to another system, go to **Settings**, stay on the **Environments** tab, and open the **Webhooks** card. A webhook is an HTTP
endpoint that receives tickets and replies. Create one with **New webhook**, then choose it as a
destination in the form's **Routing** section. Each webhook has a delivery history so you can see
what was sent and what failed.

## Related

- [Browser SDK](../sdk/browser.md)
- [Surveys](surveys.md)
