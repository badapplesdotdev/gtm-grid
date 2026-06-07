/**
 * Tests for the webhook record processor's worker-endpoint integration
 * (TRI-3256), run OFFLINE against a MOCKED `fetch`. The durable enrichment +
 * engine path is exercised in E2E; here we prove the row insert/upsert helpers
 * call the W2 worker endpoints (`/api/worker/insertRow|upsertRow|getTable`) with
 * the shared bearer and the correct payload, since that is what this migration
 * repointed off Convex. No live network, no DB, no engine run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebhookRecordData } from "./process-webhook-record";
import { fetchGrid, resolveRow } from "./process-webhook-record";

const SITE_URL = "https://app.gtmgrid.test";
const SECRET = "whk_secret_value";

function fetchReturning(status: number, body: string) {
  return vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    async () =>
      new Response(body, {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

const baseData: WebhookRecordData = {
  tableId: "table-1",
  workspaceId: "ws-1",
  mappedCells: { "col-email": "a@b.com" },
  autoRun: false,
  mode: "create",
  upsertKey: null,
  recordId: "rec-abc",
};

beforeEach(() => {
  process.env.SITE_URL = SITE_URL;
  process.env.WEBHOOK_WORKER_SECRET = SECRET;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveRow (create)", () => {
  it("POSTs /api/worker/insertRow with cells + recordId and returns rowId", async () => {
    const fetchMock = fetchReturning(200, JSON.stringify({ rowId: "row-9" }));
    vi.stubGlobal("fetch", fetchMock);

    const rowId = await resolveRow(baseData, "wh-1");

    expect(rowId).toBe("row-9");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${SITE_URL}/api/worker/insertRow`);
    expect(new Headers(init.headers).get("Authorization")).toBe(
      `Bearer ${SECRET}`,
    );
    expect(JSON.parse(String(init.body))).toEqual({
      webhookId: "wh-1",
      cells: { "col-email": "a@b.com" },
      recordId: "rec-abc",
    });
  });

  it("uses the create path when mode is upsert but upsertKey is null", async () => {
    const fetchMock = fetchReturning(200, JSON.stringify({ rowId: "row-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await resolveRow({ ...baseData, mode: "upsert", upsertKey: null }, "wh-1");

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`${SITE_URL}/api/worker/insertRow`);
  });
});

describe("resolveRow (upsert)", () => {
  it("POSTs /api/worker/upsertRow with the upsert key when set", async () => {
    const fetchMock = fetchReturning(200, JSON.stringify({ rowId: "row-up" }));
    vi.stubGlobal("fetch", fetchMock);

    const rowId = await resolveRow(
      { ...baseData, mode: "upsert", upsertKey: "col-email" },
      "wh-2",
    );

    expect(rowId).toBe("row-up");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${SITE_URL}/api/worker/upsertRow`);
    expect(JSON.parse(String(init.body))).toEqual({
      webhookId: "wh-2",
      upsertKey: "col-email",
      cells: { "col-email": "a@b.com" },
      recordId: "rec-abc",
    });
  });

  it("propagates a worker error (non-2xx) as a thrown error", async () => {
    vi.stubGlobal("fetch", fetchReturning(500, JSON.stringify({ error: "boom" })));
    await expect(resolveRow(baseData, "wh-1")).rejects.toThrow(
      /\/api\/worker\/insertRow failed: 500/,
    );
  });
});

describe("fetchGrid", () => {
  it("GET-equivalent POSTs /api/worker/getTable and returns the grid shape", async () => {
    const grid = {
      columns: [
        { _id: "c1", type: "text", kind: "function", position: 0 },
      ],
      rows: [{ _id: "r1" }],
      cells: [{ rowId: "r1", columnId: "c1", value: "x" }],
    };
    const fetchMock = fetchReturning(200, JSON.stringify(grid));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchGrid("table-1");

    expect(result).toEqual(grid);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${SITE_URL}/api/worker/getTable`);
    expect(JSON.parse(String(init.body))).toEqual({ tableId: "table-1" });
  });
});
