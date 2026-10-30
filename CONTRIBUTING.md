# Contributing to Clickroom

Thanks for helping. This is a community-supported open-source project; there is no SLA on reviews.

## Before you start

- Search existing issues and Discussions. For anything larger than a small fix, open an issue first
  so we can agree on the approach.
- **Sign the CLA.** The CLA bot comments on your first pull request; see [CLA.md](CLA.md). We cannot
  merge without it.
- Be kind: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security issues go to [SECURITY.md](SECURITY.md),
  never to public issues.

## Dev setup

Requirements: Node >= 22, pnpm 9.15, Rust (pinned by `rust-toolchain.toml`), Docker with Compose.

```bash
pnpm install
make infra:up   # first time: bootstrap docker infra (Postgres, ClickHouse, NATS, Redis) + migrate + seed
make up         # start all app services in the background (logs under .dev/)
make down       # stop them
```

Ports: api 3000, web 5180, capture 3001, dev-proxy 5177 (proxies to web).

JS only: `pnpm dev`, `pnpm build`, `pnpm test`, `pnpm typecheck`. A single package:
`pnpm --filter @clickroom/<pkg> <script>`.

## Checks

```bash
make test    # all TS + Rust tests
make check   # typecheck + biome lint + cargo fmt/clippy
```

- Formatter and linter is **Biome** (`pnpm lint`, `pnpm lint:fix`), not ESLint or Prettier.
- `lefthook` runs biome, `pnpm -r typecheck`, `cargo fmt --check` and `cargo clippy` before each
  commit. CI also runs build, tests, cargo deny, licence and secret scans, and a self-host compose
  smoke test.
- `apps/web` has no test runner: verify UI changes in the browser (375px, 768px, 1024px) plus
  typecheck and lint.

## Conventions

- `apps/web`: React 18 + Vite, Tailwind v4, shadcn/ui primitives in `src/components/ui/`. Do not add
  new MUI usage. Mobile-first layouts; skeletons for data loading, spinners for mutations.
- Keep functions small and single-purpose.
- ClickHouse migrations in `packages/clickhouse/migrations/*.sql` must be replay-safe
  (`IF NOT EXISTS` / `IF EXISTS`); read the README in that folder first.
- Releasing `packages/sdk-js`: bump both `package.json` `version` and `LIB_VERSION` in
  `src/index.ts`, and keep them equal.

## Pull requests

- Branch from `main`, keep PRs focused, fill in the PR template.
- Add or update tests with behaviour changes.
- Licence: your contribution is under AGPL-3.0, or MIT if it touches an SDK package, as described
  in [docs/explanation/licensing.md](docs/explanation/licensing.md).

## Support

GitHub issues and Discussions, answered by the community on a best-effort basis.
