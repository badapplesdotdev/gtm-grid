/**
 * `SignalRepo` — the Effect <-> Drizzle adapter for `signal_bindings` (a cloud
 * table fed by a scheduled Trigify social-signal search). CRUD only; the grid
 * row/cell writes are reused from {@link WebhookRepo}. Mirrors the two-Layer
 * shape of {@link WebhookRepo} (Drizzle-backed + in-memory test).
 */

import { schema } from "@gtmgrid/db";
import { desc, eq } from "drizzle-orm";
import { Context, Data, Effect, Layer, Option } from "effect";
import { DbClient } from "../db-client.js";

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

/** A patch over a binding; only present fields are written. */
export interface SignalBindingPatch {
  readonly searchId?: string | null;
  readonly schedule?: string;
  readonly config?: Record<string, unknown>;
  readonly seen?: readonly string[];
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
    /** Every enabled binding across all workspaces — the cron worker filters by due. */
    readonly listAllEnabled: () => Effect.Effect<readonly SignalBinding[], SignalRepoError>;
    readonly insert: (values: SignalBindingInsert) => Effect.Effect<string, SignalRepoError>;
    readonly patch: (id: string, patch: SignalBindingPatch) => Effect.Effect<void, SignalRepoError>;
    readonly remove: (id: string) => Effect.Effect<void, SignalRepoError>;
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

      listAllEnabled: () =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db.select().from(schema.signalBindings).where(eq(schema.signalBindings.enabled, true));
            return rows.map(rowToBinding);
          },
          catch: fail("signal binding scan failed"),
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
    };
  }),
);

/** In-memory `SignalRepo` for tests, backed by a mutable fixture array. */
export const signalRepoLayer = (fixtures: { bindings?: SignalBinding[] } = {}): Layer.Layer<SignalRepo> => {
  const bindings = fixtures.bindings ?? [];
  let seq = 0;
  return Layer.succeed(SignalRepo, {
    findById: (id) => Effect.succeed(Option.fromNullable(bindings.find((b) => b.id === id))),
    listByTable: (tableId) =>
      Effect.succeed([...bindings].filter((b) => b.tableId === tableId).sort((a, b) => b.createdAt - a.createdAt)),
    listAllEnabled: () => Effect.succeed(bindings.filter((b) => b.enabled)),
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
