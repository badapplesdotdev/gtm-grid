/**
 * The realtime grid change-event schema — the shared contract between the server
 * publisher (TRI-3251 `RealtimePublisher`) and the client cache-patch reducer
 * ({@link applyGridEvent}).
 *
 * These events are the live-reactivity transport that REPLACES the Convex
 * `useQuery(api.tables.getTable)` subscription (convex/tables.ts getTable,
 * consumed at desktop useCloudGrid.ts:165). After a successful grid write the
 * server broadcasts ONE typed event on the table's channel; every other client
 * subscribed to that table applies the event to its cached {@link GridSnapshot}
 * (the `getTable`-shaped cache) via the pure reducer, so the grid stays in sync
 * with NO refetch and NO Postgres-Changes/CDC.
 *
 * The shapes intentionally mirror the `getTable` projection in
 * `services/grid-service.ts` (`FullGrid`): Convex-style `_id` keys on columns and
 * rows, cells keyed by `rowId`/`columnId`. Keeping the event payloads aligned
 * with the snapshot means the reducer is a direct splice — no field translation.
 *
 * This module is PURE (types + constants only); it pulls in no Supabase, no DOM,
 * no Effect, so it is importable by the desktop (`@gtmgrid/services`) AND the web
 * client with zero runtime cost. The Supabase channel wiring lives separately in
 * `./channel.ts`.
 */

/** The Realtime Broadcast event name every grid change event is sent under. */
export const GRID_EVENT_NAME = "grid_change" as const;

/**
 * Reserved sentinel "table id" for the WORKSPACE-level realtime room
 * (`${workspaceId}:_workspace`). Used to broadcast tables-list changes (a table
 * created / synced / deleted) so members refresh their sidebar live without
 * having that table open. No real table is ever created with this id.
 */
export const WORKSPACE_ROOM_TABLE_ID = "_workspace" as const;

/** A column as it appears in the `getTable` snapshot (mirrors `FullGrid.columns`). */
export interface GridEventColumn {
  readonly _id: string;
  readonly name: string;
  readonly type: string;
  readonly kind: string;
  readonly provider: string | null;
  readonly method: string | null;
  /**
   * Which account on the provider (Slack team id); null/absent = the sole
   * account.
   *
   * Optional so a producer that predates the field still type-checks, and
   * because absent and null mean the same thing to the reducer — there is no
   * third state to distinguish.
   */
  readonly accountId?: string | null;
  readonly code: string | null;
  readonly params: unknown;
  readonly condition: string | null;
}

/** A row as it appears in the `getTable` snapshot (mirrors `FullGrid.rows`). */
export interface GridEventRow {
  readonly _id: string;
}

/** A cell as it appears in the `getTable` snapshot (mirrors `FullGrid.cells`). */
export interface GridEventCell {
  readonly rowId: string;
  readonly columnId: string;
  readonly value: unknown;
  readonly status: string;
  readonly error: string | null;
}

/** A cell was inserted or updated (setCell / setCellStatus). */
export interface CellUpsertEvent {
  readonly type: "cell.upsert";
  readonly cell: GridEventCell;
}

/** A row was added (addRow / each row of addRowsWithCells). */
export interface RowInsertEvent {
  readonly type: "row.insert";
  readonly row: GridEventRow;
  /** Cells created alongside the row (the bulk-import path); empty for addRow. */
  readonly cells: readonly GridEventCell[];
}

/** A row was deleted (its cells cascade out of the snapshot too). */
export interface RowDeleteEvent {
  readonly type: "row.delete";
  readonly rowId: string;
}

/** A column was added (addColumn). */
export interface ColumnInsertEvent {
  readonly type: "column.insert";
  readonly column: GridEventColumn;
}

/**
 * A column's definition changed (updateColumn): rename, type change, or a
 * function column's provider/method/code/params/condition. The payload is the
 * FULL updated column projection, so the reducer replaces it in place by `_id`
 * (cells are unaffected — only the column metadata changed).
 */
export interface ColumnUpdateEvent {
  readonly type: "column.update";
  readonly column: GridEventColumn;
}

/** A column was deleted (its cells cascade out of the snapshot too). */
export interface ColumnDeleteEvent {
  readonly type: "column.delete";
  readonly columnId: string;
}

/**
 * Columns were reordered (the agent's `reorder_columns` tool / a drag in the
 * grid). The payload is the FULL new column-id order so the reducer is a stable
 * splice independent of which column moved — idempotent under at-least-once /
 * out-of-order delivery (any id the snapshot doesn't hold is ignored; any column
 * the event omits is kept, appended after the listed ones in its prior order).
 */
export interface ColumnReorderEvent {
  readonly type: "column.reorder";
  readonly columnIds: readonly string[];
}

/** Rows were reordered (the agent's `reorder_rows` tool / a drag). Full new id order. */
export interface RowReorderEvent {
  readonly type: "row.reorder";
  readonly rowIds: readonly string[];
}

/**
 * A table was created in a project. Carried on the project's channel so a
 * member viewing the project's table list can react; it does NOT mutate a
 * `getTable` snapshot (a brand-new table has no rows/cells yet), so the reducer
 * passes it through unchanged.
 */
export interface TableInsertEvent {
  readonly type: "table.insert";
  readonly tableId: string;
  readonly projectId: string;
  readonly name: string;
}

/**
 * The table itself was deleted. The snapshot becomes `null` (matching the
 * desktop "table no longer exists" sentinel at useCloudGrid.ts).
 */
export interface TableDeleteEvent {
  readonly type: "table.delete";
  readonly tableId: string;
}

/**
 * A table was renamed. Carried on BOTH the table's own channel (so an open grid
 * patches its header live) and the workspace room (so a member's sidebar list
 * relabels without that table open). The reducer updates `table.name` in place
 * when the viewed snapshot is this table; cells/rows/columns are untouched.
 */
export interface TableRenameEvent {
  readonly type: "table.rename";
  readonly tableId: string;
  readonly name: string;
}

/**
 * A project's sidebar folders changed (folder created/renamed/deleted, or a
 * table moved between folders). Broadcast on the WORKSPACE room only — it does
 * not mutate any `getTable` snapshot (folders are list-organization metadata),
 * so the reducer passes it through; the sidebar refetches its folder/table
 * lists instead.
 */
export interface FoldersChangedEvent {
  readonly type: "folders.changed";
  readonly projectId: string;
}

/**
 * A table was pinned/unpinned (the workspace-shared favourite flag). Broadcast
 * on the WORKSPACE room so every member's sidebar restyles + reorders live. It
 * carries no `getTable` data, so the reducer passes it through; the sidebar
 * refetches its tables list.
 */
export interface TableFavoriteEvent {
  readonly type: "table.favorite";
  readonly tableId: string;
  readonly favorite: boolean;
}

/**
 * The discriminated union of every grid change the publisher emits and the
 * reducer applies. Discriminated on `type` so a `switch` is exhaustive.
 */
export type GridChangeEvent =
  | CellUpsertEvent
  | RowInsertEvent
  | RowDeleteEvent
  | RowReorderEvent
  | ColumnInsertEvent
  | ColumnUpdateEvent
  | ColumnDeleteEvent
  | ColumnReorderEvent
  | TableInsertEvent
  | TableDeleteEvent
  | TableRenameEvent
  | FoldersChangedEvent
  | TableFavoriteEvent;

/**
 * The `getTable`-shaped client cache the reducer patches. Identical in shape to
 * `FullGrid` (services/grid-service.ts) so W4 can store the tRPC `getTable`
 * result directly and feed it back through {@link applyGridEvent}.
 */
/** A table's row-dedup config in the `getTable` snapshot (null = off). */
export interface GridDedupe {
  readonly column: string;
  readonly keep: "oldest" | "newest";
}

export interface GridSnapshot {
  readonly table: {
    readonly _id: string;
    readonly name: string;
    readonly dedupe?: GridDedupe | null;
  };
  readonly columns: readonly GridEventColumn[];
  readonly rows: readonly GridEventRow[];
  readonly cells: readonly GridEventCell[];
}

/**
 * The channel name a workspace's table is published/subscribed on. One channel
 * PER workspace+table keeps the broadcast fan-out tight and lets the client
 * subscribe to exactly the table it is viewing. The workspace prefix scopes the
 * channel to the caller's workspace (the minted JWT authorizes the connection;
 * see `realtime.token`), so naming is `grid:{workspaceId}:{tableId}`.
 */
export const gridChannelName = (workspaceId: string, tableId: string): string =>
  `grid:${workspaceId}:${tableId}`;
