/**
 * Tests for the webhook record processor's worker-endpoint integration
 * (TRI-3256), run OFFLINE against a MOCKED `fetch`. The durable enrichment +
 * engine path is exercised in E2E; here we prove the row insert/upsert helpers
 * call the W2 worker endpoints (`/api/worker/insertRow|upsertRow|getTable`) with
 * the shared bearer and the correct payload, since that is what this migration
 * repointed off Convex. No live network, no DB, no engine run.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StepRunner, WebhookRecordData } from "./process-webhook-record";
import {
  fetchGrid,
  fetchWorkspaceManifests,
  processWebhookRecordHandler,
  registryWithManifests,
  resolveRow,
} from "./process-webhook-record";

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

/**
 * A fake {@link StepRunner} that models Inngest's durable-step memoization: each
 * step `id` runs its body AT MOST ONCE across the whole run AND across retries
 * of the handler. Completed steps return their cached value WITHOUT re-invoking
 * the body — exactly how Inngest replays a function on retry. When a body throws,
 * the step is left UNcompleted, so a later handler re-run (a "retry") can attempt
 * it again while every already-completed step is skipped.
 *
 * It also intercepts the webhook handler's three step bodies (insert-row,
 * enrich-columns, per-column enrich) by key, so the handler never touches the
 * real HTTP/engine helpers — the unit under test is purely the step KEYING.
 */
class FakeWebhookStep implements StepRunner {
  /** Cached results for completed steps, by step id. */
  readonly completed = new Map<string, unknown>();
  /** How many times each step id actually executed its (intercepted) body. */
  readonly bodyRuns = new Map<string, number>();

  constructor(
    private readonly recordId: string,
    private readonly columns: readonly string[],
    /** Counts per-column enrich executions, shared across retry attempts. */
    private readonly perColumnRuns: Map<string, number>,
    /** When set, this column's body throws while `remaining > 0`. */
    private readonly failOnColumn?: { id: string; remaining: number },
  ) {}

  async run<T>(id: string, _body: () => Promise<T>): Promise<T> {
    if (this.completed.has(id)) return this.completed.get(id) as T;
    this.bodyRuns.set(id, (this.bodyRuns.get(id) ?? 0) + 1);

    const value = this.intercept(id);
    this.completed.set(id, value);
    return value as T;
  }

  /** Produce the intercepted step result (or throw to simulate a failure). */
  private intercept(id: string): unknown {
    if (id === `insert-row:${this.recordId}`) return "row-1";
    if (id === `enrich-columns:${this.recordId}`) return this.columns;

    const prefix = `enrich:${this.recordId}:`;
    if (id.startsWith(prefix)) {
      const columnId = id.slice(prefix.length);
      this.perColumnRuns.set(
        columnId,
        (this.perColumnRuns.get(columnId) ?? 0) + 1,
      );
      const fail = this.failOnColumn;
      if (fail && fail.id === columnId && fail.remaining > 0) {
        fail.remaining -= 1;
        throw new Error(`transient failure on ${columnId}`);
      }
      return 1;
    }
    throw new Error(`unexpected step id: ${id}`);
  }
}

describe("per-column enrich step keys (TRI-3280 regression)", () => {
  const recordId = "rec-xyz";
  const columns = ["c0", "c1", "c2", "c3"];

  /** The autorun record the enrich path consumes. */
  const enrichData: WebhookRecordData = {
    ...baseData,
    recordId,
    autoRun: true,
  };

  it("uses a UNIQUE step key per function column", async () => {
    const perColumnRuns = new Map<string, number>();
    const step = new FakeWebhookStep(recordId, columns, perColumnRuns);

    await processWebhookRecordHandler(enrichData, "wh-1", step);

    for (const columnId of columns) {
      expect(
        step.completed.has(`enrich:${recordId}:${columnId}`),
        `missing per-column step key for ${columnId}`,
      ).toBe(true);
    }
    // The old single-step-for-all-columns key must NOT exist anymore.
    expect(step.completed.has(`enrich:${recordId}`)).toBe(false);
  });

  it("a retry after column K does NOT re-run columns 0..K-1 (no re-charge)", async () => {
    const perColumnRuns = new Map<string, number>();
    // Fail once on column index 2 ("c2"): the loop completes c0 and c1, then c2
    // throws, aborting the handler — exactly the mid-loop failure that, in the
    // old single-step code, would re-charge c0 and c1 on retry.
    const failOnColumn = { id: "c2", remaining: 1 };
    const step = new FakeWebhookStep(
      recordId,
      columns,
      perColumnRuns,
      failOnColumn,
    );

    // First attempt: throws after c0, c1 have completed.
    await expect(
      processWebhookRecordHandler(enrichData, "wh-1", step),
    ).rejects.toThrow(/transient failure on c2/);

    expect(perColumnRuns.get("c0")).toBe(1);
    expect(perColumnRuns.get("c1")).toBe(1);
    expect(perColumnRuns.get("c2")).toBe(1); // attempted (and failed)
    expect(perColumnRuns.get("c3")).toBeUndefined(); // never reached

    // Retry: the handler re-runs top-to-bottom. Completed steps (insert-row,
    // enrich-columns, c0, c1) are memoized and SKIPPED; only c2 (retried) and
    // c3 (new) execute their bodies.
    const result = await processWebhookRecordHandler(
      enrichData,
      "wh-1",
      step,
    );

    expect(perColumnRuns.get("c0")).toBe(1); // NOT re-run → not re-charged
    expect(perColumnRuns.get("c1")).toBe(1); // NOT re-run → not re-charged
    expect(perColumnRuns.get("c2")).toBe(2); // retried once
    expect(perColumnRuns.get("c3")).toBe(1); // finally reached
    expect(result).toEqual({ rowId: "row-1", enriched: true, ran: 4 });

    // The expensive setup steps were also memoized (not repeated on retry).
    expect(step.bodyRuns.get(`insert-row:${recordId}`)).toBe(1);
    expect(step.bodyRuns.get(`enrich-columns:${recordId}`)).toBe(1);
  });
});

describe("fetchWorkspaceManifests", () => {
  it("POSTs /api/worker/listExtensions and returns the manifests array", async () => {
    const fetchMock = fetchReturning(
      200,
      JSON.stringify({ manifests: [{ id: "leadmagic" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const manifests = await fetchWorkspaceManifests("ws-1");

    expect(manifests).toEqual([{ id: "leadmagic" }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${SITE_URL}/api/worker/listExtensions`);
    expect(new Headers(init.headers).get("Authorization")).toBe(
      `Bearer ${SECRET}`,
    );
    expect(JSON.parse(String(init.body))).toEqual({ workspaceId: "ws-1" });
  });

  it("returns [] when the worker reports no installed extensions", async () => {
    vi.stubGlobal("fetch", fetchReturning(200, JSON.stringify({ manifests: [] })));
    expect(await fetchWorkspaceManifests("ws-1")).toEqual([]);
  });
});

// REGRESSION: a function column wired to `leadmagic.emailFinder` ran through the
// worker with a bare `defaultRegistry()`, so `sdk.leadmagic` was never created
// and the column dereferenced `undefined`. The worker must load the workspace's
// uploaded manifests so the non-built-in connector is dispatchable.
describe("registryWithManifests", () => {
  const repoRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../..",
  );
  const leadmagicManifest = readFileSync(
    join(repoRoot, "extensions/leadmagic.json"),
    "utf8",
  );

  it("loads the workspace's extension connectors on top of the built-ins", () => {
    const registry = registryWithManifests([leadmagicManifest]);
    const ids = registry.list().map((c) => c.id);
    // Built-ins still present…
    expect(ids).toContain("ai");
    expect(ids).toContain("http");
    // …AND leadmagic.emailFinder is now dispatchable (the missing piece).
    expect(ids).toContain("leadmagic");
    expect(registry.method("leadmagic", "emailFinder")).toBeDefined();
  });

  it("a bare default registry does NOT expose leadmagic — proving the load is what fixes it", () => {
    expect(registryWithManifests([]).list().map((c) => c.id)).not.toContain(
      "leadmagic",
    );
  });

  it("skips a malformed manifest without dropping the valid connectors", () => {
    const registry = registryWithManifests(["{ not valid json", leadmagicManifest]);
    expect(registry.list().map((c) => c.id)).toContain("leadmagic");
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
