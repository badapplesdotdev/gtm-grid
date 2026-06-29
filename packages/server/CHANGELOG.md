# @gtmgrid/server

## 1.1.0

### Patch Changes

- 3dda979: The Codex side-panel agent no longer crashes mid-turn when the user has other MCP servers registered. Codex deep-merges `-c` config overrides, so passing `-c mcp_servers={ gtmgrid = … }` did not actually replace the user's servers — their `~/.codex/config.toml` entries (Trigify/exa/…) and bundled plugin servers (linear/computer-use) stayed live, and Codex connecting to any OAuth-walled one made its rmcp transport quit fatally ("Transport channel closed, when AuthRequired"), taking the turn down. The Codex bridge now passes `--ignore-user-config` (the only switch that drops both config and plugin servers, since Codex has no `--strict-mcp-config` equivalent) and re-injects the user's default model + reasoning effort so the panel's "Default" model option keeps working.
- 3e33da9: Hard-block credited actions when a trial expires, plus trial-status notifications.

  Previously `EntitlementService.requireCloudAccess` only checked the cached
  `currentPlanId`, so a trial that lapsed by date kept running credited actions until
  Autumn's webhook/desktop sync flipped the plan to null. And the credit-heavy column
  enrichment run path was gated by quota only, never by cloud access.

  - **Time-based backstop:** `requireCloudAccess` now also fails the instant
    `trialEndsAt` is in the past, regardless of the cached plan id — the server-side
    guarantee that an expired trial cannot run any credited action.
  - **Enrichment path gated:** `assertColumnRunQuota` and the `setCell` / `setCellStatus`
    / `insertRow` / `upsertRow` worker writes now call `requireCloudAccess`, so a lapsed
    workspace cannot complete runs server-side even with quota headroom. The worker
    boundary maps `PlanRequiredError` → 403 (distinct from the 402 quota error) and the
    sidecar re-raises it as a typed error so the run aborts cleanly with an upgrade prompt.
  - **Expired stays distinguishable:** the plan sync preserves a lapsed trial's past
    `trialEndsAt` so "trial expired" reads apart from a cancelled paid plan / Free.
  - **Desktop locks by date too:** the cloud UI now locks the instant the trial expires
    (not only after sync), closing the window where buttons looked enabled but the server
    rejected the action.
  - **Notifications along the way:** new bell items for trial started (welcome), trial
    expired, and low cloud-actions — alongside the existing countdown — all routing to the
    upgrade flow. New on-brand `trialWelcomeEmail` (on workspace creation) and
    `trialExpiredEmail` (daily "just-ended" reminder window) reuse the existing email shell.
  - @gtmgrid/engine@1.1.0
  - @gtmgrid/observability@1.1.0

## 1.0.6

### Patch Changes

- @gtmgrid/engine@1.0.6
- @gtmgrid/observability@1.0.6

## 1.0.5

### Patch Changes

- @gtmgrid/engine@1.0.5
- @gtmgrid/observability@1.0.5

## 1.0.4

### Patch Changes

- @gtmgrid/engine@1.0.4
- @gtmgrid/observability@1.0.4

## 1.0.3

### Patch Changes

- @gtmgrid/engine@1.0.3
- @gtmgrid/observability@1.0.3

## 1.0.2

### Patch Changes

- @gtmgrid/engine@1.0.2
- @gtmgrid/observability@1.0.2

## 1.0.1

### Patch Changes

- @gtmgrid/engine@1.0.1
- @gtmgrid/observability@1.0.1

## 1.0.0

### Patch Changes

- @gtmgrid/engine@1.0.0
- @gtmgrid/observability@1.0.0

## 0.22.12

### Patch Changes

- 018b623: Make the `/start` onboarding command actually work, and drop `/help`. Previously
  both were forwarded to the agent CLI, which intercepted them as its OWN built-in
  slash commands ("Unknown command: /start", "/help isn't available"). GTM Grid now
  answers `/start` itself with a local onboarding tour and never forwards it to the
  CLI. The dead onboarding instructions are removed from the agent system preamble.
  - @gtmgrid/engine@0.22.12
  - @gtmgrid/observability@0.22.12

## 0.22.11

### Patch Changes

- fff9a21: Add `/help` and `/start` onboarding commands to the agent chat. New users get a
  short, friendly orientation — what GTM Grid is, how to get data in (create a table
  or import/drag a CSV), what the agent can do, and a few example prompts to try.
  Both appear in the `/` command menu.
  - @gtmgrid/engine@0.22.11
  - @gtmgrid/observability@0.22.11

## 0.22.10

### Patch Changes

- 6c1e498: Fix the GTM Grid table tools (`get_table`, `add_rows`, `run_function`,
  `list_providers`, …) never loading inside the agent panel on Windows.

  Root cause: the spawned coding-agent CLI (claude / codex / cursor) was told to
  launch gtmgrid's MCP server via an extensionless `#!/bin/bash` launcher script
  (`gtmgrid-mcp`). That script was only ever written on macOS/Linux, and even when
  present Windows cannot execute it — so the agent connected with **no** grid tools
  while the app otherwise looked healthy.

  Fix: spawn the bundled `node` binary directly with `mcp.mjs` as a script
  argument — the one launch shape every MCP client starts identically on macOS,
  Linux and Windows. The Rust shell now exports `GTMGRID_MCP_NODE` +
  `GTMGRID_MCP_SCRIPT` (both already de-verbatim'd), `mcpConfig` emits
  `command` + `args`, and the Codex `-c mcp_servers=…` TOML now escapes the
  backslashes in Windows paths (the old inline form produced invalid TOML on
  Windows). The unused bash launcher is no longer bundled.

  - @gtmgrid/engine@0.22.10
  - @gtmgrid/observability@0.22.10

## 0.22.9

### Patch Changes

- @gtmgrid/engine@0.22.9
- @gtmgrid/observability@0.22.9

## 0.22.8

### Patch Changes

- @gtmgrid/engine@0.22.8
- @gtmgrid/observability@0.22.8

## 0.22.7

### Patch Changes

- 6aec1d2: Discover the `claude` / `codex` / `cursor` CLIs on Windows. Agent detection was
  macOS/Linux-only: it located binaries via `$SHELL -lic "command -v"` (which threw
  on Windows, where there is no POSIX login shell), scanned only POSIX install dirs,
  and used bare binary names — so on Windows the agents always read as not installed.

  `packages/server/src/agent.ts` is now cross-platform:

  - **Install locations.** On Windows it scans the documented targets —
    `%USERPROFILE%\.local\bin` (native installers), `%APPDATA%\npm` (npm cmd-shims)
    and `%LOCALAPPDATA%\Microsoft\WinGet\Links` (winget) — and resolves on `PATH`
    via `where.exe`. The native-installer dir is frequently not on `PATH`, which is
    exactly why the previous lookup missed it.
  - **Executable names.** It tries `.exe → .cmd → .bat`, preferring the native
    `.exe` so the resolved binary is directly spawnable.
  - **`.cmd`/`.bat` shims.** Those cannot be launched by `spawn`/`execFile` without
    a shell (`EINVAL` since the CVE-2024-27980 Node patch); detection, version
    probing and every turn-run now route a shim through a shell, while a native
    `.exe` still spawns directly.
  - **Packaged-app polish.** `windowsHide` is set on every child process so no
    console window flashes, and the spawn `PATH` is built with the platform
    delimiter and the existing (case-insensitive) `Path` key.

  macOS/Linux discovery is byte-for-byte unchanged.

  - @gtmgrid/engine@0.22.7
  - @gtmgrid/observability@0.22.7

## 0.22.6

### Patch Changes

- @gtmgrid/engine@0.22.6
- @gtmgrid/observability@0.22.6

## 0.22.5

### Patch Changes

- 8ddbed1: Fix the Windows "Server not reachable" / engine-unreachable failure: connect the
  renderer to the sidecar over `127.0.0.1` instead of `localhost`.

  The sidecar binds IPv4 loopback only (`server.listen(8787, "127.0.0.1")`), but the
  renderer + cloud-run defaulted to `http://localhost:8787`. On Windows `localhost`
  resolves to `::1` (IPv6) first, so the WebView2 fetch hit `[::1]:8787` where nothing
  listens and the engine read as unreachable — even though the server was up and
  healthy. macOS resolves `localhost`→`127.0.0.1`, which is why this only bit Windows.
  Defaulting to `127.0.0.1` deterministically matches the bind on every platform.

  Also adds a `sidecar_listening` server-side event (over the posthog-node channel,
  the only desktop telemetry path that delivers from packaged builds) tagged with
  platform/arch, so sidecar boot-health is finally visible per-OS — confirming the
  engine actually starts on Windows rather than leaving that invisible.

- Updated dependencies [8ddbed1]
  - @gtmgrid/observability@0.22.5
  - @gtmgrid/engine@0.22.5

## 0.22.4

### Patch Changes

- @gtmgrid/engine@0.22.4
- @gtmgrid/observability@0.22.4

## 0.22.3

### Patch Changes

- @gtmgrid/engine@0.22.3
- @gtmgrid/observability@0.22.3

## 0.22.2

### Patch Changes

- @gtmgrid/engine@0.22.2
- @gtmgrid/observability@0.22.2

## 0.22.1

### Patch Changes

- 85890be: Agent turns are no longer killed mid-task during long (especially cloud) runs. The single fixed 5-minute wall-clock watchdog is replaced by two independent timeouts: an IDLE timeout (5 min, re-armed on every chunk the CLI streams on stdout **or** stderr) that fires only when a process is genuinely hung, and a CEILING backstop (60 min) for a child that streams forever. An actively-working turn never goes idle, so it runs to completion.
  - @gtmgrid/engine@0.22.1
  - @gtmgrid/observability@0.22.1

## 0.22.0

### Patch Changes

- @gtmgrid/engine@0.22.0
- @gtmgrid/observability@0.22.0

## 0.21.0

### Patch Changes

- Updated dependencies [ea53611]
  - @gtmgrid/engine@0.21.0
  - @gtmgrid/observability@0.21.0

## 0.20.1

### Patch Changes

- @gtmgrid/engine@0.20.1
- @gtmgrid/observability@0.20.1

## 0.20.0

### Patch Changes

- @gtmgrid/engine@0.20.0
- @gtmgrid/observability@0.20.0

## 0.19.1

### Patch Changes

- @gtmgrid/engine@0.19.1
- @gtmgrid/observability@0.19.1

## 0.19.0

### Patch Changes

- @gtmgrid/engine@0.19.0
- @gtmgrid/observability@0.19.0

## 0.18.0

### Patch Changes

- @gtmgrid/engine@0.18.0
- @gtmgrid/observability@0.18.0

## 0.17.4

### Patch Changes

- @gtmgrid/engine@0.17.4
- @gtmgrid/observability@0.17.4

## 0.17.3

### Patch Changes

- @gtmgrid/engine@0.17.3
- @gtmgrid/observability@0.17.3

## 0.17.2

### Patch Changes

- @gtmgrid/engine@0.17.2
- @gtmgrid/observability@0.17.2

## 0.17.1

### Patch Changes

- @gtmgrid/engine@0.17.1
- @gtmgrid/observability@0.17.1

## 0.17.0

### Minor Changes

- b2fbbee: Remove the "local" paradigm — Postgres is now the only source of truth.

  GTM Grid was built local-first: each project was a `better-sqlite3` `.db` file served by the desktop sidecar, with cloud (Postgres) as an optional team tier. That produced two parallel data worlds and pervasive local-vs-cloud branching. This change removes the local paradigm entirely:

  - **Single data path.** The execution engine is always cloud-store-backed (`new Engine(config, registry, { store, creds })`); the SQLite `GridStore` layers, the engine's grid tables, the desktop's local `DataGrid`/`inCloud` fork, and the sidecar's local grid CRUD routes are gone. Every grid table operation goes through Postgres via tRPC. The one-way local→cloud push/sync apparatus and the `@gtmgrid/cli` package are deleted.
  - **The sidecar stays as the execution host.** It still runs connector/AI/formula columns locally and keeps a small **secrets-only** local vault (encrypted connector/AI keys, extension manifests) — but it no longer owns grid data; it proxies grid I/O to the `apps/web` worker endpoints. A new `/api/cloud/preview-function` route powers "Try on N rows" against cloud data.
  - **Login required.** `VITE_API_URL` is now mandatory (the build fails fast without it); the cloud/auth layer is always on; the "Continue locally — no account" escape hatches are removed; signed-out users hit a hard auth gate. Self-hosting = run your own Postgres + `apps/web`.
  - **Optimistic UI on every mutation.** To keep the local-first _feel_, every cloud grid mutation now patches the React Query cache instantly and reconciles with the server. Inserts carry a client-supplied UUID so the optimistic id is the persisted id and the realtime self-echo converges idempotently instead of duplicating; failures roll back.

  Note: the sidecar's local Trigify "signals" routes were local-grid-backed and have been removed pending a cloud-backed replacement (recurring signal refresh already runs as an Inngest cloud job).

### Patch Changes

- Updated dependencies [b2fbbee]
  - @gtmgrid/engine@0.17.0
  - @gtmgrid/observability@0.17.0

## 0.16.2

### Patch Changes

- @gtmgrid/engine@0.16.2
- @gtmgrid/observability@0.16.2

## 0.16.1

### Patch Changes

- 9ce6189: Drive the Browse-all gallery's "featured" tools from a code-level constant (`FEATURED_TOOLS`) read by `/api/extensions`, instead of each manifest's persisted `featured` db flag. `seedExtensions()` upserts manifests on boot but never prunes rows whose manifest left disk, so checking out a feature branch seeded stray `featured: true` rows that lingered after switching back — making tools show as featured locally but not on prod. The featured set is now identical everywhere and can't drift with stale local db state; the dead `featured` manifest field is removed.
  - @gtmgrid/engine@0.16.1
  - @gtmgrid/observability@0.16.1

## 0.16.0

### Patch Changes

- Updated dependencies [735d94c]
  - @gtmgrid/observability@0.16.0
  - @gtmgrid/engine@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [f414614]
  - @gtmgrid/engine@0.15.0

## 0.14.0

### Patch Changes

- @gtmgrid/engine@0.14.0

## 0.13.0

### Patch Changes

- @gtmgrid/engine@0.13.0

## 0.12.0

### Patch Changes

- @gtmgrid/engine@0.12.0

## 0.11.1

### Patch Changes

- @gtmgrid/engine@0.11.1

## 0.11.0

### Patch Changes

- @gtmgrid/engine@0.11.0

## 0.10.0

### Patch Changes

- @gtmgrid/engine@0.10.0

## 0.9.24

### Patch Changes

- 5e85887: Add AskUserQuestion answer cards to the Agent panel for all providers.

  When an agent needs the user to choose between options (which AI model, cohort
  size, ambiguous intent), it can now pose a structured multiple-choice question
  and the bottom of the chat replaces the composer with selectable answer cards —
  pick with a click or hotkeys `1,2,3,4`, or choose "Other" to type a custom
  answer. Works across all three CLI providers (Claude / Codex / Hermes), reusing
  the existing permission-gate pattern.

  - **mcp**: new `ask_user_question` tool returning a non-blocking questions payload.
  - **server**: `questionEventFromToolResult` converts the payload into an `ask_user`
    SSE event, wired into the Claude, Codex, and Hermes bridges. Claude's _native_
    `AskUserQuestion` tool_use is intercepted directly (headless `-p` stubs the result
    and ends the turn), and HITL payloads are detected against the untruncated Hermes
    tool-result text so a larger question payload can't be clipped.
  - **desktop**: an `AskCards` component (step-through, hotkeys, multiSelect, "Other"
    free-text) replaces the composer while a question is pending; the answer resumes
    the session.
  - @gtmgrid/engine@0.9.24

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

- Updated dependencies [7c050a2]
  - @gtmgrid/engine@0.9.23

## 0.9.22

### Patch Changes

- @gtmgrid/engine@0.9.22

## 0.9.21

### Patch Changes

- @gtmgrid/engine@0.9.21

## 0.9.20

### Patch Changes

- 154ecb9: Fix the agent's "Auto" permission mode erroring on Claude. The composer's `auto`
  label was passed straight through as `claude --permission-mode auto`, which is not
  a valid Claude CLI value (`default | acceptEdits | bypassPermissions | plan`) — so
  selecting Auto could make the Claude turn fail. `auto` now maps to the valid
  `default`. (gtmgrid grid tools stay pre-approved via `--allowedTools` regardless,
  so this only governs Claude's own non-grid tools.)
- f464186: Make the 4 agent permission modes real and add enforced human-in-the-loop (HITL)
  approval, uniformly across all three providers (claude/codex/hermes).

  - **Modes are enforced at the MCP tool gate** (the one layer all providers share),
    driven by a per-tool risk class: `bypass` runs everything; `auto` asks for
    destructive ops and large/expensive runs; `acceptEdits` asks for every delete
    and every credit spend; `plan` blocks all mutations (reads still run). The
    composer mode is threaded to the MCP via env (`GTMGRID_PERMISSION_MODE`).
  - **Enforced approval (no model self-confirm):** a gated tool returns
    `confirmationRequired` and does NOT execute; it can only be unlocked by a HUMAN
    approval delivered through the MCP env (`GTMGRID_APPROVED_TOOL`/`_ARGS_HASH`) — a
    channel the model can't reach. The approval is hash-bound to the exact action
    the user saw and single-use, so the model setting `confirm:true` itself never
    bypasses a gate.
  - **HITL chat UX:** a new `permission_request` SSE event (emitted by all three
    bridges) drives an Approve/Deny card showing the action, affected count, credit
    estimate, and mode; Approve resends the turn carrying the approval. Plan mode is
    now actually enforced, not just suggested.
  - Default mode is now **Auto** (was bypass) so destructive ops and spends ask for a
    one-click approval out of the box. Claude's invalid `auto` flag is mapped to
    `default`.
  - @gtmgrid/engine@0.9.20

## 0.9.19

### Patch Changes

- f0d120b: Cloud agents can now reliably read, write, and POPULATE the table they name.
  Previously the cloud MCP ignored the `table` argument and pinned every tool to
  the single active table, so naming another table silently operated on the wrong
  one — and `add_rows` would throw, making agents stage data to `/tmp` instead of
  filling the grid.

  - Full multi-table addressing: the cloud source resolves a table name/id to the
    right cloud table (project-wide list, cached; defaults to the active table on
    the hot path) and threads it through every tool — `get_table`, `add_rows`,
    `run_column` (incl. its workspace/credential resolution), deletes, reorders, etc.
  - Cloud `get_table` reaches parity with local: paging (`limit`/`offset`), capped
    cell values (a huge enrichment blob no longer blows the response), `totalRows`/
    `truncated`, and per-column logic for diagnosis.
  - Cloud-aware agent preamble: tells the agent it's on a shared cloud project, that
    it can address any table by name, to populate via `add_rows` (no scratch files),
    to batch large inserts, and to stop on a quota error.
  - Worker errors surface the route's own message (e.g. the quota text, prefixed
    `[quota]`) instead of a raw `Worker route … failed: 402`; unknown-column errors
    now list the table's valid column names.
  - @gtmgrid/engine@0.9.19

## 0.9.18

### Patch Changes

- @gtmgrid/engine@0.9.18

## 0.9.17

### Patch Changes

- @gtmgrid/engine@0.9.17

## 0.9.16

### Patch Changes

- @gtmgrid/engine@0.9.16

## 0.9.15

### Patch Changes

- @gtmgrid/engine@0.9.15

## 0.9.14

### Patch Changes

- 7b8ad7d: Large agent-triggered column runs (>50 pending rows, after the user
  confirms) now start in the background on the persistent sidecar instead of
  running inside the agent turn — a run of hundreds of rows previously hit
  the 5-minute turn limit and was killed mid-way. The agent gets
  {started:true} immediately and polls progress; limit-scoped runs forward
  their row scope so a "run the next N" stays bounded.
- 7eda629: Agent grid mutation tools + chat UX: the agent can now rename tables,
  reorder columns/rows, run a whole table, and use the full mutation surface
  on CLOUD tables (member-gated worker routes, metered, with confirm-protocol
  dry-runs for destructive ops). Chat gains slash commands, /goal, permission
  modes (bypass/auto/accept-edits/plan), a plan drawer, per-agent threads, and
  table rename/reorder realtime events.
- Updated dependencies [c7bd3fc]
  - @gtmgrid/engine@0.9.14

## 0.9.13

### Patch Changes

- @gtmgrid/engine@0.9.13

## 0.9.12

### Patch Changes

- @gtmgrid/engine@0.9.12

## 0.9.11

### Patch Changes

- @gtmgrid/engine@0.9.11

## 0.9.10

### Patch Changes

- @gtmgrid/engine@0.9.10

## 0.9.9

### Patch Changes

- 67f3d44: Agent sessions can now use your saved provider keys, and webhook signature
  auth is opt-in:

  - Provider CLIs and skills the agent runs (trigify-cli, gh, …) authenticate
    automatically: saved credentials are injected as conventional env vars
    (`TRIGIFY_API_KEY`, `GITHUB_TOKEN`, …) at agent spawn — cloud workspace
    credentials in cloud mode, the local credential store in local mode. An
    explicitly exported env var still wins, and values never appear in args
    or logs.
  - Inbound webhooks no longer force HMAC signing: new webhooks accept
    unsigned posts (the unguessable token URL is the credential), with a
    "Require signed requests" toggle to opt in to `X-GTMGrid-Signature`
    verification. Existing webhooks keep their secrets and behave as before.
  - @gtmgrid/engine@0.9.9

## 0.9.8

### Patch Changes

- @gtmgrid/engine@0.9.8

## 0.9.7

### Patch Changes

- @gtmgrid/engine@0.9.7

## 0.9.6

### Patch Changes

- @gtmgrid/engine@0.9.6

## 0.9.5

### Patch Changes

- @gtmgrid/engine@0.9.5

## 0.9.4

### Patch Changes

- @gtmgrid/engine@0.9.4

## 0.9.3

### Patch Changes

- @gtmgrid/engine@0.9.3

## 0.9.2

### Patch Changes

- @gtmgrid/engine@0.9.2

## 0.9.1

### Patch Changes

- @gtmgrid/engine@0.9.1

## 0.9.0

### Patch Changes

- @gtmgrid/engine@0.9.0

## 0.8.0

### Patch Changes

- @gtmgrid/engine@0.8.0

## 0.7.8

### Patch Changes

- Updated dependencies [6ab6cf9]
  - @gtmgrid/engine@0.7.8

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

- Updated dependencies [c64cbf5]
  - @gtmgrid/engine@0.7.7

## 0.7.6

### Patch Changes

- 25938ea: Agent column runs now enrich rows in grid order. The `run_column` MCP tool gains
  optional `limit`/`offset` params that scope a run to the next N **unfilled** rows
  in the order the grid displays them (threaded into the engine's existing ordered
  `rowIds` scope). Previously the tool could only run _all_ pending rows, so when a
  user asked an agent to "run this column for 10 rows" the agent improvised and
  enriched a scattered, seemingly-random subset. The agent operating manual now
  directs the model to use `limit` for "run N rows" / "do the next N" requests.
  - @gtmgrid/engine@0.7.6

## 0.7.5

### Patch Changes

- @gtmgrid/engine@0.7.5

## 0.7.4

### Patch Changes

- @gtmgrid/engine@0.7.4

## 0.7.3

### Patch Changes

- @gtmgrid/engine@0.7.3

## 0.7.2

### Patch Changes

- @gtmgrid/engine@0.7.2

## 0.7.1

### Patch Changes

- @gtmgrid/engine@0.7.1

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

### Patch Changes

- Updated dependencies [accf1a9]
  - @gtmgrid/engine@0.7.0

## 0.6.1

### Patch Changes

- @gtmgrid/engine@0.6.1

## 0.6.0

### Patch Changes

- @gtmgrid/engine@0.6.0

## 0.5.1

### Patch Changes

- @gtmgrid/engine@0.5.1

## 0.5.0

### Patch Changes

- @gtmgrid/engine@0.5.0

## 0.4.0

### Patch Changes

- @gtmgrid/engine@0.4.0

## 0.3.18

### Patch Changes

- @gtmgrid/engine@0.3.18

## 0.3.17

### Patch Changes

- @gtmgrid/engine@0.3.17

## 0.3.16

### Patch Changes

- @gtmgrid/engine@0.3.16

## 0.3.15

### Patch Changes

- @gtmgrid/engine@0.3.15

## 0.3.14

### Patch Changes

- @gtmgrid/engine@0.3.14

## 0.3.13

### Patch Changes

- @gtmgrid/engine@0.3.13

## 0.3.12

### Patch Changes

- @gtmgrid/engine@0.3.12

## 0.3.11

### Patch Changes

- @gtmgrid/engine@0.3.11

## 0.3.10

### Patch Changes

- @gtmgrid/engine@0.3.10

## 0.3.9

### Patch Changes

- @gtmgrid/engine@0.3.9

## 0.3.8

### Patch Changes

- @gtmgrid/engine@0.3.8

## 0.3.7

### Patch Changes

- @gtmgrid/engine@0.3.7

## 0.3.6

### Patch Changes

- @gtmgrid/engine@0.3.6

## 0.3.5

### Patch Changes

- @gtmgrid/engine@0.3.5

## 0.3.4

### Patch Changes

- @gtmgrid/engine@0.3.4

## 0.3.3

### Patch Changes

- @gtmgrid/engine@0.3.3

## 0.3.2

### Patch Changes

- @gtmgrid/engine@0.3.2

## 0.3.1

### Patch Changes

- @gtmgrid/engine@0.3.1

## 0.3.0

### Patch Changes

- @gtmgrid/engine@0.3.0

## 0.2.0

### Patch Changes

- @gtmgrid/engine@0.2.0

## 0.1.0

### Patch Changes

- @gtmgrid/engine@0.1.0
