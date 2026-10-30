# Uninstall

Back up first if there is any chance you want the data later ([Backup and restore](backup-restore.md)).

From the install directory (`cd ~/clickroom`):

```bash
# Stop and remove containers and the network, keep data volumes
docker compose --profile admin --profile storage --profile tools down

# ...or also DELETE ALL DATA (events, accounts, certificates). Irreversible.
docker compose --profile admin --profile storage --profile tools down -v
```

Then remove the files and, if you want the disk space back, the images:

```bash
cd ~ && rm -rf ~/clickroom        # contains .env: make sure you saved your backup first
docker image prune -a             # removes ALL unused images, not only Clickroom's
```

Also remove DNS records, firewall rules, and any cron entry for `backup.sh`. Backups you wrote to
`BACKUP_DIR` or `./backups/` are not removed by any of the above; they contain your data and secrets,
so delete them deliberately.

To remove only the optional parts, delete the profile from `COMPOSE_PROFILES` in `.env`, run
`docker compose up -d --remove-orphans`, and, for Garage data, `docker volume rm clickroom-selfhost_garage-meta clickroom-selfhost_garage-data`.
