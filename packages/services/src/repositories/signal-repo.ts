/**
 * `SignalRepo` — the Effect <-> Drizzle adapter for `signal_bindings` (a cloud
 * table fed by a scheduled Trigify social-signal search). CRUD only; the grid
 * row/cell writes are reused from {@link WebhookRepo}. Mirrors the two-Layer
 * shape of {@link WebhookRepo} (Drizzle-backed + in-memory test).
 */

import { schema } from "@gtmgrid/db";
import { and, asc, desc, eq, gt, isNull, lte, ne, or, sql } from "drizzle-orm";
import { Context, Data, Effect, Layer, Option } from "effect";
import { DbClient } from "../db-client.js";
import { isBindingDue, SCHEDULE_DUE_MS, type SignalSchedule } from "../signals/catalog.js";

/** A result-field → column id mapping entry for a signal binding. */
export interface SignalBindingColumn {
  readonly key: string;
  readonly columnId: string;
}

/** A signal_bindings row projection. Mirrors `signalBindings`. */
export interface SignalBinding {
  readonly id: string;
  readonly workspaceId: string;
  readonly tableId: string;
  readonly sourceId: string;
  readonly label: string;
  readonly kind: string;
  readonly searchId: string | null;
  readonly config: Record<string, unknown>;
  readonly schedule: string;
  readonly columns: readonly SignalBindingColumn[];
  readonly seen: readonly string[] | null;
  readonly lastSyncedAt: number | null;
  readonly lastError: string | null;
  readonly rowsPulled: number | null;
  readonly enabled: boolean;
  readonly createdAt: number;
}

/** Fields a binding insert supplies. */
export interface SignalBindingInsert {
  readonly workspaceId: string;
  readonly tableId: string;
  readonly sourceId: string;
  readonly label: string;
  readonly kind: string;
  readonly searchId: string | null;
  readonly config: Record<string, unknown>;
  readonly schedule: string;
  readonly columns: readonly SignalBindingColumn[];
  readonly enabled: boolean;
  readonly createdAt: number;
}

/** A keyset cursor over due bindings, seeking on `(createdAt, id)`. */
export interface SignalDueCursor {
  readonly createdAt: number;
  readonly id: string;
}

/** A due binding the cron needs to enqueue (the only fields the event carries). */
export interface DueBinding {
  readonly id: string;
  readonly workspaceId: string;
  readonly createdAt: number;
}

/** One keyset page of due bindings plus the cursor to fetch the next. */
export interface DueBindingPage {
  readonly items: readonly DueBinding[];
  readonly nextCursor: SignalDueCursor | null;
}

/** A patch over a binding; only present fields are written. */
export interface SignalBindingPatch {
  readonly searchId?: string | null;
  readonly schedule?: string;
  readonly config?: Record<string, unknown>;
  readonly lastSyncedAt?: number | null;
  readonly lastError?: string | null;
  readonly rowsPulled?: number | null;
  readonly enabled?: boolean;
}

/** Raised when a signal-binding read or write fails. */
export class SignalRepoError extends Data.TaggedError("SignalRepoError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class SignalRepo extends Context.Tag("SignalRepo")<
  SignalRepo,
  {
    readonly findById: (id: string) => Effect.Effect<Option.Option<SignalBinding>, SignalRepoError>;
    readonly listByTable: (tableId: string) => Effect.Effect<readonly SignalBinding[], SignalRepoError>;
    /**
     * One keyset page of DUE bindings (enabled, non-manual, `last_synced_at` null
     * or older than its schedule interval relative to `now`), seeking on
     * `(created_at, id)`. Pushes the {@link isBindingDue} predicate into SQL with
     * a `LIMIT`, so the cron never loads + JS-filters the whole enabled
     * population. `cursor === null` starts from the first page.
     */
    readonly listDuePage: (args: {
      readonly now: number;
      readonly limit: number;
      readonly cursor: SignalDueCursor | null;
    }) => Effect.Effect<DueBindingPage, SignalRepoError>;
    readonly insert: (values: SignalBindingInsert) => Effect.Effect<string, SignalRepoError>;
    readonly patch: (id: string, patch: SignalBindingPatch) => Effect.Effect<void, SignalRepoError>;
    readonly remove: (id: string) => Effect.Effect<void, SignalRepoError>;
    /**
     * Durably record `keys` as seen for a binding and return ONLY the subset that
     * was genuinely new (inserted now). Backed by an `ON CONFLICT DO NOTHING`
     * bulk upsert over the `(binding_id, key)` unique index, so dedupe is correct
     * for a binding of ANY size — replacing the bounded, truncation-prone
     * `seen` jsonb array. An empty `keys` returns empty without touching the DB.
     */
    readonly recordSeenKeys: (
      bindingId: string,
      keys: readonly string[],
    ) => Effect.Effect<readonly string[], SignalRepoError>;
  }
>() {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asColumns(value: unknown): readonly SignalBindingColumn[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((e) => {
    if (e === null || typeof e !== "object") return [];
    const r = e as Record<string, unknown>;
    if (typeof r.key === "string" && typeof r.columnId === "string") return [{ key: r.key, columnId: r.columnId }];
    return [];
  });
}
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function asSeen(value: unknown): readonly string[] | null {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : null;
}

function rowToBinding(r: {
  id: string;
  workspaceId: string;
  tableId: string;
  sourceId: string;
  label: string;
  kind: string;
  searchId: string | null;
  config: unknown;
  schedule: string;
  columns: unknown;
  seen: unknown;
  lastSyncedAt: number | null;
  lastError: string | null;
  rowsPulled: number | null;
  enabled: boolean;
  createdAt: number;
}): SignalBinding {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    tableId: r.tableId,
    sourceId: r.sourceId,
    label: r.label,
    kind: r.kind,
    searchId: r.searchId,
    config: asRecord(r.config),
    schedule: r.schedule,
    columns: asColumns(r.columns),
    seen: asSeen(r.seen),
    lastSyncedAt: r.lastSyncedAt,
    lastError: r.lastError,
    rowsPulled: r.rowsPulled,
    enabled: r.enabled,
    createdAt: r.createdAt,
  };
}

const fail = (message: string) => (cause: unknown) =>
  new SignalRepoError({ message: cause instanceof Error ? cause.message : message, cause });

export const SignalRepoLive: Layer.Layer<SignalRepo, never, DbClient> = Layer.effect(
  SignalRepo,
  Effect.gen(function* () {
    const db = yield* DbClient;
    return {
      findById: (id) =>
        UUID_RE.test(id)
          ? Effect.tryPromise({
              try: async () => {
                const rows = await db.select().from(schema.signalBindings).where(eq(schema.signalBindings.id, id)).limit(1);
                return Option.fromNullable(rows[0] === undefined ? null : rowToBinding(rows[0]));
              },
              catch: fail("signal binding lookup failed"),
            })
          : Effect.succeed(Option.none<SignalBinding>()),

      listByTable: (tableId) =>
        UUID_RE.test(tableId)
          ? Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .select()
                  .from(schema.signalBindings)
                  .where(eq(schema.signalBindings.tableId, tableId))
                  .orderBy(desc(schema.signalBindings.createdAt));
                return rows.map(rowToBinding);
              },
              catch: fail("signal binding list failed"),
            })
          : Effect.succeed([] as readonly SignalBinding[]),

      listDuePage: ({ now, limit, cursor }) =>
        Effect.tryPromise({
          try: async () => {
            const sb = schema.signalBindings;
            // `now - last_synced_at >= interval(schedule)` ⇔
            // `last_synced_at <= now - interval(schedule)`. Express the per-
            // schedule interval as a CASE so the whole predicate stays in SQL.
            // A `manual`/unknown schedule never matches (it's excluded by the
            // `ne(schedule, "manual")` clause and falls through the CASE to
            // NULL, so the `lte` below is never true — mirroring
            // `isBindingDue` returning false). NULL, not -Infinity:
            // `last_synced_at` is bigint and Postgres rejects -Infinity for
            // integer types, which made this query fail on every execution.
            const dueThreshold = sql<number>`CASE ${sb.schedule}
              WHEN 'hourly' THEN ${now - SCHEDULE_DUE_MS.hourly}
              WHEN 'daily' THEN ${now - SCHEDULE_DUE_MS.daily}
              WHEN 'weekly' THEN ${now - SCHEDULE_DUE_MS.weekly}
              ELSE NULL
            END`;
            const duePredicate = and(
              eq(sb.enabled, true),
              ne(sb.schedule, "manual"),
              or(isNull(sb.lastSyncedAt), lte(sb.lastSyncedAt, dueThreshold)),
            );
            // Keyset seek on (created_at, id) so paging is index-friendly and
            // stable under concurrent inserts.
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
            // Fetch one extra to decide whether a next page exists.
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
          catch: fail("signal due page failed"),
        }),

      insert: (values) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db
              .insert(schema.signalBindings)
              .values({
                workspaceId: values.workspaceId,
                tableId: values.tableId,
                sourceId: values.sourceId,
                label: values.label,
                kind: values.kind,
                searchId: values.searchId,
                config: values.config,
                schedule: values.schedule,
                columns: values.columns,
                seen: [],
                lastSyncedAt: null,
                lastError: null,
                rowsPulled: 0,
                enabled: values.enabled,
                createdAt: values.createdAt,
              })
              .returning({ id: schema.signalBindings.id });
            const id = rows[0]?.id;
            if (id === undefined) throw new Error("signal binding insert returned no id");
            return id;
          },
          catch: fail("signal binding insert failed"),
        }),

      patch: (id, patch) =>
        Effect.tryPromise({
          try: async () => {
            await db
              .update(schema.signalBindings)
              .set(patch as Record<string, unknown>)
              .where(eq(schema.signalBindings.id, id));
          },
          catch: fail("signal binding patch failed"),
        }),

      remove: (id) =>
        Effect.tryPromise({
          try: async () => {
            await db.delete(schema.signalBindings).where(eq(schema.signalBindings.id, id));
          },
          catch: fail("signal binding delete failed"),
        }),

      recordSeenKeys: (bindingId, keys) =>
        keys.length === 0
          ? Effect.succeed([] as readonly string[])
          : Effect.tryPromise({
              try: async () => {
                const now = Date.now();
                // De-dupe within the batch first so a single payload that repeats
                // a key doesn't trip the unique constraint mid-insert.
                const unique = [...new Set(keys)];
                const inserted = await db
                  .insert(schema.signalSeenKeys)
                  .values(unique.map((key) => ({ bindingId, key, createdAt: now })))
                  .onConflictDoNothing({
                    target: [schema.signalSeenKeys.bindingId, schema.signalSeenKeys.key],
                  })
                  .returning({ key: schema.signalSeenKeys.key });
                return inserted.map((r) => r.key);
              },
              catch: fail("signal seen-key record failed"),
            }),
    };
  }),
);

/** In-memory `SignalRepo` for tests, backed by a mutable fixture array. */
export const signalRepoLayer = (fixtures: {
  bindings?: SignalBinding[];
  /** Pre-seen keys per binding id; defaults to each binding's `seen` array. */
  seenKeys?: Map<string, Set<string>>;
}): Layer.Layer<SignalRepo> => {
  const bindings = fixtures.bindings ?? [];
  // Durable per-binding seen set. Seeded from each binding's legacy `seen` array
  // so existing fixtures (e.g. `binding({ seen: ["r1"] })`) dedupe identically.
  const seenKeys = fixtures.seenKeys ?? new Map<string, Set<string>>();
  for (const b of bindings) {
    if (!seenKeys.has(b.id)) seenKeys.set(b.id, new Set(b.seen ?? []));
  }
  let seq = 0;
  return Layer.succeed(SignalRepo, {
    findById: (id) => Effect.succeed(Option.fromNullable(bindings.find((b) => b.id === id))),
    listByTable: (tableId) =>
      Effect.succeed([...bindings].filter((b) => b.tableId === tableId).sort((a, b) => b.createdAt - a.createdAt)),
    listDuePage: ({ now, limit, cursor }) =>
      Effect.succeed(
        (() => {
          const due = bindings
            .filter((b) =>
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
    recordSeenKeys: (bindingId, keys) =>
      Effect.sync(() => {
        const set = seenKeys.get(bindingId) ?? new Set<string>();
        seenKeys.set(bindingId, set);
        const inserted: string[] = [];
        for (const key of keys) {
          if (!set.has(key)) {
            set.add(key);
            inserted.push(key);
          }
        }
        return inserted;
      }),
    insert: (values) =>
      Effect.sync(() => {
        const id = `signal_${++seq}`;
        bindings.push({
          ...values,
          id,
          seen: [],
          lastSyncedAt: null,
          lastError: null,
          rowsPulled: 0,
        });
        return id;
      }),
    patch: (id, patch) =>
      Effect.sync(() => {
        const i = bindings.findIndex((b) => b.id === id);
        if (i >= 0) bindings[i] = { ...bindings[i], ...patch } as SignalBinding;
      }),
    remove: (id) =>
      Effect.sync(() => {
        const i = bindings.findIndex((b) => b.id === id);
        if (i >= 0) bindings.splice(i, 1);
      }),
  });
};
