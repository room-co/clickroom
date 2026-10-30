# syntax=docker/dockerfile:1
#
# ingest-rs — internal-only NATS JetStream pull consumer -> batched ClickHouse
# insert. A pure background consumer; the only HTTP surface is a tiny
# `GET /health` liveness listener on INGEST_HEALTH_PORT (default 3003,
# src/health.rs), started once every dependency has connected. Never publish it.
#
# Build context MUST be the repo root, not this directory — see
# services/capture/Dockerfile for why (shared cargo workspace).
#
#   docker build -f services/ingest/Dockerfile -t clickroom/ingest .

ARG RUST_VERSION=1

# ── chef base: cargo-chef dependency-layer caching ───────────────────────────
FROM rust:${RUST_VERSION}-slim-bookworm AS chef
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config && \
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

# ── builder: cook deps (cached), then compile the ingest binary ─────────────
FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json
COPY Cargo.toml Cargo.lock ./
COPY services/capture ./services/capture
COPY services/ingest ./services/ingest
COPY services/query ./services/query
COPY services/schema-validate ./services/schema-validate
# workspace.release profile sets lto=true, codegen-units=1 (repo Cargo.toml).
RUN cargo build --release --bin ingest && \
    strip target/release/ingest

# ── runtime: distroless (no shell/package manager), non-root ────────────────
FROM gcr.io/distroless/cc-debian12:nonroot AS runtime
WORKDIR /app
COPY --from=builder /app/target/release/ingest /usr/local/bin/ingest

# Static busybox so `docker compose` / `docker run` healthchecks work in distroless
# (no shell, curl or wget otherwise): HEALTHCHECK CMD ["/busybox", "wget", ...].
COPY --from=busybox:1.36.1-musl /bin/busybox /busybox

ENV INGEST_HEALTH_PORT=3003
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["/busybox", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:3003/health"]

USER nonroot
ENTRYPOINT ["/usr/local/bin/ingest"]
