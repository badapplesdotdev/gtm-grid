/**
 * Pure cell-upsert domain logic for the Convex cloud tier (T4).
 *
 * Convex has no SQL `ON CONFLICT ... DO UPDATE SET value = COALESCE(...)` — the
 * merge semantics the engine relies on (packages/engine/src/db.ts:303-327) must
 * be expressed in code. This module is the single, unit-tested source of truth
 * for HOW a `setCell` patch merges onto an existing cell, so the Convex
 * `cells.ts` handler stays a thin wrapper (read row → `mergeCellPatch` → write).
 *
 * COALESCE merge rules, mirroring the engine exactly:
 *   - `value`  : overwritten ONLY when the patch provides it; otherwise kept.
 *   - `status` : overwritten ONLY when the patch provides it; otherwise kept.
 *   - `error`  : ALWAYS set from the patch (engine writes `error = @error`, so a
 *                patch with no error clears it to null).
 *   - `updatedAt`: ALWAYS bumped to the supplied timestamp.
 * Inserting a brand-new cell uses the same rules against empty defaults, so a
 * status-only patch on a fresh cell yields `value: null`, an explicit status,
 * and `error: null`.
 *
 * Pure (no Convex import): stays in the root `tsc -b` graph and runs under the
 * cloud package's Vitest project with the rest of the domain logic. The Convex
 * handler supplies the timestamp + existing row; this function decides the
 * resulting fields.
 *
 * Follows the canonical Effect service shape (docs/effect-conventions.md):
 * an `Effect.Service` with a `.Default` Layer, methods returning `Effect`.
 */

import { Effect } from "effect";

/** Cell status literals — mirrors `cellStatus` in convex/schema.ts. */
export type CloudCellStatus =
  | "empty"
  | "pending"
  | "running"
  | "done"
  | "error";

/**
 * The persisted fields of a cell the merge cares about. `value` is arbitrary
 * JSON (`unknown`); `updatedAt` may be null on a never-written cell.
 */
export interface CellFields {
  readonly value: unknown;
  readonly status: CloudCellStatus;
  readonly error: string | null;
  readonly updatedAt: number | null;
}

/**
 * A `setCell` patch. `value` / `status` are OPTIONAL — omitting a field means
 * "leave it unchanged" (the COALESCE behaviour). `error` is optional in the API
 * but, when the merge runs, an absent error clears the cell's error to null,
 * matching the engine's `error = @error` write.
 */
export interface CellPatch {
  readonly value?: unknown;
  readonly status?: CloudCellStatus;
  readonly error?: string | null;
}

/** The default fields a brand-new (not-yet-existing) cell starts from. */
const EMPTY_CELL: CellFields = {
  value: null,
  status: "empty",
  error: null,
  updatedAt: null,
};

/**
 * Merge a {@link CellPatch} onto existing cell fields (or {@link EMPTY_CELL} for
 * a new cell), returning the fields to persist. The pure heart of `setCell`.
 *
 * `value`/`status` use COALESCE semantics (kept when the patch omits them);
 * `error` and `updatedAt` are always taken from the patch/timestamp.
 */
export class CellMerge extends Effect.Service<CellMerge>()("CellMerge", {
  sync: () => ({
    /**
     * @param existing the current cell fields, or `null`/`undefined` when no
     *   cell row exists yet (treated as {@link EMPTY_CELL}).
     * @param patch the incoming `setCell` patch.
     * @param updatedAt the timestamp to stamp the write with.
     */
    mergeCellPatch: (
      existing: CellFields | null | undefined,
      patch: CellPatch,
      updatedAt: number,
    ): Effect.Effect<CellFields> => {
      const base = existing ?? EMPTY_CELL;
      return Effect.succeed({
        // COALESCE: only overwrite when the patch carries the field.
        value: "value" in patch ? patch.value : base.value,
        status: patch.status ?? base.status,
        // engine writes `error = @error` unconditionally — absent => null.
        error: patch.error ?? null,
        updatedAt,
      });
    },
  }),
}) {}
