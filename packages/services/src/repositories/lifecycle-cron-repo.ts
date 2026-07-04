/**
 * `LifecycleCronRepo` — the Effect <-> Drizzle adapter behind the CRON-DRIVEN
 * lifecycle emails (#8, #9, #11, #14, #16, #17, #18). Where {@link LifecycleEmailRepo}
 * owns the shared send-log/recipient seams, this repo owns the SCAN queries each
 * scheduled Inngest function runs to decide who to email:
 *
 *   - {@link LifecycleCronRepo.findFirstTableCandidates} (#8) — young workspaces
 *     with zero tables.
 *   - {@link LifecycleCronRepo.findColumnsAreFunctionsCandidates} (#9) —
 *     workspaces with a table but no function column yet.
 *   - {@link LifecycleCronRepo.findInviteTeamCandidates} (#11) — activated,
 *     single-member workspaces.
 *   - {@link LifecycleCronRepo.findCreditWarningCandidates} (#18) — workspaces
 *     at/over 80% of their cloud-action cap.
 *   - {@link LifecycleCronRepo.findWeeklyDigestTargets} (#14) — workspaces with
 *     activity in a window + their members + per-workspace stats.
 *   - {@link LifecycleCronRepo.findDormantCandidates} (#16) — users who went
 *     quiet 7–8 days ago + a snapshot of what changed while they were away.
 *   - {@link LifecycleCronRepo.findTrialWinbackCandidates} (#17) — lapsed trials
 *     that never converted + what they built.
 *
 * Every method returns PLAIN, JSON-serializable rows so the caller can memoize
 * the scan inside a single Inngest `step.run`. The queries are deliberately
 * generous (the send-guard's unique (user, template, dedupeKey) claim dedupes,
 * so overlapping/re-run scans never double-send); each takes a `limit` so a bad
 * day can't fan out unbounded.
 *
 * Two Layers, mirroring {@link LifecycleEmailRepo}: Drizzle-backed
 * {@link LifecycleCronRepoLive} and the fixture-injecting in-memory
 * {@link lifecycleCronRepoLayer} for offline tests.
 */

import { schema } from "@gtmgrid/db";
import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  notExists,
  sql,
} from "drizzle-orm";
import { Context, Data, Effect, Layer } from "effect";
import { DbClient } from "../db-client.js";

/** A workspace-owner-directed send target (owner id resolves the recipient). */
export interface CronOwnerTarget {
  readonly workspaceId: string;
  readonly ownerId: string;
}

/** #9 target — carries the workspace's first table name for the copy. */
export interface ColumnsFunctionTarget extends CronOwnerTarget {
  readonly firstTableName: string;
}

/** #11 target — carries the workspace name + current member count. */
export interface InviteTeamTarget extends CronOwnerTarget {
  readonly workspaceName: string;
  readonly memberCount: number;
}

/** #18 target — carries the metering numbers for the usage bar. */
export interface CreditWarningTarget extends CronOwnerTarget {
  readonly used: number;
  readonly limit: number;
}

/** One "most active table" line for the weekly digest. */
export interface DigestTopTable {
  readonly name: string;
  readonly rowsAdded: number;
}

/** #14 target — every member of an active workspace gets this digest. */
export interface WeeklyDigestTarget {
  readonly workspaceId: string;
  readonly workspaceName: string;
  /** Every member's user id (the caller sends one digest per member). */
  readonly memberUserIds: readonly string[];
  /** Done cells produced in the window. */
  readonly rowsEnriched: number;
  /** Cells that reached a terminal (done|error) state in the window. */
  readonly runsCompleted: number;
  /**
   * APPROXIMATION: the workspace's lifetime `cloudActionsUsed` counter — there is
   * no per-window credit ledger to diff against, so this is the running total,
   * not a weekly delta. Documented so the digest copy is not read as "this week".
   */
  readonly creditsUsed: number;
  /** APPROXIMATION: total member count (no per-user activity signal to filter on). */
  readonly teammatesActive: number;
  readonly topTables: readonly DigestTopTable[];
}

/** #16 target — a newly-dormant user + a snapshot of their busiest table. */
export interface DormantTarget {
  readonly userId: string;
  /** Epoch ms of the last heartbeat (the dedupe key, so a NEW spell re-fires). */
  readonly lastActiveAtMs: number;
  readonly table: string;
  readonly cellsChanged: number;
  readonly newRows: number;
  readonly columnsRecomputed: number;
  readonly rowsNeedRerun: number;
}

/** #17 target — a lapsed trial + what is still saved in the workspace. */
export interface TrialWinbackTarget extends CronOwnerTarget {
  readonly tableCount: number;
  readonly rowsEnriched: number;
  readonly columnCount: number;
}

/** Raised when a lifecycle-cron scan fails (DB/transport error). */
export class LifecycleCronRepoError extends Data.TaggedError(
  "LifecycleCronRepoError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class LifecycleCronRepo extends Context.Tag("LifecycleCronRepo")<
  LifecycleCronRepo,
  {
    /** #8: workspaces created within [createdFromMs, createdToMs] with ZERO tables. */
    readonly findFirstTableCandidates: (
      createdFromMs: number,
      createdToMs: number,
      limit: number,
    ) => Effect.Effect<readonly CronOwnerTarget[], LifecycleCronRepoError>;
    /** #9: workspaces created on/before the cutoff with ≥1 table but NO function column. */
    readonly findColumnsAreFunctionsCandidates: (
      createdBeforeMs: number,
      limit: number,
    ) => Effect.Effect<readonly ColumnsFunctionTarget[], LifecycleCronRepoError>;
    /** #11: workspaces created on/before the cutoff, activated (a run happened), with exactly 1 member. */
    readonly findInviteTeamCandidates: (
      createdBeforeMs: number,
      limit: number,
    ) => Effect.Effect<readonly InviteTeamTarget[], LifecycleCronRepoError>;
    /** #18: workspaces with a cloud-action cap that are at/over 80% used. */
    readonly findCreditWarningCandidates: (
      limit: number,
    ) => Effect.Effect<readonly CreditWarningTarget[], LifecycleCronRepoError>;
    /** #14: workspaces with any cell updated in [fromMs, toMs], with members + stats. */
    readonly findWeeklyDigestTargets: (
      fromMs: number,
      toMs: number,
      limit: number,
    ) => Effect.Effect<readonly WeeklyDigestTarget[], LifecycleCronRepoError>;
    /** #16: users whose lastActiveAt falls in [fromMs, toMs], with a table snapshot. */
    readonly findDormantCandidates: (
      fromMs: number,
      toMs: number,
      limit: number,
    ) => Effect.Effect<readonly DormantTarget[], LifecycleCronRepoError>;
    /** #17: workspaces on no paid plan whose trial ended in [fromMs, toMs]. */
    readonly findTrialWinbackCandidates: (
      fromMs: number,
      toMs: number,
      limit: number,
    ) => Effect.Effect<readonly TrialWinbackTarget[], LifecycleCronRepoError>;
  }
>() {}

const fail = (message: string) => (cause: unknown) =>
  new LifecycleCronRepoError({
    message: cause instanceof Error ? cause.message : message,
    cause,
  });

/** Terminal cell statuses that count as "a run happened". */
const RAN_STATUSES = ["done", "error"] as const;

/** The Drizzle-backed Layer. */
export const LifecycleCronRepoLive: Layer.Layer<
  LifecycleCronRepo,
  never,
  DbClient
> = Layer.effect(
  LifecycleCronRepo,
  Effect.gen(function* () {
    const db = yield* DbClient;
    return {
      findFirstTableCandidates: (createdFromMs, createdToMs, limit) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db
              .select({
                workspaceId: schema.workspaces.id,
                ownerId: schema.workspaces.ownerId,
              })
              .from(schema.workspaces)
              .where(
                and(
                  gte(schema.workspaces.createdAt, createdFromMs),
                  lte(schema.workspaces.createdAt, createdToMs),
                  notExists(
                    db
                      .select({ n: sql`1` })
                      .from(schema.tables)
                      .where(
                        eq(schema.tables.workspaceId, schema.workspaces.id),
                      ),
                  ),
                ),
              )
              .limit(limit);
            return rows;
          },
          catch: fail("first-table scan"),
        }),

      findColumnsAreFunctionsCandidates: (createdBeforeMs, limit) =>
        Effect.tryPromise({
          try: async () => {
            const candidates = await db
              .select({
                workspaceId: schema.workspaces.id,
                ownerId: schema.workspaces.ownerId,
              })
              .from(schema.workspaces)
              .where(
                and(
                  lte(schema.workspaces.createdAt, createdBeforeMs),
                  exists(
                    db
                      .select({ n: sql`1` })
                      .from(schema.tables)
                      .where(
                        eq(schema.tables.workspaceId, schema.workspaces.id),
                      ),
                  ),
                  notExists(
                    db
                      .select({ n: sql`1` })
                      .from(schema.columns)
                      .where(
                        and(
                          eq(schema.columns.workspaceId, schema.workspaces.id),
                          eq(schema.columns.kind, "function"),
                        ),
                      ),
                  ),
                ),
              )
              .limit(limit);
            if (candidates.length === 0) return [];
            // The earliest-created table's name for each candidate workspace.
            const ids = candidates.map((c) => c.workspaceId);
            const tableRows = await db
              .select({
                workspaceId: schema.tables.workspaceId,
                name: schema.tables.name,
                createdAt: schema.tables.createdAt,
              })
              .from(schema.tables)
              .where(inArray(schema.tables.workspaceId, ids));
            const firstName = new Map<string, { name: string; createdAt: number }>();
            for (const t of tableRows) {
              const prev = firstName.get(t.workspaceId);
              if (prev === undefined || t.createdAt < prev.createdAt) {
                firstName.set(t.workspaceId, { name: t.name, createdAt: t.createdAt });
              }
            }
            return candidates.map((c) => ({
              workspaceId: c.workspaceId,
              ownerId: c.ownerId,
              firstTableName: firstName.get(c.workspaceId)?.name ?? "your table",
            }));
          },
          catch: fail("columns-are-functions scan"),
        }),

      findInviteTeamCandidates: (createdBeforeMs, limit) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db
              .select({
                workspaceId: schema.workspaces.id,
                ownerId: schema.workspaces.ownerId,
                workspaceName: schema.workspaces.name,
              })
              .from(schema.workspaces)
              .where(
                and(
                  lte(schema.workspaces.createdAt, createdBeforeMs),
                  exists(
                    db
                      .select({ n: sql`1` })
                      .from(schema.cells)
                      .where(
                        and(
                          eq(schema.cells.workspaceId, schema.workspaces.id),
                          inArray(schema.cells.status, [...RAN_STATUSES]),
                        ),
                      ),
                  ),
                  sql`(select count(*) from ${schema.members} where ${schema.members.workspaceId} = ${schema.workspaces.id}) = 1`,
                ),
              )
              .limit(limit);
            return rows.map((r) => ({
              workspaceId: r.workspaceId,
              ownerId: r.ownerId,
              workspaceName: r.workspaceName,
              memberCount: 1,
            }));
          },
          catch: fail("invite-team scan"),
        }),

      findCreditWarningCandidates: (limit) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db
              .select({
                workspaceId: schema.workspaces.id,
                ownerId: schema.workspaces.ownerId,
                used: schema.workspaces.cloudActionsUsed,
                limit: schema.workspaces.cloudActionsLimit,
              })
              .from(schema.workspaces)
              .where(
                and(
                  isNotNull(schema.workspaces.cloudActionsLimit),
                  sql`coalesce(${schema.workspaces.cloudActionsUsed}, 0) >= 0.8 * ${schema.workspaces.cloudActionsLimit}`,
                ),
              )
              .limit(limit);
            return rows.flatMap((r) =>
              r.limit === null
                ? []
                : [
                    {
                      workspaceId: r.workspaceId,
                      ownerId: r.ownerId,
                      used: r.used ?? 0,
                      limit: r.limit,
                    },
                  ],
            );
          },
          catch: fail("credit-warning scan"),
        }),

      findWeeklyDigestTargets: (fromMs, toMs, limit) =>
        Effect.tryPromise({
          try: async () => {
            // Active workspaces + terminal-cell counts, in one grouped scan.
            const active = await db
              .select({
                workspaceId: schema.cells.workspaceId,
                runsCompleted: count(),
                rowsEnriched: sql<number>`count(*) filter (where ${schema.cells.status} = 'done')`,
              })
              .from(schema.cells)
              .where(
                and(
                  isNotNull(schema.cells.updatedAt),
                  gte(schema.cells.updatedAt, fromMs),
                  lte(schema.cells.updatedAt, toMs),
                  inArray(schema.cells.status, [...RAN_STATUSES]),
                ),
              )
              .groupBy(schema.cells.workspaceId)
              .limit(limit);
            if (active.length === 0) return [];
            const ids = active.map((a) => a.workspaceId);

            const wsRows = await db
              .select({
                id: schema.workspaces.id,
                name: schema.workspaces.name,
                cloudActionsUsed: schema.workspaces.cloudActionsUsed,
              })
              .from(schema.workspaces)
              .where(inArray(schema.workspaces.id, ids));
            const wsById = new Map(wsRows.map((w) => [w.id, w]));

            const memberRows = await db
              .select({
                workspaceId: schema.members.workspaceId,
                userId: schema.members.userId,
              })
              .from(schema.members)
              .where(inArray(schema.members.workspaceId, ids));
            const membersByWs = new Map<string, string[]>();
            for (const m of memberRows) {
              const list = membersByWs.get(m.workspaceId) ?? [];
              list.push(m.userId);
              membersByWs.set(m.workspaceId, list);
            }

            // Top tables by rows CREATED in the window.
            const topRows = await db
              .select({
                workspaceId: schema.rows.workspaceId,
                tableId: schema.rows.tableId,
                name: schema.tables.name,
                rowsAdded: count(),
              })
              .from(schema.rows)
              .innerJoin(schema.tables, eq(schema.tables.id, schema.rows.tableId))
              .where(
                and(
                  inArray(schema.rows.workspaceId, ids),
                  gte(schema.rows.createdAt, fromMs),
                  lte(schema.rows.createdAt, toMs),
                ),
              )
              .groupBy(
                schema.rows.workspaceId,
                schema.rows.tableId,
                schema.tables.name,
              );
            const topByWs = new Map<string, DigestTopTable[]>();
            for (const t of topRows) {
              const list = topByWs.get(t.workspaceId) ?? [];
              list.push({ name: t.name, rowsAdded: t.rowsAdded });
              topByWs.set(t.workspaceId, list);
            }

            return active.map((a) => {
              const ws = wsById.get(a.workspaceId);
              const memberUserIds = membersByWs.get(a.workspaceId) ?? [];
              const topTables = (topByWs.get(a.workspaceId) ?? [])
                .sort((x, y) => y.rowsAdded - x.rowsAdded)
                .slice(0, 3);
              return {
                workspaceId: a.workspaceId,
                workspaceName: ws?.name ?? "your workspace",
                memberUserIds,
                rowsEnriched: Number(a.rowsEnriched),
                runsCompleted: Number(a.runsCompleted),
                creditsUsed: ws?.cloudActionsUsed ?? 0,
                teammatesActive: memberUserIds.length,
                topTables,
              };
            });
          },
          catch: fail("weekly-digest scan"),
        }),

      findDormantCandidates: (fromMs, toMs, limit) =>
        Effect.tryPromise({
          try: async () => {
            const users = await db
              .select({
                id: schema.users.id,
                lastActiveAt: schema.users.lastActiveAt,
              })
              .from(schema.users)
              .where(
                and(
                  isNotNull(schema.users.lastActiveAt),
                  gte(schema.users.lastActiveAt, new Date(fromMs)),
                  lte(schema.users.lastActiveAt, new Date(toMs)),
                ),
              )
              .limit(limit);

            const out: DormantTarget[] = [];
            for (const u of users) {
              if (u.lastActiveAt === null) continue;
              const lastActiveMs = u.lastActiveAt.getTime();

              // The user's most recently active table across their workspaces.
              const busiest = await db
                .select({
                  tableId: schema.cells.tableId,
                  name: schema.tables.name,
                  lastTouched: sql<number>`max(${schema.cells.updatedAt})`,
                })
                .from(schema.cells)
                .innerJoin(
                  schema.tables,
                  eq(schema.tables.id, schema.cells.tableId),
                )
                .innerJoin(
                  schema.members,
                  eq(schema.members.workspaceId, schema.cells.workspaceId),
                )
                .where(
                  and(
                    eq(schema.members.userId, u.id),
                    isNotNull(schema.cells.updatedAt),
                  ),
                )
                .groupBy(schema.cells.tableId, schema.tables.name)
                .orderBy(desc(sql`max(${schema.cells.updatedAt})`))
                .limit(1);
              const table = busiest[0];
              if (table === undefined) continue; // No table to talk about — skip.

              // What changed in that table since the user went quiet.
              const changed = await db
                .select({
                  cellsChanged: sql<number>`count(*) filter (where ${schema.cells.status} = 'done')`,
                  columnsRecomputed: sql<number>`count(distinct ${schema.cells.columnId}) filter (where ${schema.cells.status} = 'done')`,
                  rowsNeedRerun: sql<number>`count(*) filter (where ${schema.cells.status} = 'error')`,
                })
                .from(schema.cells)
                .where(
                  and(
                    eq(schema.cells.tableId, table.tableId),
                    isNotNull(schema.cells.updatedAt),
                    gte(schema.cells.updatedAt, lastActiveMs),
                  ),
                );
              const newRowsRes = await db
                .select({ n: count() })
                .from(schema.rows)
                .where(
                  and(
                    eq(schema.rows.tableId, table.tableId),
                    gte(schema.rows.createdAt, lastActiveMs),
                  ),
                );
              const c = changed[0];
              out.push({
                userId: u.id,
                lastActiveAtMs: lastActiveMs,
                table: table.name,
                cellsChanged: Number(c?.cellsChanged ?? 0),
                newRows: Number(newRowsRes[0]?.n ?? 0),
                columnsRecomputed: Number(c?.columnsRecomputed ?? 0),
                rowsNeedRerun: Number(c?.rowsNeedRerun ?? 0),
              });
            }
            return out;
          },
          catch: fail("dormant scan"),
        }),

      findTrialWinbackCandidates: (fromMs, toMs, limit) =>
        Effect.tryPromise({
          try: async () => {
            const candidates = await db
              .select({
                workspaceId: schema.workspaces.id,
                ownerId: schema.workspaces.ownerId,
              })
              .from(schema.workspaces)
              .where(
                and(
                  isNull(schema.workspaces.currentPlanId),
                  isNotNull(schema.workspaces.trialEndsAt),
                  gte(schema.workspaces.trialEndsAt, fromMs),
                  lte(schema.workspaces.trialEndsAt, toMs),
                ),
              )
              .limit(limit);
            if (candidates.length === 0) return [];
            const ids = candidates.map((c) => c.workspaceId);

            const tableCounts = await db
              .select({
                workspaceId: schema.tables.workspaceId,
                n: count(),
              })
              .from(schema.tables)
              .where(inArray(schema.tables.workspaceId, ids))
              .groupBy(schema.tables.workspaceId);
            const tableByWs = new Map(tableCounts.map((r) => [r.workspaceId, r.n]));

            const fnColCounts = await db
              .select({
                workspaceId: schema.columns.workspaceId,
                n: count(),
              })
              .from(schema.columns)
              .where(
                and(
                  inArray(schema.columns.workspaceId, ids),
                  eq(schema.columns.kind, "function"),
                ),
              )
              .groupBy(schema.columns.workspaceId);
            const fnColByWs = new Map(fnColCounts.map((r) => [r.workspaceId, r.n]));

            const doneCounts = await db
              .select({
                workspaceId: schema.cells.workspaceId,
                n: count(),
              })
              .from(schema.cells)
              .where(
                and(
                  inArray(schema.cells.workspaceId, ids),
                  eq(schema.cells.status, "done"),
                ),
              )
              .groupBy(schema.cells.workspaceId);
            const doneByWs = new Map(doneCounts.map((r) => [r.workspaceId, r.n]));

            return candidates.map((c) => ({
              workspaceId: c.workspaceId,
              ownerId: c.ownerId,
              tableCount: tableByWs.get(c.workspaceId) ?? 0,
              rowsEnriched: doneByWs.get(c.workspaceId) ?? 0,
              columnCount: fnColByWs.get(c.workspaceId) ?? 0,
            }));
          },
          catch: fail("trial-winback scan"),
        }),
    };
  }),
);

/**
 * In-memory Test Layer: returns the fixtures you seed per method (args ignored).
 * The Live queries are aggregate/window SQL that a faithful in-memory port would
 * only re-implement badly; tests instead inject the exact candidate rows they
 * want the caller to fan out over, which is what the cron logic actually needs
 * to exercise. Unseeded methods return an empty list.
 */
export const lifecycleCronRepoLayer = (seed?: {
  readonly firstTable?: readonly CronOwnerTarget[];
  readonly columnsAreFunctions?: readonly ColumnsFunctionTarget[];
  readonly inviteTeam?: readonly InviteTeamTarget[];
  readonly creditWarning?: readonly CreditWarningTarget[];
  readonly weeklyDigest?: readonly WeeklyDigestTarget[];
  readonly dormant?: readonly DormantTarget[];
  readonly trialWinback?: readonly TrialWinbackTarget[];
}): Layer.Layer<LifecycleCronRepo> =>
  Layer.succeed(LifecycleCronRepo, {
    findFirstTableCandidates: () => Effect.succeed(seed?.firstTable ?? []),
    findColumnsAreFunctionsCandidates: () =>
      Effect.succeed(seed?.columnsAreFunctions ?? []),
    findInviteTeamCandidates: () => Effect.succeed(seed?.inviteTeam ?? []),
    findCreditWarningCandidates: () => Effect.succeed(seed?.creditWarning ?? []),
    findWeeklyDigestTargets: () => Effect.succeed(seed?.weeklyDigest ?? []),
    findDormantCandidates: () => Effect.succeed(seed?.dormant ?? []),
    findTrialWinbackCandidates: () => Effect.succeed(seed?.trialWinback ?? []),
  });
