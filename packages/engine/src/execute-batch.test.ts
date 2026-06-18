// Connector batchSize (TRI-3281): when a method declares batchSize > 1 and a
// `runBatch`, `Engine.runColumn` groups rows into chunks of that size and makes
// ONE method call per chunk, fanning each ordered result back to the right row's
// cell. batchSize:1 (or a method without `runBatch`) keeps the per-row path.

import { describe, expect, it } from "vitest";
import { chunk, Engine } from "./execute.js";
import { Registry } from "./registry.js";
import { makeMemoryStore, type MemoryStore } from "./test-helpers.js";
import type { Connector, ConnectorMethod } from "./types.js";

/**
 * A connector whose `upper` method declares `batchSize` and records every batch
 * it receives. Each call upper-cases `inputs.value`, returning results in input
 * order so the engine can fan them back to the right rows.
 */
function batchRegistry(batchSize: number) {
  const batches: string[][] = []; // the value of each input, per batch call
  let runCalls = 0; // per-row run() invocations (should stay 0 when batched)
  const method: ConnectorMethod = {
    id: "upper",
    label: "Upper",
    description: "Upper-cases value; supports bulk.",
    inputSchema: {},
    batchSize,
    credits: 0,
    run: async (inputs) => {
      runCalls++;
      return { text: String(inputs.value ?? "").toUpperCase() };
    },
    runBatch: async (inputs) => {
      batches.push(inputs.map((i) => String(i.value ?? "")));
      return inputs.map((i) => ({ text: String(i.value ?? "").toUpperCase() }));
    },
  };
  const connector: Connector = { id: "test", name: "Test", category: "test", auth: null, methods: [method] };
  return {
    registry: new Registry([connector]),
    batches,
    get runCalls() {
      return runCalls;
    },
  };
}

/** Seed a store with N rows whose `Name` cell is `name{i}`, plus a function column. */
function seed(store: MemoryStore, batchSizeColumn: { provider: string; method: string }, n: number) {
  store.addColumn({ id: "name", table_id: "t", name: "Name", kind: "manual" });
  store.addColumn({
    id: "out",
    table_id: "t",
    name: "Upper",
    kind: "function",
    provider: batchSizeColumn.provider,
    method: batchSizeColumn.method,
    // No custom `code`: a plain method-call column, eligible for batching.
    params: { value: "{{Name}}" },
  });
  const rows = Array.from({ length: n }, (_, i) => {
    const id = `r${i}`;
    store.addRow({ id, table_id: "t" });
    store.setCellSync(id, "name", { value: `name${i}`, status: "done" });
    return id;
  });
  return { tableId: "t", nameColId: "name", colId: "out", rowIds: rows };
}

describe("chunk", () => {
  it("splits into fixed-size groups, last one smaller", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2, 3], 1)).toEqual([[1], [2], [3]]);
    expect(chunk([], 10)).toEqual([]);
  });
});

describe("runColumn honors batchSize", () => {
  it("issues ~rows/N batch calls and maps each result to the right row", async () => {
    const store = makeMemoryStore();
    const N = 5;
    const ROWS = 23; // ceil(23/5) = 5 batch calls
    const reg = batchRegistry(N);
    const { colId, rowIds } = seed(store, { provider: "test", method: "upper" }, ROWS);

    const engine = new Engine({ defaultRateLimit: {} }, reg.registry, { store, creds: store });
    const res = await engine.runColumn(colId);

    expect(res).toEqual({ ran: ROWS, errors: 0 });
    // ONE call per batch, never the per-row path.
    expect(reg.batches.length).toBe(Math.ceil(ROWS / N));
    expect(reg.runCalls).toBe(0);
    // Each batch is at most N rows; total inputs == rows.
    expect(reg.batches.every((b) => b.length <= N)).toBe(true);
    expect(reg.batches.flat().length).toBe(ROWS);

    // Every row's cell got ITS OWN upper-cased value (keying preserved).
    for (let i = 0; i < ROWS; i++) {
      expect(store.readCell(rowIds[i], colId)?.value).toBe(`NAME${i}`);
      expect(store.readCell(rowIds[i], colId)?.status).toBe("done");
    }
  });

  it("preserves order when results are mapped back to cells", async () => {
    const store = makeMemoryStore();
    const reg = batchRegistry(10);
    const { colId, rowIds } = seed(store, { provider: "test", method: "upper" }, 10);
    const engine = new Engine({ defaultRateLimit: {} }, reg.registry, { store, creds: store });
    await engine.runColumn(colId);

    // One batch of 10, in the same row order we seeded.
    expect(reg.batches).toHaveLength(1);
    expect(reg.batches[0]).toEqual(rowIds.map((_, i) => `name${i}`));
    rowIds.forEach((rowId, i) => {
      expect(store.readCell(rowId, colId)?.value).toBe(`NAME${i}`);
    });
  });

  it("falls back to per-row run() when batchSize is 1", async () => {
    const store = makeMemoryStore();
    const reg = batchRegistry(1);
    const { colId, rowIds } = seed(store, { provider: "test", method: "upper" }, 4);
    const engine = new Engine({ defaultRateLimit: {} }, reg.registry, { store, creds: store });
    const res = await engine.runColumn(colId);

    expect(res).toEqual({ ran: 4, errors: 0 });
    expect(reg.batches).toHaveLength(0); // never batched
    expect(reg.runCalls).toBe(4); // one run() per row
    rowIds.forEach((rowId, i) => expect(store.readCell(rowId, colId)?.value).toBe(`NAME${i}`));
  });

  it("only batches pending rows, leaving already-done cells untouched", async () => {
    const store = makeMemoryStore();
    const reg = batchRegistry(2);
    const { colId, rowIds } = seed(store, { provider: "test", method: "upper" }, 4);
    // Pre-complete two rows; without force they must be skipped.
    store.setCellSync(rowIds[0], colId, { value: "DONE", status: "done" });
    store.setCellSync(rowIds[2], colId, { value: "DONE", status: "done" });

    const engine = new Engine({ defaultRateLimit: {} }, reg.registry, { store, creds: store });
    const res = await engine.runColumn(colId);

    expect(res).toEqual({ ran: 2, errors: 0 });
    // Only the 2 pending rows were grouped -> 1 batch call of 2.
    expect(reg.batches).toEqual([["name1", "name3"]]);
    expect(store.readCell(rowIds[0], colId)?.value).toBe("DONE");
    expect(store.readCell(rowIds[1], colId)?.value).toBe("NAME1");
    expect(store.readCell(rowIds[2], colId)?.value).toBe("DONE");
    expect(store.readCell(rowIds[3], colId)?.value).toBe("NAME3");
  });

  it("fails every cell in a batch when the batch call throws", async () => {
    const store = makeMemoryStore();
    const method: ConnectorMethod = {
      id: "boom",
      label: "Boom",
      description: "Always throws in bulk.",
      inputSchema: {},
      batchSize: 3,
      credits: 0,
      run: async () => ({ text: "unused" }),
      runBatch: async () => {
        throw new Error("bulk kaboom");
      },
    };
    const connector: Connector = { id: "test", name: "Test", category: "test", auth: null, methods: [method] };
    const { colId, rowIds } = seed(store, { provider: "test", method: "boom" }, 3);

    const engine = new Engine({ defaultRateLimit: {} }, new Registry([connector]), { store, creds: store });
    const res = await engine.runColumn(colId);

    expect(res).toMatchObject({ ran: 0, errors: 3 });
    for (const rowId of rowIds) {
      expect(store.readCell(rowId, colId)?.status).toBe("error");
      expect(store.readCell(rowId, colId)?.error).toMatch(/bulk kaboom/);
    }
  });
});
