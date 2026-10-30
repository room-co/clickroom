# Self-hosting Clickroom

Run your own Clickroom on one Linux server with Docker. No AWS account, no Kubernetes, no
telemetry. These pages take you from "I have never rented a server" to a running, backed-up,
HTTPS-protected install.

Clickroom self-hosting is **single node**: every service runs on one machine, with no replication
or failover. That is a deliberate trade for simplicity. Read
[How it works and its limits](how-it-works.md) before you commit production traffic to it.

## Start here

| I want to... | Read |
|---|---|
| Go from nothing to a working install, step by step | [Quickstart (tutorial)](quickstart.md) |
| Understand what the installer does, what runs, and where the limits are | [How it works and its limits](how-it-works.md) |

## How-to guides

| Task | Page |
|---|---|
| Change a setting in `.env` | [Configuration](configuration.md) |
| Control who can sign up, reset a password, create an admin | [Accounts and sign-up](accounts.md) |
| Turn on the admin console, bundled S3 storage, or the CLI container | [Optional features (compose profiles)](optional-features.md) |
| Put Clickroom behind nginx, Traefik or Cloudflare, or use your own domain layout | [Reverse proxy and TLS](reverse-proxy.md) |
| Use managed Postgres, ClickHouse, Redis or S3 | [External services](external-services.md) |
| Back up and restore | [Backup and restore](backup-restore.md) |
| Upgrade or roll back | [Upgrade](upgrade.md) |
| Harden the server | [Security hardening checklist](hardening.md) |
| Something is broken | [Troubleshooting](troubleshooting.md) |
| Remove Clickroom | [Uninstall](uninstall.md) |

## Reference

- [Environment variables](../reference/env.md): every variable, what reads it, its default.
- [Self-host files, scripts, routes and ports](../reference/self-host.md)

## After the install

Create a project, copy its write key and add the SDK to your app:
[Getting started guide](../guides/getting-started.md) · [Browser SDK](../sdk/browser.md) ·
[Node SDK](../sdk/node.md) · [React Native SDK](../sdk/react-native.md).

## Support

Self-hosting is community supported (GitHub issues and Discussions, no SLA). When you report a
problem include your `CLICKROOM_VERSION` and redacted `docker compose logs`.
