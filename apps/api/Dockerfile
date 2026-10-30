# syntax=docker/dockerfile:1
#
# apps/api — NestJS + tRPC control plane.
# pnpm/turbo monorepo build. Build context MUST be the repo root:
#
#   docker build -f apps/api/Dockerfile -t clickroom/api .
#
# Build args:
#   WITH_RDS_CA=false (default)  portable image, no AWS trust anchor.
#   WITH_RDS_CA=true             bakes Amazon's RDS global CA bundle at /etc/ssl/rds/ for the
#                                hosted (AWS) deployment. Self-hosters never need it; a TLS
#                                Postgres can instead mount a bundle and set DB_CA_BUNDLE_PATH.
ARG WITH_RDS_CA=false

# NOTE: base images are pinned by tag, not sha256 digest. Pin a digest for reproducibility with
# `docker pull node:24-alpine && docker inspect --format='{{index .RepoDigests 0}}' node:24-alpine`
# before this goes into release CI.
FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# ── RDS CA bundle ─────────────────────────────────────────────────────────
# Prod RDS enforces `rds.force_ssl=1`, and packages/db verifies the server cert
# against Amazon's global CA bundle rather than trusting it blindly. Fetched in
# its own stage so the runtime layer never gains curl/ca-certificates just to
# obtain a static PEM. The bundle is public and unauthenticated by design; it is
# a trust anchor, not a secret.
FROM base AS rds-ca-true
RUN apk add --no-cache ca-certificates curl \
    && mkdir -p /etc/ssl/rds \
    && curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
       -o /etc/ssl/rds/global-bundle.pem \
    && grep -q "BEGIN CERTIFICATE" /etc/ssl/rds/global-bundle.pem

# Portable variant: an empty directory, so the COPY below is a no-op.
FROM base AS rds-ca-false
RUN mkdir -p /etc/ssl/rds

FROM rds-ca-${WITH_RDS_CA} AS rds-ca

# ── Pruner ────────────────────────────────────────────────────────────────
FROM base AS pruner
WORKDIR /app
COPY . .
RUN pnpm dlx turbo@2.3.3 prune @clickroom/api --docker

# ── Dependency installation ──────────────────────────────────────────────
FROM base AS deps
WORKDIR /app

COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ── Build ─────────────────────────────────────────────────────────────────
FROM deps AS builder
WORKDIR /app
COPY --from=pruner /app/out/full/ .

# Generate the Prisma client (packages/db/prisma/schema.prisma) for the
# Linux container target before compiling anything that imports @clickroom/db.
RUN pnpm --filter @clickroom/db prisma:generate

# Remove stale tsbuildinfo files so incremental mode doesn't skip JS emission.
RUN find . -name "*.tsbuildinfo" -delete

# Build @clickroom/api and every workspace package it depends on.
RUN pnpm --filter @clickroom/api... build

# Self-contained production deployment (prunes to prod deps only).
RUN pnpm --filter @clickroom/api deploy --prod /deploy/api

# `pnpm deploy` doesn't carry over the generated .prisma client engine —
# copy it in manually from the package store, same as the workspace's
# @prisma/client resolution (hashed .pnpm dir, so glob for it).
RUN PRISMA_PKG=$(ls -d node_modules/.pnpm/@prisma+client@* 2>/dev/null | head -1) && \
    DEPLOY_PKG="/deploy/api/node_modules/.pnpm/$(basename "$PRISMA_PKG")/node_modules" && \
    rm -rf "$DEPLOY_PKG/.prisma" && \
    cp -r "$PRISMA_PKG/node_modules/.prisma" "$DEPLOY_PKG/.prisma"

RUN cp -r apps/api/dist /deploy/api/dist

# ── Runtime image ────────────────────────────────────────────────────────
FROM node:24-alpine AS runner
WORKDIR /app

RUN addgroup -S clickroom && adduser -S clickroom -G clickroom

COPY --from=builder --chown=clickroom:clickroom /deploy/api/node_modules ./node_modules
COPY --from=builder --chown=clickroom:clickroom /deploy/api/dist ./dist
# Prisma schema required for `prisma migrate deploy` (run as a one-shot task
# before rolling the service, not from inside this image's CMD).
COPY --from=builder --chown=clickroom:clickroom /app/packages/db/prisma ./prisma

# Trust anchor for the verified TLS connection to RDS (see packages/db/src/client.ts,
# `resolveTls`). World-readable, root-owned: nothing in the container should be able to
# swap the CA we validate against.
# (empty unless built with --build-arg WITH_RDS_CA=true; packages/db defaults
# DB_CA_BUNDLE_PATH to /etc/ssl/rds/global-bundle.pem when unset.)
COPY --from=rds-ca /etc/ssl/rds/ /etc/ssl/rds/

USER clickroom
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/main.js"]
