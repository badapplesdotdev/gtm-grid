import {
  Registry,
  type CloudClientLike,
  type Connector,
  type ConnectorMethod,
} from "@gtmgrid/engine";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CloudContext } from "./cloud-context.js";
import {
  CloudToolUnsupportedError,
  defaultCloudSourceDeps,
  makeCloudSource,
  registryWithExtensions,
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
  const queries: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: CloudClientLike = {
    query: async (ref, args) => {
      const name = String(ref);
      queries.push({ name, args });
      if (name === "/api/worker/getTable") {
        return {
          table: { workspaceId: "wks_1" },
          columns: grid.columns,
          rows: grid.rows,
          cells: grid.cells,
        };
      }
      if (name === "/api/worker/listTables") {
        // The project-wide list route returns tables with counts; echo a
        // two-table project so the test asserts the source returns ALL of them.
        return [
          { id: "t1", name: "Leads", columns: 2, rows: 5 },
          { id: "t2", name: "Accounts", columns: 1, rows: 0 },
        ];
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
      if (name === "/api/worker/createTable") {
        return { id: "t_new", name: args.name };
      }
      if (name === "/api/worker/createColumn") {
        return { id: "c_new", name: args.name, kind: args.kind };
      }
      if (name === "/api/worker/addRows") {
        const n = ((args.rows as unknown[]) ?? []).length;
        return { rowIds: Array.from({ length: n }, (_, i) => `r_new_${i}`) };
      }
      return null;
    },
    action: async () => null,
  };
  return { client, mutations, queries };
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

describe("makeCloudSource.listTables — PROJECT-WIDE list via the worker route (TRI-3299)", () => {
  it("returns ALL of the project's tables with counts, querying by projectId", async () => {
    const grid: FakeGrid = { columns: [], rows: [], cells: [] };
    const { deps, client } = depsFor(grid);
    const tables = await makeCloudSource(CTX, deps).listTables();
    expect(tables).toEqual([
      { id: "t1", name: "Leads", columns: 2, rows: 5 },
      { id: "t2", name: "Accounts", columns: 1, rows: 0 },
    ]);
    // Hits the project-scoped listTables route with the cloud projectId — not the
    // table-scoped getTable read.
    const listCall = client.queries.find(
      (q) => q.name === "/api/worker/listTables",
    );
    expect(listCall?.args).toEqual({ projectId: "proj_1" });
  });
});

describe("makeCloudSource.createTable — maps to the createTable worker route", () => {
  it("POSTs { projectId, name } and returns the new table id + name", async () => {
    const grid: FakeGrid = { columns: [], rows: [], cells: [] };
    const { deps, client } = depsFor(grid);
    const out = await makeCloudSource(CTX, deps).createTable("Prospects");
    expect(out).toEqual({ id: "t_new", name: "Prospects" });
    const call = client.mutations.find(
      (m) => m.name === "/api/worker/createTable",
    );
    expect(call?.args).toEqual({ projectId: "proj_1", name: "Prospects" });
  });
});

describe("makeCloudSource.addColumn — resolves fn/code to a kind, maps to createColumn", () => {
  it("a valid fn ('provider.method') becomes a function column", async () => {
    const grid: FakeGrid = { columns: [], rows: [], cells: [] };
    const { deps, client } = depsFor(grid);
    const out = await makeCloudSource(CTX, deps).addColumn("t1", {
      name: "Upper",
      fn: "test.upper",
    });
    expect(out).toEqual({ id: "c_new", name: "Upper", kind: "function", fn: "test.upper" });
    const call = client.mutations.find(
      (m) => m.name === "/api/worker/createColumn",
    );
    expect(call?.args).toMatchObject({
      tableId: "t1",
      name: "Upper",
      kind: "function",
      provider: "test",
      method: "upper",
    });
  });

  it("no fn/code becomes a manual column with null provider/method", async () => {
    const grid: FakeGrid = { columns: [], rows: [], cells: [] };
    const { deps, client } = depsFor(grid);
    const out = await makeCloudSource(CTX, deps).addColumn("t1", { name: "Notes" });
    expect(out.kind).toBe("manual");
    const call = client.mutations.find(
      (m) => m.name === "/api/worker/createColumn",
    );
    expect(call?.args).toMatchObject({ kind: "manual", provider: null, method: null });
  });

  it("forwards a formula column as provider:'formula'/method:'eval' with params.expression + trimmed condition", async () => {
    const grid: FakeGrid = { columns: [], rows: [], cells: [] };
    const { deps, client } = depsFor(grid);
    const out = await makeCloudSource(CTX, deps).addColumn("t1", {
      name: "Domain",
      formula: '{{Email}}.split("@")[1]',
      condition: "  !!{{Email}}  ",
    });
    expect(out).toEqual({ id: "c_new", name: "Domain", kind: "function", fn: "formula.eval" });
    const call = client.mutations.find(
      (m) => m.name === "/api/worker/createColumn",
    );
    expect(call?.args).toMatchObject({
      tableId: "t1",
      name: "Domain",
      kind: "function",
      provider: "formula",
      method: "eval",
      params: { expression: '{{Email}}.split("@")[1]' },
      // the run condition is forwarded trimmed (not raw with its padding)
      condition: "!!{{Email}}",
    });
  });

  it("rejects an unknown fn before any worker write", async () => {
    const grid: FakeGrid = { columns: [], rows: [], cells: [] };
    const { deps, client } = depsFor(grid);
    await expect(
      makeCloudSource(CTX, deps).addColumn("t1", { name: "X", fn: "nope.gone" }),
    ).rejects.toThrow(/Unknown function nope\.gone/);
    expect(
      client.mutations.some((m) => m.name === "/api/worker/createColumn"),
    ).toBe(false);
  });
});

describe("makeCloudSource.addRows — resolves column NAMES to ids, maps to addRows", () => {
  it("maps { ColumnName: value } rows to columnId-keyed rows and returns the count", async () => {
    const grid: FakeGrid = {
      columns: [
        { _id: "c1", tableId: "t1", name: "Username", type: "text", kind: "manual", provider: null, method: null, code: null, params: {}, position: 0, createdAt: 0 },
        { _id: "c2", tableId: "t1", name: "Email", type: "text", kind: "manual", provider: null, method: null, code: null, params: {}, position: 1, createdAt: 0 },
      ],
      rows: [],
      cells: [],
    };
    const { deps, client } = depsFor(grid);
    const out = await makeCloudSource(CTX, deps).addRows("t1", [
      { Username: "torvalds", Email: "lt@x.com" },
      { Username: "ada" },
    ]);
    expect(out).toEqual({ added: 2 });
    const call = client.mutations.find((m) => m.name === "/api/worker/addRows");
    expect(call?.args).toEqual({
      tableId: "t1",
      rows: [{ c1: "torvalds", c2: "lt@x.com" }, { c1: "ada" }],
    });
  });

  it("throws a clear error for an unknown column name (no worker write)", async () => {
    const grid: FakeGrid = {
      columns: [
        { _id: "c1", tableId: "t1", name: "Username", type: "text", kind: "manual", provider: null, method: null, code: null, params: {}, position: 0, createdAt: 0 },
      ],
      rows: [],
      cells: [],
    };
    const { deps, client } = depsFor(grid);
    await expect(
      makeCloudSource(CTX, deps).addRows("t1", [{ Nope: "x" }]),
    ).rejects.toThrow(/No column "Nope"/);
    expect(client.mutations.some((m) => m.name === "/api/worker/addRows")).toBe(false);
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

  // A 4-row grid with the input column filled and the function column empty, so
  // every row is an unfilled candidate. Rows are listed in grid (position) order.
  function fourUnfilledRows(): FakeGrid {
    return {
      columns: [
        { _id: "c1", tableId: "t1", name: "Username", type: "text", kind: "manual", provider: null, method: null, code: null, params: {}, position: 0, createdAt: 0 },
        { _id: "c2", tableId: "t1", name: "Upper", type: "text", kind: "function", provider: "test", method: "upper", code: null, params: { value: "{{Username}}" }, position: 1, createdAt: 0 },
      ],
      rows: [
        { _id: "r1", tableId: "t1", position: 0, createdAt: 0 },
        { _id: "r2", tableId: "t1", position: 1, createdAt: 0 },
        { _id: "r3", tableId: "t1", position: 2, createdAt: 0 },
        { _id: "r4", tableId: "t1", position: 3, createdAt: 0 },
      ],
      cells: [
        { rowId: "r1", columnId: "c1", value: "a", status: "done", error: null, updatedAt: 1 },
        { rowId: "r2", columnId: "c1", value: "b", status: "done", error: null, updatedAt: 1 },
        { rowId: "r3", columnId: "c1", value: "c", status: "done", error: null, updatedAt: 1 },
        { rowId: "r4", columnId: "c1", value: "d", status: "done", error: null, updatedAt: 1 },
      ],
    };
  }

  /** The set of row ids written for `columnId` across all cell-write mutations. */
  function rowsWritten(
    mutations: Array<{ name: string; args: Record<string, unknown> }>,
    columnId: string,
  ): Set<string> {
    const ids = new Set<string>();
    for (const m of mutations) {
      if (m.name === "/api/worker/setCell" || m.name === "/api/worker/setCellStatus") {
        if (m.args.columnId === columnId) ids.add(m.args.rowId as string);
      } else if (m.name === "/api/worker/setCells") {
        for (const c of (m.args.cells as Record<string, unknown>[]) ?? []) {
          if (c.columnId === columnId) ids.add(c.rowId as string);
        }
      }
    }
    return ids;
  }

  it("limit scopes the run to the first N unfilled rows IN GRID ORDER", async () => {
    const grid = fourUnfilledRows();
    const { deps, client } = depsFor(grid);
    const res = await makeCloudSource(CTX, deps).runColumn("t1", "Upper", { limit: 2 });
    expect(res).toEqual({ column: "Upper", ran: 2, errors: 0 });
    // Only the first two rows by position were enriched — not a random subset.
    expect([...rowsWritten(client.mutations, "c2")].sort()).toEqual(["r1", "r2"]);
  });

  it("offset + limit runs the NEXT slice (rows 3–4), so 'do the next N' is sequential", async () => {
    const grid = fourUnfilledRows();
    const { deps, client } = depsFor(grid);
    const res = await makeCloudSource(CTX, deps).runColumn("t1", "Upper", { limit: 2, offset: 2 });
    expect(res).toEqual({ column: "Upper", ran: 2, errors: 0 });
    expect([...rowsWritten(client.mutations, "c2")].sort()).toEqual(["r3", "r4"]);
  });

  it("no limit runs every pending row (unchanged behaviour)", async () => {
    const grid = fourUnfilledRows();
    const { deps, client } = depsFor(grid);
    const res = await makeCloudSource(CTX, deps).runColumn("t1", "Upper", {});
    expect(res.ran).toBe(4);
    expect(rowsWritten(client.mutations, "c2").size).toBe(4);
  });

  it("skips already-done cells when picking the next N (limit counts unfilled only)", async () => {
    const grid = fourUnfilledRows();
    // r1 + r2 are already done for the function column → the next 2 unfilled are r3, r4.
    grid.cells.push(
      { rowId: "r1", columnId: "c2", value: "A", status: "done", error: null, updatedAt: 1 },
      { rowId: "r2", columnId: "c2", value: "B", status: "done", error: null, updatedAt: 1 },
    );
    const { deps, client } = depsFor(grid);
    const res = await makeCloudSource(CTX, deps).runColumn("t1", "Upper", { limit: 2 });
    expect(res.ran).toBe(2);
    expect([...rowsWritten(client.mutations, "c2")].sort()).toEqual(["r3", "r4"]);
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

// Parity: the cloud agent must load the SAME JSON-manifest connectors the local
// agent does (engine `openProject`), so enrichment/social connectors like Trigify
// are available for `list_functions` / `run_column` in cloud mode — not just the
// built-ins. `registryWithExtensions` is the shared loader both paths use.
describe("registryWithExtensions — cloud == local connectors", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const trigifyManifest = readFileSync(
    join(repoRoot, "extensions/trigify.json"),
    "utf8",
  );

  it("loads a JSON-manifest extension (Trigify) on top of the built-ins", () => {
    const registry = registryWithExtensions([trigifyManifest]);
    const ids = registry.list().map((c) => c.id);
    // The built-ins are still present…
    expect(ids).toContain("ai");
    expect(ids).toContain("http");
    // …AND the Trigify connector + its methods are now dispatchable.
    expect(ids).toContain("trigify");
    expect(registry.method("trigify", "enrichProfile")).toBeDefined();
  });

  it("the default (no extensions) registry does NOT expose Trigify — proving the load is what adds it", () => {
    const registry = registryWithExtensions([]);
    expect(registry.list().map((c) => c.id)).not.toContain("trigify");
  });

  it("skips a malformed manifest without dropping the valid ones", () => {
    const registry = registryWithExtensions(["{ not valid json", trigifyManifest]);
    expect(registry.list().map((c) => c.id)).toContain("trigify");
  });
});
