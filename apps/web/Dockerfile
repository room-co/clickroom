# syntax=docker/dockerfile:1
#
# apps/web — static Vite SPA served by nginx (unprivileged, :8080).
# Build ONCE, configure at runtime: no VITE_* values are baked in. At container start
# infra/docker/web-config-entrypoint.sh renders /config.js from apps/web/config.js.template
# using CLICKROOM_API_ORIGIN / CLICKROOM_CAPTURE_HOST / CLICKROOM_DEPLOYMENT / CLICKROOM_WRITE_KEY
# (all optional; empty = same-origin behind the reverse proxy).
#
# Build context MUST be the repo root:
#
#   docker build -f apps/web/Dockerfile -t clickroom/web .

FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

FROM base AS pruner
WORKDIR /app
COPY . .
RUN pnpm dlx turbo@2.3.3 prune @clickroom/web --docker

FROM base AS builder
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN find . -name "*.tsbuildinfo" -delete
# @clickroom/db (a workspace dep) typechecks against the generated Prisma client; generate it first.
RUN pnpm --filter @clickroom/db prisma:generate
RUN pnpm --filter @clickroom/web... build \
    && test -s apps/web/dist/index.html
# public/config.js is a dev stub that Vite copies into dist; the real one is rendered at start.
RUN rm -f apps/web/dist/config.js

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runner
USER root
RUN rm -f /etc/nginx/conf.d/default.conf && mkdir -p /etc/clickroom /tmp/clickroom-config \
    && chown nginx:nginx /tmp/clickroom-config
COPY infra/docker/web-nginx.conf /etc/nginx/conf.d/default.conf
COPY infra/docker/web-config-entrypoint.sh /docker-entrypoint.d/40-clickroom-config.sh
COPY --from=builder /app/apps/web/config.js.template /etc/clickroom/config.js.template
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
RUN chmod +x /docker-entrypoint.d/40-clickroom-config.sh
USER nginx

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
