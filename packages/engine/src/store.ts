/**
 * GridStore — the async storage abstraction the execution engine runs against.
 *
 * `Engine.dispatch` + `runColumn` drive every read/write the run path needs
 * through this Effect service rather than a concrete store: a tagged type, typed
 * errors, and a `Layer`.
 *
 * This follows the canonical Effect pattern in `sample-service.ts`:
 *   - errors are `Data.TaggedError` values in the Effect error channel,
 *   - the service is a `Context.Tag`, and
 *   - a `Layer` provides a concrete implementation.
 *
 * The engine is always cloud-store-backed: the cloud store (`store-cloud.ts`)
 * is the `Layer` for this tag.
 */

import { Context, Data, Effect } from "effect";
import type { Cell, CellStatus, Column, Credential, Row } from "./types.js";

/**
 * Raised when an underlying store operation fails (SQLite throw, network error,
 * cloud write rejection, etc.). Travels in the Effect error channel so callers
 * handle it by `_tag` instead of catching exceptions.
 */
export class GridStoreError extends Data.TaggedError("GridStoreError")<{
  readonly message: string;
  readonly operation: string;
  readonly cause?: unknown;
}> {}

/** Patch shape accepted by {@link GridStore.setCell} — mirrors `Db.setCell`.
 *  The run-metadata fields (`ranAt`/`runMs`/`raw`) are written by the engine's
 *  terminal markDone/markError; stores that don't persist them (cloud) simply
 *  ignore the extra fields. */
export interface CellPatch {
  value?: unknown;
  status?: CellStatus;
  error?: string | null;
  ranAt?: number | null;
  runMs?: number | null;
  raw?: unknown;
}

/**
 * One keyset page of a paged full-column run: a read-only {@link GridStoreShape}
 * scoped to this page's rows, the page's `rowIds` (in run order), and the opaque
 * `nextCursor` to fetch the following page (`null` on the last).
 */
export interface GridStorePage {
  readonly reads: GridStoreShape;
  readonly rowIds: readonly string[];
  readonly nextCursor: unknown;
}

/**
 * The async CRUD surface the engine needs during a run. Every method the
 * engine previously called on the concrete `Db` (plus the credential lookup
 * `dispatch` made on `credsDb`) lives here, returning Effects so the cloud
 * implementation can be genuinely asynchronous without changing callers.
 */
export interface GridStoreShape {
  /** A single column by id (used by `runColumn` to load the column to run). */
  readonly getColumn: (
    columnId: string,
  ) => Effect.Effect<Column | undefined, GridStoreError>;
  /** All columns of a table, ordered — used to resolve `{{Column Name}}` refs. */
  readonly listColumns: (
    tableId: string,
  ) => Effect.Effect<Column[], GridStoreError>;
  /** All rows of a table, ordered — the default run target. */
  readonly listRows: (
    tableId: string,
  ) => Effect.Effect<Row[], GridStoreError>;
  /** Every cell for a row, keyed by column id — used to interpolate params. */
  readonly rowCells: (
    rowId: string,
  ) => Effect.Effect<Map<string, Cell>, GridStoreError>;
  /** A single cell (to skip already-`done` cells unless forced). */
  readonly getCell: (
    rowId: string,
    columnId: string,
  ) => Effect.Effect<Cell | undefined, GridStoreError>;
  /** Upsert a cell's value/status/error. */
  readonly setCell: (
    rowId: string,
    columnId: string,
    patch: CellPatch,
  ) => Effect.Effect<void, GridStoreError>;
  /**
   * Resolve the (decrypted) credential for a connector provider, if any.
   *
   * `accountId` names WHICH account when a workspace can hold more than one on
   * the same connector — Slack's team id. Omitted (the case for every other
   * connector, and for every column authored before multi-team Slack) the store
   * resolves the workspace's sole account.
   */
  readonly getCredential: (
    provider: string,
    accountId?: string,
  ) => Effect.Effect<Credential | undefined, GridStoreError>;
  /**
   * Optional: return a read-only snapshot of the store for the duration of one
   * run. Stores whose granular reads are expensive to repeat (e.g. a cloud
   * store that re-fetches the whole grid on every read) implement this to fetch
   * once and serve all subsequent reads from memory, turning an N-row run from
   * O(N^2) reads into O(N). The engine calls it once per `runColumn` and reads
   * the column/rows/cells through the returned shape, while still WRITING
   * through the live store. Cheap synchronous stores (SQLite) omit it and the
   * engine reads directly, preserving their exact behaviour.
   *
   * When `rowIds` is supplied (a row-scoped run — cascade / run-cell /
   * run-rows), the snapshot may fetch ONLY those rows' data instead of the whole
   * grid, so a scoped run never loads a 50k-row table to touch a handful of
   * rows. A store that can't scope ignores the arg and snapshots the full grid.
   */
  readonly snapshot?: (
    rowIds?: readonly string[],
  ) => Effect.Effect<GridStoreShape, GridStoreError>;
  /**
   * Optional: fetch ONE keyset page of the grid for a FULL-column run, so a
   * store that would otherwise load every row at once streams the grid
   * page-by-page with bounded resident memory. `cursor` is `null` for the first
   * page; the returned `nextCursor` (opaque to the engine) seeks the next page,
   * and `null` marks the last. `reads` is a snapshot scoped to that page's rows.
   * When present, the engine pages a full run; when omitted, it falls back to a
   * single {@link snapshot}. Cheap synchronous stores omit it.
   */
  readonly snapshotPage?: (
    cursor: unknown,
  ) => Effect.Effect<GridStorePage, GridStoreError>;
  /**
   * Optional: when `true`, the engine SKIPS the interim `running` cell write at
   * the start of each row (`runColumn`), writing only the terminal `done`/
   * `error` result. A store sets this when an interim status stream is not worth
   * the extra write — e.g. the cloud store, which batches terminal writes and
   * would otherwise issue two HTTP POSTs per cell (running, then done). Cheap
   * synchronous stores (SQLite) leave it unset so their live status stream is
   * preserved exactly.
   */
  readonly coalesceRunningWrites?: boolean;
  /**
   * Optional: flush any writes the store has BUFFERED during a run. Batching
   * stores (e.g. the cloud store) buffer `setCell` writes and flush them in
   * chunks; the engine calls `drain()` once after the row loop to flush the
   * final partial chunk and await all in-flight writes. Stores that write
   * synchronously omit it (a no-op).
   */
  readonly drain?: () => Effect.Effect<void, GridStoreError>;
}

/**
 * The GridStore service tag. The engine `yield*`s this; the cloud store
 * (`cloudGridStore`) provides the implementation.
 */
export class GridStore extends Context.Tag("GridStore")<
  GridStore,
  GridStoreShape
>() {}

/**
 * Distinguishes the project store from the credentials store. When running
 * multi-project, credentials live in a *separate* (shared/global) database, so
 * the engine resolves them through a second GridStore instance. We expose that
 * via its own tag so both can be provided to the same program.
 */
export class CredentialStore extends Context.Tag("CredentialStore")<
  CredentialStore,
  GridStoreShape
>() {}
