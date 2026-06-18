// The engine's systemic-error reporting (PostHog Error Tracking seam): a failing
// cell run forwards the ORIGINAL error to the injected `reportError`, but DEDUPED
// per run — at most a few distinct signatures, so a large run with one failure
// mode raises one exception, not thousands. Per-cell status is unaffected.

import { describe, expect, it, vi } from "vitest";
import { Engine } from "./execute.js";
import { Registry } from "./registry.js";
import { makeMemoryStore, type MemoryStore } from "./test-helpers.js";
import type { Connector, ConnectorMethod, RunErrorContext } from "./types.js";

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

/** Seed N rows with a plain `test.boom` function column into a memory store. */
function seed(store: MemoryStore, n: number): string {
  store.addColumn({ id: "name", table_id: "t", name: "Name", kind: "manual" });
  store.addColumn({
    id: "boom",
    table_id: "t",
    name: "Boom",
    kind: "function",
    provider: "test",
    method: "boom",
    params: { value: "{{Name}}" },
  });
  for (let i = 0; i < n; i++) {
    store.addRow({ id: `r${i}`, table_id: "t" });
    store.setCellSync(`r${i}`, "name", { value: `name${i}`, status: "done" });
  }
  return "boom";
}

describe("engine reportError (deduped systemic-error seam)", () => {
  it("reports ONE exception for a run where every row fails the same way", async () => {
    const store = makeMemoryStore();
    const reportError = vi.fn();
    const colId = seed(store, 8);
    const engine = new Engine({ defaultRateLimit: {}, reportError }, throwingRegistry(), { store, creds: store });

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
    const store = makeMemoryStore();
    const reportError = vi.fn();
    const colId = seed(store, 10); // 10 distinct messages
    const engine = new Engine(
      { defaultRateLimit: {}, reportError },
      throwingRegistry({ distinctPerRow: true }),
      { store, creds: store },
    );

    const res = await engine.runColumn(colId);

    expect(res.errors).toBe(10);
    expect(reportError).toHaveBeenCalledTimes(3); // bounded
  });

  it("never calls reportError when none is injected (cells still error)", async () => {
    const store = makeMemoryStore();
    const colId = seed(store, 3);
    const engine = new Engine({ defaultRateLimit: {} }, throwingRegistry(), { store, creds: store });
    const res = await engine.runColumn(colId);
    expect(res.errors).toBe(3); // unchanged behaviour, no throw
  });
});
