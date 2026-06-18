// Per-cell run progress (TRI-3275): `Engine.runColumn`'s `onCell` callback must
// emit a `running` event then a terminal `done`/`error` event for every cell it
// processes, so the sidecar can stream progress and the desktop patches only the
// changed cells (instead of refetching+replacing the whole grid after a run).

import { describe, expect, it } from "vitest";
import { Engine, type CellProgress } from "./execute.js";
import { Registry } from "./registry.js";
import { makeMemoryStore } from "./test-helpers.js";
import type { Connector, ConnectorMethod } from "./types.js";

/** Echo connector for happy-path cells; no network/AI. */
const echoRegistry = (): Registry => {
  const method: ConnectorMethod = {
    id: "echo",
    label: "Echo",
    description: "Returns { text } from the input.",
    inputSchema: {},
    batchSize: 1,
    credits: 0,
    run: async (inputs) => ({ text: String(inputs.value ?? "") }),
  };
  const connector: Connector = { id: "test", name: "Test", category: "test", auth: null, methods: [method] };
  return new Registry([connector]);
};

describe("runColumn onCell progress stream", () => {
  it("emits running then done for each processed cell, with the final value", async () => {
    const store = makeMemoryStore();
    store.addColumn({ id: "name", table_id: "t", name: "Name", kind: "manual" });
    store.addColumn({
      id: "upper",
      table_id: "t",
      name: "Upper",
      kind: "function",
      code: "function(inputs, sdk){ return { text: String(inputs.name).toUpperCase() }; }",
      params: { name: "{{Name}}" },
    });
    store.addRow({ id: "r1", table_id: "t" });
    store.addRow({ id: "r2", table_id: "t" });
    store.setCellSync("r1", "name", { value: "ada", status: "done" });
    store.setCellSync("r2", "name", { value: "grace", status: "done" });

    const events: CellProgress[] = [];
    const engine = new Engine({}, echoRegistry(), { store, creds: store });
    const res = await engine.runColumn("upper", { onCell: (c) => events.push(c) });

    expect(res).toEqual({ ran: 2, errors: 0 });
    // Two cells × (running + done) = 4 events.
    expect(events).toHaveLength(4);
    // Every event targets the column we ran.
    expect(events.every((e) => e.columnId === "upper")).toBe(true);

    const byRow = (rowId: string) => events.filter((e) => e.rowId === rowId);
    for (const [rowId, value] of [["r1", "ADA"], ["r2", "GRACE"]] as const) {
      const seq = byRow(rowId);
      expect(seq.map((e) => e.status)).toEqual(["running", "done"]);
      expect(seq[1].value).toBe(value);
      expect(seq[1].error).toBeNull();
    }
  });

  it("emits a terminal error event for a failing cell", async () => {
    const store = makeMemoryStore();
    store.addColumn({
      id: "bad",
      table_id: "t",
      name: "Bad",
      kind: "function",
      code: "function(){ throw new Error('kaboom'); }",
      params: {},
    });
    store.addRow({ id: "r", table_id: "t" });

    const events: CellProgress[] = [];
    const engine = new Engine({}, echoRegistry(), { store, creds: store });
    const res = await engine.runColumn("bad", { force: true, onCell: (c) => events.push(c) });

    expect(res).toMatchObject({ ran: 0, errors: 1 });
    expect(events.map((e) => e.status)).toEqual(["running", "error"]);
    const terminal = events[1];
    expect(terminal.rowId).toBe("r");
    expect(terminal.error).toMatch(/kaboom/);
  });

  it("does not abort the run when the onCell callback throws", async () => {
    const store = makeMemoryStore();
    store.addColumn({
      id: "out",
      table_id: "t",
      name: "Out",
      kind: "function",
      code: "function(){ return { text: 'ok' }; }",
      params: {},
    });
    store.addRow({ id: "r", table_id: "t" });

    const engine = new Engine({}, echoRegistry(), { store, creds: store });
    const res = await engine.runColumn("out", {
      force: true,
      onCell: () => { throw new Error("sink exploded"); },
    });

    // The run still completes and the cell is written despite the bad sink.
    expect(res).toEqual({ ran: 1, errors: 0 });
    expect(store.readCell("r", "out")?.value).toBe("ok");
    expect(store.readCell("r", "out")?.status).toBe("done");
  });
});
