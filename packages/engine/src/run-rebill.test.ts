// TRI-3283 L2: a recompute must NOT re-bill cells whose inputs are unchanged.
// A "bill" is a cell WRITE (the cloud meter increments per terminal write), so a
// re-bill shows up here as a `done` event re-emitted for a cell that was already
// `done`. These tests pin the run engine's targeting semantics that the desktop
// `runCell` / auto-run handlers rely on:
//   - a single-cell run (`force:true, rowIds:[r]`) writes ONLY that row's cell —
//     the OTHER already-`done` rows are never re-run/re-billed; and
//   - an unscoped, unforced run skips every already-`done` cell (no re-bill),
//     only writing the rows that still need computing.

import { describe, expect, it } from "vitest";
import { Engine, type CellProgress } from "./execute.js";
import { Registry } from "./registry.js";
import { makeMemoryStore } from "./test-helpers.js";
import type { Connector, ConnectorMethod } from "./types.js";

/** Echo connector — pure, no network/AI; `{ text }` from the input. */
const echoRegistry = (): Registry => {
  const method: ConnectorMethod = {
    id: "echo",
    label: "Echo",
    description: "Returns { text } from the input.",
    inputSchema: {},
    batchSize: 1,
    credits: 0,
    run: async (inputs) => ({ text: String(inputs.name ?? "") }),
  };
  const connector: Connector = {
    id: "test",
    name: "Test",
    category: "test",
    auth: null,
    methods: [method],
  };
  return new Registry([connector]);
};

describe("runColumn re-bill guard (TRI-3283 L2)", () => {
  it("a forced single-cell run writes ONLY the target row, not other done rows", async () => {
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
    store.addRow({ id: "r3", table_id: "t" });
    store.setCellSync("r1", "name", { value: "ada", status: "done" });
    store.setCellSync("r2", "name", { value: "grace", status: "done" });
    store.setCellSync("r3", "name", { value: "lin", status: "done" });
    // r2 + r3 are already computed (done); only r1 is the explicit target.
    store.setCellSync("r2", "upper", { value: "GRACE", status: "done" });
    store.setCellSync("r3", "upper", { value: "LIN", status: "done" });

    const events: CellProgress[] = [];
    const engine = new Engine({}, echoRegistry(), { store, creds: store });
    const res = await engine.runColumn("upper", {
      force: true,
      rowIds: ["r1"],
      onCell: (c) => events.push(c),
    });

    // Exactly one cell ran (the target); the already-done r2/r3 were untouched.
    expect(res).toEqual({ ran: 1, errors: 0 });
    expect(new Set(events.map((e) => e.rowId))).toEqual(new Set(["r1"]));
    expect(events.some((e) => e.rowId === "r2")).toBe(false);
    expect(events.some((e) => e.rowId === "r3")).toBe(false);
  });

  it("an unforced full-column run skips every already-done cell (no re-bill)", async () => {
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
    // r1 is already done; r2 has never been computed.
    store.setCellSync("r1", "upper", { value: "ADA", status: "done" });

    const events: CellProgress[] = [];
    const engine = new Engine({}, echoRegistry(), { store, creds: store });
    const res = await engine.runColumn("upper", { onCell: (c) => events.push(c) });

    // Only the pending r2 ran; the already-done r1 was not re-billed.
    expect(res).toEqual({ ran: 1, errors: 0 });
    expect(new Set(events.map((e) => e.rowId))).toEqual(new Set(["r2"]));
    expect(events.some((e) => e.rowId === "r1")).toBe(false);
  });
});
