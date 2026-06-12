/**
 * Unit tests for the headless webhook WORKER client (TRI-3256), run OFFLINE
 * against a MOCKED `fetch`. Proves the client POSTs to the W2 worker endpoints
 * (`${SITE_URL}/api/worker/*`) with the shared `Bearer WEBHOOK_WORKER_SECRET`,
 * forwards args as JSON, parses the JSON body (tolerating an empty body), and
 * throws on a non-2xx — the exact contract `process-webhook-record` and the
 * engine cloud store rely on. No live network, no Convex.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_REFS, workerClient } from "./worker-client";

const SITE_URL = "https://app.gtmgrid.test";
const SECRET = "whk_secret_value";

/** A `fetch` stub (typed so `mock.calls` carries `[url, init]`) for one call. */
function fetchReturning(status: number, body: string) {
  return vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    async () =>
      new Response(body, {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

beforeEach(() => {
  process.env.SITE_URL = SITE_URL;
  process.env.WEBHOOK_WORKER_SECRET = SECRET;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("workerClient", () => {
  it("POSTs to the /api/worker route with the bearer secret and JSON args", async () => {
    const fetchMock = fetchReturning(200, JSON.stringify({ rowId: "row-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await workerClient.mutation("/api/worker/insertRow", {
      webhookId: "wh-1",
      cells: { c1: "v1" },
    });

    expect(result).toEqual({ rowId: "row-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${SITE_URL}/api/worker/insertRow`);
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${SECRET}`);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      webhookId: "wh-1",
      cells: { c1: "v1" },
    });
  });

  it("trims a trailing slash on SITE_URL", async () => {
    process.env.SITE_URL = `${SITE_URL}/`;
    const fetchMock = fetchReturning(200, JSON.stringify({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await workerClient.query(WORKER_REFS.getTable, { tableId: "t-1" });

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`${SITE_URL}/api/worker/getTable`);
  });

  it("returns null for an empty response body", async () => {
    vi.stubGlobal("fetch", fetchReturning(200, ""));
    const result = await workerClient.query(WORKER_REFS.getCredential, {
      workspaceId: "ws-1",
      extensionId: "ext-1",
    });
    expect(result).toBeNull();
  });

  it("throws on a non-2xx response, surfacing status + body", async () => {
    vi.stubGlobal("fetch", fetchReturning(404, JSON.stringify({ error: "nope" })));
    await expect(
      workerClient.query(WORKER_REFS.getTable, { tableId: "missing" }),
    ).rejects.toThrow(/Worker route \/api\/worker\/getTable failed: 404/);
  });

  it("query / mutation / action all POST identically to the route", async () => {
    const fetchMock = fetchReturning(200, JSON.stringify({ n: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await workerClient.query("/api/worker/getTable", { tableId: "t" });
    await workerClient.mutation("/api/worker/setCell", { rowId: "r", columnId: "c" });
    await workerClient.action("/api/worker/setCellStatus", { rowId: "r", columnId: "c", status: "ok" });

    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([
      `${SITE_URL}/api/worker/getTable`,
      `${SITE_URL}/api/worker/setCell`,
      `${SITE_URL}/api/worker/setCellStatus`,
    ]);
  });

  it("fails closed when WEBHOOK_WORKER_SECRET is unset", async () => {
    process.env.WEBHOOK_WORKER_SECRET = "";
    vi.stubGlobal("fetch", fetchReturning(200, "{}"));
    await expect(
      workerClient.query(WORKER_REFS.getTable, { tableId: "t" }),
    ).rejects.toThrow(/WEBHOOK_WORKER_SECRET is not configured/);
  });

  it("throws when SITE_URL is unset and no Vercel fallback exists", async () => {
    process.env.SITE_URL = "";
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.VERCEL_URL;
    vi.stubGlobal("fetch", fetchReturning(200, "{}"));
    await expect(
      workerClient.query(WORKER_REFS.getTable, { tableId: "t" }),
    ).rejects.toThrow(/SITE_URL is not configured/);
  });

  it("falls back to the Vercel deployment URL when SITE_URL is unset", async () => {
    process.env.SITE_URL = "";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "app.gtmgrid.io";
    try {
      const fetchMock = fetchReturning(200, "{}");
      vi.stubGlobal("fetch", fetchMock);
      await workerClient.query(WORKER_REFS.getTable, { tableId: "t" });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe("https://app.gtmgrid.io/api/worker/getTable");
    } finally {
      delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    }
  });
});

describe("WORKER_REFS", () => {
  it("maps every ref to its /api/worker route path", () => {
    expect(WORKER_REFS).toEqual({
      getTable: "/api/worker/getTable",
      setCell: "/api/worker/setCell",
      setCellStatus: "/api/worker/setCellStatus",
      setCells: "/api/worker/setCells",
      getCredential: "/api/worker/getCredential",
    });
  });
});
