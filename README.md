# gtmgrid

A cloud-only, programmable GTM spreadsheet — a Clay/Revcode-style tool where **every column is a function**. Grid data lives in **Postgres** (the single source of truth); column **execution and your keys stay on your machine** via a local Node sidecar engine — a QuickJS sandbox for column logic, declarative HTTP connectors, bring-your-own AI key, and an MCP server so Claude Code / Codex can drive your grid. An account is **required**; the free path is **self-hosting** (run your own Postgres + the `apps/web` backend).

No remote job queue. Self-host your own Postgres for free, or use our hosted cloud. Bring your own AI key and your own Claude Code subscription.

## Getting started

Clone the repo and install dependencies — everything that powers the app lives in this repo.

**Prerequisites**
- [Node.js](https://nodejs.org) ≥ 20 and [pnpm](https://pnpm.io) (`npm i -g pnpm`)
- For building the native desktop app only: [Rust](https://rustup.rs) (`rustup` or `brew install rust`)
- For the in-app agent panel only: your own `claude` and/or `codex` CLI on `PATH` (uses your Max / Codex plan)

```bash
git clone https://github.com/badapplesdotdev/gtm-grid.git
cd gtm-grid
pnpm install          # one-time; builds better-sqlite3 natively
```

**Run it (dev — two terminals, fastest for hacking):**

```bash
# terminal 1 — the engine sidecar (HTTP API on :8787)
GTMGRID_PROJECT=default pnpm server

# terminal 2 — the React UI on http://localhost:5173
pnpm desktop
```

**Or run the native window** (spawns the sidecar for you):

```bash
PATH="/opt/homebrew/bin:$PATH" pnpm tauri:dev
```

**Build a distributable `.app` / `.dmg`:**

```bash
pnpm sidecar:build                                 # bundle the self-contained Node sidecar
PATH="/opt/homebrew/bin:$PATH" pnpm tauri:build    # → packages/desktop/src-tauri/target/release/bundle/
```

**Connect your keys (in-app):** open **AI Providers** in the sidebar to add an Anthropic / OpenAI / OpenRouter key, and **Extensions → Browse all** to connect enrichment providers. Keys are stored encrypted on *your* machine — see below.

> **Your keys & execution stay local.** Grid data lives in Postgres (self-hosted or our cloud), but your connector/AI keys are stored in a local secrets vault encrypted (AES-256-GCM) — *outside this repo* — and the sidecar engine runs column execution on your machine. A fresh clone starts as a blank slate with no keys; each person connects their own. `node_modules/`, build output, and local secret files are git-ignored by design.

## Architecture

A pnpm + Turborepo monorepo:

```
packages/
  engine/   core: SQLite (better-sqlite3) + QuickJS sandbox + connectors + execution
  server/   Node HTTP sidecar over the engine (local projects, :8787)
  cli/      gtmgrid CLI — build & run grids headlessly
  mcp/      MCP server — exposes the grid as tools for Claude Code / Codex
  cloud/    shared cloud/domain logic (Effect: seats + cloud-actions metering, crypto)
  db/       Drizzle schema + pooled Postgres (Supabase) client (@gtmgrid/db)
  auth/     Better Auth server config + session/JWT helpers (@gtmgrid/auth)
  services/ Effect-DI cloud services + repositories over Drizzle (@gtmgrid/services)
  email/    transactional email templates (Resend) (@gtmgrid/email)
  desktop/  React + Tauri desktop app (the grid UI)
apps/
  web/      Next.js app (Vercel): marketing site + tRPC API (/api/trpc) + Better Auth
            (/api/auth) + inbound-webhook receiver + Inngest worker + worker endpoints
```

- **Storage** — grid data lives in **Postgres** ([Supabase](https://supabase.com), via Drizzle, `@gtmgrid/db`) — the single source of truth for tables → columns → rows → cells, whether self-hosted or our cloud. The desktop keeps only a small **local secrets vault** on disk: encrypted `credentials` (AES-256-GCM, connector/AI keys) and extension manifests — **not** grid data.
- **Sandbox** — `quickjs-emscripten` (asyncify build). Each column's JS body runs isolated; `sdk.<provider>.<method>(...)` calls are blocking (asyncify) and marshalled to host-side async work. `process`/`require`/`fetch` are not reachable inside.
- **Connectors** — one declarative manifest (verb + path + zod input) becomes an `sdk` call, an MCP tool, and (later) a UI form. Built-ins: `ai.generate`, `github.getUser`.
- **Execution** — `engine.runColumn()` resolves `{{Column Name}}` templates, runs the column over rows with bounded concurrency (`mapConcurrent`), writes cells with `pending/running/done/error` status.

## Inbound webhooks (cloud)

Every **cloud** table can expose an inbound webhook so external systems can drive
data *in*. Enable it from the table (the "new table" chooser offers **Blank / CSV
upload / Webhook**, and any cloud table has a **Webhook** action), configure a
JSON-path → column **field mapping**, and you get a signed POST endpoint.

Flow: `POST` JSON → the receiver (`apps/web/api/webhooks/[token]`, on Vercel)
verifies the `X-GTMGrid-Signature` HMAC against the webhook's signing secret →
emits an **Inngest** event → the durable `processWebhookRecord` function inserts
(or upserts) a row and, when **auto-run** is on, runs the table's function/AI
columns to enrich it. The worker reaches the cloud grid through **secret-gated
`/api/worker/*` HTTP endpoints** (the engine runs in the worker with a cloud-backed
store over Postgres — no `Db`/SQLite loaded). A per-event **delivery log** is recorded.

Each processed record counts as **usage** via the existing `cloud_actions` meter
(see below) — once for the insert, once per terminal enrichment cell. Enrichment
runs **server-side** here (the Vercel worker), unlike normal grid runs which stay
on the user's local engine.

## CLI

```bash
pnpm install                      # one-time; builds better-sqlite3 natively

alias gtm='node --import tsx packages/cli/src/index.ts'

gtm init demo
gtm connect-ai demo --provider anthropic --key sk-ant-...   # key stored encrypted
gtm table add demo Leads
gtm col add demo Leads Username
gtm col add demo Leads GitHub  --fn github.getUser --type json username="{{Username}}"
gtm col add demo Leads Bio     --fn ai.generate prompt="One-line bio for {{Username}}"
gtm row add demo Leads Username=torvalds
gtm run  demo Leads
gtm show demo Leads
```

Custom-code column (chains off other columns):

```bash
gtm col add demo Leads Summary --code ./summary.js gh="{{GitHub}}"
# summary.js:  function(inputs){ const u = JSON.parse(inputs.gh); return u.name + " @ " + u.company; }
```

## Connect Claude Code / Codex

The MCP server exposes `list_functions`, `list_tables`, `create_table`, `add_column`, `add_rows`, `run_column`, `get_table`.

```bash
claude mcp add gtmgrid -s user -e GTMGRID_PROJECT=default -- "$HOME/dev/gtmgrid/bin/gtmgrid-mcp"
claude mcp get gtmgrid     # → Status: ✓ Connected
```

Then in Claude Code: *"Using gtmgrid, create a table of these 10 founders and enrich each with their GitHub bio."*

## Extensions (JSON manifests)

Connectors can be uploaded as pure-data JSON manifests (Revcode's "Upload manifest" model) — no code needed. Manifests live in `extensions/`.

```bash
gtm ext add demo extensions/leadmagic.json   # 9 methods → sdk.leadmagic.*
gtm ext add demo extensions/trigify.json      # 6 methods → sdk.trigify.*
gtm ext ls demo
gtm connect demo leadmagic apiKey=<LEADMAGIC_KEY>   # store credential (encrypted)
gtm connect demo trigify   apiKey=<TRIGIFY_XAPIKEY> # Trigify settings → API key (NOT the OAuth CLI token)
```

A manifest declares `baseUrl`, `auth` (apiKey header/query + which secret holds it), and `methods` (verb, path with `{param}`, JSON-Schema `input`, credits). One method → an `sdk.<id>.<method>()` call, an MCP tool, and a UI form. Bundled: **LeadMagic** (email/phone/profile/company enrichment) and **Trigify** (LinkedIn profile/company enrichment, post engagements).

## Connect Claude Code / Codex (in-app agent)

The right-side panel has **Claude Code** and **Codex** tabs — chat with an agent that builds and runs your grid. It spawns the CLI you've *already* signed into (your Max / Codex plan); no OAuth, no keys stored. The grid updates live as the agent calls tools.

- Server detects installed CLIs via `GET /api/agents`; chat streams over `POST /api/agent/chat` (SSE).
- The agent reaches the grid through gtmgrid's MCP server (`bin/gtmgrid-mcp`), scoped to the active project.
- Mutating tools push a `grid` event → the UI refetches so you watch rows fill.

Try: *"Create a table of 10 AI founders and enrich each with their Trigify profile, then draft a one-line opener."*

You can also use it from a terminal Claude Code (registered via `claude mcp add gtmgrid`).

## Adding a code connector

```ts
// packages/engine/src/connectors/apollo.ts
import { z } from "zod";
import { defineHttpConnector } from "./http.js";

export const apolloConnector = defineHttpConnector({
  id: "apollo", name: "Apollo.io", category: "enrichment",
  baseUrl: "https://api.apollo.io/v1",
  auth: { type: "apiKey", header: "x-api-key" }, secretKey: "apiKey",
  methods: [{
    id: "enrichPerson", label: "Enrich Person", verb: "POST", path: "/people/match",
    description: "Enrich a person by name + company. Returns email, title, company.",
    input: z.object({ first_name: z.string(), last_name: z.string(), domain: z.string().optional() }),
  }],
});
```

Register it in `registry.ts`, then `gtm connect demo apollo apiKey=...`.

## Desktop app

```bash
# native window (spawns the engine sidecar automatically):
PATH="/opt/homebrew/bin:$PATH" pnpm --filter @gtmgrid/desktop tauri dev

# or web-only (two terminals):
GTMGRID_PROJECT=default pnpm --filter @gtmgrid/server dev   # http://localhost:8787
pnpm --filter @gtmgrid/desktop dev                          # http://localhost:5173
```

`packages/server` is a Node HTTP wrapper over the engine (the sidecar). `packages/desktop` is a Vite/React grid UI. `packages/desktop/src-tauri` is the Tauri v2 Rust shell that spawns the sidecar and renders the UI — same shape as Revcode.

## Build a distributable app

```bash
pnpm install
# build the self-contained Node sidecar (esbuild + native deps + bundles a node runtime):
pnpm sidecar:build          # first run installs native deps + copies a node binary (~140MB)
# then the installer (.dmg + .app under packages/desktop/src-tauri/target/release/bundle/):
PATH="/opt/homebrew/bin:$PATH" pnpm tauri:build   # needs Rust (rustup or brew install rust)
```

The packaged app bundles its own Node runtime + engine, so it runs on a clean Mac with **no dev toolchain installed**. The agent panel additionally needs the user's own `claude` / `codex` CLI on PATH (their Max / Codex plan).

> Unsigned builds are quarantined by Gatekeeper on other Macs — right-click → Open, or `xattr -dr com.apple.quarantine gtmgrid.app`. Code-signing/notarization is left to the distributor.

## Cloud / Teams (commercial)

gtmgrid is **source-available** under the
[Functional Source License (FSL-1.1-MIT)](./LICENSE) — one repo, all the code,
free to use/self-host/modify for any purpose **except** building a competing
commercial product (each release converts to MIT two years after it ships). The
free path is **self-hosting**: run your own Postgres plus the `apps/web` backend
and you get the whole tool, unlimited. The commercial value is **managed hosting +
multiplayer / team collaboration**, sold on top as a paid tier.

| | Self-host (your Postgres) | Hosted cloud (ours) |
| --- | --- | --- |
| **Storage** | Postgres you run ([Supabase](https://supabase.com)/Drizzle, or any Postgres) | managed Postgres ([Supabase](https://supabase.com), via Drizzle) |
| **Account** | required (sign in against your backend) | required (sign in against ours) |
| **Collaboration** | live multiplayer within your instance | live multiplayer — members edit the same grids in real time |
| **Connectors & tables** | unlimited | unlimited (nothing is capped) |
| **Billing** | none (you run the infra) | per-**seat** subscription, metered per workspace member |
| **Execution** | **local** — on your machine via the sidecar | **still local** — see below |

Key design points (all shipped across Waves 1–3 of the cloud build):

- **No feature gating.** Capping connectors or tables would cripple an OSS local
  tool and is unenforceable. The free local product stays fully capable forever.
  The **only** thing the paid tier gates is **seats**.
- **Seats billing.** Subscriptions are seat-based and metered per workspace via
  [Autumn](https://useautumn.com) (Stripe underneath). Inviting a member runs an
  Autumn `check` on the `seats` feature; over the limit returns an Autumn
  `checkout` URL that the desktop opens as an upgrade modal. There are **no**
  connector or table caps anywhere. The desktop has a **Plan & billing** settings
  surface (current plan + usage + upgrade via the same Autumn checkout).
- **Cloud-actions usage metering.** Billable cloud operations (cell writes,
  structural inserts, and each webhook record processed) increment a per-workspace
  `cloud_actions_used` counter on the write path and track immediately to Autumn's
  `cloud_actions` meter (free tier caps at 2000, paid is metered overage). There is
  a single metering surface — both the grid `MeterService` and the webhook worker
  write the same counter; there is no pending counter or scheduled flush. Metering
  applies to our **hosted** cloud only — self-hosted instances run against your own
  Postgres and are never metered. New Autumn customers are created with the
  workspace name + owner email.
- **Realtime multiplayer via Supabase.** Cloud team projects live in Postgres. The
  desktop SEEDS each grid via tRPC `grid.getTable`, then SUBSCRIBES to a
  per-workspace+table **Supabase Realtime Broadcast** channel; the server publishes
  a typed grid-change event after each write, and every other member's client
  patches its cached snapshot through a pure reducer — so an edit, add-row, or
  column run appears live with no manual refresh. Account unit is the **workspace
  (team)**: members, projects, and credentials all scope to it, and billing is per
  workspace.
- **Execution stays local.** The cloud only stores and syncs data. When you run
  a column on a cloud project, your **local engine** reads the inputs through the
  apps/web API, runs the QuickJS sandbox + connector HTTP calls **on your machine**,
  and writes cell status (`running` → `done`/`error`) back through the same API —
  so results stream live to every member while no engine ever runs in the cloud.
- **Shared team credentials.** Workspace connector keys are stored in Postgres,
  encrypted at rest under a workspace-scoped key (envelope-wrapped by a backend
  master secret). Plaintext is only ever decrypted in the trusted run path —
  never exposed to other members' clients. Your machine keeps a local
  `~/.gtmgrid/key` AES-256-GCM secrets vault for personal connector/AI keys used by
  the local sidecar engine.

The cloud tier is built on **Drizzle over Postgres** (`@gtmgrid/db`), **Better
Auth** (`@gtmgrid/auth`), an **Effect-DI service layer** (`@gtmgrid/services`:
repositories + domain services with LIVE Drizzle and in-memory TEST Layers), and a
**tRPC** API (`apps/web/lib/trpc`) the desktop calls through a typed client.

> See [`docs/cloud.md`](./docs/cloud.md) for the full architecture and the
> verification matrix.

### Setup (cloud tier)

The cloud tier needs a Postgres database (Supabase), an Autumn (billing) secret,
and a backend master key for credential encryption. Configure these as
**environment variables** (see [`.env.example`](./.env.example)) — only the
variable **names** are listed here; never commit secret values.

| Variable | Where it lives | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | apps/web env + `.env` for `pnpm db:migrate` | Supabase POOLED (Supavisor transaction mode, port 6543) Postgres URL the Drizzle client opens with `prepare:false` |
| `SITE_URL` | apps/web env | the app's public base URL; a trusted origin for Better Auth OAuth redirects (alongside the `gtmgrid://` desktop deep link) |
| `VITE_API_URL` | `.env` (desktop build) | **required** — base URL of the apps/web backend serving the tRPC API + Better Auth (your self-hosted host, or ours). The desktop has no local-only mode; it always talks to this backend |
| `VITE_INNGEST_URL` | `.env` (desktop build) | base URL of the webhook app, used to render a table's webhook endpoint |
| `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` | `.env` (desktop build) | locate the Supabase project + publishable key for the live-grid Realtime subscription |
| `AUTUMN_SECRET_KEY` | apps/web env | server-side Autumn key for seats `check`/`checkout` + cloud-actions metering |
| `CREDENTIALS_MASTER_KEY` | apps/web env | 32-byte backend master key (KEK) that wraps per-workspace credential keys |
| `SUPABASE_JWT_SECRET` | apps/web env | HS256 secret used by `@gtmgrid/auth` to mint a Supabase-compatible Realtime JWT for the signed-in user |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | apps/web env | the server-side Supabase Realtime **broadcast** publisher (degrades to a no-op when unset) |
| `AUTH_GITHUB_ID` + `AUTH_GITHUB_SECRET` | apps/web env (optional) | GitHub OAuth; the provider registers only when both are set |
| `AUTH_GOOGLE_ID` + `AUTH_GOOGLE_SECRET` | apps/web env (optional) | Google OAuth; the provider registers only when both are set |
| `WEBHOOK_WORKER_SECRET` | apps/web env **and** the desktop sidecar | shared bearer the Inngest webhook worker AND the sidecar cloud-run path use to call the secret-gated `/api/worker/*` endpoints (must match) |
| `AUTH_RESEND_KEY` | apps/web env | Resend API key. When set, turns ON sign-up **email verification** + **password reset** and sends **invite** emails. Unset = those flows degrade gracefully (sign-up needs no code; invites still create a copyable accept link). |
| `RESEND_FROM` | apps/web env (optional) | Verified sender, e.g. `gtm grid <noreply@gtmgrid.dev>`. Defaults to Resend's shared `onboarding@resend.dev` so email works before a domain is verified. |
| `INVITE_BASE_URL` | apps/web env (optional) | Base URL of the web app that serves the `/invite/<token>` accept page. Falls back to `SITE_URL`; only used to build invite accept links. |
| `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` | apps/web env | the Inngest webhook worker keys |

**Email & invites.** Account email verification + password reset use Better Auth's
email-OTP plugin (`@gtmgrid/auth`, gated on `AUTH_RESEND_KEY`). Team invites are
**by email**: an owner/admin calls the tRPC `invitations.invite` mutation, which
seat-gates via Autumn, creates a pending `invitations` row, and emails an accept
link (`https://<INVITE_BASE_URL>/invite/<token>`, served by
`apps/web/app/invite/[token]`). The invitee accepts in-app via the email-matched
banner (`invitations.myPending`) or the link/`?invite=` token; acceptance re-checks
seats and inserts the membership. All outbound mail funnels through `@gtmgrid/email`.

**Migrations.** The Drizzle schema lives in `@gtmgrid/db`; generate and apply
migrations with:

```bash
pnpm db:generate   # generate SQL migrations from the schema (offline, no DB)
pnpm db:migrate    # apply committed migrations (reads DATABASE_URL)
```

The desktop build **requires** `VITE_API_URL` — it always talks to an apps/web
backend (your self-hosted instance or ours). Self-hosters point it at their own
host backed by their own Postgres; there is no local-only build that runs without a
database.

### Future Expansion

These are deliberately **out of scope** for v1 (cloud is additive on top of the
unchanged local tool) and tracked for later:

- **Full grid-in-browser.** A Next.js web surface now ships (`apps/web` —
  marketing site + tRPC API + webhook worker on Vercel), and native deep-link OAuth
  has landed. A full *grid UI in the browser* (a React app calling the tRPC API
  directly) is still future; the remaining gap is the in-app agent, which spawns
  the user's local `claude`/`codex` CLI.
- **Cloud execution of grids.** Partially realized: webhook record processing +
  function-column enrichment already run **server-side** in the Vercel/Inngest
  worker. Running *user-triggered* column runs in a cloud runtime (instead of the
  local engine) is the remaining piece for unattended runs and a full web build.
- **Proxied managed-key connectors.** Offering connectors (e.g. Trigify) through
  *our* keys with Autumn credit metering, as an additional revenue lever — no
  user-supplied key required.
- **Offline editing of cloud projects** with later reconciliation. The cloud tier
  is online-first today; local projects remain the offline story until then.

## Status

- ✅ Engine, sandbox, connectors, CLI, MCP (connect from terminal Claude Code)
- ✅ JSON-manifest extensions + LeadMagic (9) & Trigify (15) connectors — Trigify verified live
- ✅ Desktop app: React grid UI + Tauri shell + **in-app Claude Code / Codex agent panel** (drives the grid live)
- ✅ Self-contained `.dmg` — bundles node + engine; runs without a dev toolchain
- ✅ Cloud / Teams tier (open-core): Postgres backend on Supabase via Drizzle
  (`@gtmgrid/db`), Better Auth (`@gtmgrid/auth`), an Effect-DI service layer
  (`@gtmgrid/services`) behind a tRPC API (`apps/web/lib/trpc`) — workspace/project/
  table/cell procedures, seats billing via Autumn, workspace-encrypted shared
  credentials — the engine `GridStore` abstraction (`SqliteGridStore` + the cloud
  HTTP store), and the desktop cloud client (auth UI, workspace switcher, realtime
  grid, settings) — all with Vitest coverage. Live two-window multiplayer needs a
  human Tauri run to confirm visually; the data path is verified via `pnpm
  typecheck` + `pnpm test`.
- ✅ Turborepo monorepo + `apps/web` (marketing site + Inngest webhook worker) deployed to Vercel
- ✅ **Inbound webhooks** per cloud table: HMAC-verified receiver → Inngest durable
  insert/upsert + auto-run enrichment, per-event delivery log, metered as cloud
  actions — **verified end-to-end in production**
- ✅ CSV import → table (drop / review / done) + new-table chooser (blank / CSV / webhook)
- ✅ Cloud-actions usage metering (Autumn) + in-app **Plan & billing** settings; Better Auth with native deep-link OAuth

## License

[**FSL-1.1-MIT**](./LICENSE) — the [Functional Source License](https://fsl.software).
You may use, copy, modify, and redistribute gtmgrid for any **Permitted Purpose**
(internal use, self-hosting, education, research, professional services). The one
restriction is **Competing Use**: you may not use it to offer a commercial product
or service that substitutes for gtmgrid. Two years after each version is published
it automatically converts to the **MIT license**.

This keeps the whole codebase public and contributable while preventing commercial
resale — and every release becomes fully open source on a fixed schedule.
