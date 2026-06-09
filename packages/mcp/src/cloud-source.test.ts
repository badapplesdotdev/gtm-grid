import {
  Registry,
  type CloudClientLike,
  type Connector,
  type ConnectorMethod,
} from "@gtmgrid/engine";
import { describe, expect, it } from "vitest";
import type { CloudContext } from "./cloud-context.js";
import {
  CloudToolUnsupportedError,
  defaultCloudSourceDeps,
  makeCloudSource,
  type CloudSourceDeps,
} from "./cloud-source.js";

const CTX: CloudContext = {
  apiUrl: "https://app.test",
  token: "bearer-xyz",
  workspaceId: "wks_1",
  projectId: "proj_1",
  tableId: "t1",
};

/** A registry whose single connector upper-cases its `value` input. */
function upperRegistry(): Registry {
  const method: ConnectorMethod = {
    id: "upper",
    label: "Upper",
    description: "Uppercases the input value.",
    inputSchema: {},
    batchSize: 1,
    credits: 0,
    run: async (inputs) => ({ text: String(inputs.value ?? "").toUpperCase() }),
  };
  const connector: Connector = {
    id: "test",
    name: "Test",
    category: "test",
    auth: null,
    methods: [method],
  };
  return new Registry([connector]);
}

interface FakeGrid {
  columns: Array<Record<string, unknown>>;
  rows: Array<Record<string, unknown>>;
  cells: Array<{
    rowId: string;
    columnId: string;
    value: unknown;
    status: string;
    error: string | null;
    updatedAt: number | null;
  }>;
}

/** A fake worker client over an in-memory grid (TRI-3296 cloud source). */
function fakeClient(grid: FakeGrid): {
  client: CloudClientLike;
  mutations: Array<{ name: string; args: Record<string, unknown> }>;
} {
  const mutations: Array<{ name: string; args: Record<string, unknown> }> = [];
  const upsert = (args: Record<string, unknown>) => {
    const rowId = args.rowId as string;
    const columnId = args.columnId as string;
    let cell = grid.cells.find((c) => c.rowId === rowId && c.columnId === columnId);
    if (!cell) {
      cell = { rowId, columnId, value: null, status: "empty", error: null, updatedAt: null };
      grid.cells.push(cell);
    }
    if ("value" in args) cell.value = args.value;
    if (args.status !== undefined) cell.status = args.status as string;
    if (args.error !== undefined) cell.error = args.error as string | null;
  };
  const client: CloudClientLike = {
    query: async (ref) => {
      const name = String(ref);
      if (name === "/api/worker/getTable") {
        return {
          table: { workspaceId: "wks_1" },
          columns: grid.columns,
          rows: grid.rows,
          cells: grid.cells,
        };
      }
      throw new Error(`unexpected query ${name}`);
    },
    mutation: async (ref, args) => {
      const name = String(ref);
      mutations.push({ name, args });
      if (name === "/api/worker/setCell" || name === "/api/worker/setCellStatus") {
        upsert(args);
        return "cell-id";
      }
      if (name === "/api/worker/setCells") {
        for (const c of (args.cells as Record<string, unknown>[]) ?? []) upsert(c);
        return null;
      }
      return null;
    },
    action: async () => null,
  };
  return { client, mutations };
}

/** Deps that inject the fake client + a static workspace resolver (no HTTP). */
function depsFor(grid: FakeGrid): { deps: CloudSourceDeps; client: ReturnType<typeof fakeClient> } {
  const fake = fakeClient(grid);
  const deps: CloudSourceDeps = {
    registry: upperRegistry(),
    config: {},
    makeClient: () => fake.client,
    resolveWorkspaceId: async () => "wks_1",
  };
  return { deps, client: fake };
}

describe("makeCloudSource.getTable — reads the active cloud table from Supabase", () => {
  it("maps columns + per-row cell values (incl. error + null cells) to the MCP shape", async () => {
    const grid: FakeGrid = {
      columns: [
        { _id: "c1", tableId: "t1", name: "Username", type: "text", kind: "manual", provider: null, method: null, code: null, params: {}, position: 0, createdAt: 0 },
        { _id: "c2", tableId: "t1", name: "Upper", type: "text", kind: "function", provider: "test", method: "upper", code: null, params: { value: "{{Username}}" }, position: 1, createdAt: 0 },
      ],
      rows: [
        { _id: "r1", tableId: "t1", position: 0, createdAt: 0 },
        { _id: "r2", tableId: "t1", position: 1, createdAt: 0 },
      ],
      cells: [
        { rowId: "r1", columnId: "c1", value: "torvalds", status: "done", error: null, updatedAt: 1 },
        { rowId: "r1", columnId: "c2", value: "TORVALDS", status: "done", error: null, updatedAt: 1 },
        { rowId: "r2", columnId: "c1", value: "ada", status: "done", error: null, updatedAt: 1 },
        { rowId: "r2", columnId: "c2", value: null, status: "error", error: "boom", updatedAt: 1 },
      ],
    };
    const { deps } = depsFor(grid);
    const out = await makeCloudSource(CTX, deps).getTable("anything");
    expect(out.columns).toEqual([
      { name: "Username", kind: "manual", fn: null },
      { name: "Upper", kind: "function", fn: "test.upper" },
    ]);
    expect(out.rows).toEqual([
      { Username: "torvalds", Upper: "TORVALDS" },
      { Username: "ada", Upper: { error: "boom" } },
    ]);
  });
});

describe("makeCloudSource.listTables — the active cloud table (worker boundary is table-scoped)", () => {
  it("returns the active table id with live column/row counts", async () => {
    const grid: FakeGrid = {
      columns: [{ _id: "c1", tableId: "t1", name: "A", type: "text", kind: "manual", provider: null, method: null, code: null, params: {}, position: 0, createdAt: 0 }],
      rows: [{ _id: "r1", tableId: "t1", position: 0, createdAt: 0 }, { _id: "r2", tableId: "t1", position: 1, createdAt: 0 }],
      cells: [],
    };
    const { deps } = depsFor(grid);
    const tables = await makeCloudSource(CTX, deps).listTables();
    expect(tables).toEqual([{ id: "t1", name: "t1", columns: 1, rows: 2 }]);
  });
});

describe("makeCloudSource.runColumn — runs through the reused cloud GridStore + Db-free engine", () => {
  it("runs a function column and writes results back through the injected cloud store", async () => {
    const grid: FakeGrid = {
      columns: [
        { _id: "c1", tableId: "t1", name: "Username", type: "text", kind: "manual", provider: null, method: null, code: null, params: {}, position: 0, createdAt: 0 },
        { _id: "c2", tableId: "t1", name: "Upper", type: "text", kind: "function", provider: "test", method: "upper", code: null, params: { value: "{{Username}}" }, position: 1, createdAt: 0 },
      ],
      rows: [{ _id: "r1", tableId: "t1", position: 0, createdAt: 0 }],
      cells: [{ rowId: "r1", columnId: "c1", value: "torvalds", status: "done", error: null, updatedAt: 1 }],
    };
    const { deps, client } = depsFor(grid);
    const res = await makeCloudSource(CTX, deps).runColumn("t1", "Upper", {});
    expect(res).toEqual({ column: "Upper", ran: 1, errors: 0 });
    // The computed value was written back through the cloud store (a worker
    // cell write), not to any local SQLite file.
    const wrote = client.mutations.some(
      (m) =>
        (m.name === "/api/worker/setCell" || m.name === "/api/worker/setCells") &&
        JSON.stringify(m.args).includes("TORVALDS"),
    );
    expect(wrote).toBe(true);
  });

  it("resolves the column by name OR id", async () => {
    const grid: FakeGrid = {
      columns: [
        { _id: "c1", tableId: "t1", name: "Username", type: "text", kind: "manual", provider: null, method: null, code: null, params: {}, position: 0, createdAt: 0 },
        { _id: "c2", tableId: "t1", name: "Upper", type: "text", kind: "function", provider: "test", method: "upper", code: null, params: { value: "{{Username}}" }, position: 1, createdAt: 0 },
      ],
      rows: [{ _id: "r1", tableId: "t1", position: 0, createdAt: 0 }],
      cells: [{ rowId: "r1", columnId: "c1", value: "x", status: "done", error: null, updatedAt: 1 }],
    };
    const { deps } = depsFor(grid);
    const byId = await makeCloudSource(CTX, deps).runColumn("t1", "c2", {});
    expect(byId.ran).toBe(1);
  });

  it("throws a clear error for an unknown column", async () => {
    const grid: FakeGrid = { columns: [], rows: [], cells: [] };
    const { deps } = depsFor(grid);
    await expect(makeCloudSource(CTX, deps).runColumn("t1", "Nope", {})).rejects.toThrow(
      /No column "Nope"/,
    );
  });
});

describe("CloudToolUnsupportedError — create/list-all mutators on cloud", () => {
  it("carries a tag + a message naming the tool and pointing to the UI", () => {
    const err = new CloudToolUnsupportedError("create_table");
    expect(err._tag).toBe("CloudToolUnsupportedError");
    expect(err.message).toContain("create_table");
    expect(err.message).toMatch(/cloud/i);
  });
});

describe("defaultCloudSourceDeps — production wiring", () => {
  it("provides a registry, config, and HTTP-client factory", () => {
    const deps = defaultCloudSourceDeps();
    expect(deps.registry).toBeDefined();
    expect(typeof deps.makeClient).toBe("function");
    expect(typeof deps.resolveWorkspaceId).toBe("function");
  });
});
