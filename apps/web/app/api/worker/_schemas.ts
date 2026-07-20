/**
 * Zod schemas for every worker route body — the input-validation contract at the
 * `/api/worker/*` boundary (previously an unchecked `as T` cast). Each route imports
 * its schema and passes it to `runWorker*`, which rejects a malformed/invalid body
 * with 400 before any service runs.
 *
 * Optionality MIRRORS the prior inline interfaces (and the routes' `?? default`
 * tolerance) so validation never rejects a previously-valid call — it only rejects
 * genuinely wrong-shaped input. Types are inferred from these schemas.
 */
import { z } from "zod";

const id = z.string().min(1);

// Shared primitive unions (mirror @gtmgrid/services literal unions).
const cloudCellStatus = z.enum(["empty", "pending", "running", "done", "error"]);
const columnKind = z.enum(["manual", "function"]);
const cellMap = z.record(z.unknown());

export const AddRowsSchema = z.object({
  tableId: id,
  rows: z.array(z.record(z.unknown())).optional(),
});

export const AssertColumnRunQuotaSchema = z.object({
  tableId: id,
  columnId: id,
  rowIds: z.array(z.string()).optional(),
  force: z.boolean().optional(),
});

const nullableStr = z.string().nullable().optional();

export const CreateColumnSchema = z.object({
  tableId: id,
  name: z.string(),
  type: z.string(),
  kind: columnKind,
  provider: nullableStr,
  method: nullableStr,
  accountId: nullableStr,
  code: nullableStr,
  params: z.unknown().optional(),
  condition: nullableStr,
});

export const CreateTableSchema = z.object({ projectId: id, name: z.string() });
export const DeleteColumnSchema = z.object({ columnId: id });
export const DeleteRowSchema = z.object({ rowId: id });
export const DeleteTableSchema = z.object({ tableId: id });
export const GetCredentialSchema = z.object({
  workspaceId: id,
  extensionId: id,
  /**
   * WHICH account on the connector (a Slack team id). Absent means "the
   * workspace's only account", which the service resolves — and rejects as
   * ambiguous when there is more than one. NOT `id`: this is a provider's
   * identifier, not one of ours.
   */
  accountId: z.string().min(1).max(128).optional(),
});
export const GetExtensionsSchema = z.object({ workspaceId: id });
/** The Slack team a workspace is connected to — the Events receiver's tenant gate. */
export const SlackTeamSchema = z.object({ workspaceId: id });
export const GetTableSchema = z.object({ tableId: id });
// Scoped grid read: all columns + only these rows' cells (bounded by rowIds).
export const GetTableForRowsSchema = z.object({
  tableId: id,
  rowIds: z.array(id),
});
// Keyset grid page: cursor over the row (position, createdAt, id) total order.
const workerRowCursor = z.object({
  position: z.number(),
  createdAt: z.number(),
  id: id,
});
export const GetTablePageSchema = z.object({
  tableId: id,
  cursor: workerRowCursor.nullish(),
  limit: z.number().int().positive().max(1000).optional(),
});
export const ListTablesSchema = z.object({ projectId: id });
export const RenameTableSchema = z.object({ tableId: id, name: z.string() });
export const ReorderColumnSchema = z.object({ columnId: id, toIndex: z.number().int() });
export const ReorderRowSchema = z.object({ rowId: id, toIndex: z.number().int() });
export const ResolveTokenSchema = z.object({ token: z.string().min(1) });

export const InsertRowSchema = z.object({
  webhookId: id,
  cells: cellMap,
  recordId: z.string().optional(),
});

export const UpsertRowSchema = z.object({
  webhookId: id,
  upsertKey: z.string(),
  cells: cellMap,
  recordId: z.string().optional(),
});

// ── Cross-table actions (the table.push / table.lookup gateway routes). All
// carry the run's sourceTableId so the service can enforce same-project
// scoping server-side; targetRef may be a table NAME (not only a uuid).
export const ListProjectTablesSchema = z.object({ sourceTableId: id });
export const GetTableSchemaSchema = z.object({
  sourceTableId: id,
  targetRef: z.string().min(1),
});
export const GetTableRowsSchema = z.object({
  sourceTableId: id,
  targetTableId: id,
});
export const UpsertRowInTableSchema = z.object({
  sourceTableId: id,
  targetTableId: id,
  keyColumnId: id.nullable(),
  keyValue: z.unknown(),
  cells: cellMap,
  autoRunTarget: z.boolean().optional(),
  recordId: z.string().optional(),
});
export const CreateColumnInTableSchema = z.object({
  sourceTableId: id,
  targetTableId: id,
  name: z.string().min(1),
  type: z.enum(["text", "number", "boolean", "date", "json"]).optional(),
});
// Webhook-style push (v2): deliver ONE source row into a sibling table through
// its push connection. targetTableId may be a table NAME (resolved in-project).
export const PushRowIntoTableSchema = z.object({
  sourceTableId: id,
  sourceRowId: id,
  /** The push column itself — excluded from the delivered payload. */
  sourceColumnId: id.nullable().optional(),
  targetTableId: z.string().min(1),
  mode: z.enum(["upsert", "append"]),
  keyColumnName: z.string().nullable().optional(),
  keyValue: z.unknown().optional(),
  autoRunTarget: z.boolean().optional(),
});
export const BackfillPushMappingSchema = z.object({ webhookId: id });

export const SaveCredentialSchema = z.object({
  workspaceId: id,
  extensionId: id,
  name: z.string(),
  secrets: z.record(z.string()),
});

// setCell relies on PRESENCE of `value` (COALESCE: value:null differs from
// omitted). `z.unknown().optional()` keeps the key only when the caller sent it,
// so the route's `"value" in body` distinction survives validation.
export const SetCellSchema = z.object({
  rowId: id,
  columnId: id,
  value: z.unknown().optional(),
  status: cloudCellStatus.optional(),
  error: z.string().nullable().optional(),
});

export const SetCellStatusSchema = z.object({
  rowId: id,
  columnId: id,
  status: cloudCellStatus,
  error: z.string().nullable().optional(),
});

export const SetCellsSchema = z.object({
  cells: z.array(
    z.object({
      rowId: id,
      columnId: id,
      value: z.unknown().optional(),
      status: cloudCellStatus.optional(),
      error: z.string().nullable().optional(),
    }),
  ),
});

export const SetDedupeSchema = z.object({
  tableId: id,
  column: z.string().nullable(),
  keep: z.enum(["oldest", "newest"]).optional(),
});

export const UpdateColumnSchema = z.object({
  columnId: id,
  patch: z.object({
    name: z.string().optional(),
    type: z.string().optional(),
    kind: columnKind.optional(),
    provider: nullableStr,
    method: nullableStr,
    accountId: nullableStr,
    code: nullableStr,
    params: z.unknown().optional(),
    condition: nullableStr,
  }),
});
