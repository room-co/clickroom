# Getting started

This guide takes you from a fresh install to your first event on screen. It assumes Clickroom is
already running (see the [self-host quickstart](../self-host/quickstart.md)) and you can open the
dashboard at `https://YOUR_CLICKROOM_HOST`.

## 1. Create the owner account

On a new install the first sign-up becomes the owner. Open the dashboard, choose sign up, and enter
your name, email, password and a workspace name. Sign-up creates your organization and a project
named **Default**.

After the first account exists, other people join by invitation (see
[Team and access](team-and-access.md)).

## 2. Pick or create a project

A project is one product or site whose events you want to analyse. The project selector at the top
of the sidebar switches between projects.

To add another one: sidebar **Projects**, then **New project**, then **Create project**. Every new
project starts with two [environments](concepts.md#environments), `production` and `development`.

## 3. Create a write key

Events are sent with a **write key**. It identifies your project and environment.

1. Sidebar **API Keys**, then **New key**.
2. Give it a label such as `Production website`.
3. Leave the type on **Write** and choose the environment.
4. Click **Generate key**.

Write keys start with `ckw_live_`. A write key is meant to be embedded in web pages and apps, so it
is safe to ship in client code. Read more in [API keys](api-keys.md).

## 4. Send your first event

Open sidebar **Setup**. It shows ready-to-paste snippets with your real write key and host filled
in, in four tabs: **HTML**, **Web**, **Node** and **API**.

The quickest test needs no SDK at all:

```bash
curl -i https://YOUR_CLICKROOM_HOST/capture/v1/capture \
  -H "Authorization: Bearer ckw_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "batch": [
      { "event": "hello_clickroom", "distinct_id": "test-user-1", "properties": { "source": "curl" } }
    ]
  }'
```

A `202` response means the event was accepted. For a website, paste the snippet from the **HTML**
tab into your page `<head>`. For an app, follow one of the SDK guides:

- [Browser SDK](../sdk/browser.md)
- [Node SDK](../sdk/node.md)
- [React Native SDK](../sdk/react-native.md)

## 5. See it in the dashboard

1. Sidebar **Events** shows a live stream. Your event should appear within a few seconds. Click a
   row to see its properties.
2. Sidebar **Dashboard** shows totals, an events-over-time chart, top pages and the last 10 events.
3. If you used `identify` or a `distinct_id`, sidebar **Users** lists the user.

If nothing shows up, go to [Troubleshooting: no events showing up](troubleshooting-no-events.md).

## Where to go next

- Learn the vocabulary: [Core concepts](concepts.md)
- Gate a feature: [Feature flags](feature-flags.md)
- Measure a flow: [Product analytics](product-analytics.md)
- Invite your team: [Team and access](team-and-access.md)
