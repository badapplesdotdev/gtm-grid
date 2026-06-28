# @gtmgrid/engine

## 1.0.5

## 1.0.4

## 1.0.3

## 1.0.2

## 1.0.1

## 1.0.0

## 0.22.12

## 0.22.11

## 0.22.10

## 0.22.9

## 0.22.8

## 0.22.7

## 0.22.6

## 0.22.5

## 0.22.4

## 0.22.3

## 0.22.2

## 0.22.1

## 0.22.0

## 0.21.0

### Minor Changes

- ea53611: fix(webhook): make bundled connectors available to cloud auto-enrichment

  When a row arrived via webhook, auto-running its function columns in the cloud
  (Inngest) worker failed for any column using a bundled connector (Trigify,
  LeadMagic, Apollo, etc.) with a sandbox error — so enrichment only worked if the
  user triggered the run manually from the desktop.

  Root cause: the cloud worker built its connector registry from the built-ins plus
  the workspace's installed extensions only, and nothing seeds the app's bundled
  connectors cloud-side. The desktop sidecar registers them from disk at startup,
  but the serverless worker has no `extensions/` directory — so `sdk[provider]` was
  undefined in the sandbox and the run threw "cannot read property <method>".

  The engine now exposes `bundledConnectors()`, built from the shipped
  `extensions/*.json` manifests (inlined via a generated module so they are
  available with no disk access). The webhook worker layers these into its
  per-workspace registry, so bundled connectors run in cloud auto-enrichment
  exactly as they do on the desktop — even when the extensions endpoint returns
  nothing or fails.

## 0.20.1

## 0.20.0

## 0.19.1

## 0.19.0

## 0.18.0

## 0.17.4

## 0.17.3

## 0.17.2

## 0.17.1

## 0.17.0

### Minor Changes

- b2fbbee: Remove the "local" paradigm — Postgres is now the only source of truth.

  GTM Grid was built local-first: each project was a `better-sqlite3` `.db` file served by the desktop sidecar, with cloud (Postgres) as an optional team tier. That produced two parallel data worlds and pervasive local-vs-cloud branching. This change removes the local paradigm entirely:

  - **Single data path.** The execution engine is always cloud-store-backed (`new Engine(config, registry, { store, creds })`); the SQLite `GridStore` layers, the engine's grid tables, the desktop's local `DataGrid`/`inCloud` fork, and the sidecar's local grid CRUD routes are gone. Every grid table operation goes through Postgres via tRPC. The one-way local→cloud push/sync apparatus and the `@gtmgrid/cli` package are deleted.
  - **The sidecar stays as the execution host.** It still runs connector/AI/formula columns locally and keeps a small **secrets-only** local vault (encrypted connector/AI keys, extension manifests) — but it no longer owns grid data; it proxies grid I/O to the `apps/web` worker endpoints. A new `/api/cloud/preview-function` route powers "Try on N rows" against cloud data.
  - **Login required.** `VITE_API_URL` is now mandatory (the build fails fast without it); the cloud/auth layer is always on; the "Continue locally — no account" escape hatches are removed; signed-out users hit a hard auth gate. Self-hosting = run your own Postgres + `apps/web`.
  - **Optimistic UI on every mutation.** To keep the local-first _feel_, every cloud grid mutation now patches the React Query cache instantly and reconciles with the server. Inserts carry a client-supplied UUID so the optimistic id is the persisted id and the realtime self-echo converges idempotently instead of duplicating; failures roll back.

  Note: the sidecar's local Trigify "signals" routes were local-grid-backed and have been removed pending a cloud-backed replacement (recurring signal refresh already runs as an Inngest cloud job).

## 0.16.2

## 0.16.1

## 0.16.0

### Minor Changes

- 735d94c: Full PostHog Error Tracking observability so bugs surface as they occur. All telemetry now points at the GTM Grid **US** project (`us.i.posthog.com`). New `@gtmgrid/observability` package shares one error-tracking + structured-logging convention across the sidecar, MCP server, and CLI (process-level crash handlers + exception capture).

  Closed the remaining blind spots:

  - **Engine run failures** — connector/AI/enrichment errors now feed Error Tracking via an injected, dependency-free `reportError` hook on the engine, **deduped per run** (a large run with one failure mode raises one exception, not thousands), plus a `column_run_failed` analytics event for failure-rate dashboards.
  - **tRPC** — non-typed defects keep their original stack (attached as the `TRPCError` cause) instead of being flattened to a string.
  - **Services** — a new injectable `ErrorReporter` port surfaces deliberately-swallowed best-effort failures (e.g. a failed invite email) without coupling the package to a telemetry client.
  - **Signals** — per-binding sync/warm-up failures in the cron worker are now reported (previously `console.error` only).
  - **Desktop shell** — a Rust panic hook reports Tauri-side panics (sidecar spawn, updater, window setup) to Error Tracking.
  - **PartyKit** — realtime handlers capture unexpected exceptions.

  No behaviour change when PostHog is unconfigured — every surface no-ops without a key.

## 0.15.0

### Minor Changes

- f414614: Respect third-party API rate limits across all connectors. Every outbound connector call is now paced by a per-connector throttle (requests/second + max in-flight) at the engine's dispatch choke point, with researched limits baked into all bundled extensions and a conservative safety default (2 req/s, 2 concurrent) for any connector that declares none — so a large run can no longer fire an unbounded burst at a provider. Pure-local connectors (formatting/formula) are exempt.

  Transient failures (429/503/5xx and network blips) now retry with capped exponential backoff + jitter, honouring `Retry-After`: the manifest connector routes through the shared `fetchWithRetry`, the AI connector uses the vendor SDKs' own retry (maxRetries + timeout), and the cloud Trigify signal sync retries transient failures via an Effect schedule.

## 0.14.0

## 0.13.0

## 0.12.0

## 0.11.1

## 0.11.0

## 0.10.0

## 0.9.24

## 0.9.23

### Patch Changes

- 7c050a2: Make AI columns work without a separate AI key, and explain missing-key errors so
  the user can fix them.

  - **AI columns fall back to the agent's own model.** When no AI provider key is
    connected, `ai.generate` now routes the prompt through the user's already-
    authenticated coding agent (Claude Code / Codex) via a new `EngineConfig.aiFallback`
    (one agent call per row — slower than a batched key, but works with no key). Wired
    into every run path: the sidecar (in-process `generateWithAgent`), the MCP local +
    cloud engines (HTTP to the sidecar's new `POST /api/ai/generate`), and the cloud-run
    lane. This also fixes the cloud MCP path, which previously had **no** AI config at
    all (so `ai.generate` failed even when a key was connected).
  - **Run errors are surfaced to the agent.** `engine.runColumn` now returns the first
    cell error, and `run_column`/`run_table`/`run_function` attach an actionable
    `errorHint` — so a missing AI key, a 401, or a quota cap explains itself (and which
    panel fixes it) instead of the agent having to dig through `get_table`. The agent
    preamble is updated to relay these hints.

## 0.9.22

## 0.9.21

## 0.9.20

## 0.9.19

## 0.9.18

## 0.9.17

## 0.9.16

## 0.9.15

## 0.9.14

### Patch Changes

- c7bd3fc: Async-job connectors (e.g. Firecrawl extract) now block-poll until the job
  completes — with a wall-clock timeout and typed fail states — instead of
  returning a job id the grid can't use. Cells whose value carries an `error`
  field render an honest red error pill (with the real status code when one
  exists) instead of a fabricated "Status Code: 200".

## 0.9.13

## 0.9.12

## 0.9.11

## 0.9.10

## 0.9.9

## 0.9.8

## 0.9.7

## 0.9.6

## 0.9.5

## 0.9.4

## 0.9.3

## 0.9.2

## 0.9.1

## 0.9.0

## 0.8.0

## 0.7.8

### Patch Changes

- 6ab6cf9: Simplify integration credential scopes to **Local** and **Cloud**. The connector
  and AI-provider panels previously showed up to four confusing tabs (Workspace,
  Personal, Team, Local) where three of them all saved to the same machine. They now
  show just two:

  - **Local** — the key is stored on this machine only.
  - **Cloud** — the key is encrypted server-side and **shared with the whole team**
    (everyone in the workspace uses it). Shown only when signed into a cloud workspace.

  Pushing a local table to the cloud no longer fails when an integration is connected
  only locally: credentials are never synced, so a cloud run resolves the team's
  shared Cloud key (or surfaces a connect-integration error at run time if none is
  set). This also fixes the case where having both a local and a Cloud key wrongly
  blocked the push.

## 0.7.7

### Patch Changes

- c64cbf5: Fix two desktop bugs:

  - **In-app updater / notification popover was unclickable.** The transparent
    full-viewport `.popover-scrim` (z-index 100) sat _above_ the bell notification
    popover (z-index 61), so clicking "Update & restart" (or any action) hit the
    scrim and just closed the popover instead of firing the button. Raised the
    notification popover — and the dedupe popover, which had the same z-index 50 <
    scrim bug — above the scrim.

  - **Pushing a local table to the cloud dropped function-column config.** The
    local→cloud push only sent each column's name/type (and the sidecar hardcoded
    `kind: "manual"`), so a function/formula/code column landed in the cloud as a
    plain manual column and its cells could no longer be run/enriched. The push now
    carries the full config (kind/provider/method/code/params/condition); the
    `grid.addColumn` tRPC mutation also accepts `condition` so the "only run if"
    rule survives the push.

## 0.7.6

## 0.7.5

## 0.7.4

## 0.7.3

## 0.7.2

## 0.7.1

## 0.7.0

### Minor Changes

- accf1a9: Grid at scale: dedup + full agent control (bundles #53, #54, #55).

  - **Global-db credentials & extensions** (#53) — resolve credentials _and_
    extensions from the global db in `openProject`, fixing Exa/Firecrawl keys and
    the agent missing connectors (firecrawl/notion/supabase).
  - **HTTP request column** (#54) — generic HTTP request column (full request
    builder + try-on-N-rows) plus a LeadMagic 38-endpoint mapping.
  - **Agent session continuity** (#55) — resume the CLI's native session so chat
    survives Stop/restart, with stdin/transient-id fixes.
  - **Table deduplication** — Clay-style dedup: engine + `set_dedupe` agent tool +
    `add_rows` auto-dedup + a Deduplication panel in the table toolbar (toggle,
    column picker, keep oldest/newest, one-shot sweep).
  - **Full agent CRUD + safety** — `find_rows`, `get_column`, paginated
    `get_table` with row ids, `update_cells`/`update_column`/`rename_table`,
    `delete_rows`/`delete_column`/`delete_table`; destructive/large ops return a
    `{confirmationRequired, willAffect, estimatedCredits}` preview and require
    `confirm:true` to execute. `get_table` truncates large cell values to bound the
    agent's token budget.

## 0.6.1

## 0.6.0

## 0.5.1

## 0.5.0

## 0.4.0

## 0.3.18

## 0.3.17

## 0.3.16

## 0.3.15

## 0.3.14

## 0.3.13

## 0.3.12

## 0.3.11

## 0.3.10

## 0.3.9

## 0.3.8

## 0.3.7

## 0.3.6

## 0.3.5

## 0.3.4

## 0.3.3

## 0.3.2

## 0.3.1

## 0.3.0

## 0.2.0

## 0.1.0
