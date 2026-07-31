# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

gtmgrid is a source-available, self-hostable **programmable GTM spreadsheet** — a Clay/Revcode-style tool where **every column is a function**. Grid data lives in **Postgres** (single source of truth). Column **execution and API keys stay on the user's machine** via a local Node sidecar engine (a QuickJS sandbox for column logic, declarative HTTP connectors, bring-your-own AI key, and an MCP server so agents can drive the grid).

pnpm + Turborepo monorepo. ESM throughout (`"type": "module"`). Node ≥ 20, pnpm 10.7.0.

## Commands

```bash
pnpm install              # one-time; builds better-sqlite3 natively

# The verify gate (run before considering work done):
pnpm typecheck            # tsc -b (project refs) + web + desktop typecheck
pnpm test                 # vitest run, all package suites in one pass
pnpm lint                 # oxlint over packages/ (apps/ is excluded — see below)

# Electron E2E is a required local, detached gate for user-facing features:
pnpm e2e:background       # starts Playwright without blocking the active turn
pnpm e2e:status           # check for running / passed / failed
pnpm e2e:log              # last 60 log lines; inspect only when needed

# Turbo-orchestrated variants (cached, dependency-aware):
pnpm turbo:typecheck
pnpm turbo:test
pnpm build                # turbo run build

# Single test file / filter:
pnpm vitest run packages/engine/src/formula.test.ts
pnpm vitest run -t "coerces"          # by test name
pnpm test:watch                       # vitest watch mode

# DB migrations (Drizzle; reads DATABASE_URL):
pnpm db:generate          # generate SQL from schema (offline, no DB)
pnpm db:migrate           # apply committed migrations
```

**Running the app locally** (see README "Run it locally" for full env setup):
```bash
docker compose up -d                          # Postgres on :5432
pnpm -F @gtmgrid/db db:migrate                # one-time schema
pnpm -F @gtmgrid/web dev                       # terminal 1 — backend API (tRPC + Better Auth) :3000
GTMGRID_PROJECT=default pnpm server            # terminal 2 — engine sidecar :8787
pnpm desktop                                   # terminal 3 — desktop grid UI :5173
```

Set `GTMGRID_SELF_HOST=1` in `apps/web/.env.local` so a self-hosted instance never expires or meters usage.

**CLI** (headless grid building):
```bash
alias gtm='node --import tsx packages/cli/src/index.ts'
gtm init demo && gtm table add demo Leads && gtm run demo Leads
```

## Linting note (important)

`pnpm lint` runs **oxlint over `packages/` only** — `apps/**`, `extensions/**`, `dist/`, `sidecar/`, `_generated/`, and `*.d.ts` are ignored (`.oxlintrc.json`). `apps/web` has its own **ESLint** config (`pnpm -F @gtmgrid/web lint`). oxlint categories are set to `warn`, not `error`.

## Architecture

Monorepo layout (`pnpm-workspace.yaml`: `packages/*`, `apps/*`):

```
packages/
  engine/         core: SQLite (better-sqlite3) + QuickJS sandbox + connectors + execution
  server/         Node HTTP sidecar over the engine (local projects, :8787)
  cli/            gtmgrid CLI — build & run grids headlessly
  mcp/            MCP server — exposes the grid as tools for Claude Code / Codex
  cloud/          shared cloud/domain logic (Effect: seats + cloud-actions metering, crypto)
  db/             Drizzle schema + pooled Postgres (Supabase) client (@gtmgrid/db)
  auth/           Better Auth server config + session/JWT helpers (@gtmgrid/auth)
  services/       Effect-DI cloud services + repositories over Drizzle (@gtmgrid/services)
  email/          transactional email templates (Resend) (@gtmgrid/email)
  desktop/        React + Vite grid UI, Electron shell (@gtmgrid/desktop)
  analytics/ observability/ worker-runtime/   cross-cutting: PostHog, telemetry, cloud worker engine host
apps/
  web/            Next.js (Vercel): marketing + tRPC API (/api/trpc) + Better Auth (/api/auth)
                  + inbound-webhook receiver + Inngest worker + secret-gated /api/worker/* endpoints
  party/          PartyKit server (realtime presence)
```

### Core execution model (packages/engine)
- **Storage** — grid data (tables → columns → rows → cells) lives in Postgres. The engine talks to a store abstraction (`store.ts` `SqliteGridStore` for local projects, `store-cloud.ts` HTTP store for cloud projects — the cloud worker runs the engine with no SQLite loaded).
- **Sandbox** (`sandbox.ts`) — `quickjs-emscripten` asyncify build. Each column's JS body runs isolated; `sdk.<provider>.<method>(...)` calls are blocking (asyncify) and marshalled to host-side async. No `process`/`require`/`fetch` inside.
- **Connectors** (`connectors/`, `registry.ts`) — one declarative manifest (verb + path + zod input) becomes an `sdk` call, an MCP tool, and a UI form. Built-in code connectors register in `registry.ts`; pure-data JSON manifests live in `extensions/`.
- **Execution** (`execute.ts`, `formula.ts`) — resolves `{{Column Name}}` templates, runs a column over rows with bounded concurrency, writes cells with `pending/running/done/error` status.
- **Generated files** — `*.generated.ts` (bundled manifests, sandbox libs) are produced by `pnpm -F @gtmgrid/engine gen:*` scripts; don't hand-edit.

### Cloud tier
Drizzle over Postgres (`@gtmgrid/db`) + Better Auth (`@gtmgrid/auth`) + Effect-DI service layer (`@gtmgrid/services`) behind a **tRPC** API in `apps/web/lib/trpc`, called by the desktop through a typed client. The account unit is the **workspace (team)**; billing is **seat-based** via Autumn (Stripe underneath), plus a `cloud_actions` usage meter. **Execution always stays local** — the cloud only stores and syncs data; the local engine reads inputs via the apps/web API and writes cell status back. Realtime multiplayer is Supabase Realtime Broadcast (server publishes a typed grid-change event per write; clients patch a cached snapshot via a pure reducer).

### Inbound webhooks (cloud)
`POST` → receiver `apps/web/app/api/webhooks/[token]` verifies `X-GTMGrid-Signature` HMAC → emits an **Inngest** event → durable `processWebhookRecord` inserts/upserts a row and (if auto-run) enriches it **server-side** in the Vercel/Inngest worker (via the secret-gated `/api/worker/*` endpoints, guarded by `WEBHOOK_WORKER_SECRET`). Each processed record meters as a cloud action.

## Conventions

- **All business logic / services use Effect-TS** with typed errors (`Data.TaggedError`) and `Layer`-based DI (`Effect.Service`). No thrown exceptions in service code, **no `as` casts** — model the types. DB/external access lives behind service methods, never raw in routers/handlers/UI. React components stay plain React — Effect is for logic only. Canonical reference: `packages/engine/src/sample-service.ts` (+ `.test.ts`). Full rules in `docs/effect-conventions.md`.
- **Tests** — Vitest. Test outcomes (returned value or typed error `_tag`), not implementation. Use Effect test `Layer`s instead of mocks; assert typed failures with `Effect.runPromiseExit` + `Cause.failureOption`. Each package owns its `vitest.config.ts`; the root config discovers them via `projects`.
- **Desktop E2E** — Every user-facing desktop feature needs a Playwright spec under `packages/desktop/e2e/`. Run the suite locally with `pnpm e2e:background` and require `pnpm e2e:status` to report `passed` before opening the PR. It is intentionally excluded from GitHub Actions so a multi-minute Electron run never blocks the feedback loop.
- **TypeScript** — `typescript@^7` (native compiler). Root `tsconfig.json` is a solution file with project references to each composite package; `pnpm typecheck` runs `tsc -b`.
- **Native deps** — `better-sqlite3` and `quickjs-emscripten` must stay external (not Vite-prebundled). `kysely` is pinned to `0.29.2` with a patch (`patches/`).

## Desktop shell

The active desktop build path is **Electron** (`packages/desktop/electron/`, `electron-builder.yml`, `pnpm electron:pack`). A `src-tauri/` directory also exists and the README still references Tauri commands, but the wired-up scripts (`sidecar:build`, `electron:dev`, `electron:pack`) target Electron. When touching desktop packaging, follow the Electron scripts in `packages/desktop/package.json`, not the README's Tauri instructions.

## Releases

Changesets: `pnpm changeset` to add a changeset; `pnpm version-packages` runs `changeset version` then `scripts/sync-app-version.mjs` to sync the app version.

## Brand / design

`DESIGN.md` holds the GTM Grid brand kit — primary color `#22C55E` (green), reserved for functional accents (CTAs, active states), not decoration. Verify WCAG AA contrast before shipping color pairings.
