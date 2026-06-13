# @gtmgrid/mcp

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

- d7bbddb: Enable `run_function` for agents on cloud projects. It previously errored with
  "not available on a cloud project" because there was no worker dispatch route;
  now the cloud source resolves the workspace's shared connector credentials
  through the existing worker `getCredential` path (the same machinery cloud
  `run_column` already uses) and dispatches the connector in-process — so cloud
  agents can source data (searches, enrichment) exactly as local agents do, with
  no new backend route. `upload_extension` remains the only cloud-unsupported
  tool. (`get_table`/`describe_column` were already fixed by the #96 full-column
  projection; if still seen stripped in prod, redeploy the `apps/web` worker.)
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
