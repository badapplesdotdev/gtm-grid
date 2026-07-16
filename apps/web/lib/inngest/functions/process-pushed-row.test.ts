/**
 * The pushed-row auto-run worker (table.push autoRunTarget) — OFFLINE against a
 * mocked fetch. The load-bearing behaviours:
 *   - THE LOOP GUARD: the target's own table.push columns are excluded from the
 *     enrich plan (A→B→A cascades bounded to depth 1); table.lookup columns run.
 *   - dependency ordering ({{ref}} topo-sort) is preserved for what remains.
 *   - per-column step keys memoize across retries (no re-run / re-charge).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StepRunner } from "./process-webhook-record";
import {
  parsePushedRowData,
  processPushedRowHandler,
} from "./process-pushed-row";

const SITE_URL = "https://app.gtmgrid.test";

beforeEach(() => {
  process.env.SITE_URL = SITE_URL;
  process.env.WEBHOOK_WORKER_SECRET = "whk_secret";
});

afterEach(() => {
  vi.restoreAllMocks();
});

function fetchReturning(status: number, body: string) {
  return vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    async () =>
      new Response(body, {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

const DATA = {
  tableId: "table-target",
  workspaceId: "ws-1",
  rowId: "row-9",
  recordId: "push-rec-1",
};

/** Runs the REAL plan step body; records per-column enrich order. */
class OrderRecordingStep implements StepRunner {
  readonly order: string[] = [];
  constructor(private readonly key: string) {}
  async run<T>(id: string, body: () => Promise<T>): Promise<T> {
    if (id === `push-enrich-columns:${this.key}`) return body(); // real filter+sort
    const prefix = `push-enrich:${this.key}:`;
    if (id.startsWith(prefix)) {
      this.order.push(id.slice(prefix.length));
      return 1 as T;
    }
    throw new Error(`unexpected step id: ${id}`);
  }
}

describe("processPushedRowHandler", () => {
  it("SKIPS the target's own table.push columns and runs the rest in dep order", async () => {
    const grid = {
      columns: [
        // A push column — the cascade risk — must be excluded.
        { _id: "P", name: "Push back", type: "json", kind: "function", provider: "table", method: "push", params: { targetTable: "Leads", mapping: {} }, condition: null, position: 0 },
        // Authored out of order: C reads {{B}}, B reads {{A}}.
        { _id: "C", name: "C", type: "text", kind: "function", provider: "formula", method: "eval", params: { expr: "{{B}}" }, condition: null, position: 1 },
        { _id: "B", name: "B", type: "text", kind: "function", provider: "formula", method: "eval", params: { expr: "{{A}}" }, condition: null, position: 2 },
        { _id: "A", name: "A", type: "text", kind: "function", provider: "leadmagic", method: "emailFinder", params: {}, condition: null, position: 3 },
        // A LOOKUP column is read-only and must still run.
        { _id: "L", name: "Account", type: "json", kind: "function", provider: "table", method: "lookup", params: { targetTable: "Accounts", matchColumn: "Domain", matchValue: "{{A}}" }, condition: null, position: 4 },
        { _id: "M", name: "M", type: "text", kind: "manual", provider: null, method: null, params: {}, condition: null, position: 5 },
      ],
      rows: [],
      cells: [],
    };
    vi.stubGlobal("fetch", fetchReturning(200, JSON.stringify(grid)));

    const step = new OrderRecordingStep(DATA.recordId);
    const result = await processPushedRowHandler(DATA, DATA.recordId, step);

    expect(step.order).not.toContain("P"); // the loop guard
    expect(step.order.indexOf("A")).toBeLessThan(step.order.indexOf("B"));
    expect(step.order.indexOf("B")).toBeLessThan(step.order.indexOf("C"));
    expect(step.order).toContain("L"); // lookups still run
    expect(step.order).not.toContain("M"); // manual columns never run
    expect(result.skippedPushColumns).toBe(1);
    expect(result.rowId).toBe("row-9");
  });

  it("memoizes per-column steps across a retry (no re-run of completed columns)", async () => {
    const completed = new Map<string, unknown>();
    const bodyRuns = new Map<string, number>();
    let failRemaining = 1;
    const step: StepRunner = {
      async run<T>(id: string, _body: () => Promise<T>): Promise<T> {
        if (completed.has(id)) return completed.get(id) as T;
        bodyRuns.set(id, (bodyRuns.get(id) ?? 0) + 1);
        let value: unknown;
        if (id === `push-enrich-columns:${DATA.recordId}`) {
          value = { columnIds: ["c0", "c1", "c2"], skippedPushColumns: 0 };
        } else if (id === `push-enrich:${DATA.recordId}:c1` && failRemaining > 0) {
          failRemaining -= 1;
          throw new Error("transient failure on c1");
        } else {
          value = 1;
        }
        completed.set(id, value);
        return value as T;
      },
    };

    await expect(processPushedRowHandler(DATA, DATA.recordId, step)).rejects.toThrow(
      /transient failure on c1/,
    );
    const result = await processPushedRowHandler(DATA, DATA.recordId, step);

    expect(bodyRuns.get(`push-enrich-columns:${DATA.recordId}`)).toBe(1);
    expect(bodyRuns.get(`push-enrich:${DATA.recordId}:c0`)).toBe(1); // not re-run
    expect(bodyRuns.get(`push-enrich:${DATA.recordId}:c1`)).toBe(2); // retried
    expect(bodyRuns.get(`push-enrich:${DATA.recordId}:c2`)).toBe(1);
    expect(result).toEqual({ rowId: "row-9", ran: 3, skippedPushColumns: 0 });
  });
});

describe("parsePushedRowData", () => {
  it("narrows a valid payload (recordId optional → null)", () => {
    expect(
      parsePushedRowData({ tableId: "t", workspaceId: "w", rowId: "r" }),
    ).toEqual({ tableId: "t", workspaceId: "w", rowId: "r", recordId: null });
  });

  it("throws on a malformed payload (Inngest retries)", () => {
    expect(() => parsePushedRowData({ tableId: 42 })).toThrow(/tableId/);
    expect(() => parsePushedRowData(null)).toThrow(/not an object/);
  });
});
