# Clickroom documentation

Clickroom is open-source product analytics and feature flags that you run yourself. These docs
take you from an empty server to a working setup, and then show how to use each part of the product.

## Install and operate

- [Self-hosting overview](self-host/README.md)
- [Quickstart](self-host/quickstart.md): a running install in about five minutes
- Self-host guides: [configuration](self-host/configuration.md) ·
  [upgrade](self-host/upgrade.md) · [backup and restore](self-host/backup-restore.md) ·
  [reverse proxy](self-host/reverse-proxy.md) · [troubleshooting](self-host/troubleshooting.md)
- [Environment variables](reference/env.md)

## Learn Clickroom (start here after install)

Read these in order if you are new.

1. [Getting started](guides/getting-started.md): create a project, get a key, send your first event
2. [Core concepts](guides/concepts.md): projects, environments, events, users, sessions, properties
3. [Send events from your site](sdk/browser.md), [your server](sdk/node.md) or
   [your mobile app](sdk/react-native.md)
4. [Troubleshooting: no events showing up](guides/troubleshooting-no-events.md)

## Guides

| Guide | What it covers |
|---|---|
| [API keys](guides/api-keys.md) | Write keys, read keys, rotating and revoking |
| [Feature flags](guides/feature-flags.md) | Create flags, target and roll out, use them in code |
| [Experiments](guides/experiments.md) | A/B tests on top of flags, metrics, reading results |
| [Product analytics](guides/product-analytics.md) | Events explorer, funnels, insights, retention, breakdowns |
| [Dashboards](guides/dashboards.md) | The home dashboard and saved-insight widgets |
| [Web analytics](guides/web-analytics.md) | Visitors, pages, sources, devices, retention |
| [Users and segments](guides/users-and-segments.md) | The user explorer and saved groups of users |
| [SQL Explorer](guides/sql-explorer.md) | Query your event data directly |
| [Data management](guides/data-management.md) | Event and property definitions, schema enforcement |
| [Surveys](guides/surveys.md) | In-product surveys and results |
| [Support widget and bug reports](guides/support-widget.md) | Contact forms, bug reports, inbox |
| [AI assistant (Ask AI)](guides/ai-assistant.md) | Bring your own LLM key and ask questions about your data |
| [MCP server](guides/mcp.md) | Connect Claude, Cursor, Codex and other MCP clients |
| [Team and access](guides/team-and-access.md) | Invites, roles, single sign-on |
| [Usage and data retention](guides/usage-and-retention.md) | What is counted, what is kept, deleting data |
| [FAQ](guides/faq.md) | Short answers to common questions |

## SDKs and API

- [Browser SDK](sdk/browser.md) (`@clickroom/sdk-js`)
- [Node SDK](sdk/node.md) (`@clickroom/sdk-node`)
- [React Native SDK](sdk/react-native.md) (`@clickroom/sdk-react-native`)
- [HTTP capture API](sdk/http-api.md): send events and evaluate flags from any language

## Background reading

- [Architecture](explanation/architecture.md)
- [Identity and sessions](explanation/identity-and-sessions.md)
- [How feature flag evaluation works](explanation/flag-evaluation.md)
- [Licensing](explanation/licensing.md)

## Conventions used in these docs

- `https://YOUR_CLICKROOM_HOST` is the address you open the dashboard at. Events are sent to
  `https://YOUR_CLICKROOM_HOST/capture`.
- Menu names such as **Feature Flags** or **API Keys** are the labels in the dashboard sidebar.
