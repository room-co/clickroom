# Usage and data retention

## Usage

Self-hosted Clickroom has no plan limits. You can send as many events, create as many flags, and
invite as many members as your hardware handles. The usage panel still counts what you use, which is
handy for capacity planning.

Find it in sidebar **Settings**, tab **Usage**. It shows counts only, with no plan or limits, for
the current month:

- **Events / mo**: events accepted.
- **Flag calls / mo**: flag evaluations that were recorded.
- **Feature flags**: flags created.
- **Team seats**: members.

Usage can also be read with the MCP `usage_summary` tool.

## Rate limits

The capture service rate-limits each project to protect itself. If your app sends bursts bigger
than the limit, SDKs retry with backoff. Operators can raise the limits; see
[configuration](../self-host/configuration.md).

## What is kept, and for how long

Events are kept until you delete them. The shipped ClickHouse tables have no automatic expiry, so
storage grows with traffic. Plan disk space accordingly and watch it (see
[self-host how it works](../self-host/how-it-works.md)).

> **Clickroom does not delete events by age.** There is no retention setting in the dashboard.
> If you need an expiry, ask the operator of your install to add a ClickHouse TTL, and take a
> [backup](../self-host/backup-restore.md) first.

Events that are accepted but not yet stored wait in a queue (NATS JetStream) for at most 72 hours
by default.

## Delete data

- **One user:** Users, open the user, **Delete user data**. See
  [Users and segments](users-and-segments.md#delete-a-users-data).
- **A whole project:** Projects, delete project. This removes the project and its configuration
  (flags, keys, environments) and cannot be undone. It does not erase the project's events from
  ClickHouse; they become unreachable from the dashboard but stay on disk until an operator removes
  them.
- **Everything:** remove the install's volumes (see the self-host docs).

## Back up

Back up Postgres (configuration, accounts), ClickHouse (events) and the object store if you use it.
Procedures are in [backup and restore](../self-host/backup-restore.md).
