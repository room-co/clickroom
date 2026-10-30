# MCP server

Clickroom runs a Model Context Protocol (MCP) server so that AI tools such as Claude, Cursor and
Codex can read your analytics and manage flags and experiments for you. It is part of the API
service and needs no extra install.

## The endpoint

```
https://YOUR_CLICKROOM_HOST/mcp
```

The dashboard shows the exact URL for your install under sidebar **MCP Server** (you need the
Admin or Member role to see it). The page also has a ready-to-run command for Claude Code.

## How sign-in works

There is no token to create or paste. Clickroom supports OAuth 2.1 with dynamic client
registration, so the MCP client registers itself the first time it connects:

1. Add the server in your MCP client.
2. The client opens a browser window to your Clickroom dashboard. Sign in if asked.
3. The **Connect <client> to Clickroom** screen asks which project to authorize. Pick one and
   click **Approve** (or **Deny**).
4. The client is now connected to that one project.

To switch projects, connect again and choose another. To revoke access, remove the server from the
client; connecting again requires a new approval.

## Connect Claude Code

```bash
claude mcp add --transport http clickroom https://YOUR_CLICKROOM_HOST/mcp
```

Then run `/mcp` inside Claude Code and choose **clickroom** to start the sign-in.

## Connect Claude Desktop or claude.ai

Add a custom connector and paste `https://YOUR_CLICKROOM_HOST/mcp`. Approve the consent screen when
it opens.

## Connect Cursor, Codex and other clients

Any client that supports remote (HTTP) MCP servers with OAuth works. Add a server of type HTTP with
the URL above, and complete the browser approval. The exact menu differs per client; look for
"add MCP server" or "remote MCP".

Your install must be reachable over HTTPS at a public address from wherever the sign-in happens
(your browser), and `/mcp` must be routed to the API. The standard install already does this; see
[reverse proxy](../self-host/reverse-proxy.md) if you use your own.

## What the tools can do

| Area | Tools |
|---|---|
| Projects | `projects_list` |
| Analytics | `analytics_overview`, `analytics_trend`, `analytics_breakdown`, `analytics_funnel`, `analytics_active_users`, `analytics_top_events`, `analytics_top_pages`, `analytics_live` |
| Web analytics | `web_analytics_overview`, `web_analytics_trend`, `web_analytics_top_paths`, `web_analytics_sources`, `web_analytics_devices`, `web_analytics_hosts`, `web_analytics_active_hours`, `web_analytics_retention` |
| Events and schema | `events_list`, `event_get`, `taxonomy_list_events`, `taxonomy_list_properties` |
| Users | `users_list`, `user_detail`, `user_activity`, `user_sessions` |
| Feature flags | `flags_list`, `flag_get`, `flag_create`, `flag_update`, `flag_toggle`, `flag_delete` |
| Experiments | `experiments_list`, `experiment_get`, `experiment_create`, `experiment_update`, `experiment_launch`, `experiment_stop`, `experiment_results` |
| Insights | `insights_list`, `insight_get`, `insight_create`, `insight_update`, `insight_results` |
| Segments | `segments_list`, `segment_get`, `segment_create`, `segment_update`, `segment_preview_count`, `segment_materialize` |
| SQL | `sql_query` |
| Other | `usage_summary`, `data_sources_list` |

Example prompts: "Show me signups per day for the last two weeks", "List flags that are on in
production", "Create an experiment called New onboarding with a control and a test variant",
"Which pages do visitors from search land on?".

Some tools change things (create, update, toggle or delete flags, experiments, insights and
segments, and launch or stop experiments). Most MCP clients ask you before running a tool; leave
that prompt on for the write tools.

## Troubleshooting

- **The client cannot connect.** The URL must be public HTTPS, and the proxy must route `/mcp`,
  `/authorize`, `/token`, `/register` and `/.well-known/*` to the API. The standard install does
  this; check your own proxy against the [reverse proxy guide](../self-host/reverse-proxy.md).
- **"You have no projects to authorize".** Your account has no project yet. Create one first.
- **Approval screen redirects to login.** Sign in to the dashboard and retry.
