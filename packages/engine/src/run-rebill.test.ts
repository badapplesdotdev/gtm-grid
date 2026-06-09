// TRI-3283 L2: a recompute must NOT re-bill cells whose inputs are unchanged.
// A "bill" is a cell WRITE (the cloud meter increments per terminal write), so a
// re-bill shows up here as a `done` event re-emitted for a cell that was already
// `done`. These tests pin the run engine's targeting semantics that the desktop
// `runCell` / auto-run handlers rely on:
//   - a single-cell run (`force:true, rowIds:[r]`) writes ONLY that row's cell —
//     the OTHER already-`done` rows are never re-run/re-billed; and
//   - an unscoped, unforced run skips every already-`done` cell (no re-bill),
//     only writing the rows that still need computing.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "./db.js";
import { Engine, type CellProgress } from "./execute.js";
import { Registry } from "./registry.js";
import type { Connector, ConnectorMethod } from "./types.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "run-rebill-test-"));
  db = new Db(join(dir, "project.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

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
    const table = db.createTable("Leads");
    const name = db.createColumn({ tableId: table.id, name: "Name", kind: "manual" });
    const upper = db.createColumn({
      tableId: table.id,
      name: "Upper",
      kind: "function",
      code: "function(inputs, sdk){ return { text: String(inputs.name).toUpperCase() }; }",
      params: { name: "{{Name}}" },
    });
    const r1 = db.createRow(table.id);
    const r2 = db.createRow(table.id);
    const r3 = db.createRow(table.id);
    db.setCell(r1.id, name.id, { value: "ada", status: "done" });
    db.setCell(r2.id, name.id, { value: "grace", status: "done" });
    db.setCell(r3.id, name.id, { value: "lin", status: "done" });
    // r2 + r3 are already computed (done); only r1 is the explicit target.
    db.setCell(r2.id, upper.id, { value: "GRACE", status: "done" });
    db.setCell(r3.id, upper.id, { value: "LIN", status: "done" });

    const events: CellProgress[] = [];
    const engine = new Engine(db, {}, echoRegistry());
    const res = await engine.runColumn(upper.id, {
      force: true,
      rowIds: [r1.id],
      onCell: (c) => events.push(c),
    });

    // Exactly one cell ran (the target); the already-done r2/r3 were untouched.
    expect(res).toEqual({ ran: 1, errors: 0 });
    expect(new Set(events.map((e) => e.rowId))).toEqual(new Set([r1.id]));
    expect(events.some((e) => e.rowId === r2.id)).toBe(false);
    expect(events.some((e) => e.rowId === r3.id)).toBe(false);
  });

  it("an unforced full-column run skips every already-done cell (no re-bill)", async () => {
    const table = db.createTable("Leads");
    const name = db.createColumn({ tableId: table.id, name: "Name", kind: "manual" });
    const upper = db.createColumn({
      tableId: table.id,
      name: "Upper",
      kind: "function",
      code: "function(inputs, sdk){ return { text: String(inputs.name).toUpperCase() }; }",
      params: { name: "{{Name}}" },
    });
    const r1 = db.createRow(table.id);
    const r2 = db.createRow(table.id);
    db.setCell(r1.id, name.id, { value: "ada", status: "done" });
    db.setCell(r2.id, name.id, { value: "grace", status: "done" });
    // r1 is already done; r2 has never been computed.
    db.setCell(r1.id, upper.id, { value: "ADA", status: "done" });

    const events: CellProgress[] = [];
    const engine = new Engine(db, {}, echoRegistry());
    const res = await engine.runColumn(upper.id, { onCell: (c) => events.push(c) });

    // Only the pending r2 ran; the already-done r1 was not re-billed.
    expect(res).toEqual({ ran: 1, errors: 0 });
    expect(new Set(events.map((e) => e.rowId))).toEqual(new Set([r2.id]));
    expect(events.some((e) => e.rowId === r1.id)).toBe(false);
  });
});
