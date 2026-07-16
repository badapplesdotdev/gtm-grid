# Cross-table actions: `table.push` + `table.lookup`

Branch: `feat/table-actions` (worktree `~/dev/gtm-grid-table-actions`)

> **STATUS: IMPLEMENTED (2026-07-14).** Built against a later `main` than this plan
> was written for — by then the grid had become **cloud-only** (the sidecar keeps
> SQLite only as a credentials vault; every table lives in cloud Postgres behind
> `/api/worker/*`). That DELETED the plan's entire "local implementation" half
> (§3, the SQLite index migration, the realm-boundary edge cases): there is ONE
> gateway implementation, `cloudTableGateway` (engine `table-gateway.ts`,
> client/refs-injected like `store-cloud.ts`), wired into the sidecar cloud-run
> lane, the MCP cloud source, and the Inngest enricher. What shipped:
>
> - engine: `TableGateway` + `MethodContext.grid` + `connectors/table.ts`
>   (push/lookup), per-key upsert serialization, memoized schema/row reads.
> - worker routes: `listProjectTables`, `getTableSchema`, `getTableRows`,
>   `upsertRowInTable` (atomic, metered once/record), `createColumnInTable` —
>   all with server-side same-project scoping on `WebhookService`.
> - `autoRunTarget` via the `table/row.pushed` Inngest event →
>   `process-pushed-row.ts`, which SKIPS the target's own push columns (the
>   depth-1 loop guard). Previews get a read-only gateway (a push preview
>   refuses instead of writing).
> - desktop: "Tables" category + dedicated `TablePushForm` / `TableLookupForm`
>   editors in `ColumnEditPanel` (target/key/mapping pickers, auto-map by name),
>   wired in `cloud/CloudGrid.tsx`; MCP `add_column` teaches the agent to prefer
>   joining over new-table sprawl.
>
> **PUSH v2 (2026-07-16, after live user testing):** the sender-side mapping
> model was replaced with the WEBHOOK-STYLE receive model at the user's request:
> `table.push` now delivers the WHOLE source row through a **push connection**
> (a `webhooks` row with `source: "push"` + `sourceTableId`) on the target. The
> raw row lands in an auto-created "Pushed data" json column via the `$` mapping
> entry; the TARGET table's field mapping (edited in its Incoming data panel,
> paths = source column names, map to existing columns or create new ones)
> routes fields into columns, and **backfill** re-applies an edited mapping to
> rows already pushed (unmetered — a re-projection, not a re-ingest). Sender
> config shrank to target + mode + dedupe key + autoRunTarget + condition. The
> engine threads the current row to the connector via an AsyncLocalStorage row
> context (`ctx.row`), and the server reads the source row itself — no
> client-built mapping. Push-connection tokens are refused by `resolveToken`,
> so they are never reachable as public HTTP endpoints. The v1 sender-mapped
> routes (`upsertRowInTable`/`createColumnInTable`) remain as generic gateway
> ops but the connector no longer uses them.
>
> The sections below are the original design (kept for the edge-case catalogue —
> still accurate except where it says "local" or describes sender-side mapping).

## Goal

Two new built-in function columns that let one table interoperate with a sibling table
in the same project, so the AI (and users) can join/route data across tables instead of
creating a new table per step:

1. **Push to table** (`table.push`) — write the current row's mapped data into another
   table, upserting by a key column.
2. **Lookup table** (`table.lookup`) — find a row in another table by matching a value
   and return its columns into the current row.

Both are ordinary function columns: they appear in the Add Column browser, are
chainable with conditions (`only run if`), re-runnable, callable from code columns via
`sdk.table.push(...)`, and creatable by the agent via the existing MCP `add_column`
(`fn: "table.push"`). No new DB schema — all config lives in the column's `params`.

**Clay parity** (explicit target): `table.lookup` ≡ Clay's *Lookup Single Row in Other
Table* (match condition → returns the record; CellDetails drill-in/promote-to-column is
Clay's "add field as column" spread). `table.push` ≡ Clay's *Write to Other Table*
(field mapping + "don't write duplicates" dedupe key = our upsert key; append = the
allow-duplicates off-switch). Clay's third behaviour — the target table's columns
auto-run on newly written rows — is covered by the **`autoRunTarget` toggle** (§2a):
the cloud infra for it already exists in the webhook lane (`process-webhook-record`).

## Locked product decisions

- **Push semantics: upsert by key.** User picks a target key column; first run inserts,
  re-runs update the matched row. `mode: "append"` is an explicit opt-out.
- **Scope: local + cloud in one build.** Local SQLite path and cloud worker path ship
  together.
- **Surface: function columns only.** No row right-click action in v1.

---

## 1. The architectural gap

`ConnectorMethod.run(inputs, ctx)` receives `MethodContext = { secrets, ai, aiProviders,
guardSsrf }` — **no store handle**. Nothing today can reach a sibling table. The cloud
`GridStore` (`store-cloud.ts`) is *single-table scoped*, so it can't serve cross-table
reads either.

**Fix: a `TableGateway` injected into `MethodContext`.** A small cross-table surface with
one local implementation (over `Db`) and one cloud implementation (over new
`/api/worker/*` routes), mirroring how `GridStore` is injected today. Connector methods
that need it read `ctx.grid` and throw a clear error when it's absent (e.g. the Vercel
webhook-enrichment worker, where we deliberately don't wire it in v1).

```ts
// packages/engine/src/table-gateway.ts
export interface TableSchema {
  id: string;
  name: string;
  columns: { id: string; name: string; type: ColumnType; kind: ColumnKind }[];
}

export interface TableGateway {
  /** Sibling tables in the current project (id + name only). */
  listTables(): Promise<{ id: string; name: string }[]>;
  /** Resolve a table by id (preferred) or exact name; includes its columns. */
  getSchema(tableRef: string): Promise<TableSchema | undefined>;
  /** All rows of a table as { rowId, cells: { [columnName]: value } }. Memoized per run-ish window; invalidated by writes below. */
  readRows(tableId: string): Promise<{ rowId: string; cells: Record<string, unknown> }[]>;
  /**
   * Atomic find-or-insert by (keyColumnId, keyValue), then set the given cells
   * (values keyed by target column id, written status:"done"). keyColumnId null → append.
   * Serialized per (tableId, keyColumnId, keyValue) so concurrent rows can't double-insert.
   */
  upsertRow(input: {
    tableId: string;
    keyColumnId: string | null;
    keyValue: unknown;
    cells: Record<string, unknown>;
  }): Promise<{ rowId: string; created: boolean }>;
  /** Create a manual column on the target (auto-create-missing). Memoized/deduped per (tableId,name). */
  createColumn(tableId: string, name: string, type?: ColumnType): Promise<{ id: string }>;
}
```

`MethodContext` gains `grid?: TableGateway` (`types.ts`). `Engine.dispatch` and
`Engine.runBatch` pass `this.config.grid` (new optional `EngineConfig.grid`) into the ctx
— one-line changes in `execute.ts`.

### Consistency + concurrency inside the gateway

- **Schema memoization**: `getSchema`/`createColumn` cache per table and dedupe in-flight
  creates, so 5 concurrent rows auto-creating "Email" produce one column, not five.
- **Upsert serialization**: a per-`(tableId, keyColumnId, JSON(keyValue))` promise chain
  guarantees find-or-insert is race-free even at run concurrency 5. Local additionally
  wraps find+insert in one better-sqlite3 transaction; cloud does it server-side in one
  request (see §3).
- **Read snapshot for lookup**: `readRows` fetches once and caches; any `upsertRow`/
  `createColumn` against that table invalidates the cache. Within one run a lookup sees
  a consistent snapshot; across interleaved push→lookup on the same table it sees fresh
  data after invalidation.

---

## 2. The `table` connector (`packages/engine/src/connectors/table.ts`)

Registered in `defaultRegistry()` — automatically appears in the desktop function
browser, MCP `list_functions`/`search_functions`, and the sandbox `sdk` allow-list
(including condition expressions — intentional, same posture as other connectors).

### `table.push`

```jsonc
// inputSchema (all string values {{Column}}-templatable)
{
  "targetTable": "…",            // required — table id (UI stores id; MCP may pass name)
  "mode": "upsert" | "append",   // default "upsert"
  "keyColumn": "Email",           // target column NAME; required when mode=upsert
  "keyValue": "{{Email}}",        // required when mode=upsert
  "mapping": {                    // targetColumnName -> value/template
    "Email": "{{Email}}",
    "Company": "{{Company Name}}",
    "Score": "{{ICP Score}}"
  },
  "createMissingColumns": false,  // auto-create unmapped target columns as manual/text
  "autoRunTarget": false          // Clay-style: run the target's function columns on the pushed row
}
```

- `credits: 0`, `batchSize: 1`, `output: "json"`.
- Returns `{ table, rowId, action: "created" | "updated" }` — provenance lands in the
  cell, drillable via CellDetails, and usable by downstream conditions
  (`{{Push to CRM}}.action === "created"`).
- Behaviour:
  1. Resolve target schema (`getSchema`). Missing table → error
     `Target table not found — was it deleted?`.
  2. **Reject self-push** (`targetTable === source table_id`): pushing into the table
     being iterated mutates the row set mid-run and invites loops. Clear error.
  3. Resolve each mapping key to a target column. Function/formula target columns are
     **not writable** → error naming the column. Missing columns: `createMissingColumns`
     ? create (deduped) : error listing them.
  4. Upsert: empty/blank `keyValue` → cell error `Upsert key is empty for this row`
     (never a keyless insert in upsert mode — that's how silent duplicates happen).
  5. Write mapped values with status `done`. Target *function* columns are untouched
     unless `autoRunTarget` is on (§2a).

### 2a. `autoRunTarget` — Clay's "columns run on new rows"

When on, a push that **creates or updates** a target row triggers the target table's
function columns over just that row, dependency-ordered. This reuses machinery that
already exists for webhooks:

- **Cloud**: `apps/web/lib/inngest/functions/process-webhook-record.ts` already does
  exactly this — topo-sorts function columns via `@gtmgrid/services/columns`
  (`buildColumnDeps` + `topoSortColumnIds`), runs each in its own memoized Inngest step
  (`enrich:${recordId}:${columnId}`), quota-gated, workspace-concurrency-capped.
  Generalize: extract the enrich phase so a new `table/row.pushed` event (emitted by
  `upsertRowInTable` when `autoRunTarget`) drives the same handler body. The push's
  `recordId` analog is a hash of `(pushColumnId, sourceRowId)` — idempotent across
  Inngest retries, exactly like webhook records.
- **Local**: the gateway exposes `runTargetColumns(tableId, rowId)`; the sidecar wires
  it to `engine.runColumn(colId, { rowIds: [rowId] })` over the target's function
  columns, topo-sorted with the same `@gtmgrid/services/columns` helpers.

**Loop guard** (the reason v1 originally skipped this): when auto-running pushed rows,
**skip the target's own `table.push` columns** (provider `table`, method `push`).
Lookups are read-only and safe; only push columns can chain A→B→C→A. Skipping them
bounds cross-table auto-run to depth 1 — Clay behaves comparably (its writes don't
recursively trigger further writes-to-table by default). The skip is enforced in the
enrich column filter on both paths, not in UI copy.

> Engine detail: `table.push` needs the *raw source table id* to enforce the self-push
> guard. Cleanest: the engine adds `__sourceTableId` to dispatch ctx… instead, keep it
> simpler — `Engine.dispatch` already knows nothing of the column. We enforce self-push
> at **column-save time in the UI/MCP** and defensively in the method by comparing
> `targetTable` against an optional `ctx.sourceTableId` the engine threads through
> `MethodContext` (engine knows `col.table_id` in `runColumn`; plumb it into the
> dispatch it builds for that run — small change to make `dispatch` a factory
> `dispatchFor(tableId)` used by `runColumn`, keeping the public `dispatch` for
> MCP `run_function`, which has no source table and skips the guard).

### `table.lookup`

```jsonc
{
  "targetTable": "…",              // required (self-lookup allowed — snapshot makes it safe)
  "matchColumn": "Email",           // target column NAME
  "matchValue": "{{Email}}",        // required
  "return": ["Company", "Status"],  // [] / omitted = all columns
  "multiple": "first" | "all" | "count",  // default "first"
  "caseInsensitive": false,          // default false; trims + lowercases strings when true
  "notFound": "null" | "error"      // default "null"
}
```

- `credits: 0`, `batchSize: 1`, `output: "json"`.
- Match comparison: values are compared after canonicalising — strings trimmed;
  non-strings compared via `JSON.stringify` equality; `caseInsensitive` lowercases both
  sides when both are strings. `null`/empty `matchValue` → no match (never matches
  empty target cells by accident — an empty probe returns the `notFound` result).
- Returns:
  - `first`: `{ …returned columns }` object (keys are column *names*, so CellDetails
    drill-in + `promote to column` and `{{Lookup}}`-style formula access work), plus
    `_rowId` for provenance; or `null`/error per `notFound`.
  - `all`: array of those objects (existing array drill-in/mapping from the Array work
    applies).
  - `count`: number.
- Multiple matches with `first`: first by row position (stable, documented).

---

## 3. Local implementation (`packages/engine/src/table-gateway-local.ts`)

Backed by the project `Db` — inherently project-scoped (one .db per project).

- `listTables` → `db.listTables()`; `getSchema` → `db.resolveTable` + `db.listColumns`.
- `readRows` → `db.listRows` + `db.rowCells` mapped to names (memoized as above).
- `upsertRow` → inside one transaction:
  `SELECT row_id FROM cells WHERE column_id = ? AND value = ?` (probe is
  `JSON.stringify(keyValue)`, matching `setCell` encoding) → hit: `setCell` each mapped
  cell; miss: `createRow` + `setCell`s.
- **New migration** in `Db.migrate()`:
  `CREATE INDEX IF NOT EXISTS idx_cells_column_value ON cells(column_id, value)` so the
  key probe doesn't scan every cell of big tables. (Idempotent, additive, same pattern
  as the `condition` migration.)
- Exact-match caveat: the JSON-encoded probe means `42` ≠ `"42"`. Fallback: if the
  strict probe misses **and** the key value is a string/number, retry with the
  alternate encoding — cheap, and matches user expectations for CSV-imported numbers.

Wiring: wherever the sidecar builds the local `Engine` (`open-project.ts`), construct
`localTableGateway(db)` and set `engine.config.grid`. Same in the MCP server's local
mode (via `openProject`), so agent-driven `run_column`/`run_function` get it too.

## 4. Cloud implementation

### New worker routes (apps/web `/api/worker/*`, secret-gated like the rest)

Every route **validates the target table belongs to the same project (and workspace)
as the run's source table** — server-side, not just UI. Requests carry
`{ sourceTableId, targetTableId | targetTableName, … }`; the handler loads both tables
and rejects cross-project/cross-workspace with 403 before touching data.

1. `listProjectTables` — `{ sourceTableId }` → sibling `{ id, name }[]`
   (thin wrapper over existing `GridService.listTables(projectId)`).
2. `getTableSchema` — `{ sourceTableId, targetRef }` → `TableSchema`.
3. `getTableRows` — `{ sourceTableId, targetTableId }` → rows+cells (reuses the
   `getTable` grid shape; separate route so the same-project check is explicit).
4. `upsertRowInTable` — `{ sourceTableId, targetTableId, keyColumnId | null, keyValue,
   cells, autoRunTarget?, recordId? }` → `{ rowId, created }`. **Mostly exists**: this
   is a generalization of the webhook lane's `/api/worker/upsertRow` + `insertRow`
   (which are keyed by `webhookId`); factor the shared service logic
   (`CellRepo.findRowByCellValue` match + patch-or-insert, metered once per record) so
   both callers use one implementation, with this route adding the same-project check.
   When `autoRunTarget`, it emits the `table/row.pushed` Inngest event (§2a).
   **Metering**: once per record like the webhook path. Over quota → 402
   `CloudActionsLimitError` → surfaces as the cell's error, matching every other
   cloud-run quota failure.
5. `createColumnInTable` — `{ sourceTableId, targetTableId, name, type }` → `{ id }`,
   meters 1 action (parity with `createColumn`).

Services: add matching methods on `GridService`/`WebhookService` (Effect services,
typed errors per `docs/effect-conventions.md`), with repo-level tests for the
same-project rejection and metering.

### Cloud gateway (`packages/engine/src/table-gateway-cloud.ts`)

Same decoupling rule as `store-cloud.ts`: the engine file imports **no backend client**;
`cloud-run.ts` (packages/server) injects a thin fetch transport hitting the routes above
with the worker secret + `sourceTableId` baked in. Read snapshot memoization identical
to local. `cloud-run.ts` sets `engine.config.grid` next to where it builds the cloud
store today.

**Realm boundary**: a *local* table can only target *local* sibling tables; a *cloud*
table only cloud siblings in its project. No local↔cloud push in v1 (that's what the
existing cloud-push feature is for). The UI table picker only lists same-realm tables;
the gateway enforces it anyway.

---

## 5. Desktop UI (`packages/desktop/src`)

### Add Column browser (`AddColumn.tsx`)

- New **"Tables"** category in `CATEGORY_ORDER`/`categorize()` with the two functions
  (they arrive via the connectors list automatically once registered; category mapping
  keys off `provider === "table"`).
- Two dedicated detail panes (the generic schema-driven form would technically work but
  makes a bad experience for pickers):
  - **`PushToTableDetail`**: target-table dropdown (custom dropdown per the AI model
    picker pattern, listing `tables` minus the current one, same realm only) → on select,
    fetch `api.table(targetId)` for its columns → key-column select + mapping editor
    (one row per target manual column: name on the left, value input with the existing
    `{{Column}}` datalist on the right) → "Auto-map by name" button (pre-fills
    `{ Email: "{{Email}}" }` for case-insensitive name matches) → mode toggle
    (upsert/append) + `createMissingColumns` checkbox → shared `RunSettings` condition.
    Save → `api.addColumn(tableId, { name, fn: "table.push", params, condition })`.
  - **`LookupTableDetail`**: table dropdown (self allowed) → match-column select +
    match-value input (datalist) → returned-columns multi-select (default all) →
    first/all toggle, case-insensitive toggle, not-found behaviour → condition.
- **Column settings modal**: route `provider === "table"` columns to the same detail
  panes for editing (target table renamed/deleted since config → show a warning banner
  and force re-pick; params store the table *id*, display resolves the current name).
- Cell rendering: output is JSON — existing JSON cell + CellDetails drill-in already
  handle it; push cells read as `{"action":"created","rowId":"…"}`.

No new `api.ts` endpoints needed for the UI itself (`api.tables()` + `api.table(id)`
cover the pickers). Cloud tables' schemas come from the existing cloud table fetch used
by the cloud grid view.

### MCP / agent surface (`packages/mcp/src/index.ts`)

Zero structural change — `add_column` with `fn: "table.push"` + `params` already works
once the connector is registered. Do update:
- `add_column` description: document the two functions with a one-line example each, and
  the guidance *"prefer table.push / table.lookup over creating a new table per step"* —
  that sentence is the actual fix for the "gazillion tables" behaviour.
- `run_function`: works for `table.lookup` locally (gateway wired via `openProject`);
  `table.push` via `run_function` has no source table so the self-push guard is skipped
  (fine — there's no source to loop on).
- Cloud MCP mode: v1 leaves these two as `cloudUnsupported` for `run_function` (matching
  its existing cloud posture); `add_column`/`run_column` work because the cloud run lane
  carries the gateway.

---

## 6. Edge cases (consolidated)

**Configuration-time**
1. Target table deleted/renamed after column creation → params store the id; run errors
   with a human message; settings modal shows re-pick banner.
2. Mapped target column deleted → run errors naming it (or auto-creates when
   `createMissingColumns`).
3. Mapping into a target function/formula column → rejected at save and at run.
4. Self-push → rejected at save (UI/MCP) + defensively at run.
5. Source column referenced in a template deleted → existing interp collapses to `""`
   (same as every other column type); the empty-key guard then catches upserts.

**Run-time correctness**
6. Concurrent rows, same key value → gateway serializes per key; no double-insert
   (local: transaction; cloud: server-side atomic route).
7. Concurrent auto-create of the same missing column → deduped in-flight.
8. Empty/blank upsert key → cell error, never a keyless insert.
9. Type encoding mismatch (`42` vs `"42"`) → alternate-encoding fallback probe (local);
   cloud `findRowByCellValue` probes jsonb equivalently.
10. Force re-run of a push column → upsert makes it idempotent; append mode duplicates
    by design (documented in the UI copy under the mode toggle).
11. Rows added to the target *during* a run by the run itself → snapshot invalidation
    keeps subsequent lookups fresh; the run's own row set (source) is fixed at start —
    unchanged from today.
12. Lookup: no match → `null` (default) keeps chains alive; conditions can gate on it.
    Multi-match → `first` by position or `all` array.
13. Interleaved push+lookup on the same target within one run → cache invalidation on
    write; ordering across concurrent rows is inherently racy (same as any concurrent
    enrichment) — documented, not "fixed".

**Loops & cascades**
14. A pushes to B, B has a push column back to A → safe even with `autoRunTarget`:
    the auto-run enrich pass skips the target's own `table.push` columns (§2a), so
    cross-table cascades are bounded to depth 1. With the toggle off, pushed rows sit
    inert until the target's columns are run manually.
15. Condition expressions can call `sdk.table.lookup` (a gate that consults another
    table) — allowed, same posture as the existing "condition can dispatch" note in
    `execute.ts`.

**Cloud-specific**
16. Cross-project / cross-workspace target → 403 server-side regardless of client.
17. Quota (402) mid-run → that row's cell errors, run continues, same as other cloud
    quota failures; upsert idempotency makes the re-run after topping up safe.
18. Metering: push-insert = 1 action/row, push-update = per terminal cell write,
    lookup = free (reads unmetered today) — consistent with existing rules.
19. Big target tables in lookup: one `getTableRows` fetch per run per target (memoized),
    not per row. Very large targets (>10k rows) are acceptable v1; a server-side
    filtered lookup route is the marked follow-up if it bites.
20. Multiplayer: cloud target-table cells written via normal repo path → existing sync
    delivers them to other viewers. Local: target table refreshes on next open (the
    desktop already reloads on table switch); no live cross-table refresh in v1.

**Realm & provenance**
21. Local table → cloud target (or vice versa) → not offered in the picker, rejected by
    the gateway. The existing cloud-push feature remains the way to move a whole table.
22. Share-link import / table duplication of a table containing `table.*` columns →
    params carry a table id that doesn't exist in the destination project → the standard
    "target table not found" error at run; settings modal offers re-pick. (Share import
    already recreates function columns "with setup intact but empty" — same story.)
23. `simplify()` unwraps sole-`{text}` objects — push/lookup outputs never have that
    shape, no interference.

---

## 7. Work plan (order of implementation)

1. **Engine core** — `types.ts` (`MethodContext.grid`, `EngineConfig.grid`,
   `ctx.sourceTableId` threading), `table-gateway.ts` (interface),
   `table-gateway-local.ts`, `connectors/table.ts`, register in `registry.ts`,
   dispatch wiring in `execute.ts`, `db.ts` index migration.
   Tests: gateway races (concurrent upsert same key, dedup column create), push
   (upsert/append/empty key/self-push/missing table/missing column/function-column
   target/auto-create), lookup (no match/multi/case/typing), end-to-end `runColumn`
   over a real `Db` with two tables.
2. **Sidecar + MCP wiring** — `open-project` gateway construction; MCP description
   updates.
3. **Cloud** — worker routes (factoring `upsertRow`/`insertRow` service logic for the
   table-scoped variant) + `GridService`/`WebhookService` methods (same-project
   validation + metering, with tests), `table-gateway-cloud.ts`, `cloud-run.ts`
   injection, `table/row.pushed` Inngest event reusing the `process-webhook-record`
   enrich phase.
4. **Auto-run target** — local `runTargetColumns` wiring in the sidecar; push-column
   skip filter on both paths; tests for the A→B→A depth bound.
5. **Desktop UI** — Tables category, `PushToTableDetail`, `LookupTableDetail`
   (incl. the `autoRunTarget` toggle), settings-modal editing, mode-toggle copy for
   append duplicates.
6. **Polish** — agent-facing descriptions ("prefer joining over new tables"), docs.

Non-goals (v1): row right-click push action, cross-realm push, recursive cross-table
cascades (auto-run is depth-1 by design), server-side filtered lookup, live
cross-table UI refresh.
