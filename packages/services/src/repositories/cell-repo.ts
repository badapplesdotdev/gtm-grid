/**
 * `CellRepo` — the Effect <-> Drizzle adapter for the `cells` table.
 *
 * Ports the cell reads/writes of `convex/cells.ts` (setCell :65, setCellStatus
 * :118) and `convex/tables.ts` (getTable's cell load, addRowsWithCells bulk
 * insert). A cell is uniquely keyed by (rowId, columnId) — the `cells_by_row_column`
 * unique index — so {@link CellRepo.findByRowColumn} resolves the single existing
 * cell a setCell merge patches or inserts.
 */

import { schema } from "@gtmgrid/db";
import { and, eq, inArray } from "drizzle-orm";
import { Context, Data, Effect, Layer, Option } from "effect";
import { DbClient } from "../db-client.js";
import { chunk } from "./_chunk.js";
import { describeDbError } from "./_db-error.js";
import type { GridStore } from "./grid-store.js";

export { chunk } from "./_chunk.js";

/**
 * Characters Postgres' `jsonb` type rejects. `jsonb` stores Unicode text, and
 * the backend refuses a NUL (`\u0000`, "unsupported Unicode escape sequence",
 * SQLSTATE 22P05) and any UNPAIRED UTF-16 surrogate ("invalid byte sequence for
 * encoding UTF8"). Valid surrogate PAIRS (real emoji/astral chars) are fine, so
 * the fast-path test excludes them via lookarounds.
 */
// Matching NUL (\u0000) is the point here — it is the char jsonb rejects.
// eslint-disable-next-line no-control-regex
const JSONB_REJECTS = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Drop NUL and replace lone surrogates with U+FFFD; leave valid text intact. */
const sanitizeString = (s: string): string => {
  if (!JSONB_REJECTS.test(s)) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0) continue; // drop NUL
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i]! + s[i + 1]!; // valid pair — keep both units
        i++;
      } else {
        out += "\uFFFD"; // lone high surrogate
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\uFFFD"; // lone low surrogate
    } else {
      out += s[i]!;
    }
  }
  return out;
};

/**
 * Strip characters Postgres' `jsonb` type rejects from a cell value before it
 * is written. Imported CSV data can carry a NUL byte or invalid UTF-8 (which
 * surfaces as a lone UTF-16 surrogate in a JS string); either aborts the whole
 * `insert into cells` with a `jsonb` error. Recurses into arrays and objects
 * (keys included) and leaves numbers/booleans/null untouched.
 */
export const sanitizeCellValue = (value: unknown): unknown => {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeCellValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[sanitizeString(k)] = sanitizeCellValue(v);
    }
    return out;
  }
  return value;
};

/** A cell row projection the grid domain uses (the getTable cell shape). */
export interface Cell {
  readonly id: string;
  readonly workspaceId: string;
  readonly tableId: string;
  readonly rowId: string;
  readonly columnId: string;
  readonly value: unknown;
  readonly status: string;
  readonly error: string | null;
  readonly updatedAt: number | null;
}

/** Fields a cell insert supplies. */
export interface NewCell {
  readonly workspaceId: string;
  readonly tableId: string;
  readonly rowId: string;
  readonly columnId: string;
  readonly value: unknown;
  readonly status: string;
  readonly error: string | null;
  readonly updatedAt: number | null;
}

/** The merged fields a setCell write persists (value/status/error/updatedAt). */
export interface CellPatchValues {
  readonly value: unknown;
  readonly status: string;
  readonly error: string | null;
  readonly updatedAt: number | null;
}

/** Raised when a cell read/write fails (DB/transport error). */
export class CellRepoError extends Data.TaggedError("CellRepoError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Max cells per `INSERT` statement. Each cell binds 8 columns
 * (workspaceId, tableId, rowId, columnId, value, status, error, updatedAt) and
 * Postgres caps a statement at 65535 bind parameters → 65535 / 8 ≈ 8191 cells.
 * 1000 leaves a wide safety margin so a single bulk import never hits the wall.
 */
export const CELL_INSERT_CHUNK_SIZE = 1000;

const fail = (op: string) => (cause: unknown) =>
  new CellRepoError({ message: describeDbError(op, cause), cause });

/** Reads/writes the `cells` table. */
export class CellRepo extends Context.Tag("CellRepo")<
  CellRepo,
  {
    /** Every cell of a table — for the full (unpaged) getTable. */
    readonly listByTable: (
      tableId: string,
    ) => Effect.Effect<readonly Cell[], CellRepoError>;
    /**
     * Only a single column's cells across a table — for callers that read one
     * column over every row (e.g. the dedupe sweep, which inspects just the
     * dedupe column's value). Served by the `cells_by_table_column` index, so
     * it returns ~one cell per row instead of the full rows×columns matrix.
     */
    readonly listByTableColumn: (
      tableId: string,
      columnId: string,
    ) => Effect.Effect<readonly Cell[], CellRepoError>;
    /**
     * Only the cells belonging to a given set of rows — for the PAGED getTable.
     * Reads a single page's cells (the rows from one keyset page) instead of the
     * whole table, so resident memory stays bounded. An empty `rowIds` returns
     * `[]` without touching the database.
     */
    readonly listByRowIds: (
      rowIds: readonly string[],
    ) => Effect.Effect<readonly Cell[], CellRepoError>;
    /** The single cell at (rowId, columnId), or `None` — for the setCell merge. */
    readonly findByRowColumn: (
      rowId: string,
      columnId: string,
    ) => Effect.Effect<Option.Option<Cell>, CellRepoError>;
    /** Insert a cell and return its id. */
    readonly insert: (
      values: NewCell,
    ) => Effect.Effect<string, CellRepoError>;
    /** Insert many cells in one call (CSV bulk import). */
    readonly insertMany: (
      values: readonly NewCell[],
    ) => Effect.Effect<void, CellRepoError>;
    /** Patch an existing cell by id with the merged fields. */
    readonly patch: (
      cellId: string,
      values: CellPatchValues,
    ) => Effect.Effect<void, CellRepoError>;
  }
>() {}

/** The Drizzle-backed `CellRepo` Layer. */
export const CellRepoLive: Layer.Layer<CellRepo, never, DbClient> =
  Layer.effect(
    CellRepo,
    Effect.gen(function* () {
      const db = yield* DbClient;
      const cols = {
        id: schema.cells.id,
        workspaceId: schema.cells.workspaceId,
        tableId: schema.cells.tableId,
        rowId: schema.cells.rowId,
        columnId: schema.cells.columnId,
        value: schema.cells.value,
        status: schema.cells.status,
        error: schema.cells.error,
        updatedAt: schema.cells.updatedAt,
      } as const;
      return {
        listByTable: (tableId) =>
          UUID_RE.test(tableId)
            ? Effect.tryPromise({
                try: () =>
                  db
                    .select(cols)
                    .from(schema.cells)
                    .where(eq(schema.cells.tableId, tableId)),
                catch: fail("cell list"),
              })
            : Effect.succeed([] as readonly Cell[]),
        listByRowIds: (rowIds) => {
          const valid = rowIds.filter((id) => UUID_RE.test(id));
          return valid.length === 0
            ? Effect.succeed([] as readonly Cell[])
            : Effect.tryPromise({
                try: () =>
                  db
                    .select(cols)
                    .from(schema.cells)
                    .where(inArray(schema.cells.rowId, valid)),
                catch: fail("cell page list"),
              });
        },
        listByTableColumn: (tableId, columnId) =>
          UUID_RE.test(tableId) && UUID_RE.test(columnId)
            ? Effect.tryPromise({
                try: () =>
                  db
                    .select(cols)
                    .from(schema.cells)
                    .where(
                      and(
                        eq(schema.cells.tableId, tableId),
                        eq(schema.cells.columnId, columnId),
                      ),
                    ),
                catch: fail("cell column list"),
              })
            : Effect.succeed([] as readonly Cell[]),
        findByRowColumn: (rowId, columnId) =>
          UUID_RE.test(rowId) && UUID_RE.test(columnId)
            ? Effect.tryPromise({
                try: async () => {
                  const rows = await db
                    .select(cols)
                    .from(schema.cells)
                    .where(
                      and(
                        eq(schema.cells.rowId, rowId),
                        eq(schema.cells.columnId, columnId),
                      ),
                    )
                    .limit(1);
                  return Option.fromNullable(rows[0] ?? null);
                },
                catch: fail("cell lookup"),
              })
            : Effect.succeed(Option.none<Cell>()),
        insert: (values) =>
          Effect.tryPromise({
            try: async () => {
              const rows = await db
                .insert(schema.cells)
                .values({
                  workspaceId: values.workspaceId,
                  tableId: values.tableId,
                  rowId: values.rowId,
                  columnId: values.columnId,
                  value: sanitizeCellValue(values.value),
                  status: values.status as never,
                  error: values.error,
                  updatedAt: values.updatedAt,
                })
                .returning({ id: schema.cells.id });
              const id = rows[0]?.id;
              if (id === undefined) {
                throw new Error("cell insert returned no id");
              }
              return id;
            },
            catch: fail("cell insert"),
          }),
        insertMany: (values) =>
          values.length === 0
            ? Effect.void
            : Effect.tryPromise({
                try: async () => {
                  // Chunk so a wide CSV import never exceeds Postgres' 65535
                  // bind-parameter cap (~8191 cells at 8 cols/cell); loop the
                  // batches inside one tryPromise so a mid-import failure still
                  // surfaces as a single CellRepoError.
                  for (const batch of chunk(values, CELL_INSERT_CHUNK_SIZE)) {
                    await db.insert(schema.cells).values(
                      batch.map((v) => ({
                        workspaceId: v.workspaceId,
                        tableId: v.tableId,
                        rowId: v.rowId,
                        columnId: v.columnId,
                        value: sanitizeCellValue(v.value),
                        status: v.status as never,
                        error: v.error,
                        updatedAt: v.updatedAt,
                      })),
                    );
                  }
                },
                catch: fail("cell bulk insert"),
              }),
        patch: (cellId, values) =>
          Effect.tryPromise({
            try: async () => {
              await db
                .update(schema.cells)
                .set({
                  value: sanitizeCellValue(values.value),
                  status: values.status as never,
                  error: values.error,
                  updatedAt: values.updatedAt,
                })
                .where(eq(schema.cells.id, cellId));
            },
            catch: fail("cell patch"),
          }),
      };
    }),
  );

/** An in-memory `CellRepo` Layer over a shared {@link GridStore}. */
export const cellRepoLayer = (store: GridStore): Layer.Layer<CellRepo> =>
  Layer.succeed(CellRepo, {
    listByTable: (tableId) =>
      Effect.succeed(store.cells.filter((c) => c.tableId === tableId)),
    listByRowIds: (rowIds) => {
      const set = new Set(rowIds);
      return Effect.succeed(store.cells.filter((c) => set.has(c.rowId)));
    },
    listByTableColumn: (tableId, columnId) =>
      Effect.succeed(
        store.cells.filter(
          (c) => c.tableId === tableId && c.columnId === columnId,
        ),
      ),
    findByRowColumn: (rowId, columnId) =>
      Effect.succeed(
        Option.fromNullable(
          store.cells.find(
            (c) => c.rowId === rowId && c.columnId === columnId,
          ),
        ),
      ),
    insert: (values) =>
      Effect.sync(() => {
        const id = store.nextId("cell");
        store.cells.push({ id, ...values });
        return id;
      }),
    insertMany: (values) =>
      Effect.sync(() => {
        for (const v of values) {
          store.cells.push({ id: store.nextId("cell"), ...v });
        }
      }),
    patch: (cellId, values) =>
      Effect.sync(() => {
        const idx = store.cells.findIndex((c) => c.id === cellId);
        if (idx >= 0) {
          store.cells[idx] = {
            ...(store.cells[idx] as Cell),
            value: values.value,
            status: values.status,
            error: values.error,
            updatedAt: values.updatedAt,
          };
        }
      }),
  });
