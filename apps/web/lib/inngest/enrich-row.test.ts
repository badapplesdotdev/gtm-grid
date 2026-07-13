/**
 * Integration tests for the shared per-row enrichment cascade (`enrichRowInDepOrder`,
 * used by BOTH the webhook and signal enrichers) and the signal enqueue helper
 * (`signalEnrichEvents`). Offline against a mocked `fetch`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enrichRowInDepOrder } from "./enrich-row";
import type { StepRunner } from "./functions/process-webhook-record";
import { signalEnrichEvents } from "./functions/poll-trigify-signals";

const SITE_URL = "https://app.gtmgrid.test";

function fetchReturning(status: number, body: string) {
  return vi.fn(async () => new Response(body, { status, headers: { "Content-Type": "application/json" } }));
}

beforeEach(() => {
  process.env.SITE_URL = SITE_URL;
  process.env.WEBHOOK_WORKER_SECRET = "whk_secret";
});
afterEach(() => vi.restoreAllMocks());

/**
 * Runs the REAL `:columns` body (so the actual topo-sort runs against the mocked
 * grid) and records the ORDER per-column steps fire, intercepting the engine run.
 */
class OrderStep implements StepRunner {
  readonly order: string[] = [];
  constructor(private readonly prefix: string) {}
  async run<T>(id: string, body: () => Promise<T>): Promise<T> {
    if (id === `${this.prefix}:columns`) return body(); // real fetchGrid + topo-sort
    const colPrefix = `${this.prefix}:col:`;
    if (id.startsWith(colPrefix)) {
      this.order.push(id.slice(colPrefix.length));
      return 1 as T;
    }
    throw new Error(`unexpected step id: ${id}`);
  }
}

describe("enrichRowInDepOrder", () => {
  it("runs a row's function columns in {{ref}} dependency order, manual excluded", async () => {
    // Authored out of order: C (reads {{B}}), B (reads {{A}}), A (source), + a manual col.
    const grid = {
      columns: [
        { _id: "C", name: "C", type: "text", kind: "function", provider: "formula", params: { expr: "{{B}}" }, condition: null, position: 0 },
        { _id: "B", name: "B", type: "text", kind: "function", provider: "formula", params: { src: "{{A}}" }, condition: null, position: 1 },
        { _id: "A", name: "A", type: "text", kind: "function", provider: "leadmagic", params: {}, condition: null, position: 2 },
        { _id: "M", name: "M", type: "text", kind: "manual", provider: null, params: {}, condition: null, position: 3 },
      ],
      rows: [{ _id: "row-9" }],
      cells: [],
    };
    // Record the worker endpoints hit so we can prove the read is BOUNDED.
    const calls: { url: string; body: Record<string, unknown> | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(JSON.stringify(grid), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const step = new OrderStep("sig:row-9");
    const ran = await enrichRowInDepOrder(step, {
      tableId: "t",
      workspaceId: "ws",
      rowId: "row-9",
      keyPrefix: "sig:row-9",
    });

    expect(step.order).toEqual(["A", "B", "C"]);
    expect(ran).toBe(3); // each intercepted column reports ran=1

    // The column list is read via the COLUMNS-ONLY bounded endpoint
    // (getTableForRows with an empty row set), never the full-grid getTable.
    const colsCall = calls.find((c) => c.url.includes("/api/worker/getTableForRows"));
    expect(colsCall).toBeDefined();
    expect(colsCall?.body?.rowIds).toEqual([]);
    expect(calls.some((c) => c.url.endsWith("/api/worker/getTable"))).toBe(false);
  });
});

describe("signalEnrichEvents", () => {
  it("builds one idempotent enrichment event per inserted row", () => {
    expect(
      signalEnrichEvents({ rowIds: ["r1", "r2"], tableId: "t1", workspaceId: "ws1" }),
    ).toEqual([
      { name: "signals/row.inserted", data: { tableId: "t1", workspaceId: "ws1", rowId: "r1" }, id: "sig-enrich:r1" },
      { name: "signals/row.inserted", data: { tableId: "t1", workspaceId: "ws1", rowId: "r2" }, id: "sig-enrich:r2" },
    ]);
  });

  it("returns nothing when no rows were inserted or table/workspace is missing", () => {
    expect(signalEnrichEvents({ rowIds: [], tableId: "t", workspaceId: "ws" })).toEqual([]);
    expect(signalEnrichEvents({ rowIds: ["r1"], tableId: null, workspaceId: "ws" })).toEqual([]);
    expect(signalEnrichEvents({ rowIds: ["r1"], tableId: "t", workspaceId: null })).toEqual([]);
  });
});
