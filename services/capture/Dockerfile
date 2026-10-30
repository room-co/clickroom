# syntax=docker/dockerfile:1
#
# capture-rs — public HTTP hot path (`capture.clickroom.co`), Axum + JetStream
# publisher. Part of the clickroom Cargo workspace (services/*).
#
# Build context MUST be the repo root, not this directory: Cargo.lock and the
# sibling workspace members (ingest, query, schema-validate) are required for
# workspace resolution even though only the `capture` binary ends up in the
# final image.
#
#   docker build -f services/capture/Dockerfile -t clickroom/capture .
#
# sqlx here uses runtime `query_as`/`query_scalar` (no `sqlx::query!` macros),
# so no DATABASE_URL / SQLX_OFFLINE metadata is needed at build time.

ARG RUST_VERSION=1
ARG NODE_VERSION=24

# ── sdk: build the browser bundle that capture serves at /static/clickroom.js ─
# The install snippet customers paste points <script src> at {api_host}, and
# api_host IS capture — so the bundle has to ship inside this image. It's baked
# into the binary (services/capture/build.rs → include_str!), not COPY'd into the
# runtime layer, because the runtime stage is distroless and has no filesystem to
# serve from. If this stage is ever removed, the build still succeeds and the
# service still boots — it just serves a placeholder and screams about it in the
# startup log (see src/sdk.rs). Don't let it.
FROM node:${NODE_VERSION}-alpine AS sdk
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Everything in this stage runs as root, so corepack's default per-user cache is
# fine here — unlike infra/docker/Dockerfile.migrate, which drops to a non-root
# USER and therefore must pin COREPACK_HOME to a shared path. Keep that in mind
# if this stage ever grows a USER directive.
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# pnpm workspace: the lockfile + every package manifest must be present for
# `--frozen-lockfile` to resolve, even though only sdk-js is being built.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY apps ./apps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @clickroom/sdk-js...

# Emits dist/clickroom.js (minified IIFE, entry src/global.ts) — see
# packages/sdk-js/esbuild.config.mjs. Assert it exists rather than letting a
# silently-empty bundle reach the Rust stage.
RUN pnpm --filter @clickroom/sdk-js build \
    && test -s packages/sdk-js/dist/clickroom.js

# ── chef base: cargo-chef gives us a cached dependency-only layer, so a
# source-only change doesn't force recompiling every crate in the workspace.
FROM rust:${RUST_VERSION}-slim-bookworm AS chef
# cmake: required by `aws-lc-sys`, the TLS backend the AWS SDK
# `aws-sdk-s3`, used to presign support-attachment uploads) pulls in through
# rustls. Without it the builder stage fails at dependency-cook time with a
# "could not find cmake" build-script error, long before any of our code
# compiles.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config cmake && \
    rm -rf /var/lib/apt/lists/*
RUN cargo install cargo-chef --locked
WORKDIR /app

# ── planner: compute the dependency recipe from the whole workspace ─────────
FROM chef AS planner
COPY Cargo.toml Cargo.lock ./
COPY services/capture ./services/capture
COPY services/ingest ./services/ingest
COPY services/query ./services/query
COPY services/schema-validate ./services/schema-validate
RUN cargo chef prepare --recipe-path recipe.json

# ── builder: cook deps (cached), then compile the capture binary ────────────
FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json
COPY Cargo.toml Cargo.lock ./
COPY services/capture ./services/capture
COPY services/ingest ./services/ingest
COPY services/query ./services/query
COPY services/schema-validate ./services/schema-validate
# Land the bundle at exactly the path services/capture/build.rs reads by default
# (`../../packages/sdk-js/dist/clickroom.js`, relative to the crate root) so the
# Docker build and a plain `cargo build` in a checked-out repo agree. Copied AFTER
# `cargo chef cook` on purpose: cook compiles against dummy sources with no bundle
# present, and build.rs's `rerun-if-changed` on this path makes cargo re-run it
# once the file appears. Keep it above `cargo build`.
COPY --from=sdk /app/packages/sdk-js/dist/clickroom.js ./packages/sdk-js/dist/clickroom.js
# workspace.release profile sets lto=true, codegen-units=1 (repo Cargo.toml).
RUN cargo build --release --bin capture && \
    strip target/release/capture

# ── runtime: distroless (no shell/package manager), non-root ────────────────
FROM gcr.io/distroless/cc-debian12:nonroot AS runtime
WORKDIR /app
COPY --from=builder /app/target/release/capture /usr/local/bin/capture

# Default matches services/capture/src/config.rs's CAPTURE_PORT fallback (3001).
ENV CAPTURE_PORT=3001
EXPOSE 3001

# Static busybox so a container HEALTHCHECK works in distroless (no shell/curl/wget).
# `GET /health` (services/capture/src/main.rs) is also what the ALB probes in cloud.
COPY --from=busybox:1.36.1-musl /bin/busybox /busybox
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["/busybox", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:3001/health"]

USER nonroot
ENTRYPOINT ["/usr/local/bin/capture"]
