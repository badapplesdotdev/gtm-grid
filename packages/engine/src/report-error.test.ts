// The engine's systemic-error reporting (PostHog Error Tracking seam): a failing
// cell run forwards the ORIGINAL error to the injected `reportError`, but DEDUPED
// per run — at most a few distinct signatures, so a large run with one failure
// mode raises one exception, not thousands. Per-cell status is unaffected.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Db } from "./db.js";
import { Engine } from "./execute.js";
import { Registry } from "./registry.js";
import type { Connector, ConnectorMethod, RunErrorContext } from "./types.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "report-error-test-"));
  db = new Db(join(dir, "project.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A connector whose `boom` method throws — fixed message, or per-row distinct. */
function throwingRegistry(opts: { distinctPerRow?: boolean } = {}) {
  const method: ConnectorMethod = {
    id: "boom",
    label: "Boom",
    description: "Always throws.",
    inputSchema: {},
    batchSize: 1,
    credits: 0,
    run: async (inputs) => {
      throw new Error(opts.distinctPerRow ? `fail ${String(inputs.value)}` : "always the same failure");
    },
  };
  const connector: Connector = { id: "test", name: "Test", category: "test", auth: null, methods: [method] };
  return new Registry([connector]);
}

/** Seed N rows with a plain `test.boom` function column. */
function seed(n: number) {
  const table = db.createTable("Leads");
  const name = db.createColumn({ tableId: table.id, name: "Name", kind: "manual" });
  const out = db.createColumn({
    tableId: table.id,
    name: "Boom",
    kind: "function",
    provider: "test",
    method: "boom",
    params: { value: "{{Name}}" },
  });
  for (let i = 0; i < n; i++) {
    const r = db.createRow(table.id);
    db.setCell(r.id, name.id, { value: `name${i}`, status: "done" });
  }
  return out.id;
}

describe("engine reportError (deduped systemic-error seam)", () => {
  it("reports ONE exception for a run where every row fails the same way", async () => {
    const reportError = vi.fn();
    const colId = seed(8);
    const engine = new Engine(db, { defaultRateLimit: {}, reportError }, throwingRegistry());

    const res = await engine.runColumn(colId);

    expect(res.errors).toBe(8); // every cell still recorded as an error
    expect(res.ran).toBe(0);
    expect(reportError).toHaveBeenCalledTimes(1); // deduped to one signature
    const [error, ctx] = reportError.mock.calls[0] as [unknown, RunErrorContext];
    expect(error).toBeInstanceOf(Error); // the ORIGINAL thrown error (full stack)
    expect(ctx).toMatchObject({ columnId: colId, provider: "test", method: "boom" });
    expect(typeof ctx.rowId).toBe("string");
  });

  it("caps distinct signatures at 3 even with many distinct failures", async () => {
    const reportError = vi.fn();
    const colId = seed(10); // 10 distinct messages
    const engine = new Engine(db, { defaultRateLimit: {}, reportError }, throwingRegistry({ distinctPerRow: true }));

    const res = await engine.runColumn(colId);

    expect(res.errors).toBe(10);
    expect(reportError).toHaveBeenCalledTimes(3); // bounded
  });

  it("never calls reportError when none is injected (cells still error)", async () => {
    const colId = seed(3);
    const engine = new Engine(db, { defaultRateLimit: {} }, throwingRegistry());
    const res = await engine.runColumn(colId);
    expect(res.errors).toBe(3); // unchanged behaviour, no throw
  });
});
