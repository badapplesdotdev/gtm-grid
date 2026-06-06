/**
 * Inbound webhook endpoints (Part: webhooks backend).
 *
 * Two distinct surfaces live here:
 *
 *   1. MEMBER-GATED CONFIG CRUD (public queries/mutations) — the desktop UI uses
 *      these to create/list/edit webhooks. Each resolves the owning workspace
 *      from the parent doc and calls the T3 `requireMember` guard. Config CRUD is
 *      NOT a billable CLOUD action — it is metadata, not a grid write — so it does
 *      NOT call `meterCloudAction` (only the worker's `insertWebhookRow` meters).
 *
 *   2. HEADLESS WORKER FUNCTIONS (internal queries/mutations) — the apps/inngest
 *      receiver, gated upstream by the WEBHOOK_WORKER_SECRET at the HTTP boundary
 *      (convex/http.ts), invokes these to resolve a token, fetch a table, and
 *      write rows/cells. They are `internal*` so they are NOT publicly callable;
 *      they deliberately SKIP `requireMember` because a headless worker has no
 *      member identity (the secret is the trust boundary).
 *
 * Metering rules (deliberately precise to avoid double-counting):
 *   - `insertWebhookRow` meters EXACTLY ONCE per received record (one row + its
 *     cells = one cloud action), mirroring the CSV import's "one action per row".
 *   - `setCellFromWorker` / `setCellStatusFromWorker` meter ONLY on a TERMINAL
 *     status (`done` / `error`), never on `running` — this avoids the
 *     running+done double-count the member desktop path (convex/cells.ts) has.
 *
 * The `getCredentialForWorker` decrypt action is a `"use node"` action and lives
 * in convex/credentials.ts (alongside its sibling `getCredentialForRun`), because
 * a `"use node"` module may export ONLY actions — it cannot co-exist with the
 * queries/mutations in this file.
 */

import { ConvexError, v } from "convex/values";
import { requireMember } from "./model/auth.js";
import { mergeCellPatch } from "./model/grid.js";
import { meterCloudAction } from "./model/meter.js";
import { cellStatus, webhookFieldMapping } from "./schema.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
  type QueryCtx,
  query,
} from "./_generated/server.js";

/** Load a doc by id or fail with a typed NotFound the client can read. */
async function getOrThrow<
  T extends "tables" | "columns" | "rows" | "webhooks",
>(ctx: QueryCtx, table: T, id: Id<T>): Promise<Doc<T>> {
  const doc = await ctx.db.get(id);
  if (doc === null) {
    throw new ConvexError({
      code: "NotFoundError",
      message: `${table} ${id} not found.`,
    });
  }
  return doc as Doc<T>;
}

/**
 * The set of column ids that belong to `tableId`. Used to validate that every
 * `mapping[].columnId` (and every cell write) targets a column in the webhook's
 * bound table — no cross-table writes. Mirrors tables.ts `validColumnIds`.
 */
async function tableColumnIds(
  ctx: QueryCtx | MutationCtx,
  tableId: Id<"tables">,
): Promise<Set<string>> {
  const columns = await ctx.db
    .query("columns")
    .withIndex("by_table", (q) => q.eq("tableId", tableId))
    .collect();
  return new Set<string>(columns.map((c) => c._id));
}

/** Assert every mapping entry targets a column in `tableId`, else throw. */
async function assertMappingColumns(
  ctx: QueryCtx | MutationCtx,
  tableId: Id<"tables">,
  mapping: readonly { columnId: Id<"columns"> }[],
): Promise<void> {
  const valid = await tableColumnIds(ctx, tableId);
  for (const m of mapping) {
    if (!valid.has(m.columnId)) {
      throw new ConvexError({
        code: "InvalidMappingError",
        message: `Column ${m.columnId} does not belong to table ${tableId}.`,
      });
    }
  }
}

/**
 * Mint a high-entropy URL-safe token. `globalThis.crypto.getRandomValues` is
 * available in Convex's DEFAULT V8 mutation runtime (no `"use node"` needed), so
 * the plain `createWebhook` / `rotateSecret` mutations can mint tokens directly.
 * 32 bytes → 256 bits of entropy, base64url-encoded (no padding).
 */
function mintToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Member-gated config CRUD (public). NOT metered — config is metadata.
// ---------------------------------------------------------------------------

/**
 * List the webhooks bound to a table (newest first). Members-only — the table's
 * workspace gates access. Drives the webhook config panel in the desktop UI.
 */
export const listWebhooks = query({
  args: { tableId: v.id("tables") },
  handler: async (ctx, { tableId }) => {
    const table = await getOrThrow(ctx, "tables", tableId);
    await requireMember(ctx, table.workspaceId);
    const webhooks = await ctx.db
      .query("webhooks")
      .withIndex("by_table", (q) => q.eq("tableId", tableId))
      .collect();
    return [...webhooks].sort((a, b) => b.createdAt - a.createdAt);
  },
});

/**
 * Create a webhook bound to a table, minting its public token. Members-only.
 * Validates every mapping entry targets a column in the table. NOT metered.
 */
export const createWebhook = mutation({
  args: {
    tableId: v.id("tables"),
    name: v.optional(v.string()),
    mapping: v.optional(v.array(webhookFieldMapping)),
  },
  handler: async (ctx, { tableId, name, mapping }) => {
    const table = await getOrThrow(ctx, "tables", tableId);
    await requireMember(ctx, table.workspaceId);

    const resolvedMapping = mapping ?? [];
    await assertMappingColumns(ctx, tableId, resolvedMapping);

    return await ctx.db.insert("webhooks", {
      workspaceId: table.workspaceId,
      tableId,
      name,
      token: mintToken(),
      mapping: resolvedMapping,
      enabled: true,
      createdAt: Date.now(),
      lastReceivedAt: null,
      receivedCount: 0,
    });
  },
});

/**
 * Replace a webhook's field mapping. Members-only. Re-validates that every
 * `columnId` belongs to the webhook's bound table so a mapping can never point at
 * a foreign column. NOT metered.
 */
export const updateWebhookMapping = mutation({
  args: {
    webhookId: v.id("webhooks"),
    mapping: v.array(webhookFieldMapping),
  },
  handler: async (ctx, { webhookId, mapping }) => {
    const webhook = await getOrThrow(ctx, "webhooks", webhookId);
    await requireMember(ctx, webhook.workspaceId);
    await assertMappingColumns(ctx, webhook.tableId, mapping);
    await ctx.db.patch(webhookId, { mapping });
  },
});

/** Enable/disable a webhook. Members-only. NOT metered. */
export const toggleEnabled = mutation({
  args: { webhookId: v.id("webhooks"), enabled: v.boolean() },
  handler: async (ctx, { webhookId, enabled }) => {
    const webhook = await getOrThrow(ctx, "webhooks", webhookId);
    await requireMember(ctx, webhook.workspaceId);
    await ctx.db.patch(webhookId, { enabled });
  },
});

/**
 * Rotate a webhook's secret token, invalidating the old URL. Members-only.
 * Mints a fresh high-entropy token via Web Crypto. NOT metered.
 */
export const rotateSecret = mutation({
  args: { webhookId: v.id("webhooks") },
  handler: async (ctx, { webhookId }) => {
    const webhook = await getOrThrow(ctx, "webhooks", webhookId);
    await requireMember(ctx, webhook.workspaceId);
    const token = mintToken();
    await ctx.db.patch(webhookId, { token });
    return { token };
  },
});

/** Delete a webhook. Members-only. NOT metered. */
export const deleteWebhook = mutation({
  args: { webhookId: v.id("webhooks") },
  handler: async (ctx, { webhookId }) => {
    const webhook = await getOrThrow(ctx, "webhooks", webhookId);
    await requireMember(ctx, webhook.workspaceId);
    await ctx.db.delete(webhookId);
  },
});

// ---------------------------------------------------------------------------
// Headless worker functions (internal). Gated by WEBHOOK_WORKER_SECRET at the
// HTTP boundary (convex/http.ts), NOT by requireMember.
// ---------------------------------------------------------------------------

/**
 * Resolve an inbound token to its (enabled) webhook for the worker. Internal:
 * only reachable via the secret-gated HTTP route. Returns the webhook's id,
 * workspace, table, and mapping when it exists AND is enabled; `null` otherwise
 * (a disabled or unknown token is silently a no-op to the receiver).
 */
export const resolveWebhookToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const webhook = await ctx.db
      .query("webhooks")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (webhook === null || !webhook.enabled) return null;
    return {
      webhookId: webhook._id,
      workspaceId: webhook.workspaceId,
      tableId: webhook.tableId,
      mapping: webhook.mapping,
    };
  },
});

/**
 * Insert ONE received record as a row + its cells into the webhook's table.
 * Internal worker path (secret-gated upstream).
 *
 * `cells` is a `{ columnId: value }` map; empty values are skipped and values
 * for columns not in this table are ignored (no cross-table writes), exactly
 * like the CSV import (tables.ts `addRowsWithCells`). Metered EXACTLY ONCE per
 * record (one cloud action), regardless of how many cells are written.
 *
 * Also bumps the webhook's `lastReceivedAt` / `receivedCount` telemetry.
 */
export const insertWebhookRow = internalMutation({
  args: {
    webhookId: v.id("webhooks"),
    cells: v.record(v.string(), v.any()),
  },
  handler: async (ctx, { webhookId, cells }) => {
    const webhook = await getOrThrow(ctx, "webhooks", webhookId);
    const table = await getOrThrow(ctx, "tables", webhook.tableId);

    // Atomic quota pre-check against cached usage (free tier has a hard cap),
    // mirroring tables.ts addRowsWithCells. One record = one cloud action.
    const workspace = await ctx.db.get(table.workspaceId);
    const limit = workspace?.cloudActionsLimit;
    if (typeof limit === "number") {
      const used = workspace?.cloudActionsUsed ?? 0;
      const pending = workspace?.cloudActionsPending ?? 0;
      if (used + pending + 1 > limit) {
        throw new ConvexError({
          code: "CloudActionsLimitError",
          message:
            "This webhook delivery would exceed your plan's remaining cloud actions.",
        });
      }
    }

    // Only write cells for columns that actually belong to this table.
    const validColumnIds = await tableColumnIds(ctx, table._id);

    const siblings = await ctx.db
      .query("rows")
      .withIndex("by_table", (q) => q.eq("tableId", table._id))
      .collect();
    const position = siblings.reduce(
      (max, s) => Math.max(max, s.position + 1),
      0,
    );
    const now = Date.now();

    const rowId = await ctx.db.insert("rows", {
      workspaceId: table.workspaceId,
      tableId: table._id,
      position,
      createdAt: now,
    });
    for (const [columnId, value] of Object.entries(cells)) {
      if (value === "" || value === null || value === undefined) continue;
      if (!validColumnIds.has(columnId)) continue;
      await ctx.db.insert("cells", {
        workspaceId: table.workspaceId,
        tableId: table._id,
        rowId,
        columnId: columnId as Id<"columns">,
        value,
        status: "done",
        error: null,
        updatedAt: now,
      });
    }

    // Exactly ONE billable cloud action per received record (not per cell).
    await meterCloudAction(ctx, table.workspaceId);

    // Telemetry: bump the webhook's received counters.
    await ctx.db.patch(webhook._id, {
      lastReceivedAt: now,
      receivedCount: (webhook.receivedCount ?? 0) + 1,
    });

    return { rowId };
  },
});

/** Next `position` for a new sibling = max(existing) + 1 (0 when empty). */
const byPosition = <T extends { position: number; createdAt: number }>(
  a: T,
  b: T,
) => a.position - b.position || a.createdAt - b.createdAt;

/**
 * The full grid for a table for the worker — the SAME payload shape as
 * `tables.getTable` ({ table, columns, rows, cells }) MINUS the `requireMember`
 * guard. Internal worker path. The output must match what
 * packages/engine/src/store-convex.ts `fetchGrid` consumes.
 */
export const getTableForWorker = internalQuery({
  args: { tableId: v.id("tables") },
  handler: async (ctx, { tableId }) => {
    const table = await getOrThrow(ctx, "tables", tableId);

    const [columns, rows, cells] = await Promise.all([
      ctx.db
        .query("columns")
        .withIndex("by_table", (q) => q.eq("tableId", tableId))
        .collect(),
      ctx.db
        .query("rows")
        .withIndex("by_table", (q) => q.eq("tableId", tableId))
        .collect(),
      ctx.db
        .query("cells")
        .withIndex("by_table", (q) => q.eq("tableId", tableId))
        .collect(),
    ]);

    return {
      table,
      columns: [...columns].sort(byPosition),
      rows: [...rows].sort(byPosition),
      cells,
    };
  },
});

/**
 * Resolve + assert the (row, column) pair belong to the same table, returning the
 * existing cell (or null). The worker analogue of cells.ts `resolveCell` MINUS
 * `requireMember` (the worker has no member identity; the secret gates it).
 */
async function resolveCellForWorker(
  ctx: MutationCtx,
  rowId: Id<"rows">,
  columnId: Id<"columns">,
) {
  const row = await ctx.db.get(rowId);
  const column = await ctx.db.get(columnId);
  if (row === null || column === null) {
    throw new ConvexError({
      code: "NotFoundError",
      message: "Row or column not found.",
    });
  }
  if (row.tableId !== column.tableId) {
    throw new ConvexError({
      code: "InvalidCellError",
      message: "Row and column belong to different tables.",
    });
  }
  const existing = await ctx.db
    .query("cells")
    .withIndex("by_row_column", (q) =>
      q.eq("rowId", rowId).eq("columnId", columnId),
    )
    .unique();
  return { row, column, existing };
}

/** A terminal cell status (the only states that meter on the worker path). */
const isTerminalStatus = (status: Doc<"cells">["status"]): boolean =>
  status === "done" || status === "error";

/**
 * Worker cell upsert with COALESCE merge — the analogue of cells.ts `setCell`
 * MINUS `requireMember`. Internal worker path.
 *
 * Metering: counts ONE cloud action ONLY when the resulting status is TERMINAL
 * (`done` / `error`), NEVER on `running`. This deliberately avoids the
 * running+done double-count the member desktop path has, since the worker streams
 * running→done for each cell and we want exactly one charge per completed cell.
 */
export const setCellFromWorker = internalMutation({
  args: {
    rowId: v.id("rows"),
    columnId: v.id("columns"),
    value: v.optional(v.any()),
    status: v.optional(cellStatus),
    error: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const { row, existing } = await resolveCellForWorker(
      ctx,
      args.rowId,
      args.columnId,
    );

    const patch = {
      ...("value" in args ? { value: args.value } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.error !== undefined ? { error: args.error } : {}),
    };
    const merged = await mergeCellPatch(existing, patch, Date.now());

    // Meter ONLY on a terminal status — never on `running` (no double-count).
    if (isTerminalStatus(merged.status)) {
      await meterCloudAction(ctx, row.workspaceId);
    }

    if (existing === null) {
      return await ctx.db.insert("cells", {
        workspaceId: row.workspaceId,
        tableId: row.tableId,
        rowId: args.rowId,
        columnId: args.columnId,
        value: merged.value,
        status: merged.status,
        error: merged.error,
        updatedAt: merged.updatedAt,
      });
    }
    await ctx.db.patch(existing._id, {
      value: merged.value,
      status: merged.status,
      error: merged.error,
      updatedAt: merged.updatedAt,
    });
    return existing._id;
  },
});

/**
 * Worker status-only cell write — the analogue of cells.ts `setCellStatus` MINUS
 * `requireMember`. Internal worker path. Meters ONLY on a TERMINAL status
 * (`done` / `error`), never on `running` (see {@link setCellFromWorker}).
 */
export const setCellStatusFromWorker = internalMutation({
  args: {
    rowId: v.id("rows"),
    columnId: v.id("columns"),
    status: cellStatus,
    error: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const { row, existing } = await resolveCellForWorker(
      ctx,
      args.rowId,
      args.columnId,
    );

    const merged = await mergeCellPatch(
      existing,
      {
        status: args.status,
        ...(args.error !== undefined ? { error: args.error } : {}),
      },
      Date.now(),
    );

    // Meter ONLY on a terminal status — never on `running` (no double-count).
    if (isTerminalStatus(merged.status)) {
      await meterCloudAction(ctx, row.workspaceId);
    }

    if (existing === null) {
      return await ctx.db.insert("cells", {
        workspaceId: row.workspaceId,
        tableId: row.tableId,
        rowId: args.rowId,
        columnId: args.columnId,
        value: merged.value,
        status: merged.status,
        error: merged.error,
        updatedAt: merged.updatedAt,
      });
    }
    await ctx.db.patch(existing._id, {
      status: merged.status,
      error: merged.error,
      updatedAt: merged.updatedAt,
    });
    return existing._id;
  },
});
