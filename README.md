# gtmgrid

A local-first, programmable GTM spreadsheet — a Clay/Revcode-style tool where **every column is a function**. Runs fully on your machine: SQLite storage, a QuickJS sandbox for column logic, declarative HTTP connectors, bring-your-own AI key, and an MCP server so Claude Code / Codex can drive your grid.

No remote job queue, no pricing gate. Bring your own AI key and your own Claude Code subscription.

## Getting started

Clone the repo and install dependencies — everything that powers the app lives in this repo.

**Prerequisites**
- [Node.js](https://nodejs.org) ≥ 20 and [pnpm](https://pnpm.io) (`npm i -g pnpm`)
- For building the native desktop app only: [Rust](https://rustup.rs) (`rustup` or `brew install rust`)
- For the in-app agent panel only: your own `claude` and/or `codex` CLI on `PATH` (uses your Max / Codex plan)

```bash
git clone https://github.com/maxtrigify/gtm-grid.git
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

> **Your data & keys stay local.** Projects live at `~/gtmgrid/<name>.db` and API keys are stored there encrypted (AES-256-GCM) — *outside this repo*. A fresh clone starts as a blank slate with no tables and no keys; each person connects their own. `node_modules/`, build output, and `*.db` files are git-ignored by design.

## Architecture

```
packages/
  engine/   core: SQLite (better-sqlite3) + QuickJS sandbox + connectors + execution
  cli/      gtmgrid CLI — build & run grids headlessly
  mcp/      MCP server — exposes the grid as tools for Claude Code / Codex
```

- **Storage** — `better-sqlite3`, one `.db` file per project at `~/gtmgrid/<name>.db`. Schema: tables → columns → rows → cells, plus `extensions` and encrypted `credentials` (AES-256-GCM, scoped local/personal/team).
- **Sandbox** — `quickjs-emscripten` (asyncify build). Each column's JS body runs isolated; `sdk.<provider>.<method>(...)` calls are blocking (asyncify) and marshalled to host-side async work. `process`/`require`/`fetch` are not reachable inside.
- **Connectors** — one declarative manifest (verb + path + zod input) becomes an `sdk` call, an MCP tool, and (later) a UI form. Built-ins: `ai.generate`, `github.getUser`.
- **Execution** — `engine.runColumn()` resolves `{{Column Name}}` templates, runs the column over rows with bounded concurrency (`mapConcurrent`), writes cells with `pending/running/done/error` status.

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

## Status

- ✅ Engine, sandbox, connectors, CLI, MCP (connect from terminal Claude Code)
- ✅ JSON-manifest extensions + LeadMagic (9) & Trigify (15) connectors — Trigify verified live
- ✅ Desktop app: React grid UI + Tauri shell + **in-app Claude Code / Codex agent panel** (drives the grid live)
- ✅ Self-contained `.dmg` — bundles node + engine; runs without a dev toolchain

## License

MIT — see [LICENSE](./LICENSE).
