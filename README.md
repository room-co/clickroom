# Clickroom

Open-source product analytics and feature flags you can run on one VM. Click and pageview
autocapture, deterministic feature flags, experiments, funnels, session and user explorers, a SQL
explorer and an MCP server, in a stack that is lighter than PostHog (NATS instead of
Kafka + ZooKeeper).

<!-- TODO: screenshot of the dashboard (docs/assets/dashboard.png) -->

- **Self-host in about five minutes** on any Linux VM with Docker. No AWS account needed.
- **No telemetry.** The server never phones home.
- **Fully open source, self-host only.** There is no hosted product, no plans and no billing.

## Quickstart (self-host)

On a fresh Linux VM (4 vCPU / 8 GB RAM recommended) with Docker and the Compose plugin:

```bash
curl -fsSL https://raw.githubusercontent.com/room-co/clickroom/main/deploy/selfhost/install.sh | bash
```

The installer asks for a domain, generates every secret, pulls the images, starts the stack and
prints the URL. Then open it and create the owner account (the first signup becomes the owner).
Full walkthrough: [docs/self-host/quickstart.md](docs/self-host/quickstart.md).

Add tracking to your site from the project's setup page, or by hand:

```html
<script>
  /* snippet copied from your dashboard; it points at your own host */
</script>
```

## Features

- Click, pageview and custom-event capture (Rust hot path, NATS JetStream, batched ClickHouse inserts)
- Feature flags with deterministic rollout, segments and targeting
- Experiments, funnels, retention, trends, web analytics
- Users and sessions explorer, SQL explorer, support widget and bug reports, surveys
- Orgs, projects, roles, SSO, API keys, an MCP server for AI agents
- SDKs for browser, Node and React Native ([docs/sdk](docs/sdk/browser.md))

## Honest scale limits

The self-host stack is a single node: one ClickHouse, one NATS, one Postgres, no replication.
It suits small and mid-size workloads (see
[docs/explanation/architecture.md](docs/explanation/architecture.md) for sizing notes). Past that,
plan your own multi-node deployment. There are no Helm charts.

## Self-host defaults

- No plan limits: events, flags and members are unlimited.
- Signup follows `SIGNUP_MODE` (default: the first user becomes owner, then invite-only).
- Support is community-based (GitHub issues and Discussions), with no SLA.
- No mailer: reset passwords with the CLI, and invites are shareable links.

## Documentation

Start at [docs/README.md](docs/README.md) for the full index.

- Self-host: [quickstart](docs/self-host/quickstart.md) ·
  [configuration](docs/self-host/configuration.md) · [upgrade](docs/self-host/upgrade.md) ·
  [backup and restore](docs/self-host/backup-restore.md) ·
  [reverse proxy](docs/self-host/reverse-proxy.md) ·
  [external services](docs/self-host/external-services.md) ·
  [troubleshooting](docs/self-host/troubleshooting.md)
- SDKs: [browser](docs/sdk/browser.md) · [node](docs/sdk/node.md) · [react-native](docs/sdk/react-native.md)
- Reference: [environment variables](docs/reference/env.md)
- Explanation: [architecture](docs/explanation/architecture.md) · [licensing](docs/explanation/licensing.md)

## Develop

Requires Node >= 22, pnpm 9.15, Rust (see `rust-toolchain.toml`) and Docker. See
[CONTRIBUTING.md](CONTRIBUTING.md); in short:

```bash
make infra:up   # first time: docker infra + migrate + seed
make up         # start all app services
make test       # all TS + Rust tests
make check      # typecheck + biome lint + cargo fmt/clippy
```

## Licence

- Server-side code (`apps/*`, `services/*`, and `packages/*` except the SDKs) is
  [AGPL-3.0](LICENSE). If you run a modified version as a network service you must offer your
  users the source of your changes.
- The SDKs (`packages/sdk-js`, `sdk-node`, `sdk-react-native`) are **MIT**, so embedding them in
  your app does not put your app under the AGPL.
- The Clickroom name and logo are trademarks; see [TRADEMARK.md](TRADEMARK.md). Self-hosting and
  factual references are fine; hosted services under the name need permission and forks must rename.
- Contributions require agreeing to the [CLA](CLA.md).

More detail: [docs/explanation/licensing.md](docs/explanation/licensing.md).

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md). Community conduct:
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
