/**
 * GridStore — the async storage abstraction the execution engine runs against.
 *
 * `Engine.dispatch` + `runColumn` historically called the concrete synchronous
 * `Db` directly. To let the same engine drive either local SQLite (solo) or a
 * cloud/Convex project (team multiplayer) we hide every read/write the run path
 * needs behind this Effect service: a tagged type, typed errors, and a `Layer`.
 *
 * This follows the canonical Effect pattern in `sample-service.ts`:
 *   - errors are `Data.TaggedError` values in the Effect error channel,
 *   - the service is a `Context.Tag`, and
 *   - a `Layer` provides a concrete implementation.
 *
 * `SqliteGridStore` (this file) is the local implementation: a thin, behaviour-
 * preserving wrapper over the existing `Db`. The cloud `ConvexGridStore` (a
 * later lane) is just another `Layer` for the same tag.
 */

import { Context, Data, Effect, Layer } from "effect";
import type { Db } from "./db.js";
import type { Cell, CellStatus, Column, Credential, Row } from "./types.js";

/**
 * Raised when an underlying store operation fails (SQLite throw, network error,
 * Convex mutation rejection, etc.). Travels in the Effect error channel so
 * callers handle it by `_tag` instead of catching exceptions.
 */
export class GridStoreError extends Data.TaggedError("GridStoreError")<{
  readonly message: string;
  readonly operation: string;
  readonly cause?: unknown;
}> {}

/** Patch shape accepted by {@link GridStore.setCell} — mirrors `Db.setCell`. */
export interface CellPatch {
  value?: unknown;
  status?: CellStatus;
  error?: string | null;
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
  /** Resolve the (decrypted) credential for a connector provider, if any. */
  readonly getCredential: (
    provider: string,
  ) => Effect.Effect<Credential | undefined, GridStoreError>;
  /**
   * Optional: return a read-only snapshot of the store for the duration of one
   * run. Stores whose granular reads are expensive to repeat (e.g. a Convex
   * store that re-fetches the whole grid on every read) implement this to fetch
   * once and serve all subsequent reads from memory, turning an N-row run from
   * O(N^2) reads into O(N). The engine calls it once per `runColumn` and reads
   * the column/rows/cells through the returned shape, while still WRITING
   * through the live store. Cheap synchronous stores (SQLite) omit it and the
   * engine reads directly, preserving their exact behaviour.
   */
  readonly snapshot?: () => Effect.Effect<GridStoreShape, GridStoreError>;
}

/**
 * The GridStore service tag. The engine `yield*`s this; a `Layer`
 * (`sqliteGridStore` here, `convexGridStore` later) provides the implementation.
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

/**
 * Wrap a synchronous `Db` call in an Effect, mapping any thrown error into a
 * typed {@link GridStoreError}. Behaviour is identical to calling `Db` directly
 * — the only change is the success/failure travels through the Effect channel.
 */
const fromSync = <A>(
  operation: string,
  thunk: () => A,
): Effect.Effect<A, GridStoreError> =>
  Effect.try({
    try: thunk,
    catch: (cause) =>
      new GridStoreError({
        message: cause instanceof Error ? cause.message : String(cause),
        operation,
        cause,
      }),
  });

/**
 * Build a {@link GridStoreShape} backed by a concrete synchronous {@link Db}.
 * This is the byte-for-byte local implementation: each method delegates to the
 * matching `Db` method, so cell values, statuses, credential precedence, and
 * ordering are exactly what they were before the abstraction existed.
 */
export const sqliteGridStoreShape = (db: Db): GridStoreShape => ({
  getColumn: (columnId) => fromSync("getColumn", () => db.getColumn(columnId)),
  listColumns: (tableId) => fromSync("listColumns", () => db.listColumns(tableId)),
  listRows: (tableId) => fromSync("listRows", () => db.listRows(tableId)),
  rowCells: (rowId) => fromSync("rowCells", () => db.rowCells(rowId)),
  getCell: (rowId, columnId) =>
    fromSync("getCell", () => db.getCell(rowId, columnId)),
  setCell: (rowId, columnId, patch) =>
    fromSync("setCell", () => db.setCell(rowId, columnId, patch)),
  getCredential: (provider) =>
    fromSync("getCredential", () => db.getCredential(provider)),
});

/** A {@link GridStore} `Layer` backed by the given local SQLite {@link Db}. */
export const sqliteGridStore = (db: Db): Layer.Layer<GridStore> =>
  Layer.succeed(GridStore, sqliteGridStoreShape(db));

/** A {@link CredentialStore} `Layer` backed by the given local SQLite {@link Db}. */
export const sqliteCredentialStore = (db: Db): Layer.Layer<CredentialStore> =>
  Layer.succeed(CredentialStore, sqliteGridStoreShape(db));
