# Security policy

## Reporting a vulnerability

Please **do not open a public issue**. Report privately via either:

- GitHub: the repository's **Security > Report a vulnerability** (private security advisory), or
- Email: **security@<domain>** (placeholder until the project domain is final).

Include affected version (image tag or commit), reproduction steps and impact. We aim to acknowledge
within 3 working days and to agree a fix and disclosure timeline with you. This is a
community-run project: there is no SLA and no bug bounty, but we credit reporters who want it.

## Supported versions

Only the **latest release** (and `main`) receive security fixes. While Clickroom is `0.x`, run
the latest: see [docs/self-host/upgrade.md](docs/self-host/upgrade.md).

## Scope notes for self-hosters

- The server collects **no telemetry** and never phones home.
- `install.sh` generates all secrets locally into `.env` (mode 600). Back it up and never commit it.
- The admin console is optional (compose profile `admin`); it requires TOTP.
- Put the stack behind HTTPS (the bundled Caddy does this when you give it a domain).
