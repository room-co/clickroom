# SQL Explorer

The SQL Explorer lets you run read-only SQL against your project's event data, save queries, and
turn results into charts. Use it for questions the point-and-click builders cannot answer.

## Open the SQL Explorer

**SQL Explorer** (page `/sql`) is in the sidebar on every self-hosted install. No feature flag or
write key is needed. The [MCP server](mcp.md) `sql_query` tool and the
[AI assistant](ai-assistant.md) can also run read-only queries.

## Run a query

1. Open **SQL Explorer**.
2. The left panel lists the tables and columns. Use **Search tables & columns** to filter.
3. Type a query and press **Run** (or Cmd+Enter on macOS, Ctrl+Enter elsewhere).
4. Results appear under **Results**.

Example: top 10 events in the last 7 days.

```sql
SELECT event, count() AS total
FROM events
WHERE timestamp > now() - INTERVAL 7 DAY
GROUP BY event
ORDER BY total DESC
LIMIT 10
```

Example: read a custom property (properties are stored as a JSON string).

```sql
SELECT JSONExtractString(properties, 'plan') AS plan, uniq(distinct_id) AS users
FROM events
WHERE event = 'checkout_completed'
GROUP BY plan
```

## Tables

| Table | Contents |
|---|---|
| `events` | Every event. Columns include `event`, `distinct_id`, `timestamp`, `properties`, `elements_chain`, plus ready-made columns such as `current_url`, `path`, `host`, `session_id`, `window_id`, `referring_domain`, `channel_type`, `utm_source`, `utm_medium`, `utm_campaign`, `device_type`, `browser` and `os` |
| `flag_events` | Feature flag evaluations (exposures), including the environment |
| `survey_events` | Survey shown, dismissed and responded events |
| `person_distinct_ids` | Which anonymous ids were linked to which identified ids |

The schema panel is the authority for exact columns and types.

## Rules and limits

- One statement per run. It must be a `SELECT` (or `WITH ... SELECT`).
- Only the four tables above can be queried. System tables and other databases are rejected.
- You cannot add a `SETTINGS` clause.
- Every query is automatically limited to the current project. You do not need a `project_id`
  filter and you cannot read other projects.
- Results are capped (10,000 rows by default) and queries have time and concurrency limits set by
  the operator.

## Save queries and charts

- **Save query** stores the SQL under a name so you can reopen it.
- **Visualization** turns a result into a chart. Choose a chart type (line, bar, area, number or
  pie), the X column and the value column(s), then **Save visualization**.

## Related

- [Product analytics](product-analytics.md)
- [Data management](data-management.md)
