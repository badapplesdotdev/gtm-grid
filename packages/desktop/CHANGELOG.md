# @gtmgrid/desktop

## 0.19.0

### Minor Changes

- 4a710f2: feat(agent): replace the Hermes coding agent with Cursor (`cursor-agent`) as the third side-panel AI agent, alongside Claude and Codex. It drives the grid over MCP using your Cursor subscription (`cursor-agent login` once). Hermes is retained as an AI model provider for AI columns. The cloud member token cursor-agent needs is written to an owner-only (0600) MCP config that is deleted after each turn.

### Patch Changes

- f8125f0: fix(connectors): pass sibling field values to dependent dropdowns. A connector dropdown whose option source requires a parent field (e.g. a PlusVibe campaign list that needs `workspace_id`) now receives the in-progress sibling values from the column editor, so it loads instead of failing with a raw upstream 400. The injection is generic — keyed off each source method's own required schema — and surfaces a clear "Select <field> first" prompt when a required parent is still unset.
- dcaba83: perf(grid): make cloud column save/map feel instant. Saving or mapping a column no longer blocks on a full multi-page refetch (the optimistic patch + realtime echo already reflect it; reconcile happens in the background without an immediate refetch that could clobber a just-started run's cells), the Autumn usage flush is bounded to 2s so a slow billing call can't stall a grid write, and the edit rail / cell-details drawer close immediately. A column run now renders its unresolved cells as loading right away (done/error cells keep their result, so a re-run never flickers finished cells). A background save failure now surfaces in the grid's error banner instead of failing silently.
  - @gtmgrid/analytics@0.19.0
  - @gtmgrid/cloud@0.19.0
  - @gtmgrid/services@0.19.0

## 0.18.0

### Minor Changes

- 21b8437: feat(grid): column data cascade — running a column or cell now automatically runs every column that depends on it (via `{{Column}}` references), in dependency order, for the affected rows. A chain like _Get API data → map a field in a sibling → compute a value in the next sibling_ populates end-to-end from a single run, and independent siblings run in parallel. `Run all` / `Run selected rows` now execute in dependency order instead of authored order. Server-side enrichment matches: webhook-delivered and Signal-pulled rows are enriched in dependency order (Signal rows were previously not enriched at all).

  fix(engine): server-side enrichment could throw "cannot read property …" for any column that calls a connector (e.g. an email finder). A connector column runs `sdk[provider][method](...)` in the sandbox, but the cloud worker built its engine with only the built-in connectors. It now loads the workspace's installed connector manifests, so connector columns enrich correctly in webhook/Signal runs.

### Patch Changes

- @gtmgrid/analytics@0.18.0
- @gtmgrid/cloud@0.18.0
- @gtmgrid/services@0.18.0

## 0.17.4

### Patch Changes

- 431f761: perf(grid): revert the overscan escalation that was making large-grid scrolling worse. Benchmarking the real render cost (full DataGrid + CellContent) proved the paint-in blank is the cost of the cell COUNT per scroll step, not the cell content — so a bigger overscan buffer makes it worse, not better. The velocity-adaptive 8→100 expansion rendered ~3,100 cells in a single commit (~197ms) — the catastrophic blank in the bug report. Reverting to a small constant overscan renders only the ~680 cells entering view per fast-scroll step (~45ms, a 4.3× reduction) and eliminates the expansion spike entirely; normal/slow scrolling is now ~2.4ms.
  - @gtmgrid/analytics@0.17.4
  - @gtmgrid/cloud@0.17.4
  - @gtmgrid/services@0.17.4

## 0.17.3

### Patch Changes

- b5a0e7e: perf(grid): make the virtualization buffer velocity-adaptive so scrolling a large grid no longer paints rows/columns in. A flat overscan made scrolling worse because WebKit composites every windowed row on each scroll frame; instead the buffer now stays small at rest and during slow scrolling (cheap frames) and balloons to a large window only during a fast fling, where blank paint-in actually happens and the extra rows are imperceptible — then collapses back when scrolling settles. Rows window 8→100, columns 3→24 under fling.
  - @gtmgrid/analytics@0.17.3
  - @gtmgrid/cloud@0.17.3
  - @gtmgrid/services@0.17.3

## 0.17.2

### Patch Changes

- b29b00c: perf(grid): eliminate the paint-in flicker when scrolling a large grid and the laggy hover highlight. Raised the virtualization overscan buffer so ~one viewport of rows and columns is pre-rendered on each side — WebKit's momentum scroll no longer reaches the blank spacer before React commits the next rows, so rows/columns no longer visibly paint in as they scroll into view. The scroll container now matches the cell background so any momentary gap blends instead of flashing. Removed the cell background transition so the row-hover highlight tracks the cursor instantly instead of fading in over 80ms.
  - @gtmgrid/analytics@0.17.2
  - @gtmgrid/cloud@0.17.2
  - @gtmgrid/services@0.17.2

## 0.17.1

### Patch Changes

- f8cf334: perf(grid): memoize the data-grid row/cell tree so the existing row + column virtualization actually pays off. Extracted `React.memo` `GridRow`/`GridCell` from the inline render-prop and decoupled the rows from the controller via stable action/interaction bundles. Fast scrolling and single-cell edits no longer re-render the whole viewport, and the row-hover highlight tracks the cursor. Measured on a 2,000×40 table: an unrelated re-render goes from 25,000 cell renders to 0, a single cell edit from 25,000 to 1, and a scroll step from 250 to ~10 — 4.5–13× less render scripting per frame.
  - @gtmgrid/analytics@0.17.1
  - @gtmgrid/cloud@0.17.1
  - @gtmgrid/services@0.17.1

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
  - @gtmgrid/services@0.17.0
  - @gtmgrid/analytics@0.17.0
  - @gtmgrid/cloud@0.17.0

## 0.16.2

### Patch Changes

- Updated dependencies [c297b2a]
  - @gtmgrid/services@0.16.2
  - @gtmgrid/analytics@0.16.2
  - @gtmgrid/cloud@0.16.2

## 0.16.1

### Patch Changes

- 9ce6189: Track the active cloud table in the agent co-pilot's system-prompt context. Previously the "Active table" hint was derived only from local SQLite `tableData`, so in cloud mode the agent stayed stuck reasoning about a stale table while its MCP tools (keyed off `GTMGRID_CLOUD_TABLE`) operated on the correct one. `activeTable` now sources from the active cloud table via `useCloudTablePaged` when in cloud mode (sharing CloudGrid's paged query key, so no extra fetch), falling back to `tableData` locally.
- 9ce6189: Re-enable in-app HTML5 drag-and-drop (drag tables into sidebar folders, CSV file-drop import). Tauri's webview intercepts OS-level drag-drop by default (`dragDropEnabled`), which swallowed all HTML5 `dragover`/`drop` events inside the app. The app uses only HTML5 DnD with no Tauri-native drop handlers, so disabling Tauri's interception safely restores folder filing for local and cloud tables plus CSV drop import.
- Updated dependencies [a9ba3ac]
  - @gtmgrid/services@0.16.1
  - @gtmgrid/analytics@0.16.1
  - @gtmgrid/cloud@0.16.1

## 0.16.0

### Patch Changes

- Updated dependencies [735d94c]
  - @gtmgrid/services@0.16.0
  - @gtmgrid/analytics@0.16.0
  - @gtmgrid/cloud@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [f414614]
  - @gtmgrid/services@0.15.0
  - @gtmgrid/analytics@0.15.0
  - @gtmgrid/cloud@0.15.0

## 0.14.0

### Minor Changes

- 651e34b: Cloud tables now support rename and pin-to-favourites in the sidebar, matching local tables. Renames persist via a new `grid.renameTable` mutation and broadcast `table.rename` so every member's sidebar and the open grid relabel live. Favourites are workspace-shared (a `favorite` column on the table row): any member's pin is visible to the whole workspace, sorts favourites to the top, and broadcasts `table.favorite` so sidebars restyle and reorder in real time.

### Patch Changes

- @gtmgrid/analytics@0.14.0
- @gtmgrid/cloud@0.14.0
- @gtmgrid/services@0.14.0

## 0.13.0

### Minor Changes

- 21230d3: Rework update notifications. App-update alerts now live in a dedicated download button next to the notification bell (animated when an update is available, with a "Download version X" tooltip) instead of the notification center. On launch with a pending update, an upgrade dialog offers to download & restart; choosing "Later" keeps it behind the download button. After installing a new version, a "What's new" changelog dialog is shown on first launch.

### Patch Changes

- @gtmgrid/analytics@0.13.0
- @gtmgrid/cloud@0.13.0
- @gtmgrid/services@0.13.0

## 0.12.0

### Minor Changes

- 4f0cede: Add drag-to-resize to the agent panel, matching the app sidebar. Drag the panel's left edge to set its width (clamped 320–720px); the width persists across launches and keeps the plan drawer aligned.

### Patch Changes

- @gtmgrid/analytics@0.12.0
- @gtmgrid/cloud@0.12.0
- @gtmgrid/services@0.12.0

## 0.11.1

### Patch Changes

- 2fdb753: Make the column edit panel keyboard-accessible: convert it from an inline side rail to a shadcn Sheet, so it closes on Escape and traps focus while open (matching the cell-details drawer).
  - @gtmgrid/analytics@0.11.1
  - @gtmgrid/cloud@0.11.1
  - @gtmgrid/services@0.11.1

## 0.11.0

### Minor Changes

- 6d2bc93: Clay-style column UX

  - Reworked column authoring/editing into a dedicated `ColumnEditPanel` (identity, edit rail, run menus) replacing the old column-settings modal.
  - Mouse range cell-selection in the grid (click-drag to select a rectangle, shift-click to extend) with selection-aware right-click menu and copy.
  - Per-cell run metadata (ran-at / run duration) surfaced in the cell-details drawer, plus a "waiting for inputs" cell state for columns with unmet input mappings.
  - Connector manifest + extensions refresh (per-method categories) and engine run-metadata plumbing.

### Patch Changes

- @gtmgrid/analytics@0.11.0
- @gtmgrid/cloud@0.11.0
- @gtmgrid/services@0.11.0

## 0.10.0

### Minor Changes

- 898ab3e: Full keyboard accessibility for the desktop app

  - Spreadsheet-style grid navigation: arrow keys, Home/End, Cmd/Ctrl+Arrow, PageUp/PageDown, roving tabindex, `role="grid"` + ARIA indices, with scroll-into-view that survives row/column virtualization.
  - Type-to-edit (any character), Enter/F2 to edit, Escape to cancel, with focus returning to the cell; Space / Shift+Arrow / Cmd+A for row selection.
  - Migrated every overlay to shadcn/Radix Dialog/Popover/Sheet primitives, so dialogs, popovers and drawers all close on Escape, trap focus, and restore focus to their trigger.
  - Command palette (Cmd/Ctrl+K) for jumping to tables and common actions.
  - Skip-to-content link and keyboard-focusable sidebar navigation (table rows, section/folder headers, provider/tool rows) with a global focus-visible ring.

### Patch Changes

- @gtmgrid/analytics@0.10.0
- @gtmgrid/cloud@0.10.0
- @gtmgrid/services@0.10.0

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
  - @gtmgrid/cloud@0.9.24
  - @gtmgrid/services@0.9.24

## 0.9.23

### Patch Changes

- @gtmgrid/cloud@0.9.23
- @gtmgrid/services@0.9.23

## 0.9.22

### Patch Changes

- d2a41c5: Fix the Tables page showing duplicate tables and no row counts for cloud tables.

  - **Row counts**: `grid.listTables` now attaches each table's row count from a
    single grouped `countByTableIds` query (the efficient primitive existed but was
    never wired in; the in-memory repo was also missing it — a latent type error).
    The Tables page and sidebar now show real cloud row counts ("124 rows") instead
    of "Cloud table"/"—"; a table whose count an older server doesn't report falls
    back gracefully.
  - **Duplicates**: removed the sidebar "Recent" group, which repeated the 5 most-
    recent tables already shown in the full list below it. The Tables page already
    de-dupes by name.
  - The sidebar table rows now show a row count (hidden on hover, like folders).

- Updated dependencies [d2a41c5]
  - @gtmgrid/services@0.9.22
  - @gtmgrid/cloud@0.9.22

## 0.9.21

### Patch Changes

- 8e16910: Rebuild the Tables page as a full management hub matching the GTM Grid Tables
  design: a header with title + table-count subtitle, a controls row with search,
  status-filter chips (All / Favorites / Synced / Local only, each with a count), a
  sort dropdown (recently added / name / row count), and a list/grid view toggle.
  The list view shows each table with a checkbox, accent table icon, name + favorite
  star + column/row meta, row count, and a sync pill; the card view mirrors it.
  Multi-select reveals a bulk-action bar with an inline-confirm delete, and each row
  has a favorite toggle and an actions menu (open / rename / delete). Styled with the
  app's tokens (the design's green accent), reusing the existing open/rename/delete/
  favorite handlers.
- 2e48ab4: Add a Tables page for searching and managing tables, mirroring the connectors
  gallery. Reachable via "Browse all" in the sidebar's Tables section, it shows
  every table as a card (column/row counts for local tables, a cloud badge for
  cloud ones), with search and inline actions — open, favorite, rename (local), and
  delete (local + cloud) — reusing the existing table handlers and confirm dialogs.
  The sidebar also gains a compact "Recent" group of the 5 most-recent tables (shown
  once there are more than 5) for quick access.
  - @gtmgrid/cloud@0.9.21
  - @gtmgrid/services@0.9.21

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
  - @gtmgrid/cloud@0.9.20
  - @gtmgrid/services@0.9.20

## 0.9.19

### Patch Changes

- @gtmgrid/cloud@0.9.19
- @gtmgrid/services@0.9.19

## 0.9.18

### Patch Changes

- @gtmgrid/cloud@0.9.18
- @gtmgrid/services@0.9.18

## 0.9.17

### Patch Changes

- 8b29845: Render the agent chat with Streamdown so assistant replies get proper markdown
  — GFM tables, lists, code fences and inline formatting — streamed safely as
  incomplete tokens arrive (replacing the hand-rolled renderer). Typography is
  scoped to the copilot panel so headings stay small and bold rather than
  prose-sized. Tool calls now interleave with text in the order the agent emits
  them, instead of bunching every tool call above the reply.
  - @gtmgrid/cloud@0.9.17
  - @gtmgrid/services@0.9.17

## 0.9.16

### Patch Changes

- 9f01681: Fix "undefined is not an object (evaluating 'snapshot.columns')" when
  deleting a column (or row) on a cloud table: the optimistic cache patch fed
  react-query's `undefined` (no cached unpaged snapshot — the normal state
  while the grid loads paged) into the grid reducer, which only guarded
  `null`. The reducer now tolerates both, and the optimistic path skips absent
  cache entries entirely.
- Updated dependencies [9f01681]
  - @gtmgrid/services@0.9.16
  - @gtmgrid/cloud@0.9.16

## 0.9.15

### Patch Changes

- Updated dependencies [be203b9]
  - @gtmgrid/services@0.9.15
  - @gtmgrid/cloud@0.9.15

## 0.9.14

### Patch Changes

- 7eda629: Agent grid mutation tools + chat UX: the agent can now rename tables,
  reorder columns/rows, run a whole table, and use the full mutation surface
  on CLOUD tables (member-gated worker routes, metered, with confirm-protocol
  dry-runs for destructive ops). Chat gains slash commands, /goal, permission
  modes (bypass/auto/accept-edits/plan), a plan drawer, per-agent threads, and
  table rename/reorder realtime events.
- 0cbab23: Cascade auto-run: when a column runs (or a cell is edited), dependent mapped
  columns now auto-populate — free columns (formulas and no-provider code)
  always cascade; billed enrichment columns cascade only when Auto-run is on.
  Cycles are guarded (each column runs at most once per cascade).
- c7bd3fc: Async-job connectors (e.g. Firecrawl extract) now block-poll until the job
  completes — with a wall-clock timeout and typed fail states — instead of
  returning a job id the grid can't use. Cells whose value carries an `error`
  field render an honest red error pill (with the real status code when one
  exists) instead of a fabricated "Status Code: 200".
- f5851bc: Run selected rows + export to CSV: row checkboxes with shift-click range
  select, a "Run N selected" action (dependency-aware, non-force — done cells
  aren't re-billed), context-menu actions on the selection, and a CSV export
  of mapped scalar values (RFC-4180, UTF-8 BOM for Excel, and spreadsheet
  formula-injection neutralized with the OWASP apostrophe guard).
- 17ea929: Sidebar folders for tables, on both local and cloud projects: create, rename,
  and delete folders, file tables into them ("New table here" included), and
  drag to reorder. Deleting a folder unfiles its tables (never deletes them).
  Folder changes broadcast on the workspace room so teammates' sidebars update
  live. Cloud adds a `folders` table + `tables.folder_id` (migration 0009);
  local SQLite upgrades in place.
- Updated dependencies [7eda629]
- Updated dependencies [17ea929]
  - @gtmgrid/services@0.9.14
  - @gtmgrid/cloud@0.9.14

## 0.9.13

### Patch Changes

- 891e3b8: Agent presence (Co-Pilot cursor): the in-app AI agent now appears in cloud
  tables like a teammate. As it reads or writes — get_table, run_column,
  update_cells, add_rows — the grid shows "<Your name>'s Agent" in the avatar
  stack (bot glyph, brand-accent ring), rings the cell or column it's working
  on, and labels the activity ("reading the table", "updating 2 cells",
  "running Email"). Visible to everyone in the table's room, clears when the
  turn ends. Works against the already-deployed realtime party.
- Updated dependencies [891e3b8]
  - @gtmgrid/services@0.9.13
  - @gtmgrid/cloud@0.9.13

## 0.9.12

### Patch Changes

- fee2724: Fix the cell-details (field mapping) drawer in dark mode: the panel kept a
  hardcoded light backdrop while its title, pills, and footer used dark-theme
  colors — making the title invisible and the panel clash with the app. The
  drawer now uses theme tokens throughout, and the number/boolean type glyphs
  brighten on dark for contrast.
- Updated dependencies [9bf183f]
  - @gtmgrid/services@0.9.12
  - @gtmgrid/cloud@0.9.12

## 0.9.11

### Patch Changes

- 2ddf117: Clay-style webhook tables: every webhook now lands records in a dedicated
  "Webhook" column, so received data is always visible — even on a table with
  no other columns and no field mappings. Cells render as "Received <date>";
  clicking opens the payload in the cell-details panel, where each field has
  an "Add to column" action that promotes it to a real column applied to all
  existing and future rows. Re-enabling an existing webhook heals it with the
  new column. Mapping replaces never drop the raw-payload entry.
- Updated dependencies [2ddf117]
  - @gtmgrid/services@0.9.11
  - @gtmgrid/cloud@0.9.11

## 0.9.10

### Patch Changes

- @gtmgrid/cloud@0.9.10
- @gtmgrid/services@0.9.10

## 0.9.9

### Patch Changes

- Updated dependencies [67f3d44]
  - @gtmgrid/services@0.9.9
  - @gtmgrid/cloud@0.9.9

## 0.9.8

### Patch Changes

- Updated dependencies [3cbb8b2]
  - @gtmgrid/services@0.9.8
  - @gtmgrid/cloud@0.9.8

## 0.9.7

### Patch Changes

- b49517c: Fix cloud Trigify signal tables staying empty, end to end:

  - The prod Inngest app sync was rejected ("A concurrency key must be specified
    for Account scoped limits"), leaving every background function — including the
    hourly signal poll — unregistered. Account-scoped concurrency caps now carry
    the required key, so the cron actually runs.
  - A fresh Trigify search takes ~10–30s to return results, but the create-time
    pull stamped the binding as synced, deferring the next pull by the full
    schedule (a daily binding sat empty for 24h). A new durable warm-up retries
    the pull until first data lands (~15–60s, like local), and still-empty
    bindings stay due for the hourly cron as a safety net.
  - The cloud grid now shows a signal status strip (waiting / rows pulled / last
    synced / errors) with a "Sync now" button — previously an empty signal table
    gave no visibility or recourse.
  - @gtmgrid/cloud@0.9.7
  - @gtmgrid/services@0.9.7

## 0.9.6

### Patch Changes

- ba86bc8: Fix two cloud credential/connector issues so cloud behaves like local:

  - The cloud agent (spawned MCP) only loaded the built-in connectors
    (ai/formatting/formula/github/http), so it reported extension connectors like
    Trigify and Apollo as "not available" — diverging from a local project. The
    cloud agent now loads the SAME JSON-manifest extensions from the global db that
    `openProject` loads locally, so every connector is available to
    `list_functions` / `run_column` in cloud mode (credentials resolve via the
    shared workspace key).
  - After saving a shared Cloud connector key, the Cloud tab kept showing "No X
    credentials yet" until app restart because the save path didn't refresh the
    credential listing. It now refreshes immediately, flipping the panel to
    "connected".
  - @gtmgrid/cloud@0.9.6
  - @gtmgrid/services@0.9.6

## 0.9.5

### Patch Changes

- b1fed4b: Add "Use my local key" — one-click copy of a connector/AI provider's local API
  key up to the shared Cloud (workspace) key. Shown in each connector's Cloud tab
  when a local key exists. Security-first: the sidecar decrypts the local key
  in-process and forwards the plaintext to the cloud over TLS authenticated as the
  signed-in member; the plaintext never enters the renderer, is never logged, and is
  never returned in the response. The cloud save encrypts at rest and is
  member-gated (only a workspace member can write the shared key).
  - @gtmgrid/cloud@0.9.5
  - @gtmgrid/services@0.9.5

## 0.9.4

### Patch Changes

- 296e4cd: Fix: the agent (and the UI cloud column run) failed on cloud tables in a packaged
  prod build with `WEBHOOK_WORKER_SECRET is not configured`. The desktop sidecar and
  the MCP it spawns authenticated to the cloud `/api/worker/*` endpoints with the
  shared worker secret, which a prod build does not ship (it is a server-only
  secret) — so it only ever worked in dev. The worker routes the desktop calls
  (getTable / getTableMeta / setCell / setCellStatus / setCells / getCredential /
  assertColumnRunQuota, plus the create/list tools) now authenticate as the
  signed-in MEMBER via the session token and enforce workspace membership
  server-side (a non-member is rejected). The shared secret remains the boundary for
  the headless inngest webhook worker only. This makes the agent run/create columns
  and the UI run columns on cloud tables in prod, and the agent-derived column logic
  persists and is re-runnable.
  - @gtmgrid/cloud@0.9.4
  - @gtmgrid/services@0.9.4

## 0.9.3

### Patch Changes

- e476861: Fix: running a function/code column on a cloud table that was synced from local did
  nothing — it flicked to "running" and immediately exited without computing. A
  local→cloud synced table arrives with every cell marked `done`, and a non-forced
  run skips `done` cells, so there was nothing left to run. An explicit column Run in
  the cloud now force-recomputes the column (per-cell run already forced), so Run
  actually executes the logic over the synced data.
  - @gtmgrid/cloud@0.9.3
  - @gtmgrid/services@0.9.3

## 0.9.2

### Patch Changes

- a1756d5: You can now click a cell in a **cloud** table to view its full response (the
  status-code / JSON fields), just like local tables. The cloud grid was never
  wiring the cell-details drawer or the expanded editor, so synced responses
  (e.g. "Status Code: 200") weren't inspectable even though the data was present.
  The drawer is view-only in the cloud for now (no promote-field-to-column yet).
  - @gtmgrid/cloud@0.9.2
  - @gtmgrid/services@0.9.2

## 0.9.1

### Patch Changes

- 5882678: Show the full-screen branded loader on launch while a signed-in user's cloud
  workspace loads, instead of flashing the local app and then switching to cloud.
  The loader holds until the cloud project is open, with a short minimum display
  window so an instant (warm-cache) load still reads as an intentional splash
  rather than a flicker, and a safety timeout so it can never get stuck.
  - @gtmgrid/cloud@0.9.1
  - @gtmgrid/services@0.9.1

## 0.9.0

### Minor Changes

- a6d488d: Two cloud-parity improvements:

  - **Live sidebar** — when a teammate creates, syncs, or deletes a table in your
    workspace, your sidebar table list now updates in real time (no app restart).
    Table create/delete events are broadcast on a per-workspace realtime room that
    the sidebar subscribes to.
  - **Deduplication on cloud tables** — the Dedupe control (previously local-only)
    now works on cloud tables: pick a column and keep-oldest/newest, and the server
    removes duplicate rows and broadcasts the deletions live to everyone viewing the
    table. Adds a nullable `dedupe_column` / `dedupe_keep` to the cloud `tables`
    schema (migration included).

### Patch Changes

- ae68646: Cloud grid niceties:

  - **You now appear in the presence avatar stack** (labeled "you"), so you can see
    at a glance that you're connected — even when you're the only one in the table.
    Your own selected cell is still left un-ringed; only teammates' cells get a
    presence cursor.
  - **The app version is shown** at the bottom of the account menu ("GTM Grid
    vX.Y.Z"), so it's easy to tell which build you're on.
  - **Cloud data refreshes when you return to the app** — queries now refetch on
    window focus (gated by a 30s stale time), so tables, integration keys, and other
    changes made elsewhere or by teammates show up without restarting the app.

- Updated dependencies [a6d488d]
  - @gtmgrid/services@0.9.0
  - @gtmgrid/cloud@0.9.0

## 0.8.0

### Minor Changes

- c3eb12d: Add live multiplayer presence to the cloud grid. You can now see who else is in a
  table in real time:

  - **Live users avatar stack** in the grid toolbar — everyone currently viewing the
    table, with their profile photo (or initials), capped at 5 with a **"+N more"**
    overflow. Hover an avatar to see the member's name.
  - **Cell cursors** — each other member's selected cell gets a colored ring and a
    small avatar chip (Airtable-style), so you can see where teammates are working.
  - **Editing indicator** — a member actively editing a cell shows a pulsing ring.
  - **Follow a teammate** — click their avatar to jump the grid to their current cell.

  Presence rides the existing per-table PartyKit channel (no extra connection) and
  each member's name/photo come from the workspace (the `me`/`listMembers` APIs now
  expose the user's avatar image). Built on shadcn/ui avatar + tooltip primitives.

### Patch Changes

- Updated dependencies [c3eb12d]
  - @gtmgrid/services@0.8.0
  - @gtmgrid/cloud@0.8.0

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

  - @gtmgrid/cloud@0.7.8
  - @gtmgrid/services@0.7.8

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
  - @gtmgrid/cloud@0.7.7
  - @gtmgrid/services@0.7.7

## 0.7.6

### Patch Changes

- @gtmgrid/cloud@0.7.6
- @gtmgrid/services@0.7.6

## 0.7.5

### Patch Changes

- ef7c5da: Fix the macOS DMG upload on the self-hosted runner by adding Homebrew's bin to
  PATH so `gh` is found (the runner's service PATH is minimal). The DMG already
  builds + signs + notarizes + staples correctly; only the upload step failed with
  `gh: command not found`.
  - @gtmgrid/cloud@0.7.5
  - @gtmgrid/services@0.7.5

## 0.7.4

### Patch Changes

- c13f497: Package the macOS DMG without Finder so it builds on the self-hosted runner.
  Tauri's bundle_dmg.sh drives Finder via AppleScript (times out headless), so the
  macOS build now produces the signed+notarized .app (+ updater) and a later step
  wraps it in a DMG via hdiutil, then signs + notarizes + staples the DMG.
  - @gtmgrid/cloud@0.7.4
  - @gtmgrid/services@0.7.4

## 0.7.3

### Patch Changes

- bb5aef3: Fix macOS signing on the self-hosted runner: delete the leftover `signing_temp`
  keychain before importing the Developer ID cert. The Mac mini persists state
  between runs (and between the two macOS jobs of one run), so the lingering
  keychain made `import-codesign-certs` fail with `security` exit code 48.
  - @gtmgrid/cloud@0.7.3
  - @gtmgrid/services@0.7.3

## 0.7.2

### Patch Changes

- 6be1500: Build macOS releases on a self-hosted Apple-silicon runner.

  The two macOS targets now build on the self-hosted Mac mini (runs-on:
  [self-hosted, macOS]) instead of GitHub-hosted macOS runners, so the lengthy
  Apple notarization waits no longer consume GitHub-hosted macOS minutes. Linux
  and Windows continue to build on GitHub-hosted runners. No change to the shipped
  app.

  - @gtmgrid/cloud@0.7.2
  - @gtmgrid/services@0.7.2

## 0.7.1

### Patch Changes

- 4127808: Sign + notarize the macOS app so downloads open without a Gatekeeper warning.

  The release now signs the app with a Developer ID Application certificate and
  notarizes it via the App Store Connect API. The bundled Node sidecar (`node`
  runtime + `better-sqlite3` native addon) is codesigned under the Hardened
  Runtime with JIT/library-validation entitlements so it runs in a notarized
  build. Signing is driven by repository secrets (`APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_ISSUER`,
  `APPLE_API_KEY_ID`, `APPLE_API_KEY_P8`); releases still build unsigned when they
  are absent.

  - @gtmgrid/cloud@0.7.1
  - @gtmgrid/services@0.7.1

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

- @gtmgrid/cloud@0.7.0
- @gtmgrid/services@0.7.0

## 0.6.1

### Patch Changes

- dcb9297: Fix cloud grid not reflecting column/row deletes and column edits.

  The live grid renders the PAGED query (`grid.getTablePage`), but the cloud
  mutations either didn't refetch or invalidated only the unpaged `grid.getTable`
  cache — so deleting a column/row or editing a column left the change invisible
  (and a re-delete surfaced a scary "Column … not found") whenever the realtime
  broadcast was unconfigured or dropped.

  - `deleteColumn` / `deleteRow` now optimistically drop the column/row from the
    cache for instant feedback, then invalidate both the paged and unpaged grid
    queries to reconcile with the server.
  - `updateColumn` (edit column) now invalidates the table's grid queries so the
    edit reflects without relying on the realtime `column.update` event.
  - A "… not found" delete is treated as already-done (no error banner) — the
    refetch drops the stale row/column.
  - @gtmgrid/cloud@0.6.1
  - @gtmgrid/services@0.6.1

## 0.6.0

### Minor Changes

- ee40d02: One shared grid for local & cloud, with clear local/cloud separation.

  - **One grid, no divergence** — the local grid and the cloud grid now render the
    same `DataGrid` component, driven by an injected controller. Cloud no longer
    silently deletes a column on header right-click and no longer has a
    stripped-down add-column; it gets the identical header context menu
    (Edit / Delete), the full add-column popover (manual types + AI / function /
    formula), add-row, and run.
  - **Clear local/cloud separation** — the sidebar shows ONE environment's tables:
    only cloud tables in a cloud project, only local tables in local mode. This
    removes the dual-selection bug where a cloud and a local table were both
    highlighted at once. The sync affordances (sync-all, per-row dots, auto-sync
    toggle/nudge, auto-push) now appear only in local mode while signed into cloud.
  - **Cloud column editing (parity)** — new `grid.updateColumn` tRPC procedure
    (`GridService.updateColumn` → `ColumnRepo.update`) broadcasts a `column.update`
    realtime event so a rename / type / function-config change reflects live across
    clients with no refetch. The shared edit-column modal now persists in cloud.
  - **Cloud AI/formula authoring** — the cloud add-column flow reuses the local
    sidecar's AI providers + formula generation (which is what runs cloud columns),
    so function / AI / formula columns can be authored in cloud too.

### Patch Changes

- Updated dependencies [ee40d02]
  - @gtmgrid/services@0.6.0
  - @gtmgrid/cloud@0.6.0

## 0.5.1

### Patch Changes

- a06b5aa: Sync UX feedback fixes (TRI-3313 + TRI-3314).

  - **One unified table list** — the separate "Tables (cloud)" and "Tables" sidebar sections are merged into a single list with per-table cloud-sync status icons and a single selection (no more one-local-plus-one-cloud dual selection leaving the grid bound to the wrong table).
  - **Local tables viewable from cloud env** — selecting a local table while in a cloud project now renders it (and its sync options) instead of a dead panel.
  - **Push works from the local env** — pushing a local table to your cloud workspace no longer fails with "not found" when triggered outside the cloud project context.
  - **Environment switcher in the account menu** — the bottom account bar now shows the current environment (cloud project / local) with one-click "Switch to cloud/local" and "Switch project".
  - **Popover fixes** — the notification popover and the sync popover are no longer clipped by the sidebar; the push button is always fully visible.
  - @gtmgrid/cloud@0.5.1
  - @gtmgrid/services@0.5.1

## 0.5.0

### Minor Changes

- 71da2f3: Formula columns + conditional-run ("only run if"). **Formula columns** evaluate a JavaScript expression per row with Lodash (`_`), Moment (`moment`), and Excel/Sheets functions via FormulaJS (`VLOOKUP`, `IF`, `SUM`, …), referencing other columns with `{{Column}}`; helper libs are injected into the QuickJS sandbox on-demand so plain formulas stay fast, and `{{Column}}` compiles to typed input refs (not string interpolation). **Conditional-run** adds a per-column boolean expression that gates whether an enrichment runs for a row, so credits aren't spent when the condition is false. Both are generatable from natural language by the connected coding agent, with full parity across desktop, the MCP agents, and the cloud (Postgres) path.
- 71da2f3: Hermes integration (Nous Research Hermes). Adds a **Hermes** coding-agent tab alongside Claude/Codex that drives the grid locally over ACP (Agent Client Protocol) with the gtmgrid MCP tools mounted in — so the grid and its tools never leave the machine. Also exposes Hermes as an OpenAI-compatible **AI provider**, so `ai.generate` columns can run against a Hermes gateway (each cell gets the agent's full memory/context). The Hermes agent process is spawned detached and torn down via the shared process-group cleanup (no orphaned subprocess leak), with a max-run timeout.

### Patch Changes

- @gtmgrid/cloud@0.5.0
- @gtmgrid/services@0.5.0

## 0.4.0

### Minor Changes

- 396127a: Cloud table sync, agent environment routing, notification center, plus agent + security hardening.

  - **Sync local tables to your cloud workspace**: per-table status dots, a sync popover (push / progress / overwrite-confirm), a "Sync all" control, and an opt-in **auto-sync** setting (default off) with an enable-time overwrite warning and a dismissible nudge. One-way push (local is the source of truth); re-sync is **atomic** (create-new-then-swap) so a failed push never destroys the cloud copy, and every overwrite is explicitly confirmed.
  - **Agents on the right environment**: in cloud mode the in-app Claude/Codex agents' table tools read _and_ write the cloud (Supabase) project instead of the local SQLite one (new worker routes back the write tools, gated by membership + cloud-actions quota).
  - **Notification center**: a bell with an unread badge consolidates the trial / auto-sync / update alerts — no more stacked full-width banners.
  - **Reliability**: agent CLI process trees are reliably terminated on turn end (fixes a multi-GB memory leak), and agent turns no longer abort on unrelated re-renders.
  - **Security hardening**: every sidecar route is gated on a loopback Host + allowed Origin; SSRF protection blocks server-side connector calls to private hosts; and the QuickJS sandbox enforces the connector allow-list inside the host bridge.

### Patch Changes

- 27669e6: Harden cloud table sync state. Sync/link status now hydrates from the sidecar (new `GET /api/cloud/tables/links`, behind the loopback-Host/allowed-Origin gate) as the source of truth instead of a localStorage mirror, so a synced table can't show "Local only" from a stale/drifted cache. And an open cloud table whose id was deleted by a re-sync swap now self-heals — it falls back to the table's current linked cloud id instead of getting stuck on "This cloud table no longer exists".
  - @gtmgrid/cloud@0.4.0
  - @gtmgrid/services@0.4.0

## 0.3.18

### Patch Changes

- a0d2514: Performance & scale hardening, Tier 3 + cleanups. Column virtualization (visible columns × rows only) for very wide tables; desktop bundle code-split (lazy-loaded panels) to shrink first load; dedupe the bulk-insert chunk() helper into one shared util with a regression test bound to the real Drizzle path; recordDelivery prunes in a single set-based DELETE; cell runs force only the targeted cell (no re-billing unchanged cells); and lint is now warning-free.
  - @gtmgrid/cloud@0.3.18
  - @gtmgrid/services@0.3.18

## 0.3.17

### Patch Changes

- 203c18e: Performance & scale hardening, Tier 2. Server: retry/backoff + timeout on connector and worker HTTP (429/Retry-After aware, 402 fatal); pre-run credit/quota gate so an over-quota column run is rejected up front instead of over-metering; signals cron now filters due bindings in SQL with keyset pagination + chunked fan-out, bulk-inserts results, and dedupes via a durable signal_seen_keys table (no more >1000 re-insert); per-column Inngest step keys so a retry never re-charges completed columns; honor connector batchSize (one call per batch); cached worker Effect runtime + a process-wide sidecar concurrency semaphore with a clamped run concurrency. Device: run-all now runs independent columns concurrently (dependency-ordered).
  - @gtmgrid/cloud@0.3.17
  - @gtmgrid/services@0.3.17

## 0.3.16

### Patch Changes

- 3a9f459: Performance & scale hardening for thousands of rows + enrichments (perf epic, Tier 0 + Tier 1). Server: cap the Supavisor pool, add a global Inngest concurrency cap, chunk bulk cell/row inserts (fixes the 65535-param crash on wide CSV), collapse the per-cell cloud write to <=2 queries + batch worker writes with backpressure, make CSV import a single atomic transaction, replace the webhook upsert full-table scan with an indexed lookup, add a metadata-only table fast path, and paginate getTable cell reads. Device: virtualize the local + cloud grids, coalesce realtime events with an O(1) keyed reducer + incremental view, memoize cells and stop the full-table refetch on every edit, stream local-run progress per cell, and bound client memory to loaded pages.
  - @gtmgrid/cloud@0.3.16
  - @gtmgrid/services@0.3.16

## 0.3.15

### Patch Changes

- 85d5772: Fix "Server not reachable" after an in-app update. The auto-update relaunch left
  the previous local engine sidecar running (orphaned, holding the port), so the
  updated app's UI talked to a stale older sidecar missing newer routes and
  reported the server as offline. The sidecar now self-terminates when its parent
  app exits, retries binding the port during the relaunch handoff, and the app
  gates its connection state on the health check alone.
  - @gtmgrid/cloud@0.3.15
  - @gtmgrid/services@0.3.15

## 0.3.14

### Patch Changes

- 2f7da8b: Agent panel now shows past conversations again — read from each CLI's own native
  transcript store (Claude Code project sessions, Codex rollouts for the current
  project) instead of a local copy. Opening one loads its messages and resumes the
  CLI's native session for full context. Replaces the previous localStorage history.
  - @gtmgrid/cloud@0.3.14
  - @gtmgrid/services@0.3.14

## 0.3.13

### Patch Changes

- f469e03: Tools & agent follow-ups: add Firecrawl (scraping) and Supabase (Management API)
  connectors with manifests + agent playbooks; restyle the agent composer (model
  picker popover, send/stop icon); persist the per-agent model selection across
  relaunches; cap each sidebar section (Tools/Skills/Functions) at 10 with a
  "+ N more" reveal; and rebuild the marketing homepage (apps/web). Past agent
  conversations now rely on each CLI's own native transcript store (resume via the
  native session id) rather than a local copy.
  - @gtmgrid/cloud@0.3.13
  - @gtmgrid/services@0.3.13

## 0.3.12

### Patch Changes

- b0d17b5: Tools & Skills + Social Signals. Extensions are now "Tools", each shipping an
  agent playbook (`*.skill.md`) that's auto-loaded for connected tools so the agent
  stops guessing endpoints; adds a Skills sidebar, gallery, and custom-skill editor,
  plus HubSpot + Attio connectors. New "From Social Signals" table source backed by
  Trigify saved searches — local (one-time pull) and cloud (paid: hourly Inngest
  poller into a bound cloud table, entitlement-gated, with the Trigify key as a
  workspace credential).
  - @gtmgrid/cloud@0.3.12
  - @gtmgrid/services@0.3.12

## 0.3.11

### Patch Changes

- 6156e3e: Release pipeline reliability: serialize the per-platform desktop builds so every
  release ships binaries + an auto-updater entry for all platforms. The concurrent
  build matrix raced on the shared GitHub release (asset uploads + `latest.json`
  read-modify-write), which intermittently dropped the macOS-Intel and Windows
  artifacts from a release while all jobs still reported success (e.g. v0.3.10).
  This re-cut delivers a complete all-platform build.
  - @gtmgrid/cloud@0.3.11
  - @gtmgrid/services@0.3.11

## 0.3.10

### Patch Changes

- 5c89f92: Auto-updater now re-checks for new releases while the app stays open, instead of
  only at launch. It polls every 2 hours and re-checks when the window regains
  focus (throttled to once per 15 minutes), so a long-running app surfaces the
  update banner without needing a manual restart. Polling stops once an update is
  found.
  - @gtmgrid/cloud@0.3.10
  - @gtmgrid/services@0.3.10

## 0.3.9

### Patch Changes

- c627d4b: Fix deleted cloud tables lingering in the sidebar. `deleteTable` fired the
  mutation but never invalidated the tables-list query, so the removed table stayed
  visible until a manual refresh. It now invalidates the loaded tables lists and
  drops the deleted table's own cached query.
  - @gtmgrid/cloud@0.3.9
  - @gtmgrid/services@0.3.9

## 0.3.8

### Patch Changes

- dbe3bc7: Fix extension and AI-provider config panels not opening when a cloud workspace
  is selected. They were gated behind `!inCloud`, so the cloud grid always owned
  the main area and clicking a connector did nothing — and the shared "Workspace"
  credential scope (cloud key-sharing) was unreachable. The panels now render in
  both local and cloud workspaces, and the view returns to the grid on any
  cloud-table select/create.
- Updated dependencies [7f41587]
  - @gtmgrid/cloud@0.3.8
  - @gtmgrid/services@0.3.8

## 0.3.7

### Patch Changes

- 3ec43e5: In-app update notifications: the desktop app checks the latest GitHub release on
  launch + window focus and, when a newer version is available, shows an "update
  available" banner linking to the download page. Tauri-only; version comparison is
  a pure, unit-tested helper. (First increment of the update system — the
  download-and-install-in-app step via the Tauri updater plugin is a follow-up that
  needs an updater signing keypair.)
- 2fe6521: Full in-app auto-updater (Tauri `plugin-updater`). The desktop app checks for a
  newer SIGNED release on launch and offers "Update & restart" — it downloads,
  installs, and relaunches in-app (no manual re-download). Updates are verified
  against a public key baked into the app, signed in CI with `TAURI_SIGNING_PRIVATE_KEY`;
  the release publishes `latest.json` + per-bundle signatures. macOS + Windows are
  auto-updatable; Linux `.deb` updates via apt as before (no banner there).
  - @gtmgrid/cloud@0.3.7
  - @gtmgrid/services@0.3.7

## 0.3.6

### Patch Changes

- 3ee732b: A signed-in cloud workspace now always operates in cloud mode — it never falls
  back to the local engine (which silently saved tables to disk instead of the
  cloud). When the active cloud workspace has no cloud project yet, the app
  auto-creates a default cloud project so `inCloud` is true: the local-tables
  section + local "New table" stay hidden and all tables go to the cloud. Skipped
  when the workspace's cloud access is locked (lapsed trial).
- 8513552: Fix + polish the team-invite acceptance flow:

  - **Not-authed invites now guide sign-up.** A `gtmgrid://invite/<token>` deep link
    (or `?invite=` URL) is captured into a pending-invite store; while signed out it
    FORCES the sign-in/sign-up flow even if the user previously chose "continue
    locally", so an invitee is always routed to create an account and is then
    auto-enrolled. Previously the app opened in local state and never prompted.
  - **Celebrate on join** — accepting an invite (banner or new-signup auto-enrol)
    fires confetti + a confirmation dialog and refreshes app state (plan, badge,
    cloud tables) so everything is immediately in sync.

- 7d93c78: Simplify onboarding to Workspace → Team. The Plan-selection and AI-key steps are
  removed from the flow (every new workspace is auto-enrolled in the Team trial on
  creation, and the AI key can be added later); both screens are kept in code but
  unreachable. After onboarding finishes, app state is refreshed (react-query
  invalidate + Autumn plan sync) so the plan/badge/cloud tables are immediately in
  sync. Also: the root `typecheck` script now runs `apps/web`'s typecheck (it was
  skipped, which let a web-only type error merge + break the Vercel build).
- 6480d95: Refactor: read the launch invite token via lazy `useState` init instead of a
  mount `useEffect` in PendingInvites — fewer effects, more declarative.
  - @gtmgrid/cloud@0.3.6
  - @gtmgrid/services@0.3.6

## 0.3.5

### Patch Changes

- b0d6cce: Confirm the new price before an invite that adds a billable seat. New
  `billing.previewSeatChange` (backed by `AutumnClient.previewSeatChange` →
  Autumn `previewUpdate`, reading the recurring next-cycle total) returns the
  projected `{ seats, total, currency }` for the workspace's current members + 1.
  The desktop's Workspace settings invite flow now shows an "Add a seat?"
  confirmation with the new monthly price; the invite only sends on confirm.

  Also fixes the apps/web build for the trial-reminders Inngest job (the
  `send-trial-reminders` function used the wrong `createFunction` arity and apps/web
  was missing the `@gtmgrid/email` dependency — neither is caught by the root
  `tsc -b`, only by `apps/web`'s own typecheck / the Vercel build).

- 1628165: Proactively prompt users to upgrade before the 7-day trial hard-locks the cloud:

  - **In-app countdown banner**: a new `workspaces.trialEndsAt` column is synced from
    Autumn (`getActiveSubscriptions`) by `syncPlan` and seeded on trial start; `me`
    surfaces it, and the desktop shows a "Your trial ends in N days — upgrade" banner
    (escalating in the last 2 days) with the Autumn checkout CTA.
  - **Email reminders**: a daily Inngest job (`send-trial-reminders`) scans trials via
    `WorkspaceRepo.findTrialsEndingBetween` using two disjoint one-day windows
    (~2 days left, last day) so each milestone emails the owner exactly once (no
    reminder-stage column), and sends the new `trialEndingEmail` via Resend. No-op
    when email is unconfigured.

  Verified end-to-end against local Postgres + dev Autumn: trialEndsAt seeded on
  create, reconciled by syncPlan from Autumn, surfaced in me, and found by the scan.

- Updated dependencies [b0d6cce]
- Updated dependencies [1628165]
- Updated dependencies [17c88ae]
  - @gtmgrid/services@0.3.5
  - @gtmgrid/cloud@0.3.5

## 0.3.4

### Patch Changes

- 63629aa: New-signup onboarding: auto-enrol every new workspace in a 7-day, no-card **Team
  free trial** so owners can invite teammates from day one (least-friction), and
  auto-enrol invited users instead of prompting them to create their own workspace.

  - `createWorkspace` now starts a Team trial in Autumn (`SeatsService.startTrial` →
    `attach` with `customize.freeTrial` (7 days, `cardRequired: false`) + a prepaid
    seat grant, since the Team plan's seats are prepaid). Best-effort: a billing
    hiccup never blocks workspace creation. When the trial lapses with no card, the
    workspace returns to Free and inviting then requires an upgrade.
  - The plan badge reflects the trial (trialing subscriptions count as active in
    `getActivePlanIds`).
  - Desktop: a fresh signup with a pending (email-matched) invite is auto-enrolled
    into that workspace instead of being shown the create-workspace wizard; accepting
    an invite now also refetches `me` so the joined workspace appears immediately.

  Verified end-to-end against the dev Autumn sandbox + local Postgres (trial attach,
  seat availability, plan sync, invite-during-trial, and invite→signup→auto-enrol).

  Also gates the cloud tier on entitlement: when the trial lapses (no card) the
  workspace falls back to Free and cloud tables/projects, realtime and shared
  credentials LOCK (server-enforced via `EntitlementService.requireCloudAccess` on
  the grid service + a `cloudWorkspaceProcedure`). The desktop shows cloud tables as
  locked with an "Upgrade to unlock cloud" prompt (reusing the Autumn checkout);
  listing stays available so names render, and local tables are unaffected.

- Updated dependencies [63629aa]
  - @gtmgrid/cloud@0.3.4
  - @gtmgrid/services@0.3.4

## 0.3.3

### Patch Changes

- d8affce: Fix two cloud-state staleness bugs:

  - **Sign-up via the sidebar left the app "signed out".** The `me` query (user +
    workspaces + plan) was cached as `null` while signed out and never refetched
    when a bearer token appeared, so the UI stayed unauthenticated after an in-app
    sign-up/sign-in. React-query is now invalidated whenever the Better Auth session
    identity changes, so `me` refetches and the app reflects the new session.

  - **Plan upgrades weren't reflected.** `me` read the plan from a cached
    `currentPlanId` column that was NEVER written — so the plan was stuck at "Free"
    even after an in-app checkout or a manual upgrade in Autumn. Added
    `BillingService.syncPlan` / `billing.syncPlan` which reconciles the cached plan
    with the live Autumn subscription (writing `currentPlanId` back), and the desktop
    calls it on app load, on window focus, and when the billing panel opens. `me`
    also now refetches on window focus so external changes surface without a restart.

- c5a0d49: Fix blank screen on local-only builds with no cloud env vars. `App` always calls
  react-query hooks (`useMe`, etc.), but `CloudProvider` only mounted the
  `QueryClientProvider` when `VITE_API_URL` was set — so a no-env build threw
  "No QueryClient set" during render and white-screened the whole app (the exact
  state OSS users hit). The provider is now mounted unconditionally (it makes zero
  network calls in local mode), and a top-level error boundary keeps the window
  non-blank if any future render error occurs.
- Updated dependencies [d8affce]
  - @gtmgrid/services@0.3.3
  - @gtmgrid/cloud@0.3.3

## 0.3.2

### Patch Changes

- 7e1df59: Ship Linux as `.deb` only (the AppImage bundler's upstream `linuxdeploy` download
  returns persistent 504s and failed the release), and ad-hoc sign the macOS app
  (`bundle.macOS.signingIdentity: "-"`) so first launch shows the recoverable
  "unidentified developer" prompt instead of the "app is damaged" block. The
  `/download` page now lists the `.deb` for Linux and shows a macOS first-launch note.
  - @gtmgrid/cloud@0.3.2
  - @gtmgrid/services@0.3.2

## 0.3.1

### Patch Changes

- 7c4631b: Fix desktop cloud sign-in and make local use free + unauthed.

  - **Local-first gate:** the cloud build no longer hard-blocks the app behind sign-in. The welcome screen now offers **"Continue locally — no account"** → use the app fully offline (local SQLite engine, your tables/runs) with no cloud features. Signing in (via the account bar) unlocks cloud workspaces, sync & realtime at any time.
  - **Cloud auth fix:** the packaged Tauri app calls the apps/web API cross-origin (`tauri://localhost`), which was blocked by missing CORS and broken third-party cookies ("Couldn't create your account"). Add CORS for the desktop origins, switch the desktop session to Better Auth **Bearer tokens** (persisted + replayed on auth/tRPC/sidecar calls), and trust the desktop origins.
  - @gtmgrid/cloud@0.3.1
  - @gtmgrid/services@0.3.1

## 0.3.0

### Minor Changes

- b4b82c3: Migrate the cloud tier off Convex to Supabase Postgres + Drizzle + Better Auth + tRPC, with server-gated PartyKit realtime (multiplayer). The desktop app now talks to the tRPC API + Better Auth instead of Convex; the local-first SQLite engine is unchanged. Also adds a platform-aware download experience to the marketing site.

### Patch Changes

- @gtmgrid/cloud@0.3.0
- @gtmgrid/services@0.3.0

## 0.2.0

### Minor Changes

- 6158796: Build Windows and macOS Intel installers on release. Windows builds natively
  (the Rust sidecar spawn + bundler are now node.exe-aware and skip unix-only PATH
  probing); macOS Intel is cross-compiled on the Apple-silicon runner with an
  arch-aware sidecar (x64 node + x64 better-sqlite3). Releases now cover macOS
  arm64, macOS Intel, Linux, and Windows.

### Patch Changes

- @gtmgrid/cloud@0.2.0

## 0.1.0

### Minor Changes

- ec7ff47: Add CI (typecheck, lint via oxlint, and tests) and a semantic-versioning release
  pipeline (changesets) that builds downloadable cross-platform desktop binaries
  (macOS arm64 + Intel, Linux) on each release.

### Patch Changes

- @gtmgrid/cloud@0.1.0
