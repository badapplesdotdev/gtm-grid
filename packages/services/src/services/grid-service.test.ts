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
      expect(exit.value.table).toEqual({ _id: "t1", name: "T1" });
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
    const { run } = harness({ store, quotas });
    await run(Effect.flatMap(GridService, (s) => s.deleteTable("t1")));
    expect(store.tables).toHaveLength(0);
    expect(store.columns).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
    expect(store.cells).toHaveLength(0);
    expect(quotas.get(WS)?.cloudActionsUsed).toBe(1);
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
});

describe("GridService structural inserts — meter + position", () => {
  it("createTable computes next position and meters one action", async () => {
    const store = makeGridStore({
      projects: [{ id: "p1", workspaceId: WS, name: "P", createdAt: 1 }],
      tables: [table({ position: 3 })],
    });
    const quotas = new Map<string, MeterQuota>();
    const { run } = harness({ store, quotas });
    const exit = await run(Effect.flatMap(GridService, (s) => s.createTable({ projectId: "p1", name: "New" })));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(store.tables.find((t) => t.name === "New")?.position).toBe(4);
    expect(quotas.get(WS)?.cloudActionsUsed).toBe(1);
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
