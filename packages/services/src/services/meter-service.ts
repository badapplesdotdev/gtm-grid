/**
 * `MeterService` — the DEDICATED cloud-actions metering WRITE path for the grid
 * mutations.
 *
 * Every billable cloud grid mutation (createTable, addColumn, addRow,
 * addRowsWithCells, deleteTable/Column/Row, setCell, setCellStatus) counts toward
 * the workspace's cloud-actions usage. The Convex source did this with a cheap DB
 * bump of a PENDING counter flushed to Autumn by a cron (convex/model/meter.ts).
 * Per the W2 metering simplification (the cron is dropped — see WorkspaceRepo doc)
 * this service writes directly to the WRITE-path counter `cloudActionsUsed` and
 * tracks the usage to the injectable Autumn port, so accounting is immediate with
 * no scheduled flush.
 *
 * It is a SEPARATE service from `WorkspaceRepo` on purpose: the read snapshot
 * (`me`) lives on `WorkspaceRepo`; the metering WRITE path lives here, so the two
 * never tangle and the grid mutations depend only on the metering surface.
 *
 *   - {@link MeterServiceLive} — Drizzle increment of `cloudActionsUsed`
 *     (a `coalesce(used,0)+n` UPDATE) PLUS a best-effort Autumn `trackUsage` on
 *     the injected {@link AutumnClient} port. The read (`readQuota`) backs the
 *     atomic bulk quota pre-check.
 *   - {@link meterServiceLayer} — in-memory, backed by a mutable quota Map, so the
 *     grid service + procedures run with NO live database and a test can assert
 *     the exact increment.
 */

import { AutumnClient } from "@gtmgrid/cloud";
import { schema } from "@gtmgrid/db";
import { eq } from "drizzle-orm";
import { Context, Data, Effect, Layer, Option } from "effect";
import { DbClient } from "../db-client.js";

/** A workspace's cloud-actions quota snapshot the bulk pre-check reads. */
export interface MeterQuota {
  readonly cloudActionsUsed: number | null;
  readonly cloudActionsLimit: number | null;
}

/** Raised when a meter read/write fails (DB/transport error). */
export class MeterServiceError extends Data.TaggedError("MeterServiceError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The metering write path + quota read for the grid mutations. */
export class MeterService extends Context.Tag("MeterService")<
  MeterService,
  {
    /**
     * Increment a workspace's `cloudActionsUsed` by `n` (a no-op when `n <= 0`),
     * and best-effort track the usage to the Autumn port. Call AFTER a grid
     * mutation's authz/validation passes so only genuine writes are counted.
     */
    readonly meterActions: (
      workspaceId: string,
      n: number,
    ) => Effect.Effect<void, MeterServiceError>;
    /** A workspace's quota snapshot for the atomic bulk pre-check, or `None`. */
    readonly readQuota: (
      workspaceId: string,
    ) => Effect.Effect<Option.Option<MeterQuota>, MeterServiceError>;
  }
>() {}

const fail = (op: string) => (cause: unknown) =>
  new MeterServiceError({
    message: cause instanceof Error ? cause.message : `${op} failed`,
    cause,
  });

/**
 * The live `MeterService`. Depends on {@link DbClient} for the increment and on
 * the injected {@link AutumnClient} port for the usage track. The Autumn track is
 * best-effort: a transport error is swallowed (the DB counter is the source of
 * truth), so a metering hiccup never fails the user's grid write.
 */
export const MeterServiceLive: Layer.Layer<
  MeterService,
  never,
  DbClient | AutumnClient
> = Layer.effect(
  MeterService,
  Effect.gen(function* () {
    const db = yield* DbClient;
    const autumn = yield* AutumnClient;
    return {
      meterActions: (workspaceId, n) =>
        n <= 0 || !UUID_RE.test(workspaceId)
          ? Effect.void
          : Effect.gen(function* () {
              yield* Effect.tryPromise({
                try: async () => {
                  await db
                    .update(schema.workspaces)
                    .set({
                      cloudActionsUsed: schema.sql`coalesce(${schema.workspaces.cloudActionsUsed}, 0) + ${n}`,
                    })
                    .where(eq(schema.workspaces.id, workspaceId));
                },
                catch: fail("meter increment"),
              });
              // Best-effort: track to Autumn, but never fail the grid write on a
              // metering transport error (the DB counter is authoritative).
              yield* autumn
                .trackUsage({
                  customerId: workspaceId,
                  featureId: "cloud_actions",
                  value: n,
                })
                .pipe(Effect.ignore);
            }),
      readQuota: (workspaceId) =>
        UUID_RE.test(workspaceId)
          ? Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .select({
                    cloudActionsUsed: schema.workspaces.cloudActionsUsed,
                    cloudActionsLimit: schema.workspaces.cloudActionsLimit,
                  })
                  .from(schema.workspaces)
                  .where(eq(schema.workspaces.id, workspaceId))
                  .limit(1);
                return Option.fromNullable(rows[0] ?? null);
              },
              catch: fail("meter quota lookup"),
            })
          : Effect.succeed(Option.none<MeterQuota>()),
    };
  }),
);

/**
 * An in-memory `MeterService` Layer backed by a MUTABLE quota Map (keyed by
 * workspace id), so a test can seed a limit and assert the exact `cloudActionsUsed`
 * increment after running grid mutations — with NO live database and no Autumn.
 * The Map is shared by reference, so the test reads it back after the service runs.
 */
export const meterServiceLayer = (
  quotas: Map<string, MeterQuota> = new Map(),
): Layer.Layer<MeterService> =>
  Layer.succeed(MeterService, {
    meterActions: (workspaceId, n) =>
      n <= 0
        ? Effect.void
        : Effect.sync(() => {
            const q = quotas.get(workspaceId);
            quotas.set(workspaceId, {
              cloudActionsUsed: (q?.cloudActionsUsed ?? 0) + n,
              cloudActionsLimit: q?.cloudActionsLimit ?? null,
            });
          }),
    readQuota: (workspaceId) =>
      Effect.succeed(Option.fromNullable(quotas.get(workspaceId))),
  });
