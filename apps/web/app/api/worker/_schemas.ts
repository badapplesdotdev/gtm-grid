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
  code: nullableStr,
  params: z.unknown().optional(),
  condition: nullableStr,
});

export const CreateTableSchema = z.object({ projectId: id, name: z.string() });
export const DeleteColumnSchema = z.object({ columnId: id });
export const DeleteRowSchema = z.object({ rowId: id });
export const DeleteTableSchema = z.object({ tableId: id });
export const GetCredentialSchema = z.object({ workspaceId: id, extensionId: id });
export const ListExtensionsSchema = z.object({ workspaceId: id });
export const GetTableSchema = z.object({ tableId: id });
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
    code: nullableStr,
    params: z.unknown().optional(),
    condition: nullableStr,
  }),
});
