/**
 * Tests for the cell-upsert COALESCE merge (CellMerge).
 *
 * Outcome-focused (docs/effect-conventions.md): we assert the merged fields a
 * `setCell` would persist, covering the COALESCE rules the engine enforces
 * (packages/engine/src/db.ts:303-327) — value/status kept when omitted, error
 * always written, updatedAt always bumped — plus the new-cell path.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { type CellFields, CellMerge, type CellPatch } from "./cells.js";

const NOW = 1_700_000_000_000;

const run = <A>(effect: Effect.Effect<A, never, CellMerge>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(CellMerge.Default)));

const merge = (
  existing: CellFields | null | undefined,
  patch: CellPatch,
  updatedAt = NOW,
): Promise<CellFields> =>
  run(
    Effect.gen(function* () {
      const svc = yield* CellMerge;
      return yield* svc.mergeCellPatch(existing, patch, updatedAt);
    }),
  );

const existingCell: CellFields = {
  value: "old",
  status: "done",
  error: null,
  updatedAt: 1,
};

describe("CellMerge.mergeCellPatch — COALESCE semantics", () => {
  it("keeps existing value when the patch omits value", async () => {
    const merged = await merge(existingCell, { status: "running" });
    expect(merged.value).toBe("old");
    expect(merged.status).toBe("running");
  });

  it("keeps existing status when the patch omits status (value-only edit)", async () => {
    const merged = await merge(existingCell, { value: "new" });
    expect(merged.value).toBe("new");
    expect(merged.status).toBe("done");
  });

  it("overwrites value AND status when both are provided", async () => {
    const merged = await merge(existingCell, { value: 42, status: "error" });
    expect(merged.value).toBe(42);
    expect(merged.status).toBe("error");
  });

  it("treats an explicit value: null as a real overwrite (not omission)", async () => {
    const merged = await merge(existingCell, { value: null });
    expect(merged.value).toBeNull();
    // status preserved since it was omitted
    expect(merged.status).toBe("done");
  });

  it("always writes error from the patch, clearing it when absent", async () => {
    const withError = await merge(existingCell, { error: "boom" });
    expect(withError.error).toBe("boom");

    const cleared = await merge(
      { ...existingCell, error: "boom" },
      { status: "done" },
    );
    expect(cleared.error).toBeNull();
  });

  it("always bumps updatedAt to the supplied timestamp", async () => {
    const merged = await merge(existingCell, { status: "running" }, 999);
    expect(merged.updatedAt).toBe(999);
  });
});

describe("CellMerge.mergeCellPatch — new cell (no existing row)", () => {
  it("starts from empty defaults for a status-only patch", async () => {
    const merged = await merge(null, { status: "pending" });
    expect(merged).toEqual({
      value: null,
      status: "pending",
      error: null,
      updatedAt: NOW,
    });
  });

  it("uses empty status when neither existing nor patch provide one", async () => {
    const merged = await merge(undefined, { value: "hello" });
    expect(merged.value).toBe("hello");
    expect(merged.status).toBe("empty");
  });
});
