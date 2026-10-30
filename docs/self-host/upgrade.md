# Upgrade

## Version policy

- All images (api, capture, ingest, query, web, admin, migrate) ship together under one tag, set by
  `CLICKROOM_VERSION` in `.env`. Migrations are inside the `migrate` image.
- Tags look like `v0.2.1`. `latest` also exists in `.env.example`'s default, but for anything you
  depend on, **pin an exact tag** so a restart or re-run does not change versions under you.
- While Clickroom is `0.x`, breaking changes can arrive in **minor** versions (`0.2` to `0.3`) and
  are listed in the release notes (<https://github.com/room-co/clickroom/releases>). Read them first.
  Patch versions (`0.2.1` to `0.2.2`) are not expected to break.
- Migrations are forward-only. There is no down-migration. Your rollback is a backup.
- Only the latest release gets security fixes ([SECURITY.md](../../SECURITY.md)).

## Procedure

```bash
cd ~/clickroom
./scripts/backup.sh                 # always
./scripts/upgrade.sh v0.2.1         # target version
```

`upgrade.sh`:

1. refuses to skip more than **one minor version** at a time, to go backwards, or to change major
   version (override with `--force`; skipped when either side is `latest`);
2. downloads the stack files for that version (`docker-compose.yml`, `Caddyfile`, `garage/`,
   `scripts/` ...), saving any file it replaces under `.bak/<timestamp>/`. `.env` and
   `docker-compose.override.yml` are not touched. Skip with `--no-refresh`;
3. writes the new `CLICKROOM_VERSION` to `.env` and pulls the images;
4. runs `migrate` **before** any service restarts. If migration fails, it restores the old
   version in `.env`, restarts nothing, and tells you to restore from backup if the schema may be
   half-applied;
5. runs `docker compose up -d --remove-orphans` and shows `docker compose ps`.

Then verify: `BASE_URL=https://your.domain ./scripts/smoke-test.sh`.

To go from `0.1.x` to `0.3.0`, upgrade to the last `0.2.x` first, then to `0.3.0`.

Without a target (`./scripts/upgrade.sh`), it re-pulls the version already in `.env`; useful with a
moving tag.

### Alternative: re-run the installer

`install.sh --version v0.2.1` also refreshes the stack files, pulls, migrates and restarts, and
preserves all secrets. It does not enforce the one-minor-at-a-time rule.

### Manual upgrade

```bash
sed -i 's/^CLICKROOM_VERSION=.*/CLICKROOM_VERSION=v0.2.1/' .env
docker compose pull
docker compose run --rm migrate
docker compose up -d
```

## Updating the stack files

Both `upgrade.sh` and a re-run of `install.sh` refresh the stack files to match the target version
(the tag you give, or `main` for `latest`), so a new compose file or Caddyfile arrives together with
the images that need it. Replaced files are copied to `.bak/<timestamp>/` first; your `.env` and
`docker-compose.override.yml` are never modified, so put local customisations in the override file.
Pass `--no-refresh` to either script to keep your current files, and run
`docker compose config -q` afterwards if you edited anything by hand.

## Roll back

Not automatic. Restore the backup you took before upgrading
([Backup and restore](backup-restore.md)) and set `CLICKROOM_VERSION` back in `.env` to the old tag
(the restored `env.backup` already has it). Do not run old images against a database that new
migrations already changed.

## Downtime

Services restart after migration, so expect a short interruption of the dashboard and event capture.
Events already accepted into NATS are ingested when `ingest` is back. Whether a given SDK retries events sent while `capture` is down depends on that SDK; see its page.
