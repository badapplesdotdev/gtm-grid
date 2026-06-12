/**
 * `WebhookService` — the webhook domain service: member-gated config CRUD PLUS
 * the headless worker grid paths, collapsing the Convex action/mutation splits
 * into single Effect procedures.
 *
 * Ports `convex/webhooks.ts`:
 *   - CONFIG CRUD (member-gated): listWebhooks, createWebhook, updateWebhookConfig,
 *     updateWebhookMapping, toggleEnabled, rotateSecret, listDeliveriesPaged
 *     (now Drizzle KEYSET), deleteWebhook. NOT metered (config is metadata).
 *   - WORKER PATHS (secret-gated UPSTREAM at the route, NOT member-gated here):
 *     resolveToken, insertRow, upsertRow, getTable, setCell, setCellStatus.
 *     `insertRow`/`upsertRow` meter EXACTLY ONCE per record; `setCell`/
 *     `setCellStatus` meter ONLY on a TERMINAL status (done/error), never on
 *     running. Deliveries are recorded with a 50-row prune (recordDelivery).
 *
 * The upsert match is resolved by the repo's INDEXED `findRowByCellValue` point
 * lookup (guarded by `isValidUpsertKeyValue` from `@gtmgrid/cloud`), replacing
 * the old full-table `listCellsByTable` scan + JS filter. The COALESCE cell
 * merge + terminal meter are collapsed into the repo's single `upsertCell`
 * statement. Authz uses the same `MembershipService.requireMember` port as the
 * worked example.
 */

import {
  type CloudCellStatus,
  CredentialCryptoService,
  isValidUpsertKeyValue,
  MembershipService,
  type NotAMemberError,
  type SecretMap,
  type UnauthenticatedError,
} from "@gtmgrid/cloud";
import { Data, Effect } from "effect";
import { EntitlementService } from "./entitlement-service.js";
import { mintSigningSecret, mintToken } from "../webhook-mint.js";
import {
  type DeliveryCursor,
  type DeliveryPage,
  WebhookDeliveryRepo,
  type WebhookDeliveryRepoError,
} from "../repositories/webhook-delivery-repo.js";
import {
  type Webhook,
  type WebhookMappingEntry,
  type WebhookMode,
  WebhookRepo,
  type WebhookRepoError,
} from "../repositories/webhook-repo.js";

/** Max delivery-log rows retained PER WEBHOOK (convex/webhooks.ts:676). */
export const DELIVERY_RETENTION = 50;

/** Default page size for the deliveries panel (convex/webhooks.ts:284 initial). */
export const DELIVERIES_PAGE_SIZE = 20;

/** Raised when a referenced webhook/table/column/row does not exist. */
export class WebhookNotFoundError extends Data.TaggedError(
  "WebhookNotFoundError",
)<{
  readonly message: string;
}> {}

/** Raised when a mapping/upsert target column is not in the bound table. */
export class InvalidMappingError extends Data.TaggedError(
  "InvalidMappingError",
)<{
  readonly message: string;
}> {}

/** Raised when an upsert config is incomplete (mode upsert without a key). */
export class InvalidConfigError extends Data.TaggedError("InvalidConfigError")<{
  readonly message: string;
}> {}

/** Raised when a delivery would exceed the plan's remaining cloud actions. */
export class CloudActionsLimitError extends Data.TaggedError(
  "CloudActionsLimitError",
)<{
  readonly message: string;
}> {}

/** Raised when a worker (row, column) pair span different tables. */
export class InvalidCellError extends Data.TaggedError("InvalidCellError")<{
  readonly message: string;
}> {}

/** A `{ columnId: value }` map of one received record's mapped cells. */
export type CellMap = Readonly<Record<string, unknown>>;

/** The resolved webhook config the worker route returns (or `null`). */
export interface ResolvedWebhook {
  readonly webhookId: string;
  readonly workspaceId: string;
  readonly tableId: string;
  readonly mapping: readonly WebhookMappingEntry[];
  readonly signingSecret: string | null;
  readonly autoRun: boolean;
  readonly mode: WebhookMode;
  readonly upsertKey: string | null;
}

/**
 * The lightweight table-metadata payload `getTableMeta` returns to the worker.
 * A cloud run start only needs the table's `workspaceId` (to resolve shared
 * connector credentials), so this fast path skips the columns/rows/cells the
 * full {@link WorkerGrid} ships — see {@link WorkerGrid} for the full shape.
 */
export interface WorkerTableMeta {
  readonly table: { readonly id: string; readonly workspaceId: string };
}

/** The grid payload `getTable` returns to the worker. */
export interface WorkerGrid {
  readonly table: { readonly id: string; readonly workspaceId: string };
  readonly columns: readonly { readonly id: string }[];
  readonly rows: readonly { readonly id: string; readonly position: number }[];
  readonly cells: readonly {
    readonly id: string;
    readonly rowId: string;
    readonly columnId: string;
    readonly value: unknown;
  }[];
}

/**
 * Webhook domain service. CRUD methods assert membership first; worker methods
 * skip membership (the route's worker-secret bearer is their trust boundary) but
 * still validate table/column ownership so a webhook can never write across
 * tables.
 */
export class WebhookService extends Effect.Service<WebhookService>()(
  "WebhookService",
  {
    effect: Effect.gen(function* () {
      const repo = yield* WebhookRepo;
      const deliveries = yield* WebhookDeliveryRepo;
      const membership = yield* MembershipService;
      const crypto = yield* CredentialCryptoService;
      const entitlement = yield* EntitlementService;

      /** Load a webhook or fail typed. */
      const requireWebhook = (
        webhookId: string,
      ): Effect.Effect<Webhook, WebhookRepoError | WebhookNotFoundError> =>
        Effect.gen(function* () {
          const found = yield* repo.findById(webhookId);
          if (found._tag === "None") {
            return yield* Effect.fail(
              new WebhookNotFoundError({
                message: `Webhook ${webhookId} not found.`,
              }),
            );
          }
          return found.value;
        });

      /** The set of column ids belonging to `tableId`. */
      const tableColumnIds = (tableId: string) =>
        repo
          .listColumns(tableId)
          .pipe(Effect.map((cols) => new Set(cols.map((c) => c.id))));

      // ── CONFIG CRUD (member-gated, not metered) ──────────────────────────

      /** Webhooks bound to a table (newest first). Members-only. */
      const listWebhooks = (tableId: string) =>
        Effect.gen(function* () {
          const table = yield* repo.findTable(tableId);
          if (table._tag === "None") {
            return yield* Effect.fail(
              new WebhookNotFoundError({ message: `Table ${tableId} not found.` }),
            );
          }
          yield* membership.requireMember(table.value.workspaceId);
          return yield* repo.listByTable(tableId);
        });

      /** Create a webhook bound to a table, minting its token + secret. */
      const createWebhook = (args: {
        readonly tableId: string;
        readonly name?: string | null;
        readonly mapping?: readonly WebhookMappingEntry[];
        /** OPT-IN signature auth: mint a signing secret only when true. The
         *  default is an unauthenticated endpoint (the unguessable token URL is
         *  the credential), so senders that can't compute an HMAC still work. */
        readonly auth?: boolean;
      }) =>
        Effect.gen(function* () {
          const table = yield* repo.findTable(args.tableId);
          if (table._tag === "None") {
            return yield* Effect.fail(
              new WebhookNotFoundError({
                message: `Table ${args.tableId} not found.`,
              }),
            );
          }
          yield* membership.requireMember(table.value.workspaceId);
          yield* entitlement.requireCloudAccess(table.value.workspaceId);

          const mapping = args.mapping ?? [];
          const valid = yield* tableColumnIds(args.tableId);
          for (const m of mapping) {
            if (!valid.has(m.columnId)) {
              return yield* Effect.fail(
                new InvalidMappingError({
                  message: `Column ${m.columnId} does not belong to table ${args.tableId}.`,
                }),
              );
            }
          }

          return yield* repo.insert({
            workspaceId: table.value.workspaceId,
            tableId: args.tableId,
            name: args.name ?? null,
            token: mintToken(),
            signingSecret: args.auth === true ? mintSigningSecret() : null,
            mapping,
            enabled: true,
            autoRun: true,
            mode: "create",
            upsertKey: null,
            createdAt: Date.now(),
          });
        });

      /** Patch receive behaviour — autoRun, mode, and the upsertKey column. */
      const updateWebhookConfig = (args: {
        readonly webhookId: string;
        readonly autoRun?: boolean;
        readonly mode?: WebhookMode;
        readonly upsertKey?: string | null;
      }) =>
        Effect.gen(function* () {
          const webhook = yield* requireWebhook(args.webhookId);
          yield* membership.requireMember(webhook.workspaceId);

          const patch: {
            autoRun?: boolean;
            mode?: WebhookMode;
            upsertKey?: string | null;
          } = {};
          if (args.autoRun !== undefined) patch.autoRun = args.autoRun;

          const nextMode = args.mode ?? webhook.mode ?? "create";
          if (args.mode !== undefined) patch.mode = args.mode;

          const nextKey =
            args.upsertKey !== undefined
              ? args.upsertKey
              : (webhook.upsertKey ?? null);

          if (nextMode === "upsert") {
            if (nextKey === null) {
              return yield* Effect.fail(
                new InvalidConfigError({
                  message: "Upsert mode requires a column to match on.",
                }),
              );
            }
            const valid = yield* tableColumnIds(webhook.tableId);
            if (!valid.has(nextKey)) {
              return yield* Effect.fail(
                new InvalidConfigError({
                  message: `Column ${nextKey} does not belong to table ${webhook.tableId}.`,
                }),
              );
            }
            if (args.upsertKey !== undefined) patch.upsertKey = nextKey;
          } else {
            patch.upsertKey = null;
          }

          yield* repo.patch(args.webhookId, patch);
        });

      /** Replace a webhook's field mapping (re-validates column ownership). */
      const updateWebhookMapping = (args: {
        readonly webhookId: string;
        readonly mapping: readonly WebhookMappingEntry[];
      }) =>
        Effect.gen(function* () {
          const webhook = yield* requireWebhook(args.webhookId);
          yield* membership.requireMember(webhook.workspaceId);
          const valid = yield* tableColumnIds(webhook.tableId);
          for (const m of args.mapping) {
            if (!valid.has(m.columnId)) {
              return yield* Effect.fail(
                new InvalidMappingError({
                  message: `Column ${m.columnId} does not belong to table ${webhook.tableId}.`,
                }),
              );
            }
          }
          yield* repo.patch(args.webhookId, { mapping: args.mapping });
        });

      /** Enable/disable a webhook. */
      const toggleEnabled = (args: {
        readonly webhookId: string;
        readonly enabled: boolean;
      }) =>
        Effect.gen(function* () {
          const webhook = yield* requireWebhook(args.webhookId);
          yield* membership.requireMember(webhook.workspaceId);
          yield* repo.patch(args.webhookId, { enabled: args.enabled });
        });

      /** Rotate a webhook's token (+ signing secret when auth is enabled —
       *  rotation preserves the opt-in/opt-out state, it never enables auth). */
      const rotateSecret = (webhookId: string) =>
        Effect.gen(function* () {
          const webhook = yield* requireWebhook(webhookId);
          yield* membership.requireMember(webhook.workspaceId);
          const token = mintToken();
          const signingSecret = webhook.signingSecret === null ? null : mintSigningSecret();
          yield* repo.patch(webhookId, { token, signingSecret });
          return { token, signingSecret };
        });

      /** Opt a webhook in to (or out of) signature auth. Opting in mints a
       *  fresh signing secret and returns it; opting out clears it so the
       *  receiver accepts unsigned posts again. */
      const setAuth = (args: {
        readonly webhookId: string;
        readonly enabled: boolean;
      }) =>
        Effect.gen(function* () {
          const webhook = yield* requireWebhook(args.webhookId);
          yield* membership.requireMember(webhook.workspaceId);
          const signingSecret = args.enabled ? mintSigningSecret() : null;
          yield* repo.patch(args.webhookId, { signingSecret });
          return { signingSecret };
        });

      /** A KEYSET page of a webhook's deliveries (newest first). */
      const listDeliveriesPaged = (args: {
        readonly webhookId: string;
        readonly limit?: number;
        readonly cursor?: DeliveryCursor | null;
      }): Effect.Effect<
        DeliveryPage,
        | WebhookRepoError
        | WebhookDeliveryRepoError
        | WebhookNotFoundError
        | UnauthenticatedError
        | NotAMemberError
        | import("@gtmgrid/cloud").MemberRepoError
        | import("@gtmgrid/cloud").InsufficientRoleError
      > =>
        Effect.gen(function* () {
          const webhook = yield* requireWebhook(args.webhookId);
          yield* membership.requireMember(webhook.workspaceId);
          return yield* deliveries.listKeysetByWebhook({
            webhookId: args.webhookId,
            limit: args.limit ?? DELIVERIES_PAGE_SIZE,
            cursor: args.cursor ?? null,
          });
        });

      /** Delete a webhook. */
      const deleteWebhook = (webhookId: string) =>
        Effect.gen(function* () {
          const webhook = yield* requireWebhook(webhookId);
          yield* membership.requireMember(webhook.workspaceId);
          yield* repo.remove(webhookId);
        });

      // ── WORKER PATHS (dual-auth upstream: secret OR member) ───────────────

      /**
       * Membership gate for the dual-auth worker routes (the desktop sidecar +
       * spawned MCP reach these via `runWorkerSecretOrMember`). Two cases:
       *
       *  - MEMBER path: the request carried a member SESSION token, so the route
       *    runs with that member's identity — assert they belong to `workspaceId`
       *    (else `NotAMemberError` → 403). This is what lets the prod desktop, which
       *    ships no worker secret, authenticate cloud reads/runs as the signed-in
       *    member instead of a shared client secret.
       *  - HEADLESS path: the request was authorized by the `WEBHOOK_WORKER_SECRET`
       *    bearer (the inngest webhook worker), so there is NO current user;
       *    `requireMember` fails `UnauthenticatedError`, which we SWALLOW — the
       *    secret is the trust boundary, exactly as before.
       *
       * Safe because the route wrapper guarantees a null identity reaches here ONLY
       * on the secret path: a member request whose token does not resolve is
       * rejected 401 at the route, never reaching the service. So swallowing
       * `UnauthenticatedError` cannot bypass the member-path membership check.
       */
      const assertMemberIfIdentified = (workspaceId: string) =>
        membership.requireMember(workspaceId).pipe(
          Effect.asVoid,
          Effect.catchTag("UnauthenticatedError", () => Effect.void),
        );

      /** Resolve a token to its (enabled) webhook, or `null`. */
      const resolveToken = (token: string) =>
        Effect.gen(function* () {
          const found = yield* repo.findByToken(token);
          if (found._tag === "None" || !found.value.enabled) return null;
          const w = found.value;
          // Cloud-access gate at the inbound door: a lapsed/Free workspace stops
          // accepting webhook data. Treated as not-found (the caller 404s) so no
          // external data flows into a locked workspace and nothing leaks.
          const hasAccess = yield* entitlement.requireCloudAccess(w.workspaceId).pipe(
            Effect.as(true),
            Effect.catchTag("PlanRequiredError", () => Effect.succeed(false)),
          );
          if (!hasAccess) return null;
          return {
            webhookId: w.id,
            workspaceId: w.workspaceId,
            tableId: w.tableId,
            mapping: w.mapping,
            signingSecret: w.signingSecret ?? null,
            autoRun: w.autoRun ?? true,
            mode: w.mode ?? "create",
            upsertKey: w.upsertKey ?? null,
          } satisfies ResolvedWebhook;
        });

      /**
       * Quota pre-check: reject when `used + n` would exceed the plan's
       * cloud-actions limit. `n` is the number of billable cloud actions the
       * pending operation would meter (1 per webhook record; one per cell that
       * would actually run for a column). A workspace with no quota row or no
       * numeric limit is unmetered and always passes. A non-positive `n` (e.g. a
       * run whose every candidate cell is already done) needs no headroom and
       * passes.
       */
      const assertQuota = (workspaceId: string, n: number, message: string) =>
        Effect.gen(function* () {
          if (n <= 0) return;
          const q = yield* repo.findWorkspaceQuota(workspaceId);
          if (q._tag === "None") return;
          const limit = q.value.cloudActionsLimit;
          if (typeof limit !== "number") return;
          const used = q.value.cloudActionsUsed ?? 0;
          if (used + n > limit) {
            return yield* Effect.fail(new CloudActionsLimitError({ message }));
          }
        });

      /** The webhook-ingest message: one record = one cloud action. */
      const WEBHOOK_QUOTA_MESSAGE =
        "This webhook delivery would exceed your plan's remaining cloud actions.";

      /** Record ONE delivery (status 200), bump telemetry, prune past 50. */
      const recordDelivery = (
        webhook: Webhook,
        args: {
          readonly mode: WebhookMode;
          readonly rowsAffected: number;
          readonly recordId?: string;
          readonly receivedAt: number;
        },
      ) =>
        Effect.gen(function* () {
          yield* deliveries.insert({
            workspaceId: webhook.workspaceId,
            webhookId: webhook.id,
            tableId: webhook.tableId,
            status: 200,
            rowsAffected: args.rowsAffected,
            mode: args.mode,
            recordId: args.recordId ?? null,
            error: null,
            receivedAt: args.receivedAt,
          });
          yield* repo.patch(webhook.id, {
            lastReceivedAt: args.receivedAt,
            receivedCount: (webhook.receivedCount ?? 0) + 1,
          });
          // Bound the log to the latest 50 rows in ONE set-based DELETE — no
          // fetch-all + slice + per-row delete on this hot path.
          yield* deliveries.pruneOldest(webhook.id, DELIVERY_RETENTION);
        });

      /** Write a set of mapped cells onto a row (patch-or-insert per column). */
      const writeCells = (
        webhook: Webhook,
        rowId: string,
        cells: CellMap,
        validColumnIds: ReadonlySet<string>,
        existingByColumn: ReadonlyMap<string, string>,
        now: number,
      ) =>
        Effect.gen(function* () {
          for (const [columnId, value] of Object.entries(cells)) {
            if (value === "" || value === null || value === undefined) continue;
            if (!validColumnIds.has(columnId)) continue;
            const existingId = existingByColumn.get(columnId);
            const cell = {
              value,
              status: "done",
              error: null,
              updatedAt: now,
            } as const;
            if (existingId !== undefined) {
              yield* repo.patchCell(existingId, cell);
            } else {
              yield* repo.insertCell({
                workspaceId: webhook.workspaceId,
                tableId: webhook.tableId,
                rowId,
                columnId,
                cell,
              });
            }
          }
        });

      /** Next row position = max(existing)+1 (0 when empty). */
      const nextPosition = (tableId: string) =>
        repo
          .listRows(tableId)
          .pipe(
            Effect.map((rows) =>
              rows.reduce((max, r) => Math.max(max, r.position + 1), 0),
            ),
          );

      /** Insert ONE received record (row + mapped cells), metered once. */
      const insertRow = (args: {
        readonly webhookId: string;
        readonly cells: CellMap;
        readonly recordId?: string;
      }) =>
        Effect.gen(function* () {
          const webhook = yield* requireWebhook(args.webhookId);
          const table = yield* repo.findTable(webhook.tableId);
          if (table._tag === "None") {
            return yield* Effect.fail(
              new WebhookNotFoundError({
                message: `Table ${webhook.tableId} not found.`,
              }),
            );
          }
          yield* assertQuota(table.value.workspaceId, 1, WEBHOOK_QUOTA_MESSAGE);

          const validColumnIds = yield* tableColumnIds(webhook.tableId);
          const position = yield* nextPosition(webhook.tableId);
          const now = Date.now();

          const rowId = yield* repo.insertRow({
            workspaceId: table.value.workspaceId,
            tableId: webhook.tableId,
            position,
            createdAt: now,
          });
          yield* writeCells(
            webhook,
            rowId,
            args.cells,
            validColumnIds,
            new Map(),
            now,
          );

          yield* recordDelivery(webhook, {
            mode: "create",
            rowsAffected: 1,
            ...(args.recordId !== undefined ? { recordId: args.recordId } : {}),
            receivedAt: now,
          });
          // Exactly ONE billable cloud action per received record.
          yield* repo.meterActions(table.value.workspaceId, 1);
          return { rowId };
        });

      /** UPSERT ONE received record (match server-side), metered once. */
      const upsertRow = (args: {
        readonly webhookId: string;
        readonly upsertKey: string;
        readonly cells: CellMap;
        readonly recordId?: string;
      }) =>
        Effect.gen(function* () {
          const webhook = yield* requireWebhook(args.webhookId);
          const table = yield* repo.findTable(webhook.tableId);
          if (table._tag === "None") {
            return yield* Effect.fail(
              new WebhookNotFoundError({
                message: `Table ${webhook.tableId} not found.`,
              }),
            );
          }
          yield* assertQuota(table.value.workspaceId, 1, WEBHOOK_QUOTA_MESSAGE);

          const validColumnIds = yield* tableColumnIds(webhook.tableId);
          if (!validColumnIds.has(args.upsertKey)) {
            return yield* Effect.fail(
              new InvalidMappingError({
                message: `Upsert key ${args.upsertKey} does not belong to table ${webhook.tableId}.`,
              }),
            );
          }

          const now = Date.now();
          const incoming = args.cells[args.upsertKey];

          // Server-side match via a single INDEXED point lookup on
          // (tableId, columnId, value) over `cells_by_table_column` — no
          // full-table cell load / JS filter. A non-scalar or empty incoming
          // key can never identify an existing row (mirrors the pure
          // `findUpsertRowId` kernel), so we skip the query and insert fresh.
          const matchedRowId = isValidUpsertKeyValue(incoming)
            ? yield* repo
                .findRowByCellValue(webhook.tableId, args.upsertKey, incoming)
                .pipe(Effect.map((o) => (o._tag === "Some" ? o.value : null)))
            : null;

          let rowId: string;
          let existingByColumn: ReadonlyMap<string, string>;
          if (matchedRowId !== null) {
            rowId = matchedRowId;
            const map = new Map<string, string>();
            for (const c of yield* repo.listCellsByRow(rowId)) {
              map.set(c.columnId, c.id);
            }
            existingByColumn = map;
          } else {
            const position = yield* nextPosition(webhook.tableId);
            rowId = yield* repo.insertRow({
              workspaceId: table.value.workspaceId,
              tableId: webhook.tableId,
              position,
              createdAt: now,
            });
            existingByColumn = new Map();
          }
          yield* writeCells(
            webhook,
            rowId,
            args.cells,
            validColumnIds,
            existingByColumn,
            now,
          );

          yield* recordDelivery(webhook, {
            mode: "upsert",
            rowsAffected: 1,
            ...(args.recordId !== undefined ? { recordId: args.recordId } : {}),
            receivedAt: now,
          });
          yield* repo.meterActions(table.value.workspaceId, 1);
          return { rowId };
        });

      /** Full grid for a table (worker getTable shape). */
      const getTable = (tableId: string) =>
        Effect.gen(function* () {
          const table = yield* repo.findTable(tableId);
          if (table._tag === "None") {
            return yield* Effect.fail(
              new WebhookNotFoundError({ message: `Table ${tableId} not found.` }),
            );
          }
          yield* assertMemberIfIdentified(table.value.workspaceId);
          const [columns, rows, cells] = [
            yield* repo.listColumns(tableId),
            yield* repo.listRows(tableId),
            yield* repo.listCellsByTable(tableId),
          ];
          return {
            table: { id: table.value.id, workspaceId: table.value.workspaceId },
            columns: columns.map((c) => ({ id: c.id })),
            rows: rows.map((r) => ({ id: r.id, position: r.position })),
            cells,
          } satisfies WorkerGrid;
        });

      /**
       * Table metadata only (worker getTableMeta shape). A cloud run start reads
       * just the table's `workspaceId` to resolve shared connector credentials,
       * so this reuses the same `findTable` lookup as {@link getTable} but skips
       * the columns/rows/cells loads entirely — no full-grid payload over the
       * wire. (TRI-3273.)
       */
      const getTableMeta = (tableId: string) =>
        Effect.gen(function* () {
          const table = yield* repo.findTable(tableId);
          if (table._tag === "None") {
            return yield* Effect.fail(
              new WebhookNotFoundError({ message: `Table ${tableId} not found.` }),
            );
          }
          yield* assertMemberIfIdentified(table.value.workspaceId);
          return {
            table: { id: table.value.id, workspaceId: table.value.workspaceId },
          } satisfies WorkerTableMeta;
        });

      /**
       * Pre-flight quota gate for a cloud COLUMN run (TRI-3277). A column run
       * meters one cloud action per cell that actually runs, but historically
       * only the webhook-ingest path pre-checked the quota — a column run fanned
       * out unchecked and over-metered silently. This computes, server-side
       * (where the quota counter lives — no parallel counter), exactly how many
       * cells the run would execute and asserts the workspace has the headroom,
       * failing with {@link CloudActionsLimitError} (→ 402 at the worker
       * boundary) when it does not.
       *
       * The cell count mirrors the engine's run semantics exactly: the candidate
       * rows are `rowIds` when given else every row of the table, and a candidate
       * cell is SKIPPED (costs nothing) when `!force` and its current status is
       * already `"done"` — the same `if (!opts.force && existing?.status ===
       * "done")` idempotency skip the engine applies. The remaining count is what
       * the run would meter, so that is what we gate on.
       */
      const assertColumnRunQuota = (args: {
        readonly tableId: string;
        readonly columnId: string;
        readonly rowIds?: readonly string[];
        readonly force?: boolean;
      }) =>
        Effect.gen(function* () {
          const table = yield* repo.findTable(args.tableId);
          if (table._tag === "None") {
            return yield* Effect.fail(
              new WebhookNotFoundError({
                message: `Table ${args.tableId} not found.`,
              }),
            );
          }
          const workspaceId = table.value.workspaceId;
          yield* assertMemberIfIdentified(workspaceId);

          const candidateRowIds =
            args.rowIds ??
            (yield* repo.listRows(args.tableId)).map((r) => r.id);

          // Cells the engine would skip as already-done (unless force) cost no
          // cloud actions, so subtract them from the candidate count. The skip is
          // per (row, RUN column): a candidate row is skipped only when ITS cell
          // in `columnId` is already `done`.
          let cellsToRun = candidateRowIds.length;
          if (args.force !== true && candidateRowIds.length > 0) {
            const candidateSet = new Set(candidateRowIds);
            const cells = yield* repo.listCellsByTable(args.tableId);
            const doneRows = new Set<string>();
            for (const cell of cells) {
              if (
                cell.columnId === args.columnId &&
                cell.status === "done" &&
                candidateSet.has(cell.rowId)
              ) {
                doneRows.add(cell.rowId);
              }
            }
            cellsToRun = candidateRowIds.length - doneRows.size;
          }

          yield* assertQuota(
            workspaceId,
            cellsToRun,
            "This column run would exceed your plan's remaining cloud actions.",
          );
          return { workspaceId, cellsToRun };
        });

      /**
       * Resolve + assert a (row, column) pair share a table, returning the
       * row's table + workspace. ONE query (resolveCellTarget joins row→table
       * and the column), replacing the prior findRow + findColumn + findCell +
       * findTable fan-out. The merge no longer reads the existing cell here: the
       * COALESCE merge is performed atomically inside {@link upsertCell}.
       */
      const resolveCell = (rowId: string, columnId: string) =>
        Effect.gen(function* () {
          const target = yield* repo.resolveCellTarget(rowId, columnId);
          if (target._tag === "None") {
            return yield* Effect.fail(
              new WebhookNotFoundError({ message: "Row or column not found." }),
            );
          }
          if (target.value.rowTableId !== target.value.columnTableId) {
            return yield* Effect.fail(
              new InvalidCellError({
                message: "Row and column belong to different tables.",
              }),
            );
          }
          return {
            tableId: target.value.rowTableId,
            workspaceId: target.value.workspaceId,
          };
        });

      /**
       * Worker cell upsert (COALESCE merge; meters only terminal). Two queries:
       * resolveCell (validate + workspace) then a single
       * INSERT…ON CONFLICT DO UPDATE that merges value/status/error and folds the
       * terminal-status meter increment into the same statement.
       */
      const setCell = (args: {
        readonly rowId: string;
        readonly columnId: string;
        readonly value?: unknown;
        readonly hasValue: boolean;
        readonly status?: CloudCellStatus;
        readonly error?: string | null;
      }) =>
        Effect.gen(function* () {
          const { tableId, workspaceId } = yield* resolveCell(
            args.rowId,
            args.columnId,
          );
          yield* assertMemberIfIdentified(workspaceId);
          return yield* repo.upsertCell({
            workspaceId,
            tableId,
            rowId: args.rowId,
            columnId: args.columnId,
            patch: {
              hasValue: args.hasValue,
              ...(args.hasValue ? { value: args.value } : {}),
              ...(args.status !== undefined ? { status: args.status } : {}),
              ...(args.error !== undefined ? { error: args.error } : {}),
            },
            meter: true,
            updatedAt: Date.now(),
          });
        });

      /** Worker status-only cell write (meters only terminal). */
      const setCellStatus = (args: {
        readonly rowId: string;
        readonly columnId: string;
        readonly status: CloudCellStatus;
        readonly error?: string | null;
      }) =>
        Effect.gen(function* () {
          const { tableId, workspaceId } = yield* resolveCell(
            args.rowId,
            args.columnId,
          );
          yield* assertMemberIfIdentified(workspaceId);
          return yield* repo.upsertCell({
            workspaceId,
            tableId,
            rowId: args.rowId,
            columnId: args.columnId,
            patch: {
              hasValue: false,
              status: args.status,
              ...(args.error !== undefined ? { error: args.error } : {}),
            },
            meter: true,
            updatedAt: Date.now(),
          });
        });

      /**
       * Batched worker cell upsert: apply an ARRAY of cell writes in one call,
       * each through the same {@link setCell} path (resolve + single
       * upsert-and-meter statement). The cloud store buffers terminal writes and
       * POSTs them here in chunks, so a large column run is one request per chunk
       * instead of one per cell. Writes are applied in order; the count of cells
       * written is returned.
       */
      const setCells = (args: {
        readonly cells: ReadonlyArray<{
          readonly rowId: string;
          readonly columnId: string;
          readonly value?: unknown;
          readonly hasValue: boolean;
          readonly status?: CloudCellStatus;
          readonly error?: string | null;
        }>;
      }) =>
        Effect.gen(function* () {
          for (const cell of args.cells) {
            yield* setCell(cell);
          }
          return { written: args.cells.length };
        });

      /**
       * Decrypt the SHARED (workspace-scope) connector credential for the worker.
       * Reads only `ownerUserId IS NULL` rows (never a member's personal key) and
       * decrypts the envelope via {@link CredentialCryptoService}. Returns `null`
       * when no shared credential exists for (workspaceId, extensionId).
       */
      const getCredential = (args: {
        readonly workspaceId: string;
        readonly extensionId: string;
      }): Effect.Effect<
        { readonly secrets: SecretMap } | null,
        | WebhookRepoError
        | import("@gtmgrid/cloud").DecryptError
        | import("@gtmgrid/cloud").NotAMemberError
        | import("@gtmgrid/cloud").MemberRepoError
      > =>
        Effect.gen(function* () {
          // Decrypting a workspace's SHARED credential is member-gated on the
          // member path (a non-member gets 403); on the headless secret path the
          // assertion is skipped. Especially important here — this returns
          // plaintext connector secrets for a run.
          yield* assertMemberIfIdentified(args.workspaceId);
          const enc = yield* repo.findSharedCredentialEnc(
            args.workspaceId,
            args.extensionId,
          );
          if (enc._tag === "None") return null;
          const secrets = yield* crypto.decrypt(args.workspaceId, enc.value);
          return { secrets };
        });

      return {
        listWebhooks,
        createWebhook,
        updateWebhookConfig,
        updateWebhookMapping,
        toggleEnabled,
        rotateSecret,
        setAuth,
        listDeliveriesPaged,
        deleteWebhook,
        resolveToken,
        insertRow,
        upsertRow,
        getTable,
        getTableMeta,
        assertColumnRunQuota,
        setCell,
        setCells,
        setCellStatus,
        getCredential,
      } as const;
    }),
    dependencies: [],
  },
) {}
