// A connector method that throws a SkipCellError (e.g. the manifest `requires`
// guard short-circuiting a row with no resolvable company) must surface as a
// CLEAN skip, not a failure: the cell is written "empty" with the method's note,
// no error is counted, and the deduped error reporter is NOT invoked. This is the
// engine half of the LeadMagic emailFinder HTTP-400 fix — a doomed call is turned
// into an explained blank instead of a failed enrichment + error-tracking noise.

import { describe, expect, it } from "vitest";
import { Engine, type CellProgress } from "./execute.js";
import { Registry } from "./registry.js";
import { SkipCellError } from "./skip.js";
import { makeMemoryStore } from "./test-helpers.js";
import type { Connector, ConnectorMethod } from "./types.js";

/** A connector whose method skips when `value` is empty, else echoes it. */
const skipRegistry = (calls: { ran: number }): Registry => {
  const method: ConnectorMethod = {
    id: "find",
    label: "Find",
    description: "Skips when given no value, else echoes it.",
    inputSchema: {},
    batchSize: 1,
    credits: 1,
    run: async (inputs) => {
      if (!inputs.value) throw new SkipCellError("Missing required input — provide value");
      calls.ran++;
      return { text: String(inputs.value) };
    },
  };
  const connector: Connector = { id: "svc", name: "Svc", category: "test", auth: null, methods: [method] };
  return new Registry([connector]);
};

describe("runColumn — SkipCellError becomes a clean skip", () => {
  it("writes an empty cell with the note, no error counted, no telemetry, no run", async () => {
    const store = makeMemoryStore();
    store.addColumn({ id: "name", table_id: "t", name: "Name", kind: "manual" });
    store.addColumn({
      id: "email",
      table_id: "t",
      name: "Email",
      kind: "function",
      provider: "svc",
      method: "find",
      params: { value: "{{Name}}" },
    });
    store.addRow({ id: "r1", table_id: "t" }); // has a name → runs
    store.addRow({ id: "r2", table_id: "t" }); // blank → method skips
    store.setCellSync("r1", "name", { value: "ada", status: "done" });

    const reported: unknown[] = [];
    const calls = { ran: 0 };
    const events: CellProgress[] = [];
    const engine = new Engine(
      { reportError: (e) => reported.push(e) },
      skipRegistry(calls),
      { store, creds: store },
    );

    const res = await engine.runColumn("email", { onCell: (c) => events.push(c) });

    // One real run, ZERO errors — the skip is not a failure.
    expect(res).toEqual({ ran: 1, errors: 0 });
    expect(calls.ran).toBe(1); // the skipped row's method short-circuited before any work
    // The skipped cell is an explained blank, not an error cell.
    expect(store.readCell("r2", "email")?.status).toBe("empty");
    expect(store.readCell("r2", "email")?.value ?? null).toBeNull();
    expect(store.readCell("r2", "email")?.error).toBe("Missing required input — provide value");
    // The happy-path cell ran normally.
    expect(store.readCell("r1", "email")?.status).toBe("done");
    expect(store.readCell("r1", "email")?.value).toBe("ada");
    // No systemic-error telemetry for a clean skip.
    expect(reported).toHaveLength(0);
    // The skip streams an "empty" progress event so a live grid updates.
    expect(events.some((e) => e.rowId === "r2" && e.status === "empty")).toBe(true);
    expect(events.some((e) => e.rowId === "r2" && e.status === "error")).toBe(false);
  });
});
