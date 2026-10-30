# Data management

Sidebar **Data Management** (page title **Data**) holds the **Schema** tab, where you declare events
and properties and choose what happens to events that do not match.

For how long data is kept, see [Usage and data retention](usage-and-retention.md).

## Why define events

Clickroom accepts any event name. Left alone, event names drift (`signup`, `Signup`,
`sign_up`) and properties change type (`amount` as a number in one place and a string in another),
which breaks funnels and charts. The Schema tab lets you declare what an event should look like and
decide what happens when an event does not match.

## The Schema tab

Open **Data Management**, then **Schema**. It lists the events Clickroom has seen or that you have
declared, with the last time each was seen and its 30-day volume. Search with **Search events...**.

### Declare an event

1. Click **Add event**.
2. Enter the event name, for example `checkout_completed`, and a description.
3. Optionally add properties. Each property has a name, a type (**String**, **Numeric**,
   **Boolean** or **DateTime**) and a **Required** checkbox.
4. Choose an **Enforcement** mode.
5. Save.

To change an existing event, use **Edit event** (description, verified, hidden) or **Edit schema**
(properties and enforcement).

### Enforcement modes

| Mode | What happens to an event that breaks the schema |
|---|---|
| **None** | Nothing is checked. |
| **Warn** | The event is accepted. The problem is recorded on the event (`schema_valid` and `schema_errors` columns) so you can find and fix it. |
| **Strict** | The batch containing the event is rejected at the capture endpoint with a `400`. The response lists which event and property failed, and the SDKs print the reason with `console.warn`. The SDKs drop the rejected batch and do not retry it. |

A schema problem is a missing required property, or a property whose JSON type does not match the
declared type. A `DateTime` property must be a string in RFC 3339 format, for example
`2026-03-01T10:00:00Z`.

Start with **Warn**, look at the events with `schema_valid = 0` in the
[SQL Explorer](sql-explorer.md), fix the senders, and only then move to **Strict**.

```sql
SELECT event, schema_errors, count() AS n
FROM events
WHERE schema_valid = 0
GROUP BY event, schema_errors
ORDER BY n DESC
```

## Related

- [Concepts: events and properties](concepts.md#events)
- [HTTP API](../sdk/http-api.md) for the response shape when events are rejected
