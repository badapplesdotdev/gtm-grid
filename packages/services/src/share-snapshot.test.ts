/**
 * Pure round-trip tests for the share snapshot: build (from a full grid) →
 * validate (as if re-read from storage or fetched by the MCP clone tool) →
 * assert it survives, and that the secret-free / defensive guarantees hold.
 *
 * These matter because a share link freezes a table into this snapshot and both
 * the public `/share/<token>` view and the "clone into my project" path rebuild
 * from it; a malformed or secret-bearing payload must never drive a rebuild.
 */

import { describe, expect, it } from "vitest";
import {
  SHARE_SNAPSHOT_VERSION,
  referencedProviders,
  snapshotFromFullGrid,
  validateSnapshot,
  type SnapshotSourceGrid,
} from "./share-snapshot.js";

const grid = (): SnapshotSourceGrid => ({
  table: { name: "Companies" },
  columns: [
    { _id: "c1", name: "Company", type: "text", kind: "manual", provider: null, method: null, code: null, params: {} },
    { _id: "c2", name: "Summary", type: "text", kind: "function", provider: "ai", method: "generate", code: null, params: { prompt: "{{Company}}" } },
  ],
  rows: [{ _id: "r1" }, { _id: "r2" }],
  cells: [
    { rowId: "r1", columnId: "c1", value: "Acme", status: "done", error: null },
    { rowId: "r1", columnId: "c2", value: "An enterprise", status: "done", error: "leaked?" },
    { rowId: "r2", columnId: "c1", value: null, status: "empty", error: null }, // empty → dropped
    { rowId: "r2", columnId: "unknown", value: "orphan", status: "done", error: null }, // unknown col → dropped
  ],
});

describe("share snapshot round-trip", () => {
  it("builds a secret-free snapshot and re-validates it unchanged", () => {
    const snapshot = snapshotFromFullGrid(grid());

    // status/error are never carried into the snapshot.
    expect(JSON.stringify(snapshot)).not.toContain("leaked");
    expect(JSON.stringify(snapshot)).not.toContain("status");
    // Empty + orphan cells are dropped; remaining cells are index-keyed.
    expect(snapshot.cells).toEqual([
      { row: 0, column: 0, value: "Acme" },
      { row: 0, column: 1, value: "An enterprise" },
    ]);
    expect(snapshot.version).toBe(SHARE_SNAPSHOT_VERSION);
    expect(snapshot.rows).toBe(2);

    const validated = validateSnapshot(snapshot);
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.value).toEqual(snapshot);
  });

  it("lists only function-column providers", () => {
    expect(referencedProviders(snapshotFromFullGrid(grid()))).toEqual(["ai"]);
  });

  it("rejects an unsupported snapshot version", () => {
    const result = validateSnapshot({ ...snapshotFromFullGrid(grid()), version: 999 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/version/i);
  });

  it("rejects a forged cell whose row index is out of bounds", () => {
    const forged = { ...snapshotFromFullGrid(grid()), cells: [{ row: 99, column: 0, value: "x" }] };
    const result = validateSnapshot(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/row index out of bounds/i);
  });

  it("rejects an invalid column type", () => {
    const bad = snapshotFromFullGrid(grid());
    const result = validateSnapshot({ ...bad, columns: [{ ...bad.columns[0], type: "rocket" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/column type/i);
  });
});
