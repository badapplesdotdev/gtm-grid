/**
 * Procedure tests for the `grid` router via `createCaller`, run OFFLINE against a
 * `TestLayer` context (shared in-memory grid store, in-memory MeterService, real
 * CellMerge — no live DB).
 *
 * Proves the acceptance-criteria invariants at the PROCEDURE boundary:
 *   - getTable returns the desktop-consumed shape (table/columns/rows/cells),
 *   - setCell COALESCE merge + metering,
 *   - addRowsWithCells bulk quota enforcement (FORBIDDEN, nothing written),
 *   - deletes cascade to dependents,
 *   - non-members get FORBIDDEN, signed-out callers get UNAUTHORIZED.
 */

import type {
  Membership,
  MeterQuota,
  StoreCell,
  StoreColumn,
  StoreRow,
  StoreTable,
} from "@gtmgrid/services";
import { TestLayer, type TestLayerFixtures } from "@gtmgrid/services";
import { describe, expect, it } from "vitest";
import { createTestContext } from "../context";
import { appRouter } from "../root";
import { createCallerFactory } from "../trpc";

const createCaller = createCallerFactory(appRouter);

const WS = "11111111-1111-1111-1111-111111111111";
const ALICE = "user_alice";

const memberships: readonly Membership[] = [
  { workspaceId: WS, userId: ALICE, role: "member" },
];

const callerFor = (fixtures: TestLayerFixtures) =>
  createCaller(
    createTestContext({
      layer: TestLayer(fixtures),
      userId: fixtures.currentUserId ?? null,
    }),
  );

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
const cell = (over: Partial<StoreCell> = {}): StoreCell => ({
  id: "cell1", workspaceId: WS, tableId: "t1", rowId: "r1", columnId: "c1",
  value: "x", status: "done", error: null, updatedAt: 1, ...over,
});

describe("grid.listProjects / createProject", () => {
  it("creates then lists a workspace's projects for a member", async () => {
    const caller = callerFor({ memberships, currentUserId: ALICE });
    await caller.grid.createProject({ workspaceId: WS, name: "New" });
    const projects = await caller.grid.listProjects({ workspaceId: WS });
    expect(projects.map((p) => p.name)).toContain("New");
  });

  it("rejects a non-member with FORBIDDEN", async () => {
    const caller = callerFor({ memberships, currentUserId: "stranger" });
    await expect(
      caller.grid.listProjects({ workspaceId: WS }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a signed-out caller with UNAUTHORIZED", async () => {
    const caller = callerFor({ memberships, currentUserId: null });
    await expect(
      caller.grid.createProject({ workspaceId: WS, name: "X" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("grid.getTable", () => {
  it("returns the full grid in the desktop-consumed shape", async () => {
    const caller = callerFor({
      memberships, currentUserId: ALICE,
      gridTables: [table()], gridColumns: [column()], gridRows: [row()], gridCells: [cell()],
    });
    const grid = await caller.grid.getTable({ tableId: "t1" });
    expect(grid.table).toEqual({ _id: "t1", name: "T1" });
    expect(grid.columns[0]).toMatchObject({ _id: "c1", name: "A", type: "text", kind: "manual" });
    expect(grid.rows).toEqual([{ _id: "r1" }]);
    expect(grid.cells[0]).toEqual({ rowId: "r1", columnId: "c1", value: "x", status: "done", error: null });
  });

  it("returns NOT_FOUND for a missing table", async () => {
    const caller = callerFor({ memberships, currentUserId: ALICE });
    await expect(
      caller.grid.getTable({ tableId: "missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("grid.setCell — COALESCE merge + metering", () => {
  it("keeps the value on a status-only patch and meters one action", async () => {
    const gridCells = [cell({ value: "keep", status: "done" })];
    const meterQuotas = new Map<string, MeterQuota>();
    const caller = callerFor({
      memberships, currentUserId: ALICE,
      gridTables: [table()], gridColumns: [column()], gridRows: [row()], gridCells,
      meterQuotas,
    });
    await caller.grid.setCell({ rowId: "r1", columnId: "c1", status: "running" });
    expect(gridCells[0]).toMatchObject({ value: "keep", status: "running" });
    expect(meterQuotas.get(WS)?.cloudActionsUsed).toBe(1);
  });
});

describe("grid.addRowsWithCells — bulk quota", () => {
  it("imports N rows + cells for a member", async () => {
    const gridRows: StoreRow[] = [];
    const gridCells: StoreCell[] = [];
    const caller = callerFor({
      memberships, currentUserId: ALICE,
      gridTables: [table()], gridColumns: [column()], gridRows, gridCells,
    });
    const res = await caller.grid.addRowsWithCells({
      tableId: "t1", rows: [{ c1: "a" }, { c1: "b" }],
    });
    expect(res.rowIds).toHaveLength(2);
    expect(gridRows).toHaveLength(2);
    expect(gridCells).toHaveLength(2);
  });

  it("rejects an over-limit import with FORBIDDEN and writes nothing", async () => {
    const gridRows: StoreRow[] = [];
    const meterQuotas = new Map<string, MeterQuota>([
      [WS, { cloudActionsUsed: 9, cloudActionsLimit: 10 }],
    ]);
    const caller = callerFor({
      memberships, currentUserId: ALICE,
      gridTables: [table()], gridColumns: [column()], gridRows, meterQuotas,
    });
    await expect(
      caller.grid.addRowsWithCells({ tableId: "t1", rows: [{ c1: "a" }, { c1: "b" }] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(gridRows).toHaveLength(0);
    expect(meterQuotas.get(WS)?.cloudActionsUsed).toBe(9);
  });
});

describe("grid deletes — cascade", () => {
  it("deleteTable cascades to columns/rows/cells", async () => {
    const gridTables = [table()];
    const gridColumns = [column()];
    const gridRows = [row()];
    const gridCells = [cell()];
    const caller = callerFor({
      memberships, currentUserId: ALICE,
      gridTables, gridColumns, gridRows, gridCells,
    });
    await caller.grid.deleteTable({ tableId: "t1" });
    expect(gridTables).toHaveLength(0);
    expect(gridColumns).toHaveLength(0);
    expect(gridRows).toHaveLength(0);
    expect(gridCells).toHaveLength(0);
  });

  it("rejects deleteRow by a non-member with FORBIDDEN", async () => {
    const caller = callerFor({
      memberships, currentUserId: "stranger",
      gridTables: [table()], gridRows: [row()],
    });
    await expect(
      caller.grid.deleteRow({ rowId: "r1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
