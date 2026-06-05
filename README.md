# gtmgrid

A local-first, programmable GTM spreadsheet — a Clay/Revcode-style tool where **every column is a function**. Runs fully on your machine: SQLite storage, a QuickJS sandbox for column logic, declarative HTTP connectors, bring-your-own AI key, and an MCP server so Claude Code / Codex can drive your grid.

No remote job queue, no pricing gate. Bring your own AI key and your own Claude Code subscription.

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

## Cloud / Teams (commercial)

gtmgrid is **open-core**. The free, MIT-licensed local app is **100% local and
offline** — local solo projects use the bundled SQLite engine and never call the
cloud. The commercial value is **multiplayer / team collaboration**, sold on top
as a paid tier.

| | Free (local solo) | Paid (cloud team) |
| --- | --- | --- |
| **Storage** | local SQLite, one `.db` per project | [Convex](https://convex.dev) workspace (cloud source of truth) |
| **Collaboration** | single machine | live multiplayer — members edit the same grids in real time |
| **Connectors & tables** | unlimited | unlimited (nothing is capped) |
| **Billing** | none | per-**seat** subscription, metered per workspace member |
| **Execution** | local engine | **still local** — see below |
| **Offline** | yes | online-first (cloud is the live source of truth) |

Key design points (all shipped across Waves 1–3 of the cloud build):

- **No feature gating.** Capping connectors or tables would cripple an OSS local
  tool and is unenforceable. The free local product stays fully capable forever.
  The **only** thing the paid tier gates is **seats**.
- **Seats billing.** Subscriptions are seat-based and metered per workspace via
  [Autumn](https://useautumn.com) (Stripe underneath). Inviting a member runs an
  Autumn `check` on the `seats` feature; over the limit returns an Autumn
  `checkout` URL that the desktop opens as an upgrade modal. There are **no**
  connector or table caps anywhere.
- **Realtime multiplayer via Convex.** Cloud team projects live in Convex, whose
  reactive database makes **every `useQuery` a live subscription** — so an edit,
  add-row, or column run by any member appears in every other member's window
  with no custom sync engine and no manual refresh. Account unit is the
  **workspace (team)**: members, projects, and credentials all scope to it, and
  billing is per workspace.
- **Execution stays local.** The cloud only stores and syncs data. When you run
  a column on a cloud project, your **local engine** reads the inputs from Convex,
  runs the QuickJS sandbox + connector HTTP calls **on your machine**, and writes
  cell status (`running` → `done`/`error`) back through Convex mutations — so
  results stream live to every member while no engine ever runs in the cloud.
- **Shared team credentials.** Workspace connector keys are stored in Convex,
  encrypted at rest under a workspace-scoped key (envelope-wrapped by a backend
  master secret). Plaintext is only ever decrypted in the trusted run path —
  never exposed to other members' clients. Local projects keep the existing
  machine-local `~/.gtmgrid/key` AES-256-GCM model, untouched.

> See [`docs/cloud.md`](./docs/cloud.md) for the full architecture, the Convex
> function surface, and the verification matrix.

### Setup (cloud tier)

The cloud tier needs a Convex deployment, an Autumn (billing) secret, and a
backend master key for credential encryption. Configure these as **environment
variables** — only the variable **names** are listed here; never commit secret
values.

| Variable | Where it lives | Purpose |
| --- | --- | --- |
| `CONVEX_DEPLOYMENT` | `.env.local` (dev) | the Convex dev/prod deployment `convex dev` is bound to |
| `VITE_CONVEX_URL` | `.env.local` (desktop build) | the deploy URL the React/Convex client connects to |
| `AUTUMN_SECRET_KEY` | Convex deployment env | server-side Autumn key for the seats `check` / `checkout` |
| `CREDENTIALS_MASTER_KEY` | Convex deployment env | 32-byte backend master key (KEK) that wraps per-workspace credential keys |

Run Convex codegen before typechecking the cloud code — the client imports
`convex/_generated/*`, which only exists **after** a deployment login generates
it:

```bash
# Logs in / creates a Convex dev deployment and generates convex/_generated/.
npx convex dev          # or: pnpm convex:dev
# (codegen only, no long-running watcher:  npx convex codegen)
```

`convex dev` writes `CONVEX_DEPLOYMENT` to `.env.local` and a deploy URL you set
as the client's `VITE_CONVEX_URL`. `AUTUMN_SECRET_KEY` and `CREDENTIALS_MASTER_KEY`
are set on the **Convex deployment** (they are read server-side and never reach
the client). The OSS build runs with **no** cloud env at all: `convex/` is kept
out of the root `tsc -b` graph and the desktop client treats an absent
`VITE_CONVEX_URL` as "cloud disabled", so the local-only path needs no Convex
deployment to build or run.

### Future Expansion

These are deliberately **out of scope** for v1 (cloud is additive on top of the
unchanged local tool) and tracked for later:

- **Web app.** The same React UI can subscribe to Convex directly, so a browser
  build is now cheap. The remaining gaps are execution (today's engine is local)
  and the in-app agent (today it spawns the user's local `claude`/`codex` CLI).
- **Cloud execution of grids.** Running columns in a cloud runtime instead of on
  the user's machine — required for a true web build and for unattended runs.
- **Native deep-link OAuth.** Today's desktop sign-in does not yet open the
  system browser and handle a deep-link callback; that native OAuth flow is a
  tracked follow-up (**task #17**).
- **Proxied managed-key connectors.** Offering connectors (e.g. Trigify) through
  *our* keys with Autumn credit metering, as an additional revenue lever — no
  user-supplied key required.
- **Offline editing of cloud projects** with later reconciliation. Convex is
  online-first today; local projects remain the offline story until then.

## Status

- ✅ Engine, sandbox, connectors, CLI, MCP (connect from terminal Claude Code)
- ✅ JSON-manifest extensions + LeadMagic (9) & Trigify (15) connectors — Trigify verified live
- ✅ Desktop app: React grid UI + Tauri shell + **in-app Claude Code / Codex agent panel** (drives the grid live)
- ✅ Self-contained `.dmg` — bundles node + engine; runs without a dev toolchain
- ✅ Cloud / Teams tier (open-core): Convex backend (auth, workspace/project/table/cell
  API, seats billing via Autumn, workspace-encrypted shared credentials), the
  engine `GridStore` abstraction (`SqliteGridStore` + `ConvexGridStore`), and the
  desktop cloud client (auth UI, workspace switcher, realtime grid, settings) — all
  with Vitest coverage. Live two-window multiplayer needs a human Tauri run to
  confirm visually; the data path is verified via `pnpm typecheck` + `pnpm test`.

## License

MIT — see [LICENSE](./LICENSE).
