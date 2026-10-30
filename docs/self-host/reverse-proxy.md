# Reverse proxy, TLS and domains

By default the bundled **Caddy** container is your only public listener. It gets certificates from
Let's Encrypt automatically and routes one domain by path. This page covers:

- [how the default works](#default-caddy-with-a-domain)
- [putting Clickroom behind nginx, Traefik or another proxy on the same machine](#behind-an-existing-proxy-nginx-traefik)
- [Cloudflare](#cloudflare)
- [what is not supported](#subdomain-splits-are-not-wired-up)

## Default: Caddy with a domain

Requirements: a DNS A record for the domain pointing at the server, and inbound ports 80 and 443
(TCP, plus UDP 443 for HTTP/3) open. Certificates are requested on first start and renewed
automatically; they live in the `caddy-data` volume.

To switch domain, set `CADDY_SITE_ADDRESS` and `CLICKROOM_PUBLIC_URL` (see
[Configuration](configuration.md#changing-the-domain)) or re-run `install.sh --domain new.example.com`.

With `CADDY_SITE_ADDRESS=http://localhost` (or any `http://...` address) Caddy serves plain HTTP and
requests no certificate.

### Routes

One origin, path-routed. There is **no `/api` prefix**: API paths live at the root.

| Path | Goes to |
|---|---|
| `/capture/*` | `capture` (prefix stripped): events, flag evaluation, SDK |
| `/trpc`, `/flags/stream`, `/ai`, `/mcp`, `/auth/sso/*`, `/authorize`, `/token`, `/register`, `/revoke`, `/.well-known/*`, `/health`, `/ready` | `api` |
| `/<S3_BUCKET>/*` | Garage (bundled S3, `storage` profile) |
| everything else | `web` (dashboard) |

`/capture/*`, the API paths and the SSE stream `/flags/stream` are proxied with response buffering
disabled, which any proxy you add must preserve.

## Behind an existing proxy (nginx, Traefik)

Use this when ports 80/443 are already taken by another web server on the same machine or a load
balancer sits in front. The simplest correct setup: **let your proxy terminate TLS and forward
everything to Caddy**, which keeps the path rules above. Do not re-implement the routes (the
backend containers publish no ports).

1. In `.env`:

   ```text
   CLICKROOM_PUBLIC_URL=https://analytics.example.com   # what users see (https)
   CADDY_SITE_ADDRESS=http://analytics.example.com      # Caddy: plain HTTP, no certificate
   HTTP_PORT=8080
   HTTPS_PORT=8443                                       # must still be free: compose publishes it
   ```

   Then `docker compose up -d`. The scheme in `CLICKROOM_PUBLIC_URL` matters: it decides cookie
   `Secure` flags and the links in the snippet, so it must be `https://` when users arrive over HTTPS.
2. Keep Caddy off the public network: in `docker-compose.override.yml` bind it to loopback
   (needs Compose 2.24+ for `!override`):

   ```yaml
   services:
     caddy:
       ports: !override
         - "127.0.0.1:8080:80"
   ```

   Otherwise block port 8080 in your firewall.
3. nginx server block (TLS part omitted; use certbot):

   ```nginx
   server {
     listen 443 ssl http2;
     server_name analytics.example.com;
     # ssl_certificate ...; ssl_certificate_key ...;

     client_max_body_size 25m;

     location / {
       proxy_pass http://127.0.0.1:8080;
       proxy_http_version 1.1;
       proxy_set_header Host $host;                        # keep the original Host
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_buffering off;                                # SSE: /flags/stream
       proxy_read_timeout 1h;
     }
   }
   ```

   Traefik: a router for `Host(\`analytics.example.com\`)` with the service pointing at
   `http://127.0.0.1:8080` (or the `caddy` container on a shared Docker network) is equivalent;
   keep the `Host` header and do not strip path prefixes.
4. **Real client IPs.** Caddy, as an untrusted-edge by default, replaces `X-Forwarded-For` with the
   address of the connection (your proxy). If you want geolocation and per-client rate limits to see
   real visitors, tell Caddy to trust your proxy by setting its address ranges in `.env`
   (space-separated CIDRs; `private_ranges` covers a proxy on the same host or LAN):

   ```text
   CADDY_TRUSTED_PROXIES=private_ranges
   ```

   then `docker compose up -d caddy`. The default (`127.0.0.1/32`) trusts nothing. Only do this when Caddy is reachable solely from your proxy.
   The capture service trusts the first `X-Forwarded-For` entry it receives, so a client able to
   reach Caddy directly could spoof its IP.
5. If attachments (`storage` profile) are enabled, the proxy must pass `/<bucket>/...` through
   **unchanged** with the original `Host`, because presigned URLs are signed over both. The
   catch-all `location /` above already does.

If the dashboard loads but login does not stick, or the browser reports CORS errors, the usual cause
is a mismatch between `CLICKROOM_PUBLIC_URL` and the URL in the address bar. See
[Troubleshooting](troubleshooting.md#login-loops-or-cors-errors-behind-a-proxy).

## Cloudflare

**Orange-cloud proxy in front of Caddy (simple).** Keep `CADDY_SITE_ADDRESS=analytics.example.com`
and ports 80/443 open. Set Cloudflare SSL/TLS mode to **Full (strict)**. Before the very first start,
use "DNS only" (grey cloud) so certificate issuance cannot be blocked, then enable the proxy. Cloudflare
adds `CF-Connecting-IP` and `X-Forwarded-For`; as above, set `CADDY_TRUSTED_PROXIES` to
[Cloudflare's published ranges](https://www.cloudflare.com/ips/) (IPv4 and IPv6, space-separated)
if you want real client IPs; a Tunnel connects from the host, so `private_ranges` fits there. Cloudflare's request size limits apply to
uploads.

**Cloudflare Tunnel (no open ports).** Install `cloudflared` on the host and point the tunnel's public
hostname at `http://localhost:8080`, using the same `.env` as in the nginx section
(`CADDY_SITE_ADDRESS=http://analytics.example.com`, `HTTP_PORT=8080`, `CLICKROOM_PUBLIC_URL=https://...`).
Cloudflare terminates TLS. This path has not been tested by the maintainers.

## Subdomain splits are not wired up

The shipped stack serves dashboard, API and capture on **one origin**. Splitting them across
subdomains (for example `app.` and `capture.`) is not a supported configuration: the compose file
does not pass `COOKIE_DOMAIN` or extra `CORS_ORIGINS` to the API, and the web image's runtime config
is set for same-origin paths. The only separate hostname is the optional admin console.

## Several Clickroom installs or other sites on one host

Give each install its own `--dir`, its own `HTTP_PORT`/`HTTPS_PORT`, and front them with one proxy
as above. The compose project name is fixed (`clickroom-selfhost`), so run the second install with
`docker compose -p <other-name>` or volumes and containers will collide.
