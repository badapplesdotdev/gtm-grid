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
  deriveColumnKind,
  gridQueryKeys,
  patchGridCache,
  toCloudDelivery,
  toCloudWebhook,
} from "./useCloudGrid";

// A `getTable`-shaped cache snapshot (the shape the react-query cache holds and
// the reducer patches). Cast to the cache type the helper accepts.
type Snapshot = Parameters<typeof patchGridCache>[0];

const baseSnapshot = (): NonNullable<Snapshot> =>
  ({
    table: { _id: "t1", name: "Leads" },
    columns: [
      {
        _id: "c1",
        name: "Domain",
        type: "text",
        kind: "manual",
        provider: null,
        method: null,
        code: null,
        params: {},
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
        code: null,
        params: {},
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
