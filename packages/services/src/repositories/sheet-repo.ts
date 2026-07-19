/**
 * `SheetRepo` — the Effect <-> Drizzle adapter for `sheet_bindings` and their
 * row-identity map. CRUD only; the grid row/cell writes are reused from
 * {@link WebhookRepo}. Mirrors the two-Layer shape of {@link SignalRepo}
 * (Drizzle-backed + in-memory test).
 *
 * The identity map is the part worth reading. Without it, re-syncing a sheet
 * would insert every row again — so `findSyncedByKeys` + `upsertSynced` are what
 * turn "read values and write rows" into an actual sync. They are keyed on a
 * TEXT `externalKey` so the same index serves both identity modes (a key
 * column's value, or the sheet row number when there is no key column).
 */

import { schema } from "@gtmgrid/db";
import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer, Option } from "effect";
import { DbClient } from "../db-client.js";
import { isBindingDue, SCHEDULE_DUE_MS, type SignalSchedule } from "../signals/catalog.js";

/** A header → column mapping entry for a sheet binding. */
export interface SheetBindingColumn {
  /** The header text in the spreadsheet, matched case-insensitively at sync. */
  readonly header: string;
  readonly columnId: string;
}

/** A `sheet_bindings` row projection. */
export interface SheetBinding {
  readonly id: string;
  readonly workspaceId: string;
  readonly tableId: string;
  readonly spreadsheetId: string;
  readonly spreadsheetName: string;
  readonly sheetTitle: string;
  readonly headerRow: number;
  readonly columns: readonly SheetBindingColumn[];
  readonly keyHeader: string | null;
  readonly schedule: string;
  readonly enabled: boolean;
  readonly pausedReason: string | null;
  readonly lastSyncedAt: number | null;
  readonly lastError: string | null;
  readonly rowsSynced: number | null;
  readonly createdAt: number;
}

/** Fields a binding insert supplies. */
export interface SheetBindingInsert {
  readonly workspaceId: string;
  readonly tableId: string;
  readonly spreadsheetId: string;
  readonly spreadsheetName: string;
  readonly sheetTitle: string;
  readonly headerRow: number;
  readonly columns: readonly SheetBindingColumn[];
  readonly keyHeader: string | null;
  readonly schedule: string;
  readonly enabled: boolean;
  readonly createdAt: number;
}

/** A patch over a binding; only present fields are written. */
export interface SheetBindingPatch {
  readonly schedule?: string;
  readonly columns?: readonly SheetBindingColumn[];
  readonly keyHeader?: string | null;
  readonly enabled?: boolean;
  readonly pausedReason?: string | null;
  readonly lastSyncedAt?: number | null;
  readonly lastError?: string | null;
  readonly rowsSynced?: number | null;
}

/** One entry of the sheet-row → grid-row identity map. */
export interface SheetSyncedRow {
  readonly rowId: string;
  readonly externalKey: string;
  readonly valuesHash: string | null;
}

/** A keyset cursor over due bindings, seeking on `(createdAt, id)`. */
export interface SheetDueCursor {
  readonly createdAt: number;
  readonly id: string;
}

/** A due binding the cron needs to enqueue. */
export interface DueSheetBinding {
  readonly id: string;
  readonly workspaceId: string;
  readonly createdAt: number;
}

export interface DueSheetBindingPage {
  readonly items: readonly DueSheetBinding[];
  readonly nextCursor: SheetDueCursor | null;
}

/** Raised when a sheet-binding read or write fails. */
export class SheetRepoError extends Data.TaggedError("SheetRepoError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class SheetRepo extends Context.Tag("SheetRepo")<
  SheetRepo,
  {
    readonly findById: (id: string) => Effect.Effect<Option.Option<SheetBinding>, SheetRepoError>;
    readonly listByTable: (tableId: string) => Effect.Effect<readonly SheetBinding[], SheetRepoError>;
    readonly listByWorkspace: (
      workspaceId: string,
    ) => Effect.Effect<readonly SheetBinding[], SheetRepoError>;
    /**
     * One keyset page of DUE bindings (enabled, NOT paused, non-manual, and
     * `last_synced_at` null or older than its schedule interval).
     *
     * `pausedReason IS NULL` is part of the SQL predicate, not a post-filter: a
     * binding paused because its grant was revoked would otherwise be re-enqueued
     * every hour forever, failing identically each time and burning a worker slot
     * plus a Sheets call per tick.
     */
    readonly listDuePage: (args: {
      readonly now: number;
      readonly limit: number;
      readonly cursor: SheetDueCursor | null;
    }) => Effect.Effect<DueSheetBindingPage, SheetRepoError>;
    readonly insert: (values: SheetBindingInsert) => Effect.Effect<string, SheetRepoError>;
    readonly patch: (id: string, patch: SheetBindingPatch) => Effect.Effect<void, SheetRepoError>;
    readonly remove: (id: string) => Effect.Effect<void, SheetRepoError>;
    /**
     * The identity entries for the given source keys. Chunked by the caller;
     * an empty `keys` returns empty without touching the DB.
     */
    readonly findSyncedByKeys: (
      bindingId: string,
      keys: readonly string[],
    ) => Effect.Effect<readonly SheetSyncedRow[], SheetRepoError>;
    /** Insert-or-update identity entries, keyed on `(bindingId, externalKey)`. */
    readonly upsertSynced: (
      bindingId: string,
      entries: readonly (SheetSyncedRow & { readonly createdAt: number })[],
    ) => Effect.Effect<void, SheetRepoError>;
  }
>() {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asColumns(value: unknown): readonly SheetBindingColumn[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((e) => {
    if (e === null || typeof e !== "object") return [];
    const r = e as Record<string, unknown>;
    if (typeof r.header === "string" && typeof r.columnId === "string") {
      return [{ header: r.header, columnId: r.columnId }];
    }
    return [];
  });
}

function rowToBinding(r: {
  id: string;
  workspaceId: string;
  tableId: string;
  spreadsheetId: string;
  spreadsheetName: string;
  sheetTitle: string;
  headerRow: number;
  columns: unknown;
  keyHeader: string | null;
  schedule: string;
  enabled: boolean;
  pausedReason: string | null;
  lastSyncedAt: number | null;
  lastError: string | null;
  rowsSynced: number | null;
  createdAt: number;
}): SheetBinding {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    tableId: r.tableId,
    spreadsheetId: r.spreadsheetId,
    spreadsheetName: r.spreadsheetName,
    sheetTitle: r.sheetTitle,
    headerRow: r.headerRow,
    columns: asColumns(r.columns),
    keyHeader: r.keyHeader,
    schedule: r.schedule,
    enabled: r.enabled,
    pausedReason: r.pausedReason,
    lastSyncedAt: r.lastSyncedAt,
    lastError: r.lastError,
    rowsSynced: r.rowsSynced,
    createdAt: r.createdAt,
  };
}

const fail = (message: string) => (cause: unknown) =>
  new SheetRepoError({ message: cause instanceof Error ? cause.message : message, cause });

export const SheetRepoLive: Layer.Layer<SheetRepo, never, DbClient> = Layer.effect(
  SheetRepo,
  Effect.gen(function* () {
    const db = yield* DbClient;
    const sb = schema.sheetBindings;
    const ssr = schema.sheetSyncedRows;

    return {
      findById: (id) =>
        UUID_RE.test(id)
          ? Effect.tryPromise({
              try: async () => {
                const rows = await db.select().from(sb).where(eq(sb.id, id)).limit(1);
                return Option.fromNullable(rows[0] === undefined ? null : rowToBinding(rows[0]));
              },
              catch: fail("sheet binding lookup failed"),
            })
          : Effect.succeed(Option.none<SheetBinding>()),

      listByTable: (tableId) =>
        UUID_RE.test(tableId)
          ? Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .select()
                  .from(sb)
                  .where(eq(sb.tableId, tableId))
                  .orderBy(desc(sb.createdAt));
                return rows.map(rowToBinding);
              },
              catch: fail("sheet binding list failed"),
            })
          : Effect.succeed([] as readonly SheetBinding[]),

      listByWorkspace: (workspaceId) =>
        UUID_RE.test(workspaceId)
          ? Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .select()
                  .from(sb)
                  .where(eq(sb.workspaceId, workspaceId))
                  .orderBy(desc(sb.createdAt));
                return rows.map(rowToBinding);
              },
              catch: fail("sheet binding list failed"),
            })
          : Effect.succeed([] as readonly SheetBinding[]),

      listDuePage: ({ now, limit, cursor }) =>
        Effect.tryPromise({
          try: async () => {
            // Each threshold is cast to bigint so the CASE has a concrete result
            // type. Without the cast Postgres cannot resolve it and the outer
            // `last_synced_at <= CASE(...)` fails at EXECUTION on every run —
            // the exact bug that once silently killed the signals poll cron.
            const dueThreshold = sql<number>`CASE ${sb.schedule}
              WHEN 'hourly' THEN ${now - SCHEDULE_DUE_MS.hourly}::bigint
              WHEN 'daily' THEN ${now - SCHEDULE_DUE_MS.daily}::bigint
              WHEN 'weekly' THEN ${now - SCHEDULE_DUE_MS.weekly}::bigint
              ELSE NULL
            END`;
            const duePredicate = and(
              eq(sb.enabled, true),
              // A paused binding needs a human, not another attempt.
              isNull(sb.pausedReason),
              ne(sb.schedule, "manual"),
              or(isNull(sb.lastSyncedAt), lte(sb.lastSyncedAt, dueThreshold)),
            );
            const seek =
              cursor === null
                ? duePredicate
                : and(
                    duePredicate,
                    or(
                      gt(sb.createdAt, cursor.createdAt),
                      and(eq(sb.createdAt, cursor.createdAt), gt(sb.id, cursor.id)),
                    ),
                  );
            const rows = await db
              .select({ id: sb.id, workspaceId: sb.workspaceId, createdAt: sb.createdAt })
              .from(sb)
              .where(seek)
              .orderBy(asc(sb.createdAt), asc(sb.id))
              .limit(limit + 1);
            const hasMore = rows.length > limit;
            const items = hasMore ? rows.slice(0, limit) : rows;
            const last = items[items.length - 1];
            return {
              items,
              nextCursor:
                hasMore && last !== undefined ? { createdAt: last.createdAt, id: last.id } : null,
            };
          },
          catch: fail("sheet due page failed"),
        }),

      insert: (values) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db
              .insert(sb)
              .values({
                workspaceId: values.workspaceId,
                tableId: values.tableId,
                spreadsheetId: values.spreadsheetId,
                spreadsheetName: values.spreadsheetName,
                sheetTitle: values.sheetTitle,
                headerRow: values.headerRow,
                columns: values.columns,
                keyHeader: values.keyHeader,
                schedule: values.schedule,
                enabled: values.enabled,
                pausedReason: null,
                lastSyncedAt: null,
                lastError: null,
                rowsSynced: 0,
                createdAt: values.createdAt,
              })
              .returning({ id: sb.id });
            const id = rows[0]?.id;
            if (id === undefined) throw new Error("sheet binding insert returned no id");
            return id;
          },
          catch: fail("sheet binding insert failed"),
        }),

      patch: (id, patch) =>
        Effect.tryPromise({
          try: async () => {
            // Only PRESENT keys are written — `undefined` means "leave alone",
            // which is different from `null` ("clear it"). Spreading the patch
            // directly would write undefined over real values.
            const set: Record<string, unknown> = {};
            if (patch.schedule !== undefined) set.schedule = patch.schedule;
            if (patch.columns !== undefined) set.columns = patch.columns;
            if (patch.keyHeader !== undefined) set.keyHeader = patch.keyHeader;
            if (patch.enabled !== undefined) set.enabled = patch.enabled;
            if (patch.pausedReason !== undefined) set.pausedReason = patch.pausedReason;
            if (patch.lastSyncedAt !== undefined) set.lastSyncedAt = patch.lastSyncedAt;
            if (patch.lastError !== undefined) set.lastError = patch.lastError;
            if (patch.rowsSynced !== undefined) set.rowsSynced = patch.rowsSynced;
            if (Object.keys(set).length === 0) return;
            await db.update(sb).set(set).where(eq(sb.id, id));
          },
          catch: fail("sheet binding patch failed"),
        }),

      remove: (id) =>
        Effect.tryPromise({
          try: async () => {
            await db.delete(sb).where(eq(sb.id, id));
          },
          catch: fail("sheet binding delete failed"),
        }),

      findSyncedByKeys: (bindingId, keys) =>
        keys.length === 0
          ? Effect.succeed([] as readonly SheetSyncedRow[])
          : Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .select({ rowId: ssr.rowId, externalKey: ssr.externalKey, valuesHash: ssr.valuesHash })
                  .from(ssr)
                  .where(and(eq(ssr.bindingId, bindingId), inArray(ssr.externalKey, [...keys])));
                return rows;
              },
              catch: fail("sheet synced-row lookup failed"),
            }),

      upsertSynced: (bindingId, entries) =>
        entries.length === 0
          ? Effect.void
          : Effect.tryPromise({
              try: async () => {
                await db
                  .insert(ssr)
                  .values(
                    entries.map((e) => ({
                      bindingId,
                      rowId: e.rowId,
                      externalKey: e.externalKey,
                      valuesHash: e.valuesHash,
                      createdAt: e.createdAt,
                    })),
                  )
                  .onConflictDoUpdate({
                    target: [ssr.bindingId, ssr.externalKey],
                    // rowId is intentionally updatable: if a user deletes the grid
                    // row, the next sync re-creates it and the identity must follow
                    // the new row rather than dangling at the deleted one.
                    set: {
                      rowId: sql`excluded.row_id`,
                      valuesHash: sql`excluded.values_hash`,
                    },
                  });
              },
              catch: fail("sheet synced-row upsert failed"),
            }),
    };
  }),
);

/** In-memory {@link SheetRepo} for tests. Mirrors the Live semantics. */
export const sheetRepoLayer = (fixtures: {
  bindings?: SheetBinding[];
  synced?: Map<string, Map<string, SheetSyncedRow>>;
}): Layer.Layer<SheetRepo> => {
  const bindings = fixtures.bindings ?? [];
  const synced = fixtures.synced ?? new Map<string, Map<string, SheetSyncedRow>>();
  let seq = 0;

  const bucket = (bindingId: string) => {
    const existing = synced.get(bindingId);
    if (existing) return existing;
    const created = new Map<string, SheetSyncedRow>();
    synced.set(bindingId, created);
    return created;
  };

  return Layer.succeed(SheetRepo, {
    findById: (id) => Effect.succeed(Option.fromNullable(bindings.find((b) => b.id === id))),
    listByTable: (tableId) =>
      Effect.succeed(
        [...bindings].filter((b) => b.tableId === tableId).sort((a, b) => b.createdAt - a.createdAt),
      ),
    listByWorkspace: (workspaceId) =>
      Effect.succeed(
        [...bindings]
          .filter((b) => b.workspaceId === workspaceId)
          .sort((a, b) => b.createdAt - a.createdAt),
      ),
    listDuePage: ({ now, limit, cursor }) =>
      Effect.succeed(
        (() => {
          const due = bindings
            .filter(
              (b) =>
                b.pausedReason === null &&
                isBindingDue(
                  { enabled: b.enabled, schedule: b.schedule as SignalSchedule, lastSyncedAt: b.lastSyncedAt },
                  now,
                ),
            )
            .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
          const after =
            cursor === null
              ? due
              : due.filter(
                  (b) =>
                    b.createdAt > cursor.createdAt ||
                    (b.createdAt === cursor.createdAt && b.id > cursor.id),
                );
          const slice = after.slice(0, limit);
          const hasMore = after.length > limit;
          const last = slice[slice.length - 1];
          return {
            items: slice.map((b) => ({ id: b.id, workspaceId: b.workspaceId, createdAt: b.createdAt })),
            nextCursor: hasMore && last !== undefined ? { createdAt: last.createdAt, id: last.id } : null,
          };
        })(),
      ),
    insert: (values) =>
      Effect.sync(() => {
        seq += 1;
        const id = `sheet_binding_${seq}`;
        bindings.push({
          ...values,
          id,
          pausedReason: null,
          lastSyncedAt: null,
          lastError: null,
          rowsSynced: 0,
        });
        return id;
      }),
    patch: (id, patch) =>
      Effect.sync(() => {
        const index = bindings.findIndex((b) => b.id === id);
        if (index < 0) return;
        const current = bindings[index];
        if (current === undefined) return;
        bindings[index] = {
          ...current,
          ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
          ...(patch.columns !== undefined ? { columns: patch.columns } : {}),
          ...(patch.keyHeader !== undefined ? { keyHeader: patch.keyHeader } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(patch.pausedReason !== undefined ? { pausedReason: patch.pausedReason } : {}),
          ...(patch.lastSyncedAt !== undefined ? { lastSyncedAt: patch.lastSyncedAt } : {}),
          ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
          ...(patch.rowsSynced !== undefined ? { rowsSynced: patch.rowsSynced } : {}),
        };
      }),
    remove: (id) =>
      Effect.sync(() => {
        const index = bindings.findIndex((b) => b.id === id);
        if (index >= 0) bindings.splice(index, 1);
        synced.delete(id);
      }),
    findSyncedByKeys: (bindingId, keys) =>
      Effect.succeed(
        keys.flatMap((k) => {
          const hit = bucket(bindingId).get(k);
          return hit === undefined ? [] : [hit];
        }),
      ),
    upsertSynced: (bindingId, entries) =>
      Effect.sync(() => {
        const map = bucket(bindingId);
        for (const e of entries) {
          map.set(e.externalKey, { rowId: e.rowId, externalKey: e.externalKey, valuesHash: e.valuesHash });
        }
      }),
  });
};
