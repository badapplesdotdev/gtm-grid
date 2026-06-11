/**
 * `GridService` unit tests — OFFLINE against in-memory Test Layers (shared
 * GridStore, in-memory MeterService, real CellMerge, cloud authz core). Proves
 * the acceptance-criteria invariants at the SERVICE boundary:
 *   - cell upsert COALESCE merge semantics (value/status kept when omitted),
 *   - bulk import quota enforcement (atomic pre-check, nothing written on reject),
 *   - cascade deletes drop dependent rows/cells,
 *   - MeterService increments cloudActionsUsed on the write path (N per bulk row),
 *   - non-member rejection (authz before any data).
 */

import {
  CellMerge,
  identityLayer as cloudIdentityLayer,
  memberRepoLayer as cloudMemberRepoLayer,
  type Membership,
  MembershipService,
} from "@gtmgrid/cloud";
import { Cause, Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { cellRepoLayer } from "../repositories/cell-repo.js";
import { columnRepoLayer } from "../repositories/column-repo.js";
import {
  type GridStore,
  makeGridStore,
  type StoreColumn,
  type StoreRow,
  type StoreTable,
} from "../repositories/grid-store.js";
import { projectRepoLayer } from "../repositories/project-repo.js";
import { rowRepoLayer } from "../repositories/row-repo.js";
import { tableRepoLayer } from "../repositories/table-repo.js";
import {
  type Workspace,
  workspaceRepoLayer,
} from "../repositories/workspace-repo.js";
import { EntitlementService } from "./entitlement-service.js";
import { GridService } from "./grid-service.js";
import { WORKSPACE_ROOM_TABLE_ID } from "../realtime/events.js";
import { type MeterQuota, meterServiceLayer } from "./meter-service.js";
import {
  type RecordedGridEvent,
  recordingRealtimePublisherLayer,
} from "./realtime-publisher.js";

const WS = "ws-1";
const memberships: readonly Membership[] = [
  { workspaceId: WS, userId: "member", role: "member" },
];

function harness(opts: {
  store?: GridStore;
  quotas?: Map<string, MeterQuota>;
  currentUserId?: string | null;
  /** The workspace's cached plan; `undefined` defaults to "team" (cloud on). */
  plan?: string | null;
}) {
  const store = opts.store ?? makeGridStore();
  const quotas = opts.quotas ?? new Map<string, MeterQuota>();
  const events: RecordedGridEvent[] = [];
  const membership = MembershipService.Default.pipe(
    Layer.provide(cloudIdentityLayer(opts.currentUserId ?? "member")),
    Layer.provide(cloudMemberRepoLayer(memberships)),
  );
  // EntitlementService reads the workspace's currentPlanId; default "team" so the
  // cloud gate passes. Pass `plan: null` to exercise a lapsed/Free workspace.
  const workspaces: Workspace[] = [
    {
      id: WS,
      name: "WS",
      ownerId: "owner",
      currentPlanId: opts.plan === undefined ? "team" : opts.plan,
    },
  ];
  const entitlement = EntitlementService.Default.pipe(
    Layer.provide(workspaceRepoLayer(workspaces)),
  );
  // Wire the in-memory bulk-import meter step to the SAME quotas Map the
  // MeterService uses, so addRowsWithCells' atomic meter bump is observable —
  // and rolled back together with the rows on a simulated failure.
  const meterIncrement = (workspaceId: string, n: number) => {
    const q = quotas.get(workspaceId);
    quotas.set(workspaceId, {
      cloudActionsUsed: (q?.cloudActionsUsed ?? 0) + n,
      cloudActionsLimit: q?.cloudActionsLimit ?? null,
    });
  };
  const layer = GridService.Default.pipe(
    Layer.provide(projectRepoLayer(store)),
    Layer.provide(tableRepoLayer(store)),
    Layer.provide(columnRepoLayer(store)),
    Layer.provide(rowRepoLayer(store, meterIncrement)),
    Layer.provide(cellRepoLayer(store)),
    Layer.provide(CellMerge.Default),
    Layer.provide(membership),
    Layer.provide(meterServiceLayer(quotas)),
    Layer.provide(recordingRealtimePublisherLayer(events)),
    Layer.provide(entitlement),
  );
  const run = <A, E>(program: Effect.Effect<A, E, GridService>) =>
    Effect.runPromiseExit(program.pipe(Effect.provide(layer)));
  return { run, store, quotas, events };
}

const failTag = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  const f = Cause.failureOption(exit.cause);
  return f._tag === "Some" ? (f.value as { _tag?: string })._tag : undefined;
};

const table = (over: Partial<StoreTable> = {}): StoreTable => ({
  id: "t1", workspaceId: WS, projectId: "p1", name: "T1", position: 0, createdAt: 1, ...over,
});
const column = (over: Partial<StoreColumn> = {}): StoreColumn => ({
  id: "c1", workspaceId: WS, tableId: "t1", name: "A", type: "text",
  kind: "manual", provider: null, method: null, code: null, params: {},
  position: 0, createdAt: 1, ...over,
});
const row = (over: Partial<StoreRow> = {}): StoreRow => ({
  id: "r1", workspaceId: WS, tableId: "t1", position: 0, createdAt: 1, ...over,
});

describe("GridService.getTable", () => {
  it("returns the full grid in the desktop shape (_id keys + cells)", async () => {
    const store = makeGridStore({
      tables: [table()],
      columns: [column()],
      rows: [row()],
      cells: [
        { id: "cell1", workspaceId: WS, tableId: "t1", rowId: "r1", columnId: "c1", value: "x", status: "done", error: null, updatedAt: 1 },
      ],
    });
    const { run } = harness({ store });
    const exit = await run(Effect.flatMap(GridService, (s) => s.getTable("t1")));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.table).toEqual({ _id: "t1", name: "T1", dedupe: null });
      expect(exit.value.columns[0]).toMatchObject({ _id: "c1", name: "A", type: "text", kind: "manual" });
      expect(exit.value.rows).toEqual([{ _id: "r1" }]);
      expect(exit.value.cells[0]).toEqual({ rowId: "r1", columnId: "c1", value: "x", status: "done", error: null });
    }
  });

  it("rejects a non-member with NotAMemberError (authz before data)", async () => {
    const store = makeGridStore({ tables: [table()] });
    const { run } = harness({ store, currentUserId: "stranger" });
    const exit = await run(Effect.flatMap(GridService, (s) => s.getTable("t1")));
    expect(failTag(exit)).toBe("NotAMemberError");
  });

  it("fails GridNotFoundError for a missing table", async () => {
    const { run } = harness({});
    const exit = await run(Effect.flatMap(GridService, (s) => s.getTable("missing")));
    expect(failTag(exit)).toBe("GridNotFoundError");
  });
});

describe("GridService.dedupe (cloud parity with the local engine)", () => {
  const dupStore = (keep: "oldest" | "newest") =>
    makeGridStore({
      tables: [table({ dedupeColumn: "c1", dedupeKeep: keep })],
      columns: [column()],
      rows: [
        row({ id: "r1", position: 0 }),
        row({ id: "r2", position: 1 }),
        row({ id: "r3", position: 2 }),
      ],
      cells: [
        // r1 & r3 share value "a" (duplicates); r2 is unique "b".
        { id: "x1", workspaceId: WS, tableId: "t1", rowId: "r1", columnId: "c1", value: "a", status: "done", error: null, updatedAt: 1 },
        { id: "x2", workspaceId: WS, tableId: "t1", rowId: "r2", columnId: "c1", value: "b", status: "done", error: null, updatedAt: 1 },
        { id: "x3", workspaceId: WS, tableId: "t1", rowId: "r3", columnId: "c1", value: "a", status: "done", error: null, updatedAt: 1 },
      ],
    });

  it("keep=oldest deletes the later duplicate (keeps the first in table order)", async () => {
    const store = dupStore("oldest");
    const { run, events } = harness({ store });
    const exit = await run(Effect.flatMap(GridService, (s) => s.dedupeTable("t1")));
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ deleted: 1 });
    expect(store.rows.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
    // The deletion is broadcast so other clients live-update.
    expect(events.some((e) => e.event.type === "row.delete" && e.event.rowId === "r3")).toBe(true);
  });

  it("keep=newest deletes the earlier duplicate (keeps the last)", async () => {
    const store = dupStore("newest");
    const { run } = harness({ store });
    await run(Effect.flatMap(GridService, (s) => s.dedupeTable("t1")));
    expect(store.rows.map((r) => r.id).sort()).toEqual(["r2", "r3"]);
  });

  it("setDedupe persists config and sweeps immediately", async () => {
    const store = makeGridStore({
      tables: [table()],
      columns: [column()],
      rows: [row({ id: "r1", position: 0 }), row({ id: "r2", position: 1 })],
      cells: [
        { id: "x1", workspaceId: WS, tableId: "t1", rowId: "r1", columnId: "c1", value: "dup", status: "done", error: null, updatedAt: 1 },
        { id: "x2", workspaceId: WS, tableId: "t1", rowId: "r2", columnId: "c1", value: "dup", status: "done", error: null, updatedAt: 1 },
      ],
    });
    const { run } = harness({ store });
    const exit = await run(Effect.flatMap(GridService, (s) => s.setDedupe({ tableId: "t1", column: "c1", keep: "oldest" })));
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ dedupe: { column: "c1", keep: "oldest" }, deleted: 1 });
    expect(store.tables[0].dedupeColumn).toBe("c1");
    expect(store.rows).toHaveLength(1);
  });

  it("setDedupe with column:null disables dedupe and sweeps nothing", async () => {
    const store = makeGridStore({ tables: [table({ dedupeColumn: "c1", dedupeKeep: "oldest" })] });
    const { run } = harness({ store });
    const exit = await run(Effect.flatMap(GridService, (s) => s.setDedupe({ tableId: "t1", column: null, keep: "oldest" })));
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ dedupe: null, deleted: 0 });
    expect(store.tables[0].dedupeColumn).toBe(null);
  });
});

describe("GridService.getTablePage — keyset pagination (TRI-3272)", () => {
  const pageStore = () =>
    makeGridStore({
      tables: [table()],
      columns: [column()],
      rows: [
        row({ id: "r1", position: 0 }),
        row({ id: "r2", position: 1 }),
        row({ id: "r3", position: 2 }),
      ],
      cells: [
        { id: "cell1", workspaceId: WS, tableId: "t1", rowId: "r1", columnId: "c1", value: "a", status: "done", error: null, updatedAt: 1 },
        { id: "cell2", workspaceId: WS, tableId: "t1", rowId: "r2", columnId: "c1", value: "b", status: "done", error: null, updatedAt: 1 },
        { id: "cell3", workspaceId: WS, tableId: "t1", rowId: "r3", columnId: "c1", value: "c", status: "done", error: null, updatedAt: 1 },
      ],
    });

  it("returns a page of rows + ONLY their cells + a nextCursor (not the whole grid)", async () => {
    const { run } = harness({ store: pageStore() });
    const exit = await run(
      Effect.flatMap(GridService, (s) => s.getTablePage({ tableId: "t1", limit: 2 })),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.rows).toEqual([{ _id: "r1" }, { _id: "r2" }]);
      expect(exit.value.cells.map((c) => c.value).sort()).toEqual(["a", "b"]);
      expect(exit.value.columns[0]).toMatchObject({ _id: "c1" });
      expect(exit.value.table).toEqual({ _id: "t1", name: "T1", dedupe: null });
      expect(exit.value.nextCursor).not.toBeNull();
    }
  });

  it("follows the nextCursor to the last page, which reports nextCursor=null", async () => {
    const { run } = harness({ store: pageStore() });
    const first = await run(
      Effect.flatMap(GridService, (s) => s.getTablePage({ tableId: "t1", limit: 2 })),
    );
    if (!Exit.isSuccess(first)) throw new Error("first page failed");
    const second = await run(
      Effect.flatMap(GridService, (s) =>
        s.getTablePage({ tableId: "t1", limit: 2, cursor: first.value.nextCursor }),
      ),
    );
    expect(Exit.isSuccess(second)).toBe(true);
    if (Exit.isSuccess(second)) {
      expect(second.value.rows).toEqual([{ _id: "r3" }]);
      expect(second.value.cells.map((c) => c.value)).toEqual(["c"]);
      expect(second.value.nextCursor).toBeNull();
    }
  });

  it("rejects a non-member with NotAMemberError (authz before any page read)", async () => {
    const { run } = harness({ store: pageStore(), currentUserId: "stranger" });
    const exit = await run(
      Effect.flatMap(GridService, (s) => s.getTablePage({ tableId: "t1" })),
    );
    expect(failTag(exit)).toBe("NotAMemberError");
  });

  it("blocks a lapsed/Free workspace with PlanRequiredError", async () => {
    const { run } = harness({ store: pageStore(), plan: null });
    const exit = await run(
      Effect.flatMap(GridService, (s) => s.getTablePage({ tableId: "t1" })),
    );
    expect(failTag(exit)).toBe("PlanRequiredError");
  });

  it("fails GridNotFoundError for a missing table", async () => {
    const { run } = harness({});
    const exit = await run(
      Effect.flatMap(GridService, (s) => s.getTablePage({ tableId: "missing" })),
    );
    expect(failTag(exit)).toBe("GridNotFoundError");
  });
});

describe("GridService.setCell — COALESCE merge", () => {
  it("keeps the existing value when a status-only patch omits it", async () => {
    const store = makeGridStore({
      tables: [table()], columns: [column()], rows: [row()],
      cells: [{ id: "cell1", workspaceId: WS, tableId: "t1", rowId: "r1", columnId: "c1", value: "keep", status: "done", error: null, updatedAt: 1 }],
    });
    const { run } = harness({ store });
    await run(Effect.flatMap(GridService, (s) => s.setCell({ rowId: "r1", columnId: "c1", hasValue: false, status: "running" })));
    const cell = store.cells.find((c) => c.rowId === "r1" && c.columnId === "c1");
    expect(cell?.value).toBe("keep");
    expect(cell?.status).toBe("running");
  });

  it("overwrites the value when the patch carries it", async () => {
    const store = makeGridStore({
      tables: [table()], columns: [column()], rows: [row()],
      cells: [{ id: "cell1", workspaceId: WS, tableId: "t1", rowId: "r1", columnId: "c1", value: "old", status: "done", error: null, updatedAt: 1 }],
    });
    const { run } = harness({ store });
    await run(Effect.flatMap(GridService, (s) => s.setCell({ rowId: "r1", columnId: "c1", hasValue: true, value: "new", status: "done" })));
    expect(store.cells.find((c) => c.rowId === "r1")?.value).toBe("new");
  });

  it("inserts a new cell when none exists for (rowId, columnId)", async () => {
    const store = makeGridStore({ tables: [table()], columns: [column()], rows: [row()] });
    const { run } = harness({ store });
    await run(Effect.flatMap(GridService, (s) => s.setCell({ rowId: "r1", columnId: "c1", hasValue: true, value: "v", status: "done" })));
    expect(store.cells).toHaveLength(1);
    expect(store.cells[0]).toMatchObject({ rowId: "r1", columnId: "c1", value: "v", status: "done" });
  });

  it("meters ONE cloud action on the write path", async () => {
    const store = makeGridStore({ tables: [table()], columns: [column()], rows: [row()] });
    const quotas = new Map<string, MeterQuota>();
    const { run } = harness({ store, quotas });
    await run(Effect.flatMap(GridService, (s) => s.setCell({ rowId: "r1", columnId: "c1", hasValue: true, value: "v" })));
    expect(quotas.get(WS)?.cloudActionsUsed).toBe(1);
  });

  it("rejects a (row, column) pair from different tables", async () => {
    const store = makeGridStore({
      tables: [table(), table({ id: "t2" })],
      columns: [column({ id: "c2", tableId: "t2" })],
      rows: [row()],
    });
    const { run } = harness({ store });
    const exit = await run(Effect.flatMap(GridService, (s) => s.setCell({ rowId: "r1", columnId: "c2", hasValue: true, value: "v" })));
    expect(failTag(exit)).toBe("InvalidCellError");
  });
});

describe("GridService.setCellStatus", () => {
  it("sets status while preserving the value (COALESCE)", async () => {
    const store = makeGridStore({
      tables: [table()], columns: [column()], rows: [row()],
      cells: [{ id: "cell1", workspaceId: WS, tableId: "t1", rowId: "r1", columnId: "c1", value: "v", status: "running", error: null, updatedAt: 1 }],
    });
    const { run } = harness({ store });
    await run(Effect.flatMap(GridService, (s) => s.setCellStatus({ rowId: "r1", columnId: "c1", status: "done" })));
    const cell = store.cells[0];
    expect(cell).toMatchObject({ value: "v", status: "done" });
  });
});

describe("GridService.addRowsWithCells — bulk quota + meter", () => {
  it("inserts N rows + their cells and meters N actions", async () => {
    const store = makeGridStore({ tables: [table()], columns: [column()] });
    const quotas = new Map<string, MeterQuota>();
    const { run } = harness({ store, quotas });
    const exit = await run(
      Effect.flatMap(GridService, (s) =>
        s.addRowsWithCells({ tableId: "t1", rows: [{ c1: "a" }, { c1: "b" }] }),
      ),
    );
    expect(Exit.isSuccess(exit) && exit.value.rowIds).toHaveLength(2);
    expect(store.rows).toHaveLength(2);
    expect(store.cells).toHaveLength(2);
    expect(quotas.get(WS)?.cloudActionsUsed).toBe(2);
  });

  it("skips empty values and values for columns not in the table", async () => {
    const store = makeGridStore({ tables: [table()], columns: [column()] });
    const { run } = harness({ store });
    await run(
      Effect.flatMap(GridService, (s) =>
        s.addRowsWithCells({ tableId: "t1", rows: [{ c1: "", cOther: "x" }] }),
      ),
    );
    expect(store.rows).toHaveLength(1);
    expect(store.cells).toHaveLength(0);
  });

  it("rejects an import that would exceed the plan limit, writing NOTHING (atomic)", async () => {
    const store = makeGridStore({ tables: [table()], columns: [column()] });
    const quotas = new Map<string, MeterQuota>([
      [WS, { cloudActionsUsed: 9, cloudActionsLimit: 10 }],
    ]);
    const { run } = harness({ store, quotas });
    const exit = await run(
      Effect.flatMap(GridService, (s) =>
        s.addRowsWithCells({ tableId: "t1", rows: [{ c1: "a" }, { c1: "b" }] }),
      ),
    );
    expect(failTag(exit)).toBe("CloudActionsLimitError");
    // Atomic: nothing written, usage unchanged.
    expect(store.rows).toHaveLength(0);
    expect(store.cells).toHaveLength(0);
    expect(quotas.get(WS)?.cloudActionsUsed).toBe(9);
  });

  it("allows an unlimited plan (limit null) regardless of count", async () => {
    const store = makeGridStore({ tables: [table()], columns: [column()] });
    const quotas = new Map<string, MeterQuota>([
      [WS, { cloudActionsUsed: 1000, cloudActionsLimit: null }],
    ]);
    const { run } = harness({ store, quotas });
    const exit = await run(
      Effect.flatMap(GridService, (s) =>
        s.addRowsWithCells({ tableId: "t1", rows: [{ c1: "a" }] }),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(store.rows).toHaveLength(1);
  });
});

describe("GridService deletes — cascade + meter", () => {
  it("deleteTable cascades to columns/rows/cells and meters one action", async () => {
    const store = makeGridStore({
      tables: [table()], columns: [column()], rows: [row()],
      cells: [{ id: "cell1", workspaceId: WS, tableId: "t1", rowId: "r1", columnId: "c1", value: "x", status: "done", error: null, updatedAt: 1 }],
    });
    const quotas = new Map<string, MeterQuota>();
    const { run, events } = harness({ store, quotas });
    await run(Effect.flatMap(GridService, (s) => s.deleteTable("t1")));
    expect(store.tables).toHaveLength(0);
    expect(store.columns).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
    expect(store.cells).toHaveLength(0);
    expect(quotas.get(WS)?.cloudActionsUsed).toBe(1);
    // Live sidebar (E): a table.delete is broadcast on the workspace room too.
    expect(
      events.some(
        (e) => e.tableId === WORKSPACE_ROOM_TABLE_ID && e.event.type === "table.delete",
      ),
    ).toBe(true);
  });

  it("deleteRow cascades to that row's cells only", async () => {
    const store = makeGridStore({
      tables: [table()], columns: [column()],
      rows: [row(), row({ id: "r2", position: 1 })],
      cells: [
        { id: "cell1", workspaceId: WS, tableId: "t1", rowId: "r1", columnId: "c1", value: "x", status: "done", error: null, updatedAt: 1 },
        { id: "cell2", workspaceId: WS, tableId: "t1", rowId: "r2", columnId: "c1", value: "y", status: "done", error: null, updatedAt: 1 },
      ],
    });
    const { run } = harness({ store });
    await run(Effect.flatMap(GridService, (s) => s.deleteRow("r1")));
    expect(store.rows.map((r) => r.id)).toEqual(["r2"]);
    expect(store.cells.map((c) => c.rowId)).toEqual(["r2"]);
  });

  it("deleteColumn cascades to that column's cells only", async () => {
    const store = makeGridStore({
      tables: [table()],
      columns: [column(), column({ id: "c2", position: 1 })],
      rows: [row()],
      cells: [
        { id: "cell1", workspaceId: WS, tableId: "t1", rowId: "r1", columnId: "c1", value: "x", status: "done", error: null, updatedAt: 1 },
        { id: "cell2", workspaceId: WS, tableId: "t1", rowId: "r1", columnId: "c2", value: "y", status: "done", error: null, updatedAt: 1 },
      ],
    });
    const { run } = harness({ store });
    await run(Effect.flatMap(GridService, (s) => s.deleteColumn("c1")));
    expect(store.columns.map((c) => c.id)).toEqual(["c2"]);
    expect(store.cells.map((c) => c.columnId)).toEqual(["c2"]);
  });

  it("updateColumn patches only the provided fields and meters one action", async () => {
    const store = makeGridStore({
      tables: [table()],
      columns: [column({ name: "A", type: "text", condition: "keep" })],
    });
    const quotas = new Map<string, MeterQuota>();
    const { run } = harness({ store, quotas });
    await run(
      Effect.flatMap(GridService, (s) => s.updateColumn("c1", { name: "Renamed", type: "number" })),
    );
    expect(store.columns[0]).toMatchObject({ name: "Renamed", type: "number", condition: "keep" });
    expect(quotas.get(WS)?.cloudActionsUsed).toBe(1);
  });
});

describe("GridService structural inserts — meter + position", () => {
  it("createTable computes next position and meters one action", async () => {
    const store = makeGridStore({
      projects: [{ id: "p1", workspaceId: WS, name: "P", createdAt: 1 }],
      tables: [table({ position: 3 })],
    });
    const quotas = new Map<string, MeterQuota>();
    const { run, events } = harness({ store, quotas });
    const exit = await run(Effect.flatMap(GridService, (s) => s.createTable({ projectId: "p1", name: "New" })));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(store.tables.find((t) => t.name === "New")?.position).toBe(4);
    expect(quotas.get(WS)?.cloudActionsUsed).toBe(1);
    // Live sidebar (E): a table.insert is broadcast on the workspace room too.
    expect(
      events.some(
        (e) => e.tableId === WORKSPACE_ROOM_TABLE_ID && e.event.type === "table.insert",
      ),
    ).toBe(true);
  });

  it("createProject is NOT metered", async () => {
    const store = makeGridStore();
    const quotas = new Map<string, MeterQuota>();
    const { run } = harness({ store, quotas });
    await run(Effect.flatMap(GridService, (s) => s.createProject({ workspaceId: WS, name: "P" })));
    expect(store.projects).toHaveLength(1);
    expect(quotas.has(WS)).toBe(false);
  });

  it("addColumn and addRow each meter one action", async () => {
    const store = makeGridStore({ tables: [table()] });
    const quotas = new Map<string, MeterQuota>();
    const { run } = harness({ store, quotas });
    await run(Effect.flatMap(GridService, (s) => s.addColumn({ tableId: "t1", name: "B", type: "text", kind: "manual" })));
    await run(Effect.flatMap(GridService, (s) => s.addRow("t1")));
    expect(quotas.get(WS)?.cloudActionsUsed).toBe(2);
    expect(store.columns).toHaveLength(1);
    expect(store.rows).toHaveLength(1);
  });
});

describe("GridService realtime publishing (TRI-3251)", () => {
  it("setCell publishes a cell.upsert with the merged value", async () => {
    const store = makeGridStore({ tables: [table()], columns: [column()], rows: [row()] });
    const { run, events } = harness({ store });
    await run(Effect.flatMap(GridService, (s) => s.setCell({ rowId: "r1", columnId: "c1", hasValue: true, value: "hello" })));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ workspaceId: WS, tableId: "t1" });
    expect(events[0].event).toMatchObject({
      type: "cell.upsert",
      cell: { rowId: "r1", columnId: "c1", value: "hello" },
    });
  });

  it("setCellStatus publishes a cell.upsert preserving the value", async () => {
    const store = makeGridStore({
      tables: [table()], columns: [column()], rows: [row()],
      cells: [{ id: "cell1", workspaceId: WS, tableId: "t1", rowId: "r1", columnId: "c1", value: "keep", status: "done", error: null, updatedAt: 1 }],
    });
    const { run, events } = harness({ store });
    await run(Effect.flatMap(GridService, (s) => s.setCellStatus({ rowId: "r1", columnId: "c1", status: "running" })));
    expect(events[0].event).toMatchObject({
      type: "cell.upsert",
      cell: { rowId: "r1", columnId: "c1", value: "keep", status: "running" },
    });
  });

  it("addRow publishes a row.insert with the new row id and no cells", async () => {
    const store = makeGridStore({ tables: [table()] });
    const { run, events } = harness({ store });
    const exit = await run(Effect.flatMap(GridService, (s) => s.addRow("t1")));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(events[0].event).toMatchObject({ type: "row.insert", cells: [] });
  });

  it("addColumn publishes a column.insert with the column projection", async () => {
    const store = makeGridStore({ tables: [table()] });
    const { run, events } = harness({ store });
    await run(Effect.flatMap(GridService, (s) => s.addColumn({ tableId: "t1", name: "B", type: "number", kind: "manual" })));
    expect(events[0].event).toMatchObject({
      type: "column.insert",
      column: { name: "B", type: "number", kind: "manual" },
    });
  });

  it("updateColumn publishes a column.update with the updated projection", async () => {
    const store = makeGridStore({ tables: [table()], columns: [column({ name: "A" })] });
    const { run, events } = harness({ store });
    await run(Effect.flatMap(GridService, (s) => s.updateColumn("c1", { name: "Renamed", type: "number" })));
    expect(events[0].event).toMatchObject({
      type: "column.update",
      column: { _id: "c1", name: "Renamed", type: "number" },
    });
  });

  it("createTable publishes a table.insert", async () => {
    const store = makeGridStore({ projects: [{ id: "p1", workspaceId: WS, name: "P", createdAt: 1 }] });
    const { run, events } = harness({ store });
    await run(Effect.flatMap(GridService, (s) => s.createTable({ projectId: "p1", name: "New" })));
    expect(events[0].event).toMatchObject({ type: "table.insert", projectId: "p1", name: "New" });
  });

  it("addRowsWithCells publishes one row.insert per imported row with its cells", async () => {
    const store = makeGridStore({ tables: [table()], columns: [column()] });
    const { run, events } = harness({ store });
    await run(Effect.flatMap(GridService, (s) => s.addRowsWithCells({ tableId: "t1", rows: [{ c1: "a" }, { c1: "b" }] })));
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.event.type === "row.insert")).toBe(true);
    const first = events[0].event;
    if (first.type === "row.insert") {
      expect(first.cells[0]).toMatchObject({ columnId: "c1", value: "a" });
    }
  });

  it("deleteRow publishes a row.delete", async () => {
    const store = makeGridStore({ tables: [table()], rows: [row()] });
    const { run, events } = harness({ store });
    await run(Effect.flatMap(GridService, (s) => s.deleteRow("r1")));
    expect(events[0].event).toMatchObject({ type: "row.delete", rowId: "r1" });
  });

  it("deleteColumn publishes a column.delete", async () => {
    const store = makeGridStore({ tables: [table()], columns: [column()] });
    const { run, events } = harness({ store });
    await run(Effect.flatMap(GridService, (s) => s.deleteColumn("c1")));
    expect(events[0].event).toMatchObject({ type: "column.delete", columnId: "c1" });
  });

  it("deleteTable publishes a table.delete", async () => {
    const store = makeGridStore({ tables: [table()] });
    const { run, events } = harness({ store });
    await run(Effect.flatMap(GridService, (s) => s.deleteTable("t1")));
    expect(events[0].event).toMatchObject({ type: "table.delete", tableId: "t1" });
  });

  it("does not publish when authz fails (no write happened)", async () => {
    const store = makeGridStore({ tables: [table()], rows: [row()] });
    const { run, events } = harness({ store, currentUserId: "stranger" });
    await run(Effect.flatMap(GridService, (s) => s.deleteRow("r1")));
    expect(events).toHaveLength(0);
  });
});

describe("cloud-access gate (lapsed trial / Free workspace)", () => {
  it("blocks opening a cloud table (getTable) with PlanRequiredError", async () => {
    const store = makeGridStore({ tables: [table()] });
    const { run } = harness({ store, plan: null });
    const exit = await run(Effect.flatMap(GridService, (s) => s.getTable("t1")));
    expect(failTag(exit)).toBe("PlanRequiredError");
  });

  it("blocks cloud writes (createProject) with PlanRequiredError", async () => {
    const { run } = harness({ plan: null });
    const exit = await run(
      Effect.flatMap(GridService, (s) =>
        s.createProject({ workspaceId: WS, name: "P" }),
      ),
    );
    expect(failTag(exit)).toBe("PlanRequiredError");
  });

  it("still ALLOWS listing projects so the desktop can render them as locked", async () => {
    const { run } = harness({ plan: null });
    const exit = await run(
      Effect.flatMap(GridService, (s) => s.listProjects(WS)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("still ALLOWS listing a project's tables (locked view)", async () => {
    const store = makeGridStore({
      projects: [{ id: "p1", workspaceId: WS, name: "P", createdAt: 1 }],
      tables: [table()],
    });
    const { run } = harness({ store, plan: null });
    const exit = await run(Effect.flatMap(GridService, (s) => s.listTables("p1")));
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("GridService.listTablesWithCounts (project-wide list for the agent — TRI-3299)", () => {
  it("returns every table in the project with its column + row counts", async () => {
    const store = makeGridStore({
      projects: [{ id: "p1", workspaceId: WS, name: "P", createdAt: 1 }],
      tables: [
        table({ id: "t1", name: "T1", position: 0 }),
        table({ id: "t2", name: "T2", position: 1 }),
      ],
      columns: [
        column({ id: "c1", tableId: "t1", name: "A", position: 0 }),
        column({ id: "c2", tableId: "t1", name: "B", position: 1 }),
        column({ id: "c3", tableId: "t2", name: "C", position: 0 }),
      ],
      rows: [
        row({ id: "r1", tableId: "t1", position: 0 }),
        row({ id: "r2", tableId: "t2", position: 0 }),
        row({ id: "r3", tableId: "t2", position: 1 }),
      ],
    });
    const { run } = harness({ store });
    const exit = await run(
      Effect.flatMap(GridService, (s) => s.listTablesWithCounts("p1")),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual([
        { id: "t1", name: "T1", columns: 2, rows: 1 },
        { id: "t2", name: "T2", columns: 1, rows: 2 },
      ]);
    }
  });

  it("rejects a non-member with NotAMemberError (authz before any read)", async () => {
    const store = makeGridStore({
      projects: [{ id: "p1", workspaceId: WS, name: "P", createdAt: 1 }],
      tables: [table()],
    });
    const { run } = harness({ store, currentUserId: "stranger" });
    const exit = await run(
      Effect.flatMap(GridService, (s) => s.listTablesWithCounts("p1")),
    );
    expect(failTag(exit)).toBe("NotAMemberError");
  });

  it("fails GridNotFoundError for an unknown project", async () => {
    const { run } = harness({});
    const exit = await run(
      Effect.flatMap(GridService, (s) => s.listTablesWithCounts("nope")),
    );
    expect(failTag(exit)).toBe("GridNotFoundError");
  });

  it("does NOT meter (a pure read)", async () => {
    const store = makeGridStore({
      projects: [{ id: "p1", workspaceId: WS, name: "P", createdAt: 1 }],
      tables: [table()],
    });
    const quotas = new Map<string, MeterQuota>();
    const { run } = harness({ store, quotas });
    await run(Effect.flatMap(GridService, (s) => s.listTablesWithCounts("p1")));
    expect(quotas.get(WS)?.cloudActionsUsed ?? 0).toBe(0);
  });
});
