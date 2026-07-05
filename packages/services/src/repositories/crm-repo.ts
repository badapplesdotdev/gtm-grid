/**
 * CRM-sync repositories (TRI: crm-sync) — the Effect <-> Drizzle adapters for
 * `crm_bindings`, `crm_synced_rows`, and `crm_sync_runs`. CRUD + the bulk
 * identity-map operations the sync loop needs; grid row/cell writes are reused
 * from {@link WebhookRepo}. Mirrors the shape of {@link SignalRepo}.
 */

import { schema } from "@gtmgrid/db";
import { and, count, desc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer, Option } from "effect";
import { DbClient } from "../db-client.js";

// ── Shared types ──────────────────────────────────────────────────────────────

/** A synced attribute → column mapping entry. */
export interface CrmBindingColumn {
  readonly attrSlug: string;
  readonly attrType: string;
  readonly columnId: string;
  /** The attribute's human title at bind time (drift reporting: "Twitter, Region"). */
  readonly title: string;
}

/** A crm_bindings row projection. Mirrors `crmBindings`. */
export interface CrmBinding {
  readonly id: string;
  readonly workspaceId: string;
  readonly tableId: string;
  readonly provider: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly columns: readonly CrmBindingColumn[];
  readonly config: Record<string, unknown>;
  readonly schedule: string;
  readonly enabled: boolean;
  readonly pausedReason: string | null;
  readonly lastSyncedAt: number | null;
  readonly lastError: string | null;
  readonly rowsSynced: number | null;
  readonly createdAt: number;
}

export interface CrmBindingInsert {
  readonly workspaceId: string;
  readonly tableId: string;
  readonly provider: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly columns: readonly CrmBindingColumn[];
  readonly config: Record<string, unknown>;
  readonly schedule: string;
  readonly enabled: boolean;
  readonly createdAt: number;
}

/** A patch over a binding; only present fields are written. */
export interface CrmBindingPatch {
  readonly columns?: readonly CrmBindingColumn[];
  readonly config?: Record<string, unknown>;
  readonly schedule?: string;
  readonly enabled?: boolean;
  readonly pausedReason?: string | null;
  readonly lastSyncedAt?: number | null;
  readonly lastError?: string | null;
  readonly rowsSynced?: number | null;
}

/** A keyset cursor over due bindings, seeking on `(createdAt, id)`. */
export interface CrmDueCursor {
  readonly createdAt: number;
  readonly id: string;
}

export interface CrmDueBinding {
  readonly id: string;
  readonly workspaceId: string;
  readonly createdAt: number;
}

export interface CrmDueBindingPage {
  readonly items: readonly CrmDueBinding[];
  readonly nextCursor: CrmDueCursor | null;
}

/** One crm_synced_rows identity-map entry (external record → grid row). */
export interface CrmSyncedRow {
  readonly id: string;
  readonly bindingId: string;
  readonly rowId: string;
  readonly externalId: string;
  readonly matchKey: string | null;
  /** Hash of flattened synced values at last write (unchanged → skip cell writes). */
  readonly valuesHash: string | null;
  readonly lastSeenRunId: string | null;
  readonly stale: boolean;
}

export interface CrmSyncedRowUpsert {
  readonly bindingId: string;
  readonly rowId: string;
  readonly externalId: string;
  readonly matchKey: string | null;
  readonly valuesHash: string | null;
  readonly lastSeenRunId: string;
  readonly createdAt: number;
}

/** A crm_sync_runs row projection (the user-visible sync log). */
export interface CrmSyncRun {
  readonly id: string;
  readonly workspaceId: string;
  readonly bindingId: string;
  readonly tableId: string;
  readonly status: string;
  readonly trigger: string;
  readonly rowsCreated: number;
  readonly rowsUpdated: number;
  readonly rowsSkipped: number;
  readonly rowsStaled: number;
  readonly fieldsDropped: readonly string[] | null;
  readonly error: string | null;
  readonly startedAt: number;
  readonly finishedAt: number | null;
}

export interface CrmSyncRunFinish {
  readonly status: string;
  readonly rowsCreated: number;
  readonly rowsUpdated: number;
  readonly rowsSkipped: number;
  readonly rowsStaled: number;
  readonly fieldsDropped: readonly string[] | null;
  readonly error: string | null;
  readonly finishedAt: number;
}

/** Raised when a CRM repo read or write fails. */
export class CrmRepoError extends Data.TaggedError("CrmRepoError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * A daily binding is due once its last sync is at least this old. Deliberately
 * under 24h: the cron fires at a fixed time, so a strict 24h window would skip
 * every other day whenever a run finished seconds after the previous tick.
 */
export const CRM_DAILY_DUE_MS = 20 * 60 * 60 * 1000;

// ── Tags ──────────────────────────────────────────────────────────────────────

export class CrmBindingRepo extends Context.Tag("CrmBindingRepo")<
  CrmBindingRepo,
  {
    readonly findById: (id: string) => Effect.Effect<Option.Option<CrmBinding>, CrmRepoError>;
    readonly listByTable: (tableId: string) => Effect.Effect<readonly CrmBinding[], CrmRepoError>;
    readonly listByWorkspace: (
      workspaceId: string,
    ) => Effect.Effect<readonly CrmBinding[], CrmRepoError>;
    /**
     * One keyset page of DUE bindings (enabled, daily, not paused, last sync
     * null or ≥ {@link CRM_DAILY_DUE_MS} old), seeking on `(created_at, id)` —
     * the cron never loads + JS-filters the whole population.
     */
    readonly listDuePage: (args: {
      readonly now: number;
      readonly limit: number;
      readonly cursor: CrmDueCursor | null;
    }) => Effect.Effect<CrmDueBindingPage, CrmRepoError>;
    readonly insert: (values: CrmBindingInsert) => Effect.Effect<string, CrmRepoError>;
    readonly patch: (id: string, patch: CrmBindingPatch) => Effect.Effect<void, CrmRepoError>;
    readonly remove: (id: string) => Effect.Effect<void, CrmRepoError>;
    /**
     * Un-pause every binding for `(workspaceId, provider)` whose pause reason
     * matches — the reconnect path after a successful re-OAuth.
     */
    readonly clearPause: (args: {
      readonly workspaceId: string;
      readonly provider: string;
      readonly reason: string;
    }) => Effect.Effect<number, CrmRepoError>;
  }
>() {}

export class CrmSyncedRowRepo extends Context.Tag("CrmSyncedRowRepo")<
  CrmSyncedRowRepo,
  {
    /** Bulk identity lookup for one pulled page (≤500 external ids). */
    readonly findByExternalIds: (
      bindingId: string,
      externalIds: readonly string[],
    ) => Effect.Effect<readonly CrmSyncedRow[], CrmRepoError>;
    /** Bulk match-key lookup (update-mode upsert of records never seen before). */
    readonly findByMatchKeys: (
      bindingId: string,
      keys: readonly string[],
    ) => Effect.Effect<readonly CrmSyncedRow[], CrmRepoError>;
    /**
     * Bulk upsert of identity entries; `(binding_id, external_id)` conflicts
     * update rowId/matchKey/lastSeenRunId and clear `stale` (a record that
     * reappears upstream is no longer stale).
     */
    readonly upsertMany: (
      entries: readonly CrmSyncedRowUpsert[],
    ) => Effect.Effect<void, CrmRepoError>;
    /** Mark records seen this run without other changes (skip-mode touch). */
    readonly touchSeen: (
      bindingId: string,
      externalIds: readonly string[],
      runId: string,
    ) => Effect.Effect<void, CrmRepoError>;
    /**
     * After a FULLY COMPLETE pull: mark entries not seen by `runId` stale.
     * Returns how many flipped fresh→stale this run.
     */
    readonly markStaleNotSeen: (
      bindingId: string,
      runId: string,
    ) => Effect.Effect<number, CrmRepoError>;
    readonly countByBinding: (bindingId: string) => Effect.Effect<number, CrmRepoError>;
  }
>() {}

export class CrmSyncRunRepo extends Context.Tag("CrmSyncRunRepo")<
  CrmSyncRunRepo,
  {
    readonly start: (args: {
      readonly workspaceId: string;
      readonly bindingId: string;
      readonly tableId: string;
      readonly trigger: string;
      readonly startedAt: number;
    }) => Effect.Effect<string, CrmRepoError>;
    readonly finish: (runId: string, args: CrmSyncRunFinish) => Effect.Effect<void, CrmRepoError>;
    /**
     * Update the live counters on a RUNNING run (called after each pulled
     * page) so the strip can show "Pulling records… N so far" during a sync.
     */
    readonly progress: (
      runId: string,
      args: { readonly rowsCreated: number; readonly rowsUpdated: number; readonly rowsSkipped: number },
    ) => Effect.Effect<void, CrmRepoError>;
    readonly findById: (runId: string) => Effect.Effect<Option.Option<CrmSyncRun>, CrmRepoError>;
    readonly listByBinding: (
      bindingId: string,
      limit: number,
    ) => Effect.Effect<readonly CrmSyncRun[], CrmRepoError>;
  }
>() {}

// ── Row mapping helpers ───────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asBindingColumns(value: unknown): readonly CrmBindingColumn[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((e) => {
    if (e === null || typeof e !== "object") return [];
    const r = e as Record<string, unknown>;
    if (typeof r.attrSlug === "string" && typeof r.attrType === "string" && typeof r.columnId === "string") {
      return [
        {
          attrSlug: r.attrSlug,
          attrType: r.attrType,
          columnId: r.columnId,
          title: typeof r.title === "string" ? r.title : r.attrSlug,
        },
      ];
    }
    return [];
  });
}

function asStrings(value: unknown): readonly string[] | null {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : null;
}

function rowToBinding(r: typeof schema.crmBindings.$inferSelect): CrmBinding {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    tableId: r.tableId,
    provider: r.provider,
    sourceKind: r.sourceKind,
    sourceId: r.sourceId,
    sourceLabel: r.sourceLabel,
    columns: asBindingColumns(r.columns),
    config: asRecord(r.config),
    schedule: r.schedule,
    enabled: r.enabled,
    pausedReason: r.pausedReason,
    lastSyncedAt: r.lastSyncedAt,
    lastError: r.lastError,
    rowsSynced: r.rowsSynced,
    createdAt: r.createdAt,
  };
}

function rowToRun(r: typeof schema.crmSyncRuns.$inferSelect): CrmSyncRun {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    bindingId: r.bindingId,
    tableId: r.tableId,
    status: r.status,
    trigger: r.trigger,
    rowsCreated: r.rowsCreated,
    rowsUpdated: r.rowsUpdated,
    rowsSkipped: r.rowsSkipped,
    rowsStaled: r.rowsStaled,
    fieldsDropped: asStrings(r.fieldsDropped),
    error: r.error,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
}

const fail = (message: string) => (cause: unknown) =>
  new CrmRepoError({ message: cause instanceof Error ? cause.message : message, cause });

// ── Live layers ───────────────────────────────────────────────────────────────

export const CrmBindingRepoLive: Layer.Layer<CrmBindingRepo, never, DbClient> = Layer.effect(
  CrmBindingRepo,
  Effect.gen(function* () {
    const db = yield* DbClient;
    const cb = schema.crmBindings;
    return {
      findById: (id) =>
        UUID_RE.test(id)
          ? Effect.tryPromise({
              try: async () => {
                const rows = await db.select().from(cb).where(eq(cb.id, id)).limit(1);
                return Option.fromNullable(rows[0] === undefined ? null : rowToBinding(rows[0]));
              },
              catch: fail("crm binding lookup failed"),
            })
          : Effect.succeed(Option.none<CrmBinding>()),

      listByTable: (tableId) =>
        UUID_RE.test(tableId)
          ? Effect.tryPromise({
              try: async () => {
                const rows = await db.select().from(cb).where(eq(cb.tableId, tableId)).orderBy(desc(cb.createdAt));
                return rows.map(rowToBinding);
              },
              catch: fail("crm binding list failed"),
            })
          : Effect.succeed([] as readonly CrmBinding[]),

      listByWorkspace: (workspaceId) =>
        UUID_RE.test(workspaceId)
          ? Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .select()
                  .from(cb)
                  .where(eq(cb.workspaceId, workspaceId))
                  .orderBy(desc(cb.createdAt));
                return rows.map(rowToBinding);
              },
              catch: fail("crm binding list failed"),
            })
          : Effect.succeed([] as readonly CrmBinding[]),

      listDuePage: ({ now, limit, cursor }) =>
        Effect.tryPromise({
          try: async () => {
            const duePredicate = and(
              eq(cb.enabled, true),
              eq(cb.schedule, "daily"),
              isNull(cb.pausedReason),
              or(isNull(cb.lastSyncedAt), lte(cb.lastSyncedAt, now - CRM_DAILY_DUE_MS)),
            );
            const seek = cursor
              ? and(
                  duePredicate,
                  or(gt(cb.createdAt, cursor.createdAt), and(eq(cb.createdAt, cursor.createdAt), gt(cb.id, cursor.id))),
                )
              : duePredicate;
            const rows = await db
              .select({ id: cb.id, workspaceId: cb.workspaceId, createdAt: cb.createdAt })
              .from(cb)
              .where(seek)
              .orderBy(cb.createdAt, cb.id)
              .limit(limit + 1);
            const items = rows.slice(0, limit);
            const last = items[items.length - 1];
            return {
              items,
              nextCursor:
                rows.length > limit && last !== undefined ? { createdAt: last.createdAt, id: last.id } : null,
            };
          },
          catch: fail("crm due-binding page failed"),
        }),

      insert: (values) =>
        Effect.tryPromise({
          try: async () => {
            const inserted = await db
              .insert(cb)
              .values({
                workspaceId: values.workspaceId,
                tableId: values.tableId,
                provider: values.provider,
                sourceKind: values.sourceKind,
                sourceId: values.sourceId,
                sourceLabel: values.sourceLabel,
                columns: values.columns,
                config: values.config,
                schedule: values.schedule,
                enabled: values.enabled,
                createdAt: values.createdAt,
              })
              .returning({ id: cb.id });
            const first = inserted[0];
            if (first === undefined) throw new Error("crm binding insert returned no id");
            return first.id;
          },
          catch: fail("crm binding insert failed"),
        }),

      patch: (id, patch) =>
        Effect.tryPromise({
          try: async () => {
            const set: Record<string, unknown> = {};
            if (patch.columns !== undefined) set.columns = patch.columns;
            if (patch.config !== undefined) set.config = patch.config;
            if (patch.schedule !== undefined) set.schedule = patch.schedule;
            if (patch.enabled !== undefined) set.enabled = patch.enabled;
            if (patch.pausedReason !== undefined) set.pausedReason = patch.pausedReason;
            if (patch.lastSyncedAt !== undefined) set.lastSyncedAt = patch.lastSyncedAt;
            if (patch.lastError !== undefined) set.lastError = patch.lastError;
            if (patch.rowsSynced !== undefined) set.rowsSynced = patch.rowsSynced;
            if (Object.keys(set).length === 0) return;
            await db.update(cb).set(set).where(eq(cb.id, id));
          },
          catch: fail("crm binding patch failed"),
        }),

      remove: (id) =>
        Effect.tryPromise({
          try: async () => {
            await db.delete(cb).where(eq(cb.id, id));
          },
          catch: fail("crm binding delete failed"),
        }),

      clearPause: ({ workspaceId, provider, reason }) =>
        Effect.tryPromise({
          try: async () => {
            const updated = await db
              .update(cb)
              .set({ pausedReason: null, lastError: null })
              .where(and(eq(cb.workspaceId, workspaceId), eq(cb.provider, provider), eq(cb.pausedReason, reason)))
              .returning({ id: cb.id });
            return updated.length;
          },
          catch: fail("crm binding unpause failed"),
        }),
    };
  }),
);

const CHUNK = 500;

export const CrmSyncedRowRepoLive: Layer.Layer<CrmSyncedRowRepo, never, DbClient> = Layer.effect(
  CrmSyncedRowRepo,
  Effect.gen(function* () {
    const db = yield* DbClient;
    const sr = schema.crmSyncedRows;
    const project = {
      id: sr.id,
      bindingId: sr.bindingId,
      rowId: sr.rowId,
      externalId: sr.externalId,
      matchKey: sr.matchKey,
      valuesHash: sr.valuesHash,
      lastSeenRunId: sr.lastSeenRunId,
      stale: sr.stale,
    };
    return {
      findByExternalIds: (bindingId, externalIds) =>
        externalIds.length === 0
          ? Effect.succeed([] as readonly CrmSyncedRow[])
          : Effect.tryPromise({
              try: () =>
                db
                  .select(project)
                  .from(sr)
                  .where(and(eq(sr.bindingId, bindingId), inArray(sr.externalId, [...externalIds]))),
              catch: fail("crm synced-row lookup failed"),
            }),

      findByMatchKeys: (bindingId, keys) =>
        keys.length === 0
          ? Effect.succeed([] as readonly CrmSyncedRow[])
          : Effect.tryPromise({
              try: () =>
                db
                  .select(project)
                  .from(sr)
                  .where(and(eq(sr.bindingId, bindingId), inArray(sr.matchKey, [...keys]))),
              catch: fail("crm synced-row match lookup failed"),
            }),

      upsertMany: (entries) =>
        entries.length === 0
          ? Effect.void
          : Effect.tryPromise({
              try: async () => {
                for (let i = 0; i < entries.length; i += CHUNK) {
                  const chunk = entries.slice(i, i + CHUNK);
                  await db
                    .insert(sr)
                    .values(
                      chunk.map((e) => ({
                        bindingId: e.bindingId,
                        rowId: e.rowId,
                        externalId: e.externalId,
                        matchKey: e.matchKey,
                        valuesHash: e.valuesHash,
                        lastSeenRunId: e.lastSeenRunId,
                        stale: false,
                        createdAt: e.createdAt,
                      })),
                    )
                    .onConflictDoUpdate({
                      target: [sr.bindingId, sr.externalId],
                      // `excluded.*` = the incoming values (plain column refs
                      // would no-op the update against the row's own values).
                      set: {
                        rowId: sql`excluded.row_id`,
                        matchKey: sql`excluded.match_key`,
                        valuesHash: sql`excluded.values_hash`,
                        lastSeenRunId: sql`excluded.last_seen_run_id`,
                        stale: false,
                      },
                    });
                }
              },
              catch: fail("crm synced-row upsert failed"),
            }),

      touchSeen: (bindingId, externalIds, runId) =>
        externalIds.length === 0
          ? Effect.void
          : Effect.tryPromise({
              try: async () => {
                for (let i = 0; i < externalIds.length; i += CHUNK) {
                  const chunk = externalIds.slice(i, i + CHUNK);
                  await db
                    .update(sr)
                    .set({ lastSeenRunId: runId, stale: false })
                    .where(and(eq(sr.bindingId, bindingId), inArray(sr.externalId, [...chunk])));
                }
              },
              catch: fail("crm synced-row touch failed"),
            }),

      markStaleNotSeen: (bindingId, runId) =>
        Effect.tryPromise({
          try: async () => {
            const flipped = await db
              .update(sr)
              .set({ stale: true })
              .where(
                and(
                  eq(sr.bindingId, bindingId),
                  eq(sr.stale, false),
                  or(isNull(sr.lastSeenRunId), ne(sr.lastSeenRunId, runId)),
                ),
              )
              .returning({ id: sr.id });
            return flipped.length;
          },
          catch: fail("crm stale marking failed"),
        }),

      countByBinding: (bindingId) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db.select({ n: count() }).from(sr).where(eq(sr.bindingId, bindingId));
            return rows[0]?.n ?? 0;
          },
          catch: fail("crm synced-row count failed"),
        }),
    };
  }),
);

export const CrmSyncRunRepoLive: Layer.Layer<CrmSyncRunRepo, never, DbClient> = Layer.effect(
  CrmSyncRunRepo,
  Effect.gen(function* () {
    const db = yield* DbClient;
    const runs = schema.crmSyncRuns;
    return {
      start: ({ workspaceId, bindingId, tableId, trigger, startedAt }) =>
        Effect.tryPromise({
          try: async () => {
            const inserted = await db
              .insert(runs)
              .values({
                workspaceId,
                bindingId,
                tableId,
                status: "running",
                trigger,
                rowsCreated: 0,
                rowsUpdated: 0,
                rowsSkipped: 0,
                rowsStaled: 0,
                startedAt,
              })
              .returning({ id: runs.id });
            const first = inserted[0];
            if (first === undefined) throw new Error("crm sync run insert returned no id");
            return first.id;
          },
          catch: fail("crm sync run start failed"),
        }),

      finish: (runId, args) =>
        Effect.tryPromise({
          try: async () => {
            await db
              .update(runs)
              .set({
                status: args.status,
                rowsCreated: args.rowsCreated,
                rowsUpdated: args.rowsUpdated,
                rowsSkipped: args.rowsSkipped,
                rowsStaled: args.rowsStaled,
                fieldsDropped: args.fieldsDropped,
                error: args.error,
                finishedAt: args.finishedAt,
              })
              .where(eq(runs.id, runId));
          },
          catch: fail("crm sync run finish failed"),
        }),

      progress: (runId, args) =>
        Effect.tryPromise({
          try: async () => {
            await db
              .update(runs)
              .set({
                rowsCreated: args.rowsCreated,
                rowsUpdated: args.rowsUpdated,
                rowsSkipped: args.rowsSkipped,
              })
              .where(eq(runs.id, runId));
          },
          catch: fail("crm sync run progress failed"),
        }),

      findById: (runId) =>
        UUID_RE.test(runId)
          ? Effect.tryPromise({
              try: async () => {
                const rows = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
                return Option.fromNullable(rows[0] === undefined ? null : rowToRun(rows[0]));
              },
              catch: fail("crm sync run lookup failed"),
            })
          : Effect.succeed(Option.none<CrmSyncRun>()),

      listByBinding: (bindingId, limit) =>
        UUID_RE.test(bindingId)
          ? Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .select()
                  .from(runs)
                  .where(eq(runs.bindingId, bindingId))
                  .orderBy(desc(runs.startedAt))
                  .limit(limit);
                return rows.map(rowToRun);
              },
              catch: fail("crm sync run list failed"),
            })
          : Effect.succeed([] as readonly CrmSyncRun[]),
    };
  }),
);

// ── In-memory layers (tests) ──────────────────────────────────────────────────

/** In-memory {@link CrmBindingRepo} over mutable fixtures (mirrors signalRepoLayer). */
export const crmBindingRepoLayer = (fixtures: {
  bindings?: CrmBinding[];
}): Layer.Layer<CrmBindingRepo> => {
  const bindings = fixtures.bindings ?? [];
  let seq = 0;
  const isDue = (b: CrmBinding, now: number): boolean =>
    b.enabled &&
    b.schedule === "daily" &&
    b.pausedReason === null &&
    (b.lastSyncedAt === null || b.lastSyncedAt <= now - CRM_DAILY_DUE_MS);
  return Layer.succeed(CrmBindingRepo, {
    findById: (id) => Effect.succeed(Option.fromNullable(bindings.find((b) => b.id === id))),
    listByTable: (tableId) =>
      Effect.succeed([...bindings].filter((b) => b.tableId === tableId).sort((a, b) => b.createdAt - a.createdAt)),
    listByWorkspace: (workspaceId) =>
      Effect.succeed(
        [...bindings].filter((b) => b.workspaceId === workspaceId).sort((a, b) => b.createdAt - a.createdAt),
      ),
    listDuePage: ({ now, limit, cursor }) =>
      Effect.succeed(
        (() => {
          const due = bindings
            .filter((b) => isDue(b, now))
            .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
          const after =
            cursor === null
              ? due
              : due.filter(
                  (b) => b.createdAt > cursor.createdAt || (b.createdAt === cursor.createdAt && b.id > cursor.id),
                );
          const slice = after.slice(0, limit);
          const last = slice[slice.length - 1];
          return {
            items: slice.map((b) => ({ id: b.id, workspaceId: b.workspaceId, createdAt: b.createdAt })),
            nextCursor:
              after.length > limit && last !== undefined ? { createdAt: last.createdAt, id: last.id } : null,
          };
        })(),
      ),
    insert: (values) =>
      Effect.sync(() => {
        const id = `crmb_${++seq}`;
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
        const i = bindings.findIndex((b) => b.id === id);
        if (i >= 0) bindings[i] = { ...bindings[i], ...patch } as CrmBinding;
      }),
    remove: (id) =>
      Effect.sync(() => {
        const i = bindings.findIndex((b) => b.id === id);
        if (i >= 0) bindings.splice(i, 1);
      }),
    clearPause: ({ workspaceId, provider, reason }) =>
      Effect.sync(() => {
        let n = 0;
        for (let i = 0; i < bindings.length; i++) {
          const b = bindings[i];
          if (b.workspaceId === workspaceId && b.provider === provider && b.pausedReason === reason) {
            bindings[i] = { ...b, pausedReason: null, lastError: null };
            n++;
          }
        }
        return n;
      }),
  });
};

/** In-memory {@link CrmSyncedRowRepo} over a mutable identity map. */
export const crmSyncedRowRepoLayer = (fixtures: {
  entries?: CrmSyncedRow[];
}): Layer.Layer<CrmSyncedRowRepo> => {
  const entries = fixtures.entries ?? [];
  let seq = 0;
  return Layer.succeed(CrmSyncedRowRepo, {
    findByExternalIds: (bindingId, externalIds) =>
      Effect.succeed(
        entries.filter((e) => e.bindingId === bindingId && externalIds.includes(e.externalId)),
      ),
    findByMatchKeys: (bindingId, keys) =>
      Effect.succeed(
        entries.filter((e) => e.bindingId === bindingId && e.matchKey !== null && keys.includes(e.matchKey)),
      ),
    upsertMany: (ups) =>
      Effect.sync(() => {
        for (const u of ups) {
          const i = entries.findIndex((e) => e.bindingId === u.bindingId && e.externalId === u.externalId);
          if (i >= 0) {
            entries[i] = {
              ...entries[i],
              rowId: u.rowId,
              matchKey: u.matchKey,
              valuesHash: u.valuesHash,
              lastSeenRunId: u.lastSeenRunId,
              stale: false,
            };
          } else {
            entries.push({
              id: `crmsr_${++seq}`,
              bindingId: u.bindingId,
              rowId: u.rowId,
              externalId: u.externalId,
              matchKey: u.matchKey,
              valuesHash: u.valuesHash,
              lastSeenRunId: u.lastSeenRunId,
              stale: false,
            });
          }
        }
      }),
    touchSeen: (bindingId, externalIds, runId) =>
      Effect.sync(() => {
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (e.bindingId === bindingId && externalIds.includes(e.externalId)) {
            entries[i] = { ...e, lastSeenRunId: runId, stale: false };
          }
        }
      }),
    markStaleNotSeen: (bindingId, runId) =>
      Effect.sync(() => {
        let n = 0;
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          if (e.bindingId === bindingId && !e.stale && e.lastSeenRunId !== runId) {
            entries[i] = { ...e, stale: true };
            n++;
          }
        }
        return n;
      }),
    countByBinding: (bindingId) =>
      Effect.succeed(entries.filter((e) => e.bindingId === bindingId).length),
  });
};

// Module-scoped so run ids stay unique even when a test builds several layer
// instances over the same fixtures — the stale pass compares lastSeenRunId
// against the CURRENT run id, and a reset counter would collide them (live
// runs use DB-generated uuids and can never collide).
let runSeq = 0;

/** In-memory {@link CrmSyncRunRepo} over a mutable run log. */
export const crmSyncRunRepoLayer = (fixtures: { runs?: CrmSyncRun[] }): Layer.Layer<CrmSyncRunRepo> => {
  const runs = fixtures.runs ?? [];
  return Layer.succeed(CrmSyncRunRepo, {
    start: ({ workspaceId, bindingId, tableId, trigger, startedAt }) =>
      Effect.sync(() => {
        const id = `crmrun_${++runSeq}`;
        runs.push({
          id,
          workspaceId,
          bindingId,
          tableId,
          status: "running",
          trigger,
          rowsCreated: 0,
          rowsUpdated: 0,
          rowsSkipped: 0,
          rowsStaled: 0,
          fieldsDropped: null,
          error: null,
          startedAt,
          finishedAt: null,
        });
        return id;
      }),
    finish: (runId, args) =>
      Effect.sync(() => {
        const i = runs.findIndex((r) => r.id === runId);
        if (i >= 0) runs[i] = { ...runs[i], ...args };
      }),
    progress: (runId, args) =>
      Effect.sync(() => {
        const i = runs.findIndex((r) => r.id === runId);
        if (i >= 0) runs[i] = { ...runs[i], ...args };
      }),
    findById: (runId) => Effect.succeed(Option.fromNullable(runs.find((r) => r.id === runId))),
    listByBinding: (bindingId, limit) =>
      Effect.succeed(
        [...runs]
          .filter((r) => r.bindingId === bindingId)
          .sort((a, b) => b.startedAt - a.startedAt)
          .slice(0, limit),
      ),
  });
};
