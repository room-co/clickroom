# Quickstart: from nothing to a running Clickroom

This tutorial assumes you have never set up a server. By the end you will have Clickroom running on
your own domain with HTTPS, an owner account, a project, and your first event arriving.

Time: about 20 minutes, most of it waiting for DNS and image downloads.

If you only want to try it on your own laptop, skip to [Try it on localhost](#just-trying-it-on-your-own-machine).

## 1. Choose a server

Clickroom runs on one Linux machine ("VPS" or "VM"). Any provider works (Hetzner, DigitalOcean,
Linode, AWS Lightsail, a spare machine at home).

| | Minimum | Recommended |
|---|---|---|
| CPU | 2 vCPU | **4 vCPU** |
| RAM | 4 GB (the installer refuses less than about 3.5 GB) | **8 GB** |
| Disk | 20 GB | **40 GB SSD**, more if you expect many events |
| OS | Ubuntu 22.04/24.04 or Debian 12 (Ubuntu 24.04 is what was tested) | same |
| CPU architecture | x86-64 or ARM64 | same |

Why those numbers: the ten containers use roughly 800 MiB of RAM when idle (measured), but
ClickHouse, the analytics database, uses memory when you open dashboards and run queries. It is
configured to take up to 60% of the RAM it sees, so a bigger machine is faster, and a 4 GB machine
works for light use but has little headroom. This is a **single-server** setup: if the server dies
you restore from a backup (see [How it works](how-it-works.md#limits-stated-honestly)).

Create the server, add your SSH key, and note its public IP address. Then connect:

```bash
ssh root@YOUR_SERVER_IP
```

(Some providers use a different user, for example `ubuntu`. Use the one your provider tells you.)

## 2. Point a domain at it

You need a domain or subdomain, for example `analytics.example.com`. HTTPS certificates are
issued automatically, but only once DNS is correct.

In your DNS provider, add an **A record**:

| Type | Name | Value |
|---|---|---|
| A | `analytics` | your server's IPv4 address |

(Add an `AAAA` record too if you want IPv6 and your server has an IPv6 address.)

Check that it has propagated, from your own computer:

```bash
dig +short analytics.example.com
```

It should print your server IP. This can take a few minutes. Do not continue until it does,
otherwise certificate issuance will fail.

If you plan to enable the [admin console](optional-features.md#admin-console), also add an A
record for `admin.analytics.example.com` (the installer names it `admin.<your domain>`).

**Using Cloudflare?** Set the records to "DNS only" (grey cloud) for the first install so
certificate issuance works, then see [Reverse proxy and TLS](reverse-proxy.md#cloudflare).

## 3. Open the firewall

Clickroom needs these inbound ports and nothing else:

| Port | Protocol | Why |
|---|---|---|
| 22 | TCP | SSH (you) |
| 80 | TCP | HTTP, certificate issuance, redirect to HTTPS |
| 443 | TCP and UDP | HTTPS (UDP is for HTTP/3) |

Allow them in your provider's firewall or security group. If you also run a host firewall on
Ubuntu:

```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443
ufw enable
```

Postgres, ClickHouse, NATS and Redis are not published on any host port. Only Caddy (the web
front door) listens publicly.

## 4. Install Docker

Skip this if `docker compose version` already works.

```bash
curl -fsSL https://get.docker.com | sh
docker compose version      # must print a version (the Compose plugin)
```

If you are not logged in as root, add your user to the `docker` group and log in again:

```bash
sudo usermod -aG docker $USER
```

The installer also needs `openssl` and `curl`. Both are present on standard Ubuntu and Debian images.

## 5. Run the installer

Pass your domain so it does not need to ask:

```bash
curl -fsSL https://raw.githubusercontent.com/room-co/clickroom/main/deploy/selfhost/install.sh | bash -s -- --domain analytics.example.com
```

Without `--domain` it asks one question: the domain (press Enter for `http://localhost`). Other
options: `--version v0.1.0` to pin a release, `--dir PATH` to install somewhere other than
`~/clickroom`, `--with-storage` (support attachments), `--with-admin` (admin console),
`--non-interactive`, `--no-pull`, `--no-refresh`. Details in the
[reference](../reference/self-host.md#installsh).

It then:

1. checks Docker, openssl, RAM, disk and that ports 80/443 are free;
2. downloads the stack files into `~/clickroom`;
3. creates `~/clickroom/.env` (mode 600) and generates every password and key;
4. pulls the images (first run downloads about 1-2 GB);
5. runs the database migrations;
6. starts the stack and waits until it is healthy (up to about 5 minutes);
7. prints the URL.

Expected ending:

```text
[install] Clickroom is running.

  1. Open  https://analytics.example.com
  2. Create your owner account ...
```

If it fails, the message ends with a `Fix:` line. See [Troubleshooting](troubleshooting.md).

**Back up `~/clickroom/.env` now** (copy it to your password manager or another machine). It holds
the keys that encrypt stored secrets. Losing it makes parts of your data unreadable.

## 6. Create your owner account

Open `https://analytics.example.com`. The first sign-up screen creates the **owner** account of
your organization. Use a strong password.

After the first signup, sign-up is closed to the public (the default `SIGNUP_MODE=first_user_only`).
Teammates join by invitation: the invite is a link you copy and send yourself, because there is no
mail server. See [Accounts and sign-up](accounts.md).

## 7. Create a project and send an event

1. In the dashboard, create a **project**.
2. Open the project's setup page. Copy the **write key** (it looks like `ckw_live_...`) and the
   snippet, which already points at your own host.
3. Paste the snippet into your site. By hand it looks like this:

   ```html
   <script>
     /* loader snippet from your dashboard */
     clickroom.init('ckw_live_xxx', {
       api_host: 'https://analytics.example.com/capture',
       autocapture: true,
     })
   </script>
   ```

   The `api_host` must end in `/capture`: that is where events are received.
4. Load your page and click around. Events appear in the project within a few seconds.

Full SDK instructions: [Getting started guide](../guides/getting-started.md), [Browser SDK](../sdk/browser.md),
[Node SDK](../sdk/node.md), [React Native SDK](../sdk/react-native.md).

## 8. Verify the install

Health endpoints (no login needed):

```bash
curl -fsS https://analytics.example.com/health            # API
curl -fsS https://analytics.example.com/capture/health    # event capture
```

For a full end-to-end test (sends an event and reads it back from ClickHouse), run from the install
directory. After you have created a project, the script finds its write key itself:

```bash
cd ~/clickroom
BASE_URL=https://analytics.example.com ./scripts/smoke-test.sh
```

## 9. Do these before you rely on it

- [ ] Take a backup and copy it off the server: `./scripts/backup.sh` ([how](backup-restore.md)).
- [ ] Schedule backups with cron.
- [ ] Pin the version: set `CLICKROOM_VERSION` to a release tag in `.env` instead of `latest`
      ([why](upgrade.md#version-policy)).
- [ ] Walk the [hardening checklist](hardening.md).

## Just trying it on your own machine

On a laptop or any machine with Docker, no domain needed:

```bash
curl -fsSL https://raw.githubusercontent.com/room-co/clickroom/main/deploy/selfhost/install.sh | bash
# press Enter at the domain prompt
```

Open `http://localhost`. It is plain HTTP and only reachable from that machine. Ports 80 and 443
must be free (or set `HTTP_PORT` in `.env`, see [troubleshooting](troubleshooting.md#port-80-or-443-is-already-in-use)).

## Next

[Accounts and sign-up](accounts.md) · [Optional features](optional-features.md) ·
[Backup and restore](backup-restore.md) · [Upgrade](upgrade.md) ·
[Troubleshooting](troubleshooting.md)
