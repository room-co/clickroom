# Users and segments

## Users

Sidebar **Users** lists the people who have sent events. A row exists for each distinct id. There
is no separate person record to maintain: the list is built from your events.

- Search by user id with **Search by user ID...**.
- Sort by **Last seen**, **First seen** or **Most events**.
- Click a user to open their page. It shows totals for events and sessions, and tabs for the
  **Timeline** of their activity, their **Sessions**, and their **Properties** (the traits you set
  with `identify`).

Users show up under the id you passed to `identify` (browser, React Native) or `distinctId` (Node).
Before `identify`, a browser visitor appears under a random anonymous id; calling `identify` links
that history to the real id. See [Identity and sessions](../explanation/identity-and-sessions.md).

### Delete a user's data

On a user's page, choose **Delete user data** and confirm. This removes that user's events and flag
evaluation records, including those under any other ids linked to the same person. Use it to answer
erasure requests. It cannot be undone.

## Segments

A segment is a saved group of users defined by rules. Sidebar **Segments** lists them.

To create one:

1. **Segments**, then create a new segment, and name it, for example `Power users`.
2. Add conditions. There are three kinds:
   - **Trait**: a user property, such as `plan` equals `pro`.
   - **Event property**: a property on events the user sent, optionally limited to one event.
   - **Behavioral**: the user did an event at least N times in the last N days (up to 365).
3. Combine conditions with **AND** or **OR**, and nest groups if you need to.
4. The page shows a live count of matching users and a preview list. Click a member to open
   their user page.
5. Click **Create segment**.

On an existing segment, **Materialize** takes a snapshot of the current members and shows the
member count and when it was computed.

Segments are used on the survey results page (**Response rate by segment**) and are available to the
[MCP server](mcp.md) and the [AI assistant](ai-assistant.md). Feature flag targeting does not use
segments; it tests user properties directly (see [Feature flags](feature-flags.md#targeting-rules)).
