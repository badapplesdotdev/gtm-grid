/**
 * `ShareRepo` — the Effect <-> Drizzle adapter for the `table_shares` flow
 * (the "share a table via URL" feature).
 *
 * Mirrors the repo pattern of `invitation-repo.ts`: a `Context.Tag` with two
 * Layers —
 *   - {@link ShareRepoLive} — Drizzle-backed over `@gtmgrid/db`, depends on
 *     {@link DbClient}; every query is wrapped in `Effect.tryPromise` so a
 *     transport failure surfaces as the typed {@link ShareRepoError}.
 *   - {@link shareRepoLayer} — in-memory, backed by mutable arrays so the full
 *     create -> read -> revoke lifecycle runs with NO live database.
 *
 * Beyond the `table_shares` table itself it exposes {@link ShareRepo.tableWorkspace}
 * — a tiny `tables` lookup the service uses to resolve the owning workspace for
 * the membership gate (mirrors `InvitationRepo.workspaceName`).
 */

import { schema } from "@gtmgrid/db";
import { eq, inArray } from "drizzle-orm";
import { Context, Data, Effect, Layer, Option } from "effect";
import { DbClient } from "../db-client.js";

/**
 * A `table_shares` row projection. Mirrors the table in
 * packages/db/src/schema.ts. `snapshot` is the frozen, secret-free table
 * snapshot (validated against `share-snapshot.ts` before use).
 */
export interface TableShare {
  readonly id: string;
  readonly workspaceId: string;
  /** Source table id; null once the table is deleted (snapshot survives). */
  readonly tableId: string | null;
  readonly token: string;
  readonly name: string | null;
  readonly snapshot: unknown;
  readonly snapshotVersion: number;
  readonly enabled: boolean;
  readonly expiresAt: number | null;
  readonly createdBy: string | null;
  readonly createdAt: number;
  readonly revokedAt: number | null;
}

/** Fields needed to mint a new share row. */
export interface InsertShareInput {
  readonly workspaceId: string;
  readonly tableId: string;
  readonly token: string;
  readonly name: string | null;
  readonly snapshot: unknown;
  readonly snapshotVersion: number;
  readonly enabled: boolean;
  readonly expiresAt: number | null;
  readonly createdBy: string | null;
  readonly createdAt: number;
}

/** Raised when a share read/write fails (DB/transport error). */
export class ShareRepoError extends Data.TaggedError("ShareRepoError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Postgres uuid shape — share/table ids are uuid columns. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads + writes the table-share flow. Backed by Drizzle in production
 * ({@link ShareRepoLive}); by mutable in-memory arrays in tests
 * ({@link shareRepoLayer}).
 */
export class ShareRepo extends Context.Tag("ShareRepo")<
  ShareRepo,
  {
    /** The share for `token`, or `None`. */
    readonly findByToken: (
      token: string,
    ) => Effect.Effect<Option.Option<TableShare>, ShareRepoError>;
    /** The share by id, or `None`. */
    readonly findById: (
      id: string,
    ) => Effect.Effect<Option.Option<TableShare>, ShareRepoError>;
    /** A table's shares, newest first. */
    readonly listByTable: (
      tableId: string,
    ) => Effect.Effect<readonly TableShare[], ShareRepoError>;
    /** Insert a new share, returning the persisted row. */
    readonly insert: (
      input: InsertShareInput,
    ) => Effect.Effect<TableShare, ShareRepoError>;
    /** Disable a share (sets enabled=false + revokedAt). Idempotent. */
    readonly revoke: (
      id: string,
      revokedAt: number,
    ) => Effect.Effect<void, ShareRepoError>;
    /** The workspace that owns `tableId`, or `None` if the table is gone. */
    readonly tableWorkspace: (
      tableId: string,
    ) => Effect.Effect<Option.Option<string>, ShareRepoError>;
    /**
     * Hard-delete every share whose table is in `tableIds`. Project-delete
     * teardown: the public snapshot links die with the project (unlike a
     * single-table delete, where a share survives with `tableId` set null).
     */
    readonly deleteByTableIds: (
      tableIds: readonly string[],
    ) => Effect.Effect<void, ShareRepoError>;
  }
>() {}

/** A Drizzle table_shares row in the {@link TableShare} projection's shape. */
type ShareRow = {
  id: string;
  workspaceId: string;
  tableId: string | null;
  token: string;
  name: string | null;
  snapshot: unknown;
  snapshotVersion: number;
  enabled: boolean;
  expiresAt: number | null;
  createdBy: string | null;
  createdAt: number;
  revokedAt: number | null;
};

const toShare = (r: ShareRow): TableShare => ({
  id: r.id,
  workspaceId: r.workspaceId,
  tableId: r.tableId,
  token: r.token,
  name: r.name,
  snapshot: r.snapshot,
  snapshotVersion: r.snapshotVersion,
  enabled: r.enabled,
  expiresAt: r.expiresAt,
  createdBy: r.createdBy,
  createdAt: r.createdAt,
  revokedAt: r.revokedAt,
});

const SHARE_COLUMNS = {
  id: schema.tableShares.id,
  workspaceId: schema.tableShares.workspaceId,
  tableId: schema.tableShares.tableId,
  token: schema.tableShares.token,
  name: schema.tableShares.name,
  snapshot: schema.tableShares.snapshot,
  snapshotVersion: schema.tableShares.snapshotVersion,
  enabled: schema.tableShares.enabled,
  expiresAt: schema.tableShares.expiresAt,
  createdBy: schema.tableShares.createdBy,
  createdAt: schema.tableShares.createdAt,
  revokedAt: schema.tableShares.revokedAt,
} as const;

/**
 * The Drizzle-backed `ShareRepo` Layer. Depends on {@link DbClient}; every call
 * is wrapped so a transport failure becomes a typed {@link ShareRepoError}.
 */
export const ShareRepoLive: Layer.Layer<ShareRepo, never, DbClient> =
  Layer.effect(
    ShareRepo,
    Effect.gen(function* () {
      const db = yield* DbClient;

      const fail = (message: string) => (cause: unknown) =>
        new ShareRepoError({
          message: cause instanceof Error ? cause.message : message,
          cause,
        });

      const findByToken: ShareRepo["Type"]["findByToken"] = (token) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db
              .select(SHARE_COLUMNS)
              .from(schema.tableShares)
              .where(eq(schema.tableShares.token, token))
              .limit(1);
            return Option.fromNullable(
              rows[0] === undefined ? null : toShare(rows[0]),
            );
          },
          catch: fail("share lookup failed"),
        });

      const findById: ShareRepo["Type"]["findById"] = (id) =>
        !UUID_RE.test(id)
          ? Effect.succeed(Option.none())
          : Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .select(SHARE_COLUMNS)
                  .from(schema.tableShares)
                  .where(eq(schema.tableShares.id, id))
                  .limit(1);
                return Option.fromNullable(
                  rows[0] === undefined ? null : toShare(rows[0]),
                );
              },
              catch: fail("share lookup failed"),
            });

      const listByTable: ShareRepo["Type"]["listByTable"] = (tableId) =>
        !UUID_RE.test(tableId)
          ? Effect.succeed([])
          : Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .select(SHARE_COLUMNS)
                  .from(schema.tableShares)
                  .where(eq(schema.tableShares.tableId, tableId));
                return rows
                  .map(toShare)
                  .sort((a, b) => b.createdAt - a.createdAt);
              },
              catch: fail("share list failed"),
            });

      const insert: ShareRepo["Type"]["insert"] = (input) =>
        Effect.tryPromise({
          try: async () => {
            const inserted = await db
              .insert(schema.tableShares)
              .values({
                workspaceId: input.workspaceId,
                tableId: input.tableId,
                token: input.token,
                name: input.name,
                snapshot: input.snapshot,
                snapshotVersion: input.snapshotVersion,
                enabled: input.enabled,
                expiresAt: input.expiresAt,
                createdBy: input.createdBy,
                createdAt: input.createdAt,
              })
              .returning(SHARE_COLUMNS);
            return toShare(inserted[0]);
          },
          catch: fail("share insert failed"),
        });

      const revoke: ShareRepo["Type"]["revoke"] = (id, revokedAt) =>
        Effect.tryPromise({
          try: async () => {
            await db
              .update(schema.tableShares)
              .set({ enabled: false, revokedAt })
              .where(eq(schema.tableShares.id, id));
          },
          catch: fail("share revoke failed"),
        });

      const tableWorkspace: ShareRepo["Type"]["tableWorkspace"] = (tableId) =>
        !UUID_RE.test(tableId)
          ? Effect.succeed(Option.none())
          : Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .select({ workspaceId: schema.tables.workspaceId })
                  .from(schema.tables)
                  .where(eq(schema.tables.id, tableId))
                  .limit(1);
                return Option.fromNullable(rows[0]?.workspaceId ?? null);
              },
              catch: fail("table workspace lookup failed"),
            });

      const deleteByTableIds: ShareRepo["Type"]["deleteByTableIds"] = (tableIds) =>
        tableIds.length === 0
          ? Effect.void
          : Effect.tryPromise({
              try: () =>
                db
                  .delete(schema.tableShares)
                  .where(inArray(schema.tableShares.tableId, [...tableIds])),
              catch: fail("share delete failed"),
            });

      return {
        findByToken,
        findById,
        listByTable,
        insert,
        revoke,
        tableWorkspace,
        deleteByTableIds,
      };
    }),
  );

/** A table projection the in-memory repo needs (id -> workspace). */
export interface InMemoryShareTable {
  readonly id: string;
  readonly workspaceId: string;
}

/** Fixtures for the in-memory {@link shareRepoLayer}. */
export interface ShareRepoFixtures {
  /** Share rows (MUTATED by insert/revoke). */
  readonly shares?: readonly TableShare[];
  /** Tables backing {@link ShareRepo.tableWorkspace} resolution. */
  readonly tables?: readonly InMemoryShareTable[];
}

/**
 * An in-memory `ShareRepo` Layer backed by MUTABLE copies of the fixtures, so
 * the create -> read -> revoke lifecycle is exercised exactly like the Drizzle
 * Layer but with NO live database.
 */
export const shareRepoLayer = (
  fixtures: ShareRepoFixtures = {},
): Layer.Layer<ShareRepo> => {
  const shares: TableShare[] = [...(fixtures.shares ?? [])];
  const tables = fixtures.tables ?? [];
  let counter = shares.length;

  return Layer.succeed(ShareRepo, {
    findByToken: (token) =>
      Effect.succeed(Option.fromNullable(shares.find((s) => s.token === token))),
    findById: (id) =>
      Effect.succeed(Option.fromNullable(shares.find((s) => s.id === id))),
    listByTable: (tableId) =>
      Effect.succeed(
        shares
          .filter((s) => s.tableId === tableId)
          .sort((a, b) => b.createdAt - a.createdAt),
      ),
    insert: (input) =>
      Effect.sync(() => {
        const created: TableShare = {
          id: `share_${++counter}_${input.token.slice(0, 8)}`,
          workspaceId: input.workspaceId,
          tableId: input.tableId,
          token: input.token,
          name: input.name,
          snapshot: input.snapshot,
          snapshotVersion: input.snapshotVersion,
          enabled: input.enabled,
          expiresAt: input.expiresAt,
          createdBy: input.createdBy,
          createdAt: input.createdAt,
          revokedAt: null,
        };
        shares.push(created);
        return created;
      }),
    revoke: (id, revokedAt) =>
      Effect.sync(() => {
        const idx = shares.findIndex((s) => s.id === id);
        if (idx >= 0) {
          shares[idx] = { ...shares[idx], enabled: false, revokedAt };
        }
      }),
    tableWorkspace: (tableId) =>
      Effect.succeed(
        Option.fromNullable(
          tables.find((t) => t.id === tableId)?.workspaceId ?? null,
        ),
      ),
    deleteByTableIds: (tableIds) =>
      Effect.sync(() => {
        const drop = new Set(tableIds);
        for (let i = shares.length - 1; i >= 0; i -= 1) {
          const t = shares[i]?.tableId;
          if (t !== null && t !== undefined && drop.has(t)) shares.splice(i, 1);
        }
      }),
  });
};
