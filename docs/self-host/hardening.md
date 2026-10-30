# Security hardening checklist

The defaults are reasonable (random secrets, no database ports published, automatic TLS), but a
server on the internet needs a few more things. Tick these off.

## Network

- [ ] Only ports **22, 80, 443/tcp, 443/udp** are reachable from the internet (provider firewall or
      security group). Postgres (5432), ClickHouse (8123/9000), NATS (4222/8222), Redis (6379) and
      Garage (3900/3901/3903) are not published by the compose file; keep it that way.
- [ ] Beware of `ufw` plus Docker: ports published by Docker bypass `ufw` rules. Rely on the
      provider-level firewall and do not add `ports:` to data services.
- [ ] SSH: key-only login (`PasswordAuthentication no`), no root login if you can, optionally
      `fail2ban`.
- [ ] If Caddy sits behind another proxy, bind it to loopback and keep it unreachable from outside
      ([how](reverse-proxy.md#behind-an-existing-proxy-nginx-traefik)).

## Secrets and access

- [ ] `~/clickroom/.env` is mode 600 and owned by the user running Docker (the installer sets this).
- [ ] `.env` and backups are stored in a password manager or encrypted storage, not in chat or git.
- [ ] `SIGNUP_MODE` is `first_user_only` or `closed` (not `open`) unless you intend public sign-up.
- [ ] Owner and admin passwords are long and unique; admin console sign-in requires TOTP.
- [ ] If you used `CLICKROOM_ADMIN_PASSWORD` for bootstrap, remove it (and the email) from `.env`.
- [ ] Do not set `INGEST_WEBHOOK_ALLOW_PRIVATE_TARGETS=true` (it lets webhooks reach your internal
      network).
- [ ] Do not expose the admin console to everyone if you do not use it: leave the `admin` profile off.

## Host

- [ ] Automatic security updates (`unattended-upgrades` on Ubuntu/Debian).
- [ ] Docker kept up to date; images pinned to an exact `CLICKROOM_VERSION` and upgraded
      deliberately, with release notes read ([Upgrade](upgrade.md)).
- [ ] Time sync is on (`timedatectl`): TLS, session tokens and presigned URLs depend on correct time.
- [ ] Disk monitoring or alerts: a full disk stops ClickHouse and NATS.

## Data

- [ ] Nightly `backup.sh`, copied **off** the machine, and a restore tested at least once.
- [ ] Backups encrypted at rest where they are stored (they contain all secrets).

## Know the limits

- Event data is stored unencrypted at rest on the server's disk. Use provider disk encryption if you
  need encryption at rest.
- The capture service trusts the first `X-Forwarded-For` value. Do not let clients reach it
  bypassing your proxy.
- Self-host has no built-in audit shipping, alerting or intrusion detection.

Report vulnerabilities privately per [SECURITY.md](../../SECURITY.md).
