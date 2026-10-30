# Clickroom — full-stack dev orchestration.
#
# Layout:
#   infra (docker):  postgres :5433 · clickhouse :8123 · nats :4222 · redis :6380 · localstack :4567
#   rust services:   capture :3001 · ingest (NATS→ClickHouse consumer, no port)
#   node apps:       api :3000 · web :5180 (Vite, proxies /trpc → :3000)
#
# Bootstrap infra:  make infra:up     (deps + docker infra + schema + seed; idempotent)
# Every day:        make up           (start app services)   /   make down (stop them)
# Tear infra down:  make infra:down   (stop containers; make infra:reset wipes volumes)
# Load testing:     make up:release   (release-binary capture/ingest, alongside `make up`)
#                    / make down:release (stop them)
#
# App services run in the background; pids + logs live under .dev/.

SHELL := bash
.DEFAULT_GOAL := help

DC       := docker compose
PNPM     := pnpm
CARGO    := cargo
RUN_DIR  := .dev
# Per-service log size cap (KiB, bash `ulimit -f` units; default 2 GiB). A service that tries to write
# past it gets SIGXFSZ and dies loudly instead of filling the disk (a retry loop once wrote ~680 GB to
# one log). Existing logs are rotated to <name>.log.1 (one generation kept) on each start.
LOG_MAX_KB ?= 2097152

# Managed background app services (Rust + Node — NOT docker infra).
# proxy starts last so web is (usually) up first; it 502s gracefully
# until they are, so ordering is best-effort, not required.
#
SERVICES := capture ingest query api web admin proxy
# All app services except capture/ingest — reused by `up:release` so it can start
# everything else the normal (debug/dev) way while only capture+ingest run as release
# binaries.
NON_RUST_HOT_PATH_SERVICES := query api web admin proxy

# Per-service launch command (used by the start-% pattern rule).
CMD_capture   := $(CARGO) run -p capture
CMD_ingest    := $(CARGO) run -p ingest
CMD_query     := $(CARGO) run -p query
CMD_api       := $(PNPM) --filter @clickroom/api dev
CMD_web       := $(PNPM) --filter @clickroom/web dev
CMD_admin     := $(PNPM) --filter @clickroom/admin dev
CMD_proxy     := node scripts/dev-proxy.mjs

# Release-binary launch commands for capture/ingest — used only by `make up:release`
# (load-testing), never by the default `make up` dev loop. See "Release build" section below.
CMD_capture_release := ./target/release/capture
CMD_ingest_release  := ./target/release/ingest

.PHONY: help
help: ## Show this help
	@echo "Clickroom dev — targets:"
	@grep -hE '^[a-zA-Z_:\\-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort \
		| awk '{ i=index($$0,": "); j=index($$0,"## "); \
		         name=substr($$0,1,i-1); gsub(/\\/,"",name); \
		         printf "  \033[36m%-12s\033[0m %s\n", name, substr($$0,j+3) }'
	@echo ""
	@echo "First time:  make infra:up   then   make up   →   landing http://localhost:5177 · web http://localhost:5180"

# ── Environment ────────────────────────────────────────────────────────────

.env: ## Create .env from the example if missing
	@[ -f .env ] || { cp .env.example .env && echo "created .env from .env.example — review it"; }

# ── Infra bootstrap (docker + schema + seed) ───────────────────────────────
# Colon-named targets (make infra:up) — the ':' is escaped for GNU Make.

.PHONY: install
install: .env ## Install JS deps + fetch Rust crates
	$(PNPM) install
	$(CARGO) fetch

infra\:up: install ## Start docker infra + migrate schema + seed + dev S3 bucket (idempotent bootstrap)
	$(DC) up -d --wait
	$(MAKE) infra:s3
	$(MAKE) migrate
	$(MAKE) seed
	@echo "✅ infra ready — run 'make up' to start services"

# Support-attachment bucket in LocalStack. Done from the Makefile rather than a
# LocalStack init hook so bucket provisioning sits next to migrate/seed in one bootstrap path.
# `awslocal` ships in the localstack image and pre-points at the container's own endpoint.
# CORS matters even locally: the browser PUTs straight at :4566 from the web/dev-proxy origin,
# so without it the upload fails preflight and looks like a signing bug.
infra\:s3: .env ## Create the dev support-attachments bucket in LocalStack (idempotent)
	@set -a; . ./.env; set +a; \
	bucket="$${SUPPORT_ATTACHMENTS_BUCKET:-clickroom-dev-support-attachments}"; \
	$(DC) exec -T localstack awslocal s3api create-bucket --bucket "$$bucket" >/dev/null 2>&1 || true; \
	$(DC) exec -T localstack awslocal s3api put-bucket-cors --bucket "$$bucket" \
		--cors-configuration '{"CORSRules":[{"AllowedMethods":["PUT","GET","HEAD"],"AllowedOrigins":["*"],"AllowedHeaders":["*"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":3000}]}' >/dev/null; \
	echo "  s3 bucket ready: $$bucket (localstack http://localhost:4567)"

infra\:down: ## Stop docker infra containers (volumes kept)
	$(DC) down

infra\:reset: stop down\:release ## Stop everything AND delete data volumes, then re-bootstrap (destructive)
	$(DC) down -v
	@echo "⚠️  data volumes wiped"
	$(MAKE) infra:up
	@echo "⚠️  app services stopped (capture/ingest hold stale NATS stream/consumer handles across a reset) — run 'make up' or 'make up:release' to bring them back"

infra\:logs: ## Follow docker infra logs
	$(DC) logs -f

.PHONY: infra\:up infra\:down infra\:reset infra\:logs infra\:s3

# ── Schema + seed (standalone; also invoked by infra:init) ─────────────────

.PHONY: migrate
migrate: .env ## Apply Postgres (Prisma) + ClickHouse migrations
	@set -a; . ./.env; set +a; \
	$(PNPM) --filter @clickroom/db prisma:generate && \
	$(PNPM) --filter @clickroom/db exec prisma migrate deploy && \
	$(PNPM) --filter @clickroom/clickhouse migrate

.PHONY: seed
seed: .env ## Seed Postgres (demo org/project/api keys) — idempotent
	@set -a; . ./.env; set +a; $(PNPM) --filter @clickroom/db seed

# ── Build ──────────────────────────────────────────────────────────────────

.PHONY: build
build: ## Build all TS packages + release Rust binaries
	$(PNPM) build
	$(CARGO) build --release -p capture -p ingest

# NOTE: the build helpers below are named with HYPHENS (build-release-rust,
# build-ts-packages) and referenced by those names in the `up` / `up:release`
# prerequisite lists. GNU Make 3.81 (the macOS system make) does NOT resolve a
# backslash-escaped colon (`build\:foo`) when it appears as a *prerequisite* —
# it silently drops it — so a colon-named build target used as a prereq never
# runs. The `build:*` colon spellings are kept as thin aliases for the
# documented `make build:release-rust` CLI usage.
.PHONY: build-release-rust build\:release-rust
build-release-rust: ## Build only release capture+ingest binaries (used by 'make up:release')
	$(CARGO) build --release -p capture -p ingest
build\:release-rust: build-release-rust

# The api/web/query services import the workspace TS packages from their compiled
# `dist/` (package.json "main" → ./dist/index.js), NOT their `src/`. `tsx watch`
# only watches each service's own src, so a package source edit is invisible until
# its dist is rebuilt — hence `up` / `up:release` build the package dists first.
# Turbo caches, so this is ~instant when nothing changed.
.PHONY: build-ts-packages build\:ts-packages
build-ts-packages: ## Build workspace TS package dists (consumed by api/web/query at runtime)
	$(PNPM) exec turbo run build --filter="./packages/*"
	@$(MAKE) --no-print-directory stabilize-sdk-js-bundle-mtime
build\:ts-packages: build-ts-packages

# Turbo re-materializes a cache HIT by rewriting the output file with a fresh mtime, even
# when its bytes are byte-identical to what was already there. services/capture/build.rs
# watches this exact file via `cargo:rerun-if-changed` (mtime-based, like all such Cargo
# directives), so on `up:release` that harmless mtime bump was enough to make Cargo mark
# `capture` dirty and recompile+relink the whole binary on every single run, even with zero
# real changes anywhere. This restores the file's previous mtime whenever its content hash
# hasn't moved, so only a genuine SDK bundle change (or the very first build) reaches Cargo
# as a change worth rebuilding for.
.PHONY: stabilize-sdk-js-bundle-mtime
stabilize-sdk-js-bundle-mtime:
	@f=packages/sdk-js/dist/clickroom.js; \
	stamp=packages/sdk-js/dist/.clickroom.js.sha256; \
	if [ -f "$$f" ]; then \
		new=$$(shasum -a256 "$$f" | cut -d' ' -f1); \
		if [ -f "$$stamp" ] && [ "$$(cat "$$stamp")" = "$$new" ]; then \
			touch -r "$$stamp" "$$f"; \
		else \
			echo "$$new" >"$$stamp"; \
			touch -r "$$f" "$$stamp"; \
		fi; \
	fi

# ── Run app services (backgrounded) — no docker here ───────────────────────

.PHONY: up
up: .env build-ts-packages $(addprefix start-,$(SERVICES)) ## Start all app services (capture/ingest/api/web) in the background
	@echo ""
	@echo "✅ clickroom up:"
	@echo "   app       http://localhost:5177  (dev-proxy: everything → web)"
	@echo "   web       http://localhost:5180  (app SPA, direct)"
	@echo "   admin     http://localhost:5181  (internal admin console, direct)"
	@echo "   api       http://localhost:3000"
	@echo "   capture   http://localhost:3001/health"
	@echo "   query     http://localhost:3002/health"
	@echo "   logs      make logs   ·   status  make ps   ·   stop  make down"

# start-<svc>: launch one service in the background with a pidfile, unless already running.
# .env is exported so the node apps see the same config the Rust services load via dotenvy.
# NOTE: no $(MAKE) here on purpose — a recursive-make line would run even under `make -n`.
start-%:
	@mkdir -p $(RUN_DIR)
	@if [ -f $(RUN_DIR)/$*.pid ] && kill -0 $$(cat $(RUN_DIR)/$*.pid) 2>/dev/null; then \
		echo "  $* already running (pid $$(cat $(RUN_DIR)/$*.pid))"; \
	else \
		echo "  starting $* → $(RUN_DIR)/$*.log"; \
		mv -f $(RUN_DIR)/$*.log $(RUN_DIR)/$*.log.1 2>/dev/null || true; \
		( ulimit -f $(LOG_MAX_KB); set -a; . ./.env; set +a; \
		  $(CMD_$*) >$(RUN_DIR)/$*.log 2>&1 & echo $$! >$(RUN_DIR)/$*.pid ); \
	fi

# Foreground runners — usable standalone (e.g. `make run-api` in its own terminal).
.PHONY: run-capture run-ingest run-query run-api run-web run-admin
run-capture: ## Run capture-rs in the foreground (:3001)
	$(CMD_capture)
run-ingest: ## Run ingest-rs in the foreground (NATS→CH)
	$(CMD_ingest)
run-query: ## Run query-rs in the foreground (:3002)
	$(CMD_query)
run-api: ## Run the API in the foreground (:3000)
	$(CMD_api)
run-web: ## Run the web app in the foreground (:5180)
	$(CMD_web)
run-admin: ## Run the admin console in the foreground (:5181)
	$(CMD_admin)

# ── Stop / status ──────────────────────────────────────────────────────────

.PHONY: down
down: stop ## Stop all background app services (infra stays up)
	@echo "✅ clickroom down (infra still running — 'make infra:down' to stop it)"

.PHONY: stop
stop: ## Stop background app services (alias of down's core; keeps infra)
	@for s in $(SERVICES); do \
		if [ -f $(RUN_DIR)/$$s.pid ]; then \
			pid=$$(cat $(RUN_DIR)/$$s.pid); \
			if kill -0 $$pid 2>/dev/null; then kill $$pid 2>/dev/null && echo "  stopped $$s (pid $$pid)"; fi; \
			rm -f $(RUN_DIR)/$$s.pid; \
		fi; \
	done

up\:e2e: ## Start isolated e2e stack (capture/ingest/api on alt ports) alongside `make up`
	bash scripts/e2e-up.sh

down\:e2e: ## Stop the e2e stack (for --wipe: bash scripts/e2e-down.sh --wipe)
	bash scripts/e2e-down.sh

.PHONY: up\:e2e down\:e2e

# Full stack, but capture/ingest run as release binaries (load-testing). Same one-command
# UX as `make up` — starts query/api/web/proxy the normal (debug/dev) way, and
# capture+ingest from release binaries instead of `cargo run`. Separate pidfiles
# (capture-release.pid, ingest-release.pid) under .dev/ for the Rust services so `make down`/
# `make ps` never see or touch those two; the other services share the same pidfiles/
# start-% machinery as `make up`, so `make down` DOES stop them (only capture/ingest need
# `make down:release`).
.PHONY: up\:release
up\:release: .env build-ts-packages build-release-rust start-capture-release start-ingest-release $(addprefix start-,$(NON_RUST_HOT_PATH_SERVICES)) ## Full stack, capture+ingest from release binaries (load-testing; one command like `make up`)
	@echo ""
	@echo "✅ clickroom up (release capture/ingest, load-test mode):"
	@echo "   app       http://localhost:5177  (dev-proxy: everything → web)"
	@echo "   web       http://localhost:5180  (app SPA, direct)"
	@echo "   admin     http://localhost:5181  (internal admin console, direct)"
	@echo "   api       http://localhost:3000"
	@echo "   capture   http://localhost:3001/health  (release binary)"
	@echo "   query     http://localhost:3002/health"
	@echo "   logs      make logs   ·   status  make ps   ·   stop  make down && make down:release"

start-capture-release:
	@mkdir -p $(RUN_DIR)
	@if [ -f $(RUN_DIR)/capture-release.pid ] && kill -0 $$(cat $(RUN_DIR)/capture-release.pid) 2>/dev/null; then \
		echo "  capture-release already running (pid $$(cat $(RUN_DIR)/capture-release.pid))"; \
	else \
		echo "  starting capture-release → $(RUN_DIR)/capture-release.log"; \
		mv -f $(RUN_DIR)/capture-release.log $(RUN_DIR)/capture-release.log.1 2>/dev/null || true; \
		( ulimit -f $(LOG_MAX_KB); set -a; . ./.env; set +a; \
		  $(CMD_capture_release) >$(RUN_DIR)/capture-release.log 2>&1 & echo $$! >$(RUN_DIR)/capture-release.pid ); \
	fi

start-ingest-release:
	@mkdir -p $(RUN_DIR)
	@if [ -f $(RUN_DIR)/ingest-release.pid ] && kill -0 $$(cat $(RUN_DIR)/ingest-release.pid) 2>/dev/null; then \
		echo "  ingest-release already running (pid $$(cat $(RUN_DIR)/ingest-release.pid))"; \
	else \
		echo "  starting ingest-release → $(RUN_DIR)/ingest-release.log"; \
		mv -f $(RUN_DIR)/ingest-release.log $(RUN_DIR)/ingest-release.log.1 2>/dev/null || true; \
		( ulimit -f $(LOG_MAX_KB); set -a; . ./.env; set +a; \
		  $(CMD_ingest_release) >$(RUN_DIR)/ingest-release.log 2>&1 & echo $$! >$(RUN_DIR)/ingest-release.pid ); \
	fi

.PHONY: down\:release
down\:release: ## Stop release capture/ingest started via 'make up:release' (does not touch `make up`'s debug services)
	@for s in capture-release ingest-release; do \
		if [ -f $(RUN_DIR)/$$s.pid ]; then \
			pid=$$(cat $(RUN_DIR)/$$s.pid); \
			if kill -0 $$pid 2>/dev/null; then kill $$pid 2>/dev/null && echo "  stopped $$s (pid $$pid)"; fi; \
			rm -f $(RUN_DIR)/$$s.pid; \
		fi; \
	done

.PHONY: restart
restart: stop up ## Restart all app services

.PHONY: ps
ps: ## Show infra + app-service status
	@$(DC) ps
	@echo ""
	@for s in $(SERVICES); do \
		if [ -f $(RUN_DIR)/$$s.pid ] && kill -0 $$(cat $(RUN_DIR)/$$s.pid) 2>/dev/null; then \
			echo "  $$s: running (pid $$(cat $(RUN_DIR)/$$s.pid))"; \
		elif [ -f $(RUN_DIR)/$$s-release.pid ] && kill -0 $$(cat $(RUN_DIR)/$$s-release.pid) 2>/dev/null; then \
			echo "  $$s: running (pid $$(cat $(RUN_DIR)/$$s-release.pid), release binary)"; \
		else echo "  $$s: stopped"; fi; \
	done

.PHONY: logs
logs: ## Tail all background service logs
	@tail -n +1 -f $(RUN_DIR)/*.log 2>/dev/null || echo "no logs — services not started"

.PHONY: clean
clean: stop ## Remove build artifacts, node_modules, cargo target, run state
	$(PNPM) clean || true
	$(CARGO) clean || true
	rm -rf $(RUN_DIR)
