# Architecture

```
SDKs ──> capture (Rust/Axum) ──> NATS JetStream ──> ingest (Rust) ──> ClickHouse (events)
dashboard ──> api (NestJS + tRPC) ──> Postgres (config, tenancy) · Redis (cache) · query (Rust) ──> ClickHouse
```

- **capture** is the hot path: authenticates write keys, rate-limits, validates events, publishes to
  NATS, and serves flag evaluation and the SDK bundle.
- **ingest** consumes from NATS and writes to ClickHouse in batches; failures go to a dead-letter stream.
- **api** is the control plane (auth, orgs, projects, flags, experiments, insights, MCP).
- **query** runs the SQL explorer against ClickHouse with a read-only user and concurrency limits.
- **web** (and optional **admin**) are static React apps configured at container start via `/config.js`.
- **migrate** is a one-shot job: Postgres migrations, ClickHouse migrations, plan seed. It must
  finish before the other services start.
- **caddy** terminates TLS and routes one domain to web, api, capture and storage.

The queue is NATS rather than Kafka plus ZooKeeper, which keeps the footprint small.

## Scale limits

Single node only: one ClickHouse, one NATS, one Postgres, no replication or failover. Backups are the
recovery plan. There is no Helm chart and no multi-node guidance.

## Resource sizing

Target: 4 vCPU / 8 GB RAM / 40 GB disk. Treat that as the minimum. Event storage grows with traffic
and nothing expires automatically, so watch disk use. No verified events-per-month ceiling is
published; size by watching your own usage and keep headroom. More detail is in
[how it works](../self-host/how-it-works.md).

## Life of an event

1. An SDK sends a batch to `POST /capture/v1/capture` with a write key.
2. **capture** looks up the key (cached in Redis), applies the per-project rate limit, checks
   strict schemas, stamps server-side fields, and publishes the events to NATS JetStream. It answers
   `202` once JetStream has stored them.
3. **ingest** reads the stream and inserts events into ClickHouse in batches. Events that cannot be
   written go to a dead-letter stream.
4. The dashboard reads the events through **api** (and **query** for the SQL Explorer).

Because the queue sits between capture and storage, short ClickHouse outages do not lose events:
capture keeps answering and the backlog drains afterwards. Events normally become visible within a
few seconds.

## Telemetry

None. The server does not phone home.
