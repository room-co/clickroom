# CLAUDE.md

Guidance for agents working in this repo.

## Stack

- pnpm@9.15 workspace (`apps/*`, `packages/*`) + Turborepo. Node >=22.
- Rust cargo workspace (`services/`: capture, ingest, query — Axum).
- Data: Postgres (Prisma) for config/tenancy, ClickHouse for events.

## Run / build / test

Prefer the `Makefile` for full-stack dev (spins up Rust + Node + docker infra together):

```
make infra:up      # first time: bootstrap docker infra + migrate + seed
make up            # start all app services in background
make down           # stop app services
make test           # all TS + Rust tests
make check          # typecheck + biome lint + cargo fmt/clippy
```

JS-only via pnpm/turbo:

```
pnpm install
pnpm dev            # turbo run dev (all apps)
pnpm build
pnpm test
pnpm typecheck
pnpm lint           # biome check . (not eslint/prettier)
pnpm lint:fix
```

Single package: `pnpm --filter @clickroom/<pkg> <script>`.

Ports: api 3000, web 5180, capture 3001, dev-proxy 5177 (proxies to web).

**`apps/web` has no test runner** (no vitest/jest configured) — verify web changes by running the
dev server and checking in-browser, plus `typecheck`/`lint`. `apps/api`, `packages/{auth,db,
clickhouse,sdk-js}` use `vitest run`; `apps/web/e2e` holds the Playwright end-to-end suite.

## Architecture

- `apps/web` — React 18 + Vite dashboard, react-router 7 (library mode, not framework mode),
  Tailwind v4 + shadcn/ui (new-york), tRPC client via `@tanstack/react-query`. MUI + Emotion are
  also present as a dependency but shadcn is the standard for new UI — don't introduce new MUI
  usage.
- `apps/api` — NestJS + tRPC control plane.
- `apps/admin` — internal operator console (separate identity plane from tenant users).
- `apps/mcp` — stdio MCP bridge (`npx clickroom-mcp`).
- `packages/ui`, `packages/config` — shared UI/tsconfig.
- `packages/clickhouse`, `packages/db` (Prisma), `packages/auth`, `packages/sdk-js` — data/auth/SDK
  libs consumed by apps.
- `services/capture`, `services/ingest` — Rust/Axum hot-path ingest → NATS → batched ClickHouse
  insert; `services/query` — read-only SQL Explorer backend.
- Architecture overview: `docs/explanation/architecture.md`.

## Releasing `packages/sdk-js`

Bumping the SDK version means editing **two** places, and they must match:

1. `packages/sdk-js/package.json` → `version`
2. `packages/sdk-js/src/index.ts` → `LIB_VERSION` (stamped on every event as `$lib_version`)

Nothing enforces this. It has already drifted once: **`0.2.0` shipped still stamping
`"0.1.0"`**, so every event from that release misreported which SDK sent it — and a
`$lib_version: "0.1.0"` in prod looked like a mystery third library rather than "0.2.0 is
lying". Note `0.1.0` was never published; if you see it in event properties, the client is
really on `0.2.0`.

Why it matters beyond tidiness: `$lib_version` is the only way to tell which clients have
picked up a new SDK. Rollouts that change event semantics (e.g. a change to how `$session_id` is
shared across tabs) are verified by watching that field flip over in ClickHouse. If it lies, a
deploy cannot be confirmed and a mixed old/new fleet is indistinguishable from a broken one.

The SDK is consumed by **`apps/web` and `packages/sdk-node` via `workspace:*`** (they track a
bump for free) **and by separate downstream projects via npm** with a caret range. A caret bump
inside the same minor (`0.2.x`) is picked up by a routine `pnpm install` there; a minor bump
(`0.3.0`) is not, which is deliberate — it forces adoption to be an explicit, dated act you can
correlate against the metric shift a semantics change causes.

## ClickHouse migrations

Every statement in `packages/clickhouse/migrations/*.sql` **must be replay-safe** —
`CREATE ... IF NOT EXISTS`, `DROP ... IF EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
ClickHouse has no transactional DDL and the runner records a file as applied only after *all* its
statements succeed, so a migration that fails partway is replayed from the top on the next run.
Enforced by `packages/clickhouse/src/migration-guards.test.ts` (fails closed on unknown statement
kinds). Read `packages/clickhouse/migrations/README.md` before adding one — especially before
copying `008`'s destructive drop-and-recreate shape.

## Conventions

- Formatter/linter is **Biome**, not ESLint/Prettier — `pnpm lint` / `pnpm lint:fix`.
- Commit gate is `lefthook.yml` pre-commit: biome check, `pnpm -r typecheck`, `cargo fmt --check`,
  `cargo clippy`.
- **Agents do not `git commit`/`git push`.** Leave a clean, verified working tree; a maintainer
  reviews and commits.
- `apps/web` path alias `@/*` → `src/*`. Tailwind v4 is config-in-CSS (no `tailwind.config.*`) —
  design tokens live in `apps/web/src/styles/theme.css`; default breakpoints (sm640/md768/lg1024).
- Prefer editing existing pages/components over adding new files; shadcn primitives live in
  `apps/web/src/components/ui/` — check there before writing a new one from scratch.
- Split up functions doing heavy lifting (multiple unrelated concerns: fetch + index + build +
  persist, etc.) into small single-purpose helpers instead of one long function — easier to test
  and review in isolation.

## Web responsiveness rules

`apps/web` is being retrofitted for mobile. For any new or edited page:

- **Mobile-first**: default to stacked/single-column layout; add `sm:`/`md:`/`lg:` prefixes to
  restore desktop layout, not the other way around.
- Every `grid-cols-N` needs responsive prefixes (e.g. `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`)
  — never ship a bare fixed `grid-cols-N`.
- Wrap tables (`<table>` or shadcn `<Table>`) in `overflow-x-auto`; don't cap table containers with
  a fixed `max-w-[…px]`.
- Two-pane / master-detail layouts must stack to a single column below `md` (`flex-col md:flex-row`),
  not stay side-by-side at fixed pixel widths.
- Mobile navigation and any off-canvas panel goes through `components/ui/sheet.tsx`, not a
  hand-rolled fixed-width absolutely-positioned drawer.
- Test at 375px, 768px, and 1024px before calling a page done — `md` (768px) is the desktop/mobile
  switch for the shell and two-pane layouts.

## Web loading states

For any new or edited page:

- **Skeletons for data, spinners for mutations.** A tRPC query that's loading gets a skeleton; a
  button mid-submit gets a spinner + disabled state. Never a spinner for a page's data fetch, never
  a bare `Loading…` string, never a blank render.
- **Skeletons mirror the real layout** — right row count, right column count, right card height — so
  nothing jumps when the data lands. A full-width grey bar where a 4-column table is about to appear
  is worse than nothing.
- Compose from `apps/web/src/components/skeletons/` (`SkeletonText`, `SkeletonTable`,
  `SkeletonCard`, `SkeletonChart`, `SkeletonList`, `SkeletonStatCard`/`SkeletonStatRow`). Don't
  hand-roll `animate-pulse bg-muted/40` divs, and don't loop bare `<Skeleton>` bars — reach for the
  composite that matches the shape. `StatCard` takes `loading`.
- **First load only.** Key the skeleton off `isPending` (or `isLoading && !data`), never a bare
  `isLoading` on a query that already holds data. Paginated / date-filtered queries take
  `placeholderData: keepPreviousData` so changing a filter doesn't collapse loaded content back to
  skeleton.
- Skeleton grids follow the responsiveness rules above — no bare fixed `grid-cols-N`.
