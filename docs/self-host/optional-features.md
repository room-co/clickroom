# Optional features (compose profiles)

The default install runs the core stack only. Three extras are off until you turn on a Docker
Compose *profile* by listing it in `COMPOSE_PROFILES` in `.env`:

| Profile | Adds | Needed for |
|---|---|---|
| `admin` | `admin` container, served on its own hostname | Operating the instance (internal admin console) |
| `storage` | `garage` (S3-compatible store) and a one-shot `garage-init` | Support-widget attachments (screenshots/files on tickets) |
| `tools` | `cli` container | One-off commands (not needed to run; `docker compose run --rm cli ...` works regardless) |

The easiest way is the installer, which writes the `.env` values for you and is safe to re-run:

```bash
cd ~/clickroom
./install.sh --with-admin --with-storage     # or CLICKROOM_WITH_ADMIN=1 / CLICKROOM_WITH_STORAGE=1
```

(If you installed with `curl | bash`, run the same command through `curl ... | bash -s -- --with-storage`.)
By hand, combine profiles with commas (`COMPOSE_PROFILES=admin,storage`), edit `.env`, and run
`docker compose up -d`. Run all commands from `~/clickroom`.

## Admin console

1. DNS: add an A record for `admin.<your domain>` to the same server IP.
2. Enable and start:

   ```bash
   ./install.sh --with-admin
   ```

   This adds `admin` to `COMPOSE_PROFILES` and sets `ADMIN_SITE_ADDRESS=admin.<domain>` and
   `ADMIN_PUBLIC_URL=https://admin.<domain>` in `.env`. By hand, set those three and run
   `docker compose up -d`.
3. Create an admin account: `docker compose run --rm cli pnpm admin:create --email you@example.com`
   ([details](accounts.md#the-admin-console-optional)).
4. Open `https://admin.<your domain>` and sign in; you will be asked to enroll TOTP.

Its hostname is separate on purpose so admin cookies are isolated from the dashboard.

With the profile off, the admin site address stays at the plain-HTTP `http://admin.localhost`, so Caddy
never tries to get a certificate for a hostname you have no DNS record for. (Installs made before this
change are reset to that value on the next `install.sh` run.)

## Storage for support attachments (Garage)

Only needed if you use the support widget and want users to attach files. Without it, attachments are
disabled and everything else works. The bundled store is **Garage** (single node, no replication),
not MinIO.

1. Run `./install.sh --with-storage`. It generates `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN`,
   `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` if missing, writes the values below into `.env`
   (with `S3_PUBLIC_ENDPOINT` set to your public URL), adds `storage` to `COMPOSE_PROFILES` and
   starts Garage. The rest of this list is what it does, for manual setups.
2. In `.env`:

   ```text
   COMPOSE_PROFILES=storage
   S3_BUCKET=clickroom-attachments
   SUPPORT_ATTACHMENTS_BUCKET=clickroom-attachments
   S3_ENDPOINT=http://garage:3900
   S3_PUBLIC_ENDPOINT=https://analytics.example.com   # same as CLICKROOM_PUBLIC_URL
   AWS_REGION=us-east-1
   ```
3. `docker compose up -d`. `garage-init` runs once (and is safe to re-run): it assigns the
   single-node layout, creates the bucket, imports the S3 key from `.env`, and sets bucket CORS.
4. Verify: `./scripts/smoke-test.sh` (it targets your `CLICKROOM_PUBLIC_URL`) includes an attachment
   upload/download round trip when `SUPPORT_ATTACHMENTS_BUCKET` is set.

How it works: the browser uploads straight to a presigned URL on **your own domain**
(`https://<domain>/<bucket>/<key>`); Caddy routes that path to Garage without changing it. That is
why `S3_PUBLIC_ENDPOINT` must be your public origin and why any proxy in front must keep the path and
`Host` header untouched ([Reverse proxy](reverse-proxy.md)).

`AWS_REGION` must match `s3_region` in `garage/garage.toml` (default `us-east-1`); change both
together or uploads are rejected. To use AWS S3 or another provider instead, see
[External services](external-services.md#s3-support-attachments).

Garage data is included in `backup.sh` while Garage is running.

## CLI container

```bash
docker compose run --rm cli pnpm user:reset-password --email you@example.com
docker compose run --rm cli pnpm admin:create --email you@example.com
```

`run` works without enabling the `tools` profile. Add `tools` to `COMPOSE_PROFILES` only if you want
`docker compose --profile tools ...` forms or want the service to appear in `docker compose config`.
The container uses the `migrate` image (full workspace) with the stack's database settings.
