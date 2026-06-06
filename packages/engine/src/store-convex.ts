/**
 * ConvexGridStore — a {@link GridStoreShape} backed by a Convex deployment, so
 * the LOCAL engine can drive a cloud/team project: it reads a table's columns,
 * rows, and cells from Convex and writes cell status/results back via the T4
 * mutations (`cells.setCellStatus` / `cells.setCell`) during a run. Cell status
 * (`running` → `done`/`error`) streams live to every workspace member through
 * Convex reactivity.
 *
 * DECOUPLING (the load-bearing constraint): this module — and therefore the
 * engine's `tsc -b` build — must NOT import `convex/_generated` or any generated
 * deployment code, so the engine package never depends on codegen that only
 * exists after `npx convex dev`. We achieve that by injecting a small typed
 * client interface ({@link ConvexClientLike}) plus opaque function references
 * ({@link ConvexFunctionRefs}). The real `ConvexHttpClient` from "convex/browser"
 * structurally satisfies `ConvexClientLike`, and `api.tables.getTable` /
 * `api.cells.setCell` / `api.cells.setCellStatus` satisfy the refs — the caller
 * (desktop/server wiring lane) passes them in; this file imports neither.
 *
 * SCOPE: a run targets a single table (`Engine.runColumn` resolves rows from
 * `col.table_id`). So a `ConvexGridStore` is constructed for ONE Convex table:
 * the granular reads the engine makes (`getColumn`/`getCell`/`rowCells` — all
 * keyed by column/row id with no table id) are served by fetching the table's
 * full grid via `getTable(tableId)` and indexing it in memory. This reuses the
 * one existing T4 reactive query rather than adding new Convex functions.
 *
 * Follows the canonical Effect service shape (docs/effect-conventions.md):
 * typed errors via {@link GridStoreError}, methods returning `Effect.Effect`,
 * and `Layer`s for the {@link GridStore} / {@link CredentialStore} tags. Status
 * and credential-scope mapping reuse {@link CloudSchemaMapping} (cloud-schema.ts)
 * so engine→cloud literal drift fails loudly with a typed error.
 */

import { Effect, Layer } from "effect";
import {
  CloudSchemaMapping,
  type CloudCredentialScope,
} from "./cloud-schema.js";
import {
  CredentialStore,
  GridStore,
  GridStoreError,
  type CellPatch,
  type GridStoreShape,
} from "./store.js";
import type {
  Cell,
  CellStatus,
  Column,
  Credential,
  Row,
} from "./types.js";

/**
 * The minimal Convex client surface ConvexGridStore needs. Structurally
 * satisfied by `ConvexHttpClient` (from "convex/browser") and the reactive
 * `ConvexReactClient`, so the caller injects the real client without this file
 * importing any Convex code. `ref` is an opaque function reference (e.g.
 * `api.tables.getTable`); typed as `unknown` precisely so the engine build never
 * imports the generated `api`.
 */
export interface ConvexClientLike {
  query(ref: unknown, args: Record<string, unknown>): Promise<unknown>;
  mutation(ref: unknown, args: Record<string, unknown>): Promise<unknown>;
  /**
   * Execute a Convex ACTION. Workspace-shared credentials are decrypted by the
   * T7 `credentials:getCredentialForRun` action (Node runtime), so resolving a
   * cloud run's secrets goes through here, not `query`. `ConvexHttpClient` from
   * "convex/browser" structurally satisfies this.
   */
  action(ref: unknown, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Opaque references to the T4 Convex functions this store calls. The caller
 * passes `api.tables.getTable`, `api.cells.setCell`, `api.cells.setCellStatus`,
 * and optionally a credential-read query. They are `unknown` to the engine —
 * only the injected {@link ConvexClientLike} interprets them — which is what
 * keeps the engine decoupled from `convex/_generated`.
 */
export interface ConvexFunctionRefs {
  /** `api.tables.getTable` — returns `{ table, columns, rows, cells }`. */
  readonly getTable: unknown;
  /** `api.cells.setCell` — upsert value/status/error for a cell. */
  readonly setCell: unknown;
  /** `api.cells.setCellStatus` — status-only upsert (run lifecycle). */
  readonly setCellStatus: unknown;
  /**
   * Optional ACTION resolving the decrypted secrets for a connector during a
   * run — the T7 `credentials:getCredentialForRun` decrypt-for-run path, gated
   * to an authorized workspace member. When wired (together with
   * {@link ConvexCredentialResolution} on the config), it is called as an action
   * with `{ workspaceId, extensionId, scope }` and is expected to return
   * {@link ConvexCredentialForRunResult} (or null). When omitted, credential
   * lookups resolve to `undefined` (matching a project with no connected keys).
   */
  readonly getCredential?: unknown;
}

/**
 * How a cloud run resolves a connector's decrypted secrets from the workspace.
 * The credential is keyed on the workspace and a scope: a CLOUD column run uses
 * the `workspace` scope (the shared team key), per the F2 personal-vs-workspace
 * ownership rules. The T7 `getCredentialForRun` action enforces membership +
 * ownership before any plaintext is produced.
 */
export interface ConvexCredentialResolution {
  /** The Convex `workspaces._id` the credential is scoped to. */
  readonly workspaceId: string;
  /** Which credential to read — `workspace` (shared) for a cloud column run. */
  readonly scope: CloudCredentialScope;
}

/** Config to build a table-scoped ConvexGridStore. */
export interface ConvexGridStoreConfig {
  readonly client: ConvexClientLike;
  readonly refs: ConvexFunctionRefs;
  /** The Convex `tables._id` (a string) this store reads/writes within. */
  readonly tableId: string;
  /**
   * Optional credential resolution for the run. When present (and
   * `refs.getCredential` is wired), `getCredential(provider)` decrypts the
   * workspace's shared secret for that connector via the T7 action. Omitted for
   * data-only stores (reads/writes), where credential lookups are a no-op.
   */
  readonly credentials?: ConvexCredentialResolution;
}

/** The shape `cells.setCell` / `cells.setCellStatus` are addressed by. */
interface ConvexCellArgs {
  readonly rowId: string;
  readonly columnId: string;
}

/** A Convex column doc as returned by `getTable` (camelCase, string ids). */
interface ConvexColumnDoc {
  readonly _id: string;
  readonly tableId: string;
  readonly name: string;
  readonly type: Column["type"];
  readonly kind: Column["kind"];
  readonly provider: string | null;
  readonly method: string | null;
  readonly code: string | null;
  readonly params: Record<string, unknown>;
  readonly position: number;
  readonly createdAt: number;
}

/** A Convex row doc as returned by `getTable`. */
interface ConvexRowDoc {
  readonly _id: string;
  readonly tableId: string;
  readonly position: number;
  readonly createdAt: number;
}

/** A Convex cell doc as returned by `getTable`. */
interface ConvexCellDoc {
  readonly rowId: string;
  readonly columnId: string;
  readonly value: unknown;
  readonly status: CellStatus;
  readonly error: string | null;
  readonly updatedAt: number | null;
}

/** The payload shape of `tables.getTable`. */
interface ConvexGetTableResult {
  readonly columns: readonly ConvexColumnDoc[];
  readonly rows: readonly ConvexRowDoc[];
  readonly cells: readonly ConvexCellDoc[];
}

/**
 * The result of the T7 `getCredentialForRun` action: the DECRYPTED secret map
 * for an authorized member, or `null` when the connector has no stored
 * credential. This is the ONLY shape that ever carries plaintext — listing
 * queries return metadata only, so no plaintext is exposed to them.
 */
export interface ConvexCredentialForRunResult {
  readonly secrets: Record<string, string>;
}

/** Map a Convex column doc onto the engine {@link Column} (snake_case ids). */
const toColumn = (c: ConvexColumnDoc): Column => ({
  id: c._id,
  table_id: c.tableId,
  name: c.name,
  type: c.type,
  kind: c.kind,
  provider: c.provider,
  method: c.method,
  code: c.code,
  params: c.params,
  position: c.position,
  created_at: c.createdAt,
});

/** Map a Convex row doc onto the engine {@link Row}. */
const toRow = (r: ConvexRowDoc): Row => ({
  id: r._id,
  table_id: r.tableId,
  position: r.position,
  created_at: r.createdAt,
});

/** Map a Convex cell doc onto the engine {@link Cell}. */
const toCell = (c: ConvexCellDoc): Cell => ({
  row_id: c.rowId,
  column_id: c.columnId,
  value: c.value,
  status: c.status,
  error: c.error,
  updated_at: c.updatedAt,
});

/**
 * Build the engine {@link Credential} the run path consumes from the decrypted
 * secrets the T7 action returns, for one connector + resolution scope. The
 * cloud scope literal (`workspace`|`personal`) maps back onto the engine scope
 * (`team`|`personal`) — the inverse of `CloudSchemaMapping.credentialScopeForCloud`.
 * The engine only reads `secrets` during dispatch; the other fields describe the
 * connector this credential was resolved for.
 */
const toCredential = (
  extensionId: string,
  scope: CloudCredentialScope,
  result: ConvexCredentialForRunResult,
): Credential => ({
  id: `${scope}:${extensionId}`,
  extension_id: extensionId,
  scope: scope === "workspace" ? "team" : "personal",
  name: extensionId,
  secrets: result.secrets,
  created_at: 0,
});

/** Wrap a Convex client promise, mapping any rejection to a typed error. */
const fromClient = <A>(
  operation: string,
  thunk: () => Promise<A>,
): Effect.Effect<A, GridStoreError> =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) =>
      new GridStoreError({
        message: cause instanceof Error ? cause.message : String(cause),
        operation,
        cause,
      }),
  });

/**
 * Build a {@link GridStoreShape} backed by a Convex client, scoped to one
 * table. Reads fetch the table's full grid via `getTable(tableId)` and index it;
 * writes call the T4 `cells.setCell` / `cells.setCellStatus` mutations. The
 * effect resolves {@link CloudSchemaMapping} so cell statuses are validated
 * against the cloud literal union before they are written.
 */
export const convexGridStoreShape = (
  config: ConvexGridStoreConfig,
): Effect.Effect<GridStoreShape, never, CloudSchemaMapping> =>
  Effect.gen(function* () {
    const mapping = yield* CloudSchemaMapping;
    const { client, refs, tableId } = config;

    /** Fetch + map the table grid once (columns, rows, cells). */
    const fetchGrid = (
      operation: string,
    ): Effect.Effect<ConvexGetTableResult, GridStoreError> =>
      fromClient(operation, () =>
        client.query(refs.getTable, { tableId }),
      ).pipe(Effect.map((r) => r as ConvexGetTableResult));

    /**
     * Validate the patch's status against the cloud literal union (reusing
     * CloudSchemaMapping), then call the matching mutation. A status-only patch
     * uses `setCellStatus`; any patch carrying a value uses `setCell`.
     */
    const writeCell = (
      rowId: string,
      columnId: string,
      patch: CellPatch,
    ): Effect.Effect<void, GridStoreError> =>
      Effect.gen(function* () {
        const cellArgs: ConvexCellArgs = { rowId, columnId };
        const status =
          patch.status === undefined
            ? undefined
            : yield* mapping
                .cellStatusForCloud(patch.status)
                .pipe(
                  Effect.mapError(
                    (e) =>
                      new GridStoreError({
                        message: e.message,
                        operation: "setCell",
                        cause: e,
                      }),
                  ),
                );

        const hasValue = "value" in patch;
        // Status-only updates take the lighter setCellStatus path (the run
        // lifecycle's running→done/error), which preserves value via COALESCE.
        if (!hasValue && status !== undefined) {
          yield* fromClient("setCell", () =>
            client.mutation(refs.setCellStatus, {
              ...cellArgs,
              status,
              ...(patch.error !== undefined ? { error: patch.error } : {}),
            }),
          );
          return;
        }
        yield* fromClient("setCell", () =>
          client.mutation(refs.setCell, {
            ...cellArgs,
            ...(hasValue ? { value: patch.value } : {}),
            ...(status !== undefined ? { status } : {}),
            ...(patch.error !== undefined ? { error: patch.error } : {}),
          }),
        );
      });

    /**
     * Resolve the DECRYPTED workspace credential for a connector during a run.
     * Calls the T7 `getCredentialForRun` ACTION with `{ workspaceId,
     * extensionId, scope }` — the only path that yields plaintext, gated to an
     * authorized member by the action itself. A no-op (`undefined`) unless BOTH
     * a credential ref and a {@link ConvexCredentialResolution} are wired, so a
     * data-only store never resolves secrets and a run with no stored credential
     * behaves like a project with no connected keys.
     */
    const getCredential = (
      provider: string,
    ): Effect.Effect<Credential | undefined, GridStoreError> => {
      const ref = refs.getCredential;
      const resolution = config.credentials;
      if (ref === undefined || resolution === undefined)
        return Effect.succeed(undefined);
      return fromClient("getCredential", () =>
        client.action(ref, {
          workspaceId: resolution.workspaceId,
          extensionId: provider,
          scope: resolution.scope,
        }),
      ).pipe(
        Effect.map((result) =>
          result == null
            ? undefined
            : toCredential(
                provider,
                resolution.scope,
                result as ConvexCredentialForRunResult,
              ),
        ),
      );
    };

    /** Index a fetched grid into the engine read surface (pure, no I/O). */
    const readsFromGrid = (grid: ConvexGetTableResult) => ({
      getColumn: (columnId: string) =>
        Effect.sync(() => {
          const found = grid.columns.find((c) => c._id === columnId);
          return found ? toColumn(found) : undefined;
        }),
      listColumns: (_tableId: string) =>
        Effect.sync(() => grid.columns.map(toColumn)),
      listRows: (_tableId: string) => Effect.sync(() => grid.rows.map(toRow)),
      rowCells: (rowId: string) =>
        Effect.sync(() => {
          const out = new Map<string, Cell>();
          for (const cell of grid.cells) {
            if (cell.rowId === rowId) out.set(cell.columnId, toCell(cell));
          }
          return out;
        }),
      getCell: (rowId: string, columnId: string) =>
        Effect.sync(() => {
          const found = grid.cells.find(
            (c) => c.rowId === rowId && c.columnId === columnId,
          );
          return found ? toCell(found) : undefined;
        }),
    });

    return {
      getColumn: (columnId) =>
        fetchGrid("getColumn").pipe(
          Effect.flatMap((grid) => readsFromGrid(grid).getColumn(columnId)),
        ),
      listColumns: (tableId) =>
        fetchGrid("listColumns").pipe(
          Effect.flatMap((grid) => readsFromGrid(grid).listColumns(tableId)),
        ),
      listRows: (tableId) =>
        fetchGrid("listRows").pipe(
          Effect.flatMap((grid) => readsFromGrid(grid).listRows(tableId)),
        ),
      rowCells: (rowId) =>
        fetchGrid("rowCells").pipe(
          Effect.flatMap((grid) => readsFromGrid(grid).rowCells(rowId)),
        ),
      getCell: (rowId, columnId) =>
        fetchGrid("getCell").pipe(
          Effect.flatMap((grid) => readsFromGrid(grid).getCell(rowId, columnId)),
        ),
      setCell: (rowId, columnId, patch) => writeCell(rowId, columnId, patch),
      getCredential,
      // Snapshot the grid ONCE for a run: every per-row read below is served
      // from this in-memory grid, so an N-row `runColumn` issues one getTable
      // query instead of one-per-read (O(N) total, not O(N^2)). Writes and
      // credential reads stay live so cell status streams during the run.
      snapshot: () =>
        fetchGrid("snapshot").pipe(
          Effect.map(
            (grid): GridStoreShape => ({
              ...readsFromGrid(grid),
              setCell: (rowId, columnId, patch) =>
                writeCell(rowId, columnId, patch),
              getCredential,
            }),
          ),
        ),
    } satisfies GridStoreShape;
  });

/**
 * A {@link GridStore} `Layer` backed by a Convex client for one cloud table.
 * Requires {@link CloudSchemaMapping} (provided via its `.Default` Layer); the
 * caller composes `Layer.provide(CloudSchemaMapping.Default)`.
 */
export const convexGridStore = (
  config: ConvexGridStoreConfig,
): Layer.Layer<GridStore, never, CloudSchemaMapping> =>
  Layer.effect(GridStore, convexGridStoreShape(config));

/**
 * A {@link CredentialStore} `Layer` backed by a Convex client. Used when a
 * cloud run resolves connector secrets from the workspace's shared credentials
 * (via the injected `getCredential` ref) rather than the local key store.
 */
export const convexCredentialStore = (
  config: ConvexGridStoreConfig,
): Layer.Layer<CredentialStore, never, CloudSchemaMapping> =>
  Layer.effect(CredentialStore, convexGridStoreShape(config));
