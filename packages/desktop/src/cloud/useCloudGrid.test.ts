/**
 * Cloud grid hook/query LOGIC tests (W4 / TRI-3254).
 *
 * The hooks themselves are thin React glue; the testable substance is the PURE
 * logic they delegate to — the tRPC↔desktop shape mappers, the query-key
 * factory, the addColumn `fn`→provider/method/kind derivation, and (the headline
 * AC) the REALTIME CACHE-PATCH integration: `patchGridCache` drives the W3
 * `applyGridEvent` reducer over a stored `getTable` snapshot, which is exactly
 * what the live subscription does to the react-query cache. We assert each event
 * type maps the snapshot to the next snapshot, with no React and no Supabase.
 */

import { describe, expect, it } from "vitest";
import {
  createIncrementalTableView,
  deriveColumnKind,
  gridQueryKeys,
  makeLatestWins,
  makeSerialQueue,
  mergePagesToSnapshot,
  patchGridCache,
  patchPagedGridCache,
  wasEventDropped,
  toCloudDelivery,
  toCloudWebhook,
} from "./useCloudGrid";

// A `getTable`-shaped cache snapshot (the shape the react-query cache holds and
// the reducer patches). Cast to the cache type the helper accepts.
type Snapshot = Parameters<typeof patchGridCache>[0];

const baseSnapshot = (): NonNullable<Snapshot> =>
  ({
    table: { _id: "t1", name: "Leads", dedupe: null, autoRun: true },
    columns: [
      {
        _id: "c1",
        name: "Domain",
        type: "text",
        kind: "manual",
        provider: null,
        method: null,
        accountId: null,
        code: null,
        params: {},
        condition: null,
      },
    ],
    rows: [{ _id: "r1" }],
    cells: [
      {
        rowId: "r1",
        columnId: "c1",
        value: "acme.com",
        status: "done",
        error: null,
      },
    ],
  }) as NonNullable<Snapshot>;

describe("deriveColumnKind — addColumn fn → provider/method/kind", () => {
  it("splits a provider.method fn into a function column", () => {
    expect(deriveColumnKind({ fn: "clearbit.enrich" })).toEqual({
      provider: "clearbit",
      method: "enrich",
      kind: "function",
    });
  });

  it("treats a code column as a function column with no provider", () => {
    expect(deriveColumnKind({ code: "return 1" })).toEqual({
      provider: null,
      method: null,
      kind: "function",
    });
  });

  it("is a manual column when neither fn nor code is given", () => {
    expect(deriveColumnKind({})).toEqual({
      provider: null,
      method: null,
      kind: "manual",
    });
  });
});

describe("gridQueryKeys — react-query key factory", () => {
  it("namespaces grid and webhook keys distinctly + by id", () => {
    expect(gridQueryKeys.projects("w1")).toEqual(["grid", "projects", "w1"]);
    expect(gridQueryKeys.tables("p1")).toEqual(["grid", "tables", "p1"]);
    expect(gridQueryKeys.table("t1")).toEqual(["grid", "table", "t1"]);
    expect(gridQueryKeys.webhooks("t1")).toEqual(["webhooks", "list", "t1"]);
    expect(gridQueryKeys.deliveries("h1")).toEqual([
      "webhooks",
      "deliveries",
      "h1",
    ]);
  });
});

describe("toCloudWebhook — tRPC row → desktop shape", () => {
  it("maps id→_id and drops null optionals", () => {
    const w = toCloudWebhook({
      id: "h1",
      workspaceId: "w1",
      tableId: "t1",
      name: null,
      token: "whk_x",
      signingSecret: null,
      mapping: [{ path: "a.b", columnId: "c1" }],
      enabled: true,
      autoRun: null,
      mode: null,
      upsertKey: null,
      createdAt: 5,
      lastReceivedAt: null,
      receivedCount: null,
    });
    expect(w._id).toBe("h1");
    expect(w.token).toBe("whk_x");
    expect(w.enabled).toBe(true);
    expect(w.mapping).toEqual([{ path: "a.b", columnId: "c1" }]);
    expect(w.upsertKey).toBeNull();
    expect("name" in w).toBe(false);
    expect("signingSecret" in w).toBe(false);
    expect("autoRun" in w).toBe(false);
  });

  it("carries through populated optionals", () => {
    const w = toCloudWebhook({
      id: "h2",
      workspaceId: "w1",
      tableId: "t1",
      name: "Inbound",
      token: "whk_y",
      signingSecret: "whsec_y",
      mapping: [],
      enabled: false,
      autoRun: true,
      mode: "upsert",
      upsertKey: "c9",
      createdAt: 9,
      lastReceivedAt: 12,
      receivedCount: 3,
    });
    expect(w.name).toBe("Inbound");
    expect(w.signingSecret).toBe("whsec_y");
    expect(w.autoRun).toBe(true);
    expect(w.mode).toBe("upsert");
    expect(w.upsertKey).toBe("c9");
    expect(w.receivedCount).toBe(3);
  });

  it("carries push-connection source fields (and drops them when null)", () => {
    const base = {
      id: "h3",
      workspaceId: "w1",
      tableId: "t1",
      name: "Push from Leads",
      token: "whk_z",
      signingSecret: null,
      mapping: [],
      enabled: true,
      autoRun: null,
      mode: null,
      upsertKey: null,
      createdAt: 1,
      lastReceivedAt: null,
      receivedCount: null,
    };
    const push = toCloudWebhook({ ...base, source: "push", sourceTableId: "t9" });
    expect(push.source).toBe("push");
    expect(push.sourceTableId).toBe("t9");

    const http = toCloudWebhook({ ...base, source: null, sourceTableId: null });
    expect("source" in http).toBe(false);
    expect("sourceTableId" in http).toBe(false);
  });
});

describe("toCloudDelivery — tRPC item → desktop shape", () => {
  it("maps id→_id and drops a null recordId", () => {
    const d = toCloudDelivery({
      id: "d1",
      webhookId: "h1",
      tableId: "t1",
      status: 200,
      rowsAffected: 1,
      mode: "create",
      recordId: null,
      error: null,
      receivedAt: 100,
    });
    expect(d._id).toBe("d1");
    expect(d.status).toBe(200);
    expect(d.rowsAffected).toBe(1);
    expect("recordId" in d).toBe(false);
    expect(d.error).toBeNull();
  });
});

describe("patchGridCache — realtime cache-patch integration (pure reducer)", () => {
  it("passes a null snapshot through (no live patch before seed)", () => {
    expect(
      patchGridCache(null, {
        type: "cell.upsert",
        cell: {
          rowId: "r1",
          columnId: "c1",
          value: "x",
          status: "done",
          error: null,
        },
      }),
    ).toBeNull();
  });

  it("cell.upsert replaces an existing cell by (rowId, columnId)", () => {
    const next = patchGridCache(baseSnapshot(), {
      type: "cell.upsert",
      cell: {
        rowId: "r1",
        columnId: "c1",
        value: "new.com",
        status: "done",
        error: null,
      },
    });
    expect(next?.cells).toHaveLength(1);
    expect(next?.cells[0].value).toBe("new.com");
  });

  it("cell.upsert appends a new cell key", () => {
    const next = patchGridCache(baseSnapshot(), {
      type: "cell.upsert",
      cell: {
        rowId: "r2",
        columnId: "c1",
        value: "z",
        status: "pending",
        error: null,
      },
    });
    expect(next?.cells).toHaveLength(2);
  });

  it("row.insert adds the row and merges its cells, de-duping by id", () => {
    const snap = baseSnapshot();
    const next = patchGridCache(snap, {
      type: "row.insert",
      row: { _id: "r2" },
      cells: [
        {
          rowId: "r2",
          columnId: "c1",
          value: "b.com",
          status: "done",
          error: null,
        },
      ],
    });
    expect(next?.rows.map((r) => r._id)).toEqual(["r1", "r2"]);
    expect(next?.cells).toHaveLength(2);
    // Idempotent: a duplicate insert does not double the row.
    const again = patchGridCache(next, {
      type: "row.insert",
      row: { _id: "r2" },
      cells: [],
    });
    expect(again?.rows).toHaveLength(2);
  });

  it("row.delete removes the row and cascades its cells", () => {
    const next = patchGridCache(baseSnapshot(), {
      type: "row.delete",
      rowId: "r1",
    });
    expect(next?.rows).toHaveLength(0);
    expect(next?.cells).toHaveLength(0);
  });

  it("column.insert appends a column (de-duped by id)", () => {
    const next = patchGridCache(baseSnapshot(), {
      type: "column.insert",
      column: {
        _id: "c2",
        name: "Score",
        type: "number",
        kind: "function",
        provider: "ai",
        method: "score",
        accountId: null,
        code: null,
        params: {},
        condition: null,
      },
    });
    expect(next?.columns.map((c) => c._id)).toEqual(["c1", "c2"]);
  });

  it("column.delete removes the column and cascades its cells", () => {
    const next = patchGridCache(baseSnapshot(), {
      type: "column.delete",
      columnId: "c1",
    });
    expect(next?.columns).toHaveLength(0);
    expect(next?.cells).toHaveLength(0);
  });

  it("table.insert leaves this table's snapshot unchanged", () => {
    const snap = baseSnapshot();
    const next = patchGridCache(snap, {
      type: "table.insert",
      tableId: "t2",
      projectId: "p1",
      name: "Other",
    });
    expect(next).toEqual(snap);
  });

  it("table.delete collapses the viewed table's snapshot to null", () => {
    const next = patchGridCache(baseSnapshot(), {
      type: "table.delete",
      tableId: "t1",
    });
    expect(next).toBeNull();
  });

  it("table.delete for a sibling table is a no-op", () => {
    const snap = baseSnapshot();
    const next = patchGridCache(snap, {
      type: "table.delete",
      tableId: "t999",
    });
    expect(next).toEqual(snap);
  });
});

describe("createIncrementalTableView — incremental derivation + row identity", () => {
  /** A snapshot with `rows`×`cols` cells (every cell populated). */
  const grid = (rows: number, cols: number): NonNullable<Snapshot> =>
    ({
      table: { _id: "t1", name: "Grid", dedupe: null, autoRun: true },
      columns: Array.from({ length: cols }, (_, c) => ({
        _id: `c${c}`,
        name: `C${c}`,
        type: "text",
        kind: "manual",
        provider: null,
        method: null,
        accountId: null,
        code: null,
        params: {},
        condition: null,
      })),
      rows: Array.from({ length: rows }, (_, r) => ({ _id: `r${r}` })),
      cells: Array.from({ length: rows }, (_, r) =>
        Array.from({ length: cols }, (_, c) => ({
          rowId: `r${r}`,
          columnId: `c${c}`,
          value: `${r}-${c}`,
          status: "done",
          error: null,
        })),
      ).flat(),
    }) as NonNullable<Snapshot>;

  it("produces the same FullTable shape as a one-shot derivation", () => {
    const snap = grid(3, 2);
    const a = createIncrementalTableView().derive(snap);
    const b = createIncrementalTableView().derive(snap);
    expect(a).toEqual(b);
    expect(a.rows.map((r) => r.id)).toEqual(["r0", "r1", "r2"]);
    expect(a.rows[0].cells.c1.value).toBe("0-1");
  });

  it("rebuilds ONLY the touched row; untouched rows keep their identity", () => {
    const view = createIncrementalTableView();
    const snap0 = grid(4, 2);
    const v0 = view.derive(snap0);

    // One cell.upsert on r1/c0, fed through the SAME reducer the live cache uses.
    const snap1 = patchGridCache(snap0, {
      type: "cell.upsert",
      cell: {
        rowId: "r1",
        columnId: "c0",
        value: "edited",
        status: "done",
        error: null,
      },
    });
    const v1 = view.derive(snap1!);

    // The changed row is a new object with the new value.
    expect(v1.rows[1]).not.toBe(v0.rows[1]);
    expect(v1.rows[1].cells.c0.value).toBe("edited");
    // Every untouched row keeps referential identity (memo-friendly).
    expect(v1.rows[0]).toBe(v0.rows[0]);
    expect(v1.rows[2]).toBe(v0.rows[2]);
    expect(v1.rows[3]).toBe(v0.rows[3]);
    // The columns array identity is preserved when columns are unchanged.
    expect(v1.columns).toBe(v0.columns);
  });

  it("keeps a row's identity when an UNRELATED row changes only", () => {
    const view = createIncrementalTableView();
    const snap0 = grid(3, 1);
    const v0 = view.derive(snap0);
    const snap1 = patchGridCache(snap0, {
      type: "cell.upsert",
      cell: {
        rowId: "r2",
        columnId: "c0",
        value: "z",
        status: "running",
        error: null,
      },
    });
    const v1 = view.derive(snap1!);
    expect(v1.rows[0]).toBe(v0.rows[0]);
    expect(v1.rows[1]).toBe(v0.rows[1]);
    expect(v1.rows[2]).not.toBe(v0.rows[2]);
    expect(v1.rows[2].cells.c0.status).toBe("running");
  });
});

// ─── TRI-3272: keyset-paged grid — page merge + page-aware realtime patch ─────

type Page = Parameters<typeof patchPagedGridCache>[0][number];

const page = (
  rowIds: readonly string[],
  nextCursor: Page["nextCursor"],
): Page =>
  ({
    table: { _id: "t1", name: "Leads", dedupe: null, autoRun: true },
    columns: [
      {
        _id: "c1",
        name: "Domain",
        type: "text",
        kind: "manual",
        provider: null,
        method: null,
        accountId: null,
        code: null,
        params: {},
        condition: null,
      },
    ],
    rows: rowIds.map((_id) => ({ _id })),
    cells: rowIds.map((rowId) => ({
      rowId,
      columnId: "c1",
      value: rowId,
      status: "done",
      error: null,
    })),
    nextCursor,
  }) as Page;

const cursor = (id: string): NonNullable<Page["nextCursor"]> =>
  ({ position: 0, createdAt: 0, id }) as NonNullable<Page["nextCursor"]>;

describe("mergePagesToSnapshot — flatten loaded pages (TRI-3272)", () => {
  it("returns null when no page is loaded", () => {
    expect(mergePagesToSnapshot([])).toBeNull();
  });

  it("concatenates only the loaded pages' rows + cells, columns from the first", () => {
    const snap = mergePagesToSnapshot([
      page(["r1", "r2"], cursor("r2")),
      page(["r3"], null),
    ]);
    expect(snap?.rows.map((r) => r._id)).toEqual(["r1", "r2", "r3"]);
    expect(snap?.cells.map((c) => c.rowId)).toEqual(["r1", "r2", "r3"]);
    expect(snap?.columns.map((c) => c._id)).toEqual(["c1"]);
    expect(snap?.table).toEqual({
      _id: "t1",
      name: "Leads",
      dedupe: null,
      autoRun: true,
    });
  });
});

describe("patchPagedGridCache — page-aware realtime patch (TRI-3272)", () => {
  it("cell.upsert patches ONLY the page that holds the row (no phantom row elsewhere)", () => {
    const pages = [page(["r1"], cursor("r1")), page(["r2"], null)];
    const next = patchPagedGridCache(pages, {
      type: "cell.upsert",
      cell: { rowId: "r2", columnId: "c1", value: "new", status: "running", error: null },
    });
    // Page 0 (no r2) is untouched by reference; page 1 patched, no new rows.
    expect(next[0]).toBe(pages[0]);
    expect(next[1]?.rows.map((r) => r._id)).toEqual(["r2"]);
    expect(next[1]?.cells.find((c) => c.rowId === "r2")?.status).toBe("running");
  });

  it("cell.upsert for an UNLOADED row is dropped (no page gains a phantom row)", () => {
    const pages = [page(["r1"], cursor("r1"))];
    const next = patchPagedGridCache(pages, {
      type: "cell.upsert",
      cell: { rowId: "r9", columnId: "c1", value: "x", status: "done", error: null },
    });
    expect(next).toBe(pages); // unchanged identity — nothing applied
  });

  it("row.insert appends ONLY to the final page (nextCursor === null)", () => {
    const pages = [page(["r1"], cursor("r1")), page(["r2"], null)];
    const next = patchPagedGridCache(pages, {
      type: "row.insert",
      row: { _id: "r3" },
      cells: [],
    });
    expect(next[0]).toBe(pages[0]);
    expect(next[1]?.rows.map((r) => r._id)).toEqual(["r2", "r3"]);
  });

  it("row.insert is NOT applied when the last loaded page still has a next page", () => {
    const pages = [page(["r1"], cursor("r1"))];
    const next = patchPagedGridCache(pages, {
      type: "row.insert",
      row: { _id: "r2" },
      cells: [],
    });
    // The new row belongs to an unloaded tail — surfaces when paged to.
    expect(next).toBe(pages);
  });

  it("row.delete drops the row + its cells across loaded pages", () => {
    const pages = [page(["r1", "r2"], null)];
    const next = patchPagedGridCache(pages, { type: "row.delete", rowId: "r1" });
    expect(next[0]?.rows.map((r) => r._id)).toEqual(["r2"]);
    expect(next[0]?.cells.map((c) => c.rowId)).toEqual(["r2"]);
  });

  it("column.insert is applied to EVERY loaded page (columns duplicated per page)", () => {
    const pages = [page(["r1"], cursor("r1")), page(["r2"], null)];
    const col = {
      _id: "c2",
      name: "Name",
      type: "text",
      kind: "manual" as const,
      provider: null,
      method: null,
      code: null,
      params: {},
      condition: null,
    };
    const next = patchPagedGridCache(pages, { type: "column.insert", column: col });
    expect(next[0]?.columns.map((c) => c._id)).toEqual(["c1", "c2"]);
    expect(next[1]?.columns.map((c) => c._id)).toEqual(["c1", "c2"]);
  });

  it("table.delete collapses the whole paged result to no loaded pages", () => {
    const pages = [page(["r1"], null)];
    const next = patchPagedGridCache(pages, { type: "table.delete", tableId: "t1" });
    expect(next).toEqual([]);
  });

  it("each page keeps its own nextCursor after a patch", () => {
    const pages = [page(["r1"], cursor("r1")), page(["r2"], null)];
    const next = patchPagedGridCache(pages, {
      type: "cell.upsert",
      cell: { rowId: "r2", columnId: "c1", value: "z", status: "done", error: null },
    });
    expect(next[0]?.nextCursor).toEqual(cursor("r1"));
    expect(next[1]?.nextCursor).toBeNull();
  });
});

describe("wasEventDropped — the realtime drop-backstop predicate", () => {
  it("row.insert is dropped while the loaded tail still has a next page", () => {
    const pages = [page(["r1"], { position: 1, createdAt: 1, id: "r1" })];
    expect(wasEventDropped(pages, { type: "row.insert", row: { _id: "rX" }, cells: [] })).toBe(true);
  });

  it("row.insert applies when the tail is the final page", () => {
    const pages = [page(["r1"], null)];
    expect(wasEventDropped(pages, { type: "row.insert", row: { _id: "rX" }, cells: [] })).toBe(false);
  });

  it("cell.upsert is dropped only when the row is not loaded", () => {
    const pages = [page(["r1"], null)];
    expect(
      wasEventDropped(pages, { type: "cell.upsert", cell: { rowId: "r1", columnId: "c1", value: "v", status: "done", error: null } }),
    ).toBe(false);
    expect(
      wasEventDropped(pages, { type: "cell.upsert", cell: { rowId: "missing", columnId: "c1", value: "v", status: "done", error: null } }),
    ).toBe(true);
  });

  it("no loaded pages → nothing to drop (seed will fetch)", () => {
    expect(wasEventDropped([], { type: "row.insert", row: { _id: "rX" }, cells: [] })).toBe(false);
  });
});

/**
 * The supersession guard behind the Auto-run toggle (PR #224 review, P1).
 *
 * The bug it prevents: `setAutoRun` used to undo a failure with
 * `beginOptimistic`'s whole-snapshot rollback, which reinstates the cache as it
 * was before THAT toggle. With several toggles in flight, a late failure of an
 * early one restored a snapshot predating the later ones — so the switch could
 * read ON while the server had it OFF, and the cascade would bill against a
 * policy the user could not see.
 */
describe("makeLatestWins — only the newest attempt may reconcile", () => {
  it("the sole in-flight attempt is the latest", () => {
    const g = makeLatestWins();
    expect(g.isLatest("t1", g.claim("t1"))).toBe(true);
  });

  it("a newer claim supersedes the older one", () => {
    const g = makeLatestWins();
    const first = g.claim("t1");
    const second = g.claim("t1");
    expect(g.isLatest("t1", first)).toBe(false);
    expect(g.isLatest("t1", second)).toBe(true);
  });

  it("THE REGRESSION: a late failure of the FIRST of three toggles cannot reconcile", () => {
    // on→off, off→on, on→off issued back to back; the third owns the outcome.
    const g = makeLatestWins();
    const a = g.claim("t1");
    const b = g.claim("t1");
    const c = g.claim("t1");
    // …then A's request fails, long after C already settled the policy.
    expect(g.isLatest("t1", a)).toBe(false);
    expect(g.isLatest("t1", b)).toBe(false);
    expect(g.isLatest("t1", c)).toBe(true);
  });

  it("tickets are per TABLE — toggling one table never supersedes another", () => {
    const g = makeLatestWins();
    const t1 = g.claim("t1");
    const t2 = g.claim("t2");
    expect(g.isLatest("t1", t1)).toBe(true);
    expect(g.isLatest("t2", t2)).toBe(true);
    g.claim("t2");
    expect(g.isLatest("t1", t1)).toBe(true); // t2's churn left t1 alone
  });

  it("a ticket from one guard means nothing to another (no shared global state)", () => {
    const a = makeLatestWins();
    const b = makeLatestWins();
    a.claim("t1");
    expect(b.isLatest("t1", 1)).toBe(false); // b never saw a claim for t1
  });

  it("an unknown table has no latest attempt", () => {
    expect(makeLatestWins().isLatest("nope", 1)).toBe(false);
  });
});

/**
 * The serial queue behind the Auto-run toggle (PR #224 review, second P1).
 *
 * The guard above stops a stale attempt from RECONCILING, but it cannot stop a
 * stale attempt from WRITING: with requests overlapping, the last toggle clicked
 * is not necessarily the last one persisted, so a superseded write can land after
 * the winner and leave the server holding a value nobody chose. Serializing per
 * table is what makes "last click wins" true at the server, not just in the UI.
 */
describe("makeSerialQueue — same-key writes never overlap", () => {
  /** A task that resolves only when told to, recording start/finish order. */
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  it("does not start the second task until the first has settled", async () => {
    const run = makeSerialQueue();
    const first = deferred<string>();
    const started: string[] = [];

    const a = run("t1", () => {
      started.push("a");
      return first.promise;
    });
    const b = run("t1", () => {
      started.push("b");
      return Promise.resolve("b");
    });

    await Promise.resolve();
    expect(started).toEqual(["a"]); // b is queued, NOT in flight

    first.resolve("a");
    await Promise.all([a, b]);
    expect(started).toEqual(["a", "b"]);
  });

  it("THE REGRESSION: a superseded write cannot land after the winner", async () => {
    // enable then disable, clicked back to back. Serialized, the server ends on
    // the disable — the last CLICK — however slow the enable was.
    const run = makeSerialQueue();
    const server: boolean[] = [];
    const enable = deferred<void>();

    const a = run("t1", async () => {
      await enable.promise;
      server.push(true);
    });
    const b = run("t1", async () => {
      server.push(false);
    });

    enable.resolve();
    await Promise.all([a, b]);
    expect(server).toEqual([true, false]); // disable persisted LAST
  });

  it("a rejected task does not break the chain, and its error reaches only its own caller", async () => {
    const run = makeSerialQueue();
    const failed = run("t1", () => Promise.reject(new Error("boom")));
    const after = run("t1", () => Promise.resolve("ran anyway"));

    await expect(failed).rejects.toThrow("boom");
    await expect(after).resolves.toBe("ran anyway");
  });

  it("different tables run concurrently — one table's queue never blocks another", async () => {
    const run = makeSerialQueue();
    const blocked = deferred<void>();
    const started: string[] = [];

    const a = run("t1", () => {
      started.push("t1");
      return blocked.promise;
    });
    const b = run("t2", () => {
      started.push("t2");
      return Promise.resolve();
    });

    await b;
    expect(started).toEqual(["t1", "t2"]); // t2 ran while t1 was still pending

    blocked.resolve();
    await a;
  });

  it("a drained chain is dropped, so repeated toggling does not accumulate state", async () => {
    const run = makeSerialQueue();
    await run("t1", () => Promise.resolve(1));
    // A fresh task after the chain drained starts immediately (nothing to await).
    let startedSync = false;
    const next = run("t1", () => {
      startedSync = true;
      return Promise.resolve(2);
    });
    await next;
    expect(startedSync).toBe(true);
  });
});
