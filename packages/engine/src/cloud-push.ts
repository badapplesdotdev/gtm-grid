/**
 * Local→cloud one-way table push — a SCOPED Effect orchestrator (TRI-3295).
 *
 * This module reads a LOCAL SQLite table (columns/rows/cells) via the engine's
 * {@link Db}, maps it onto the cloud schema via {@link CloudSchemaMapping}
 * (rejecting unsupported scopes with a typed error), and writes it into the
 * ACTIVE OPEN cloud project through the SAME grid surface the CSV cloud import
 * uses (createTable → addColumn(s) → addRowsWithCells). It is ONE-WAY and local
 * is the source of truth:
 *
 *   - First push of an UNLINKED local table CREATES a cloud table and stores a
 *     local↔cloud link in the local `meta` store ({@link Db.setCloudTableLink}).
 *   - Re-push of a LINKED local table OVERWRITES the cloud data from local
 *     (detected via the stored link) using CREATE-NEW-THEN-SWAP (TRI-3302): it
 *     builds a fresh replacement cloud table FULLY (columns + rows), then
 *     atomically repoints the link to it and deletes the OLD table. A mid-flight
 *     failure therefore leaves the OLD table fully intact — there is no
 *     clear-then-rebuild window that could destroy data on failure.
 *
 * RESILIENCE (the load-bearing constraint): this is an Effect orchestrator that
 * OWNS its own resilience around a THIN, NON-RETRYING transport:
 *
 *   - Retry ONLY transient errors (429/503/5xx → {@link TransientPushError}) with
 *     capped exponential backoff + jitter, honouring `Retry-After`.
 *   - A per-request timeout (default 30s).
 *   - A scoped token-bucket {@link RateLimiter} bounding requests/second.
 *   - Bounded concurrency (≤4) + row batching (~100 rows/chunk via {@link chunk}).
 *
 * CRITICAL: the injected {@link CloudPushTransport} MUST be a thin, NON-retrying
 * POST — this orchestrator owns retry/rate-limit/concurrency. Do NOT stack it on
 * top of the engine's `fetchWithRetry` (packages/engine/src/http-retry.ts) or you
 * get nested retry storms. The transport classifies each failure into a typed
 * {@link CloudPushError} and is expected to honour `Retry-After` via
 * {@link parseRetryAfter} when raising a {@link TransientPushError}.
 *
 * DECOUPLING: like the cloud GridStore (store-cloud.ts), this file imports NO
 * backend client. The caller (the desktop sidecar) injects a
 * {@link CloudPushTransport} that talks to the apps/web tRPC `grid` surface, so
 * the engine's `tsc -b` build stays backend-agnostic.
 *
 * Follows docs/effect-conventions.md: typed errors via `Data.TaggedError`,
 * methods returning `Effect.Effect`, an `Effect.Service` with a `.Default` Layer.
 */

import { Data, type Duration, Effect, RateLimiter, Schedule } from "effect";
import { CloudSchemaMapping } from "./cloud-schema.js";
import { chunk } from "./execute.js";
import type { Db } from "./db.js";
import type { CredentialScope } from "./types.js";

/** Rows per cloud `addRowsWithCells` POST. Mirrors the cloud store's FLUSH_CHUNK. */
export const PUSH_ROW_CHUNK = 100;
/** Max concurrent in-flight chunk POSTs (mirrors store-cloud.ts MAX_IN_FLIGHT). */
export const PUSH_MAX_CONCURRENCY = 4;
/** Default token-bucket request budget per second for the cloud API. */
export const PUSH_RATE_LIMIT = 8;
/** Default per-request timeout. */
export const PUSH_TIMEOUT: Duration.DurationInput = "30 seconds";
/** Default retry budget for transient failures. */
export const PUSH_MAX_RETRIES = 3;

/**
 * A transient (retryable) push failure: a 429/503/5xx from the cloud API or a
 * network blip. The orchestrator retries these with capped backoff + jitter.
 * `retryAfterMs` carries a server-supplied `Retry-After` (parsed via
 * {@link parseRetryAfter}) so the orchestrator can honour it; `undefined` falls
 * back to the computed backoff.
 */
export class TransientPushError extends Data.TaggedError("TransientPushError")<{
  readonly message: string;
  readonly operation: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}> {}

/**
 * A fatal (non-retryable) push failure: a 4xx client error (other than 402
 * quota), a malformed response, or any error that retrying cannot fix.
 */
export class FatalPushError extends Data.TaggedError("FatalPushError")<{
  readonly message: string;
  readonly operation: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

/**
 * The cloud-actions quota is exhausted (the cloud API returned 402). REUSES the
 * existing `CloudActionsLimitError` tag (the services/grid-service.ts and the
 * sidecar cloud-run.ts both use this tag → HTTP 402) rather than inventing a
 * parallel client-side counter: the receiving end meters, and a 402 from it is
 * surfaced here unchanged so the sidecar maps it straight back to a 402.
 */
export class CloudActionsLimitError extends Data.TaggedError(
  "CloudActionsLimitError",
)<{
  readonly message: string;
}> {}

/**
 * The stored local↔cloud link is inconsistent — e.g. a re-push targets a cloud
 * table that no longer exists, or a concurrent push raced this one. Surfaced as a
 * typed error so the caller can prompt the user to re-link rather than silently
 * recreating or corrupting cloud data.
 */
export class LinkConflictError extends Data.TaggedError("LinkConflictError")<{
  readonly message: string;
  readonly localTableId: string;
  readonly cloudTableId: string;
}> {}

/** Every typed failure a push can raise. */
export type CloudPushError =
  | TransientPushError
  | FatalPushError
  | CloudActionsLimitError
  | LinkConflictError;

/** A row of cells to write, keyed by CLOUD column id. */
export type CloudCellMap = Record<string, unknown>;

/** A column to create in the cloud table (mapped from the local column). */
export interface CloudColumnSpec {
  /** The local column id — used to map local cells onto the created cloud column. */
  readonly localColumnId: string;
  readonly name: string;
  readonly type: string;
}

/**
 * The THIN, NON-RETRYING cloud transport this orchestrator drives. Each method is
 * ONE request the orchestrator wraps in its OWN retry/timeout/rate-limit policy,
 * so an implementation MUST NOT retry internally (that would nest with this
 * orchestrator's `Effect.retry` and storm). On failure a method MUST fail with a
 * typed {@link CloudPushError}: {@link TransientPushError} for 429/503/5xx/network
 * (carrying any parsed `Retry-After`), {@link CloudActionsLimitError} for 402, and
 * {@link FatalPushError} for other 4xx / malformed responses.
 */
export interface CloudPushTransport {
  /** Create a table in the active cloud project; resolves its cloud `tables.id`. */
  readonly createTable: (
    name: string,
  ) => Effect.Effect<string, CloudPushError>;
  /** Add a manual column to a cloud table; resolves its cloud `columns.id`. */
  readonly addColumn: (
    cloudTableId: string,
    col: { readonly name: string; readonly type: string },
  ) => Effect.Effect<string, CloudPushError>;
  /** Bulk-insert one chunk of rows + cells (cells keyed by cloud column id). */
  readonly addRowsWithCells: (
    cloudTableId: string,
    rows: readonly CloudCellMap[],
  ) => Effect.Effect<void, CloudPushError>;
  /**
   * Delete a cloud table outright (rows + columns cascade). Used by a re-push
   * OVERWRITE to remove the OLD table AFTER the replacement has been built and
   * the local↔cloud link repointed — so a mid-flight build failure never
   * touches the prior table (TRI-3302). Resolves when the table is gone.
   */
  readonly deleteTable: (
    cloudTableId: string,
  ) => Effect.Effect<void, CloudPushError>;
  /** Whether a cloud table still exists (re-push link validation). */
  readonly tableExists: (
    cloudTableId: string,
  ) => Effect.Effect<boolean, CloudPushError>;
}

/** What a single table push does to the cloud project. */
export type PushOutcome = "created" | "overwritten";

/** The structured result of a push — lets the UI warn correctly before a re-push. */
export interface PushResult {
  readonly outcome: PushOutcome;
  /** The cloud `tables.id` the local table is linked to after the push. */
  readonly cloudTableId: string;
  /** Number of rows written to the cloud table. */
  readonly rowCount: number;
  /** Number of columns created (push always builds the cloud columns fresh). */
  readonly columnCount: number;
}

/** Inputs to a push. */
export interface PushTableInput {
  /** The local `tables.id` to push. */
  readonly localTableId: string;
  /**
   * Re-push of a LINKED table OVERWRITES existing cloud data and is destructive,
   * so it requires explicit confirmation. The orchestrator FAILS a re-push with a
   * {@link LinkConflictError} unless `confirmOverwrite` is `true`; a first push
   * (no link) is non-destructive and never needs it.
   */
  readonly confirmOverwrite?: boolean;
}

/** Tunables for the orchestrator's resilience policy (all have safe defaults). */
export interface CloudPushConfig {
  readonly rowChunkSize?: number;
  readonly concurrency?: number;
  readonly rateLimitPerSecond?: number;
  readonly timeout?: Duration.DurationInput;
  readonly maxRetries?: number;
}

/** Map an engine column type onto the cloud column type (cloud accepts the same). */
const cloudColumnType = (type: string): string => type;

/**
 * Validate that a local column may be pushed to the cloud. Function columns may
 * carry a credential scope; a `local`-scoped credential is machine-local and must
 * never be synced (CloudSchemaMapping.credentialScopeForCloud rejects it). We
 * surface that rejection as a FATAL push error (retrying cannot fix an unpushable
 * scope). A `null` scope (a plain manual column) is always pushable.
 */
const assertColumnPushable = (
  mapping: CloudSchemaMapping,
  columnName: string,
  scope: CredentialScope | null,
): Effect.Effect<void, FatalPushError> =>
  scope === null
    ? Effect.void
    : mapping.credentialScopeForCloud(scope).pipe(
        Effect.asVoid,
        Effect.mapError(
          (e) =>
            new FatalPushError({
              message: `Column "${columnName}" uses an unpushable credential scope: ${e.message}`,
              operation: "mapColumn",
              cause: e,
            }),
        ),
      );

/**
 * The local→cloud table push orchestrator. Reads the local table via the injected
 * {@link Db}, maps + validates it via {@link CloudSchemaMapping}, then pushes it
 * through the injected {@link CloudPushTransport} with this service OWNING all
 * resilience (retry/jitter/timeout/rate-limit/bounded-concurrency). The local
 * meta link is read/written through the same {@link Db}.
 */
export class CloudPushService extends Effect.Service<CloudPushService>()(
  "CloudPushService",
  {
    accessors: false,
    effect: Effect.gen(function* () {
      const mapping = yield* CloudSchemaMapping;

      /**
       * Push ONE local table to the active cloud project. Scoped: the
       * token-bucket {@link RateLimiter} is created per call so it lives only for
       * this push (its `Scope` is closed when the push completes).
       */
      const pushTable = (
        db: Db,
        transport: CloudPushTransport,
        input: PushTableInput,
        config: CloudPushConfig = {},
      ): Effect.Effect<PushResult, CloudPushError> =>
        Effect.gen(function* () {
          const rowChunkSize = config.rowChunkSize ?? PUSH_ROW_CHUNK;
          const concurrency = config.concurrency ?? PUSH_MAX_CONCURRENCY;
          const rateLimitPerSecond =
            config.rateLimitPerSecond ?? PUSH_RATE_LIMIT;
          const timeout = config.timeout ?? PUSH_TIMEOUT;
          const maxRetries = config.maxRetries ?? PUSH_MAX_RETRIES;

          // ── Read the local table grid (pure local SQLite, no Effect needed).
          const table = db.getTable(input.localTableId);
          if (table === undefined) {
            return yield* Effect.fail(
              new FatalPushError({
                message: `Local table ${input.localTableId} not found`,
                operation: "readLocalTable",
              }),
            );
          }
          const localColumns = db.listColumns(input.localTableId);
          const localRows = db.listRows(input.localTableId);

          // ── Validate every column is pushable BEFORE any cloud write, so an
          //    unpushable scope fails fast and never half-creates a cloud table.
          for (const col of localColumns) {
            // A function column resolves its credential from the connector; only
            // a `local`-scoped credential is unpushable. Manual columns have no
            // scope. We read the connector's stored scope via the credential.
            const scope =
              col.kind === "function" && col.provider !== null
                ? (db.getCredential(col.provider)?.scope ?? null)
                : null;
            yield* assertColumnPushable(mapping, col.name, scope);
          }

          // ── Resolve the link: present → overwrite, absent → create.
          const existingLink = db.getCloudTableLink(input.localTableId);

          // Build the per-request resilience wrapper: timeout → retry transient.
          // The RateLimiter is applied at the call sites so EVERY request (create,
          // columns, chunks) is rate-limited as one token.
          const retrySchedule = Schedule.exponential("250 millis").pipe(
            Schedule.jittered,
            Schedule.intersect(Schedule.recurs(maxRetries)),
          );
          const resilient = <A>(
            operation: string,
            effect: Effect.Effect<A, CloudPushError>,
          ): Effect.Effect<A, CloudPushError> =>
            effect.pipe(
              Effect.timeoutFail({
                duration: timeout,
                onTimeout: () =>
                  new TransientPushError({
                    message: `Cloud request timed out (${operation})`,
                    operation,
                  }),
              }),
              Effect.retry({
                schedule: retrySchedule,
                while: (e) => e._tag === "TransientPushError",
              }),
            );

          // Scoped token-bucket rate limiter — closed when this push completes.
          const limiter = yield* RateLimiter.make({
            limit: rateLimitPerSecond,
            interval: "1 seconds",
            algorithm: "token-bucket",
          });
          /** One rate-limited + resilient cloud request. */
          const request = <A>(
            operation: string,
            effect: Effect.Effect<A, CloudPushError>,
          ): Effect.Effect<A, CloudPushError> =>
            limiter(resilient(operation, effect));

          // ── A re-push (OVERWRITE) must be validated + confirmed BEFORE any
          //    cloud write. We then build a brand-new replacement table and only
          //    repoint/delete the old one once the new one is fully populated —
          //    so a mid-flight failure can NEVER destroy the prior data (TRI-3302).
          let outcome: PushOutcome;
          let oldCloudTableId: string | undefined;

          if (existingLink !== undefined) {
            outcome = "overwritten";
            oldCloudTableId = existingLink;
            // Validate the link still resolves.
            const exists = yield* request(
              "tableExists",
              transport.tableExists(existingLink),
            );
            if (!exists) {
              return yield* Effect.fail(
                new LinkConflictError({
                  message: `Linked cloud table ${existingLink} no longer exists; re-link before pushing`,
                  localTableId: input.localTableId,
                  cloudTableId: existingLink,
                }),
              );
            }
            // Require explicit confirmation (destructive — the old table will be
            // deleted once the replacement is in place).
            if (input.confirmOverwrite !== true) {
              return yield* Effect.fail(
                new LinkConflictError({
                  message: `Pushing "${table.name}" overwrites the linked cloud table ${existingLink}; confirm the overwrite to proceed`,
                  localTableId: input.localTableId,
                  cloudTableId: existingLink,
                }),
              );
            }
          } else {
            outcome = "created";
          }

          // ── Build the replacement (or first) cloud table FULLY — create the
          //    table, then its columns, then all its rows — BEFORE touching the
          //    link or the old table. Any failure here (incl. a 402 quota inside
          //    addRowsWithCells) leaves the OLD table intact and the link still
          //    pointing at it: no data-loss window. This is create-new-then-swap.
          const newCloudTableId = yield* request(
            "createTable",
            transport.createTable(table.name),
          );

          // ── Build the cloud columns (fresh each push so the cloud schema
          //    mirrors local), mapping local column id → cloud column id.
          const columnIdByLocal = new Map<string, string>();
          for (const col of localColumns) {
            const cloudColumnId = yield* request(
              "addColumn",
              transport.addColumn(newCloudTableId, {
                name: col.name,
                type: cloudColumnType(col.type),
              }),
            );
            columnIdByLocal.set(col.id, cloudColumnId);
          }

          // ── Map every local row's cells onto the cloud column ids.
          const cloudRows: CloudCellMap[] = localRows.map((row) => {
            const cells = db.rowCells(row.id);
            const out: CloudCellMap = {};
            for (const [localColumnId, cell] of cells) {
              const cloudColumnId = columnIdByLocal.get(localColumnId);
              // Skip cells for columns that weren't created (none expected, but
              // defensive against a stale cell for a deleted column).
              if (cloudColumnId === undefined) continue;
              if (cell.value !== null && cell.value !== undefined) {
                out[cloudColumnId] = cell.value;
              }
            }
            return out;
          });

          // ── Push rows in bounded-concurrency, rate-limited, batched chunks.
          const rowChunks = chunk(cloudRows, rowChunkSize);
          yield* Effect.forEach(
            rowChunks,
            (rowChunk) =>
              request(
                "addRowsWithCells",
                transport.addRowsWithCells(newCloudTableId, rowChunk),
              ),
            { concurrency, discard: true },
          );

          // ── THE SWAP. The replacement is fully built and populated. Repoint the
          //    local↔cloud link to it FIRST so the link always resolves a table
          //    that actually has the data (a crash after this still leaves valid
          //    data linked). Persisting only after a successful build also means a
          //    failed FIRST push leaves no dangling link.
          db.setCloudTableLink(input.localTableId, newCloudTableId);

          // ── Now (and only now) remove the OLD table on an overwrite. This is
          //    best-effort cleanup: the link already points at the new table, so a
          //    failure to delete the old one is NOT data-loss — it just leaves an
          //    orphan cloud table. We swallow its failure so a successful push is
          //    not reported as failed over a stale orphan.
          if (oldCloudTableId !== undefined) {
            yield* request(
              "deleteTable",
              transport.deleteTable(oldCloudTableId),
            ).pipe(Effect.ignore);
          }

          return {
            outcome,
            cloudTableId: newCloudTableId,
            rowCount: cloudRows.length,
            columnCount: localColumns.length,
          };
        }).pipe(Effect.scoped);

      return { pushTable };
    }),
    dependencies: [CloudSchemaMapping.Default],
  },
) {}
