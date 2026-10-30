# API keys

Keys let your code talk to Clickroom. You manage them under sidebar **API Keys**.

## Key types

| Type | Prefix | Use it for | Where it can live |
|---|---|---|---|
| **Write** | `ckw_live_` | Sending events, fetching flag values for one user | Web pages, mobile apps, servers |
| **Read** | `ckr_live_` | Downloading flag definitions so a server can evaluate flags locally | Servers only |

A write key can only add events and ask "what is this flag's value for this user". It cannot read
your data, so it is safe in public JavaScript and in app binaries. A read key can download your full
flag configuration. Never put it in a web page or mobile app.

Each key belongs to one project and one environment. A key for `production` returns the flag values
of `production`.

MCP access (for Claude and other agents) does not use these keys. See [MCP server](mcp.md).

## Create a key

1. Sidebar **API Keys**, then **New key**.
2. Enter a label, for example `Production ingest` or `CI`.
3. Choose **Write** or **Read**.
4. Choose the environment.
5. Review the scopes. Write keys default to `Events: Write` and `Flags: Read`. Read keys default to
   `Flags: Read`.
6. Click **Generate key**.

The full key is shown once, with a **Copy** button. Read keys cannot be shown again after you close
the dialog, so store them in a secrets manager or environment variable straight away. Write keys
stay visible in the key list and on the **Setup** page, because they are not secret.

## Rotate a key

1. Create a new key.
2. Deploy it to your app.
3. Wait until the old key stops being used (the list shows when each key was last used).
4. Revoke the old key.

## Revoke or delete a key

On the key row, choose **Revoke key**. Requests with a revoked key are rejected (capture answers
`401`); because keys are cached briefly, it can take a short moment to take effect. **Delete key** removes the row permanently. You need the member or admin
role to manage keys; viewers cannot.

## Related

- [Getting started](getting-started.md)
- [Troubleshooting: no events showing up](troubleshooting-no-events.md)
