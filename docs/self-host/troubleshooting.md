# Troubleshooting

Always start with these, from the install directory (`cd ~/clickroom`):

```bash
docker compose ps                         # what is running / unhealthy / exited
docker compose logs --tail=200 api        # replace with: caddy capture ingest query web migrate clickhouse postgres nats redis
docker compose logs -f                    # follow everything
curl -i https://YOUR_DOMAIN/health        # API through the edge: expect 200
curl -i https://YOUR_DOMAIN/capture/health # capture through the edge: expect 200
BASE_URL=https://YOUR_DOMAIN ./scripts/smoke-test.sh   # end-to-end event round trip
```

## Symptom, cause, fix

| Symptom | Likely cause | Fix |
|---|---|---|
| Installer: `Docker is not installed` / `compose plugin is missing` / `Cannot talk to the Docker daemon` | Missing Docker, no Compose v2, or your user is not in the `docker` group | `curl -fsSL https://get.docker.com \| sh`; `sudo usermod -aG docker $USER` then log out and in |
| Installer: `Only N MB RAM` | Under about 3.5 GB | Use a larger machine (4 vCPU / 8 GB recommended). To try anyway: `CLICKROOM_FORCE=1` before the command. Expect ClickHouse OOM kills. |
| <a id="port-80-or-443-is-already-in-use"></a>Installer: `Port 80 is already in use` (or 443) | nginx, Apache or another container holds the port | Stop it, or set `HTTP_PORT`/`HTTPS_PORT` in `.env` and put a proxy in front ([Reverse proxy](reverse-proxy.md#behind-an-existing-proxy-nginx-traefik)). Find the culprit: `ss -ltnp \| grep -E ':80\|:443'` |
| Installer: `Could not pull images` | No internet, wrong `CLICKROOM_REGISTRY`/`CLICKROOM_VERSION`, registry rate limit | Check connectivity; check `CLICKROOM_VERSION` exists as a tag; `docker compose pull` to see the error |
| Installer: `Database migration failed. Nothing was restarted.` | Postgres or ClickHouse not healthy, wrong credentials, or a failed ClickHouse migration | `docker compose logs migrate clickhouse postgres`. Fix the cause, then `docker compose run --rm migrate`. Migrations are replay-safe, so re-running is fine. Out of memory is a common cause. |
| Installer: `Timed out waiting for the stack to become healthy` | A service crash-loops, low RAM, or images still starting on a slow disk | `docker compose ps` and `docker compose logs --tail=50 api caddy`; see rows below |
| `api` restarting, logs name a missing/invalid secret or `SIGNUP_MODE` | Empty secret in `.env`, or a typo in `SIGNUP_MODE` | Re-run `install.sh` (fills empty secrets, never overwrites) or fix the value; allowed: `open`, `first_user_only`, `closed` |
| `service "..." depends on undefined` / `required variable ... is missing` | `.env` incomplete or edited incorrectly | `docker compose config` shows which variable; re-run `install.sh` |
| Containers killed, `Exited (137)`, ClickHouse restarting, whole box slow | Out of memory | `free -h`, `dmesg \| grep -i kill`, `docker stats`. Add RAM or swap; close heavy dashboards; ClickHouse is limited to 60% of RAM and 3 GiB per query (`clickhouse/memory.xml`) |
| <a id="login-loops-or-cors-errors-behind-a-proxy"></a>Login succeeds then bounces back to login, or browser console shows CORS / blocked cookie errors | `CLICKROOM_PUBLIC_URL` does not exactly match the URL in the address bar (scheme, host, port); behind a TLS-terminating proxy it was left as `http://`; or you opened the site by IP or an alias hostname | Set `CLICKROOM_PUBLIC_URL=https://exact.host` (the API derives CORS origin, cookies and OAuth links from it), `docker compose up -d`, and use that URL. Pass `Host` through your proxy. Do not use `COOKIE_DOMAIN`/`CORS_ORIGINS` in `.env`: they are not wired into the stack. |
| Login works over HTTP but not HTTPS (or the reverse) | Cookie `Secure` flag follows the scheme of `CLICKROOM_PUBLIC_URL` | Make the scheme match how users really connect |
| Everyone suddenly signed out, or TOTP codes rejected, or `Invalid token` errors | Server clock wrong (clock skew) | `timedatectl`; enable NTP: `sudo timedatectl set-ntp true`. TLS, JWTs, admin TOTP and presigned S3 URLs all depend on correct time. |
| Caddy cannot get a certificate (`obtaining certificate`, ACME errors in `docker compose logs caddy`) | DNS does not point here yet, ports 80/443 blocked, Cloudflare proxying during first issuance, or Let's Encrypt rate limit after many failures | `dig +short YOUR_DOMAIN` must equal the server IP; open 80/443; set Cloudflare to DNS-only until issued; wait if rate limited. |
| Browser says certificate invalid on `localhost` | `http://localhost` installs have no TLS | Use `http://localhost`, not `https://` |
| `502 Bad Gateway` from Caddy right after start | Upstream still starting or crashed | Wait a minute; `docker compose ps`; `docker compose logs api web capture` |
| Dashboard loads, no events appear | Wrong `api_host` or key in the snippet; ad blocker; capture or ingest down; event rejected | `api_host` must be `https://YOUR_DOMAIN/capture`. Run the smoke test. `docker compose logs capture ingest`. Test with curl: `curl -i -X POST https://YOUR_DOMAIN/capture/v1/capture -H "Authorization: Bearer ckw_live_..." -H 'content-type: application/json' -d '{"batch":[{"event":"test","distinct_id":"me"}]}'` |
| Capture returns 503 | NATS stream cap reached (backpressure) or NATS down | `docker compose logs capture nats`; check `df -h`; make sure `ingest` is running and ClickHouse healthy so the backlog drains |
| Events arrive late | `ingest` batching or a ClickHouse backlog | `docker compose logs ingest clickhouse`; normally under a few seconds |
| 429 from capture | Per-project rate limit exceeded | Raise `CAPTURE_RATE_LIMIT_BURST` / `CAPTURE_RATE_LIMIT_REFILL_PER_SEC` via an override file ([how](configuration.md#override-file)) |
| `admin:create` / `user:reset-password` fail to connect | Stack not running, or run from the wrong directory | `cd ~/clickroom && docker compose ps`, then retry |
| `pnpm: command not found` when running a CLI command | Ran it on the host, not in the container | Always prefix with `docker compose run --rm cli ` |
| Attachment upload or download fails | `S3_PUBLIC_ENDPOINT` not your public origin, proxy rewrote path/`Host`, region mismatch, or clock skew | See [Optional features](optional-features.md#storage-for-support-attachments-garage); run the smoke test, which tests it; check `AWS_REGION` equals `s3_region` in `garage/garage.toml` |
| `garage-init` fails | Garage unhealthy or token missing | `docker compose logs garage garage-init`; confirm `GARAGE_ADMIN_TOKEN` and `S3_*` are set in `.env` |
| `backup.sh` says `no .env here` or cannot reach containers | Run outside the install directory or stack stopped | `cd ~/clickroom`, start the stack |
| Disk full | Events grow without retention; NATS/ClickHouse/Docker logs | `df -h`, `docker system df`, `du -sh /var/lib/docker/volumes/*`. Prune unused images (`docker image prune`), add disk, delete old data. Free space, then `docker compose up -d`. |
| `upgrade.sh` says `refusing ... upgrade one minor at a time` | Version-skip guard | Step through intermediate minors, or `--force` at your own risk ([Upgrade](upgrade.md)) |
| Smoke test cannot reach the edge | It targets `CLICKROOM_PUBLIC_URL` from `.env`; that name does not resolve from this machine (for example behind split DNS) | `BASE_URL=http://localhost:80 ./scripts/smoke-test.sh` or another reachable URL |

## Resetting a stuck stack without losing data

```bash
docker compose down            # stops containers, keeps volumes
docker compose up -d
```

Never use `down -v` unless you mean to delete all data.

## Still stuck?

Open an issue (<https://github.com/room-co/clickroom/issues/new?template=bug.yml>) with your
`CLICKROOM_VERSION`, `docker compose ps` output and redacted logs. Remove secrets, write keys and
domains you do not want public.
