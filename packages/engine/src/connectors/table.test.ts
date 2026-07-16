// The `table` connector (push/lookup) — the cross-table semantics. Push is
// WEBHOOK-STYLE (v2): the whole source row is delivered server-side by rowId
// through the target's push connection (mapping lives on the TARGET), so the
// connector's job is target/key validation + the pushRow gateway call. Covers
// upsert vs append, the empty-key guard, self-push rejection, the no-row-
// context guard, and lookup's matching/canonicalization (trim, case,
// number-vs-string) + first/all/count/notFound shapes. Ends with end-to-end
// Engine.runColumn runs proving the row context (AsyncLocalStorage) and
// {{Column}} templates reach the gateway via ctx.

import { describe, expect, it, vi } from "vitest";
import { Engine } from "../execute.js";
import { defaultRegistry } from "../registry.js";
import { makeMemoryStore } from "../test-helpers.js";
import type {
  GatewayPushInput,
  GatewayRow,
  GatewayTableSchema,
  GatewayUpsertInput,
  TableGateway,
} from "../table-gateway.js";
import { tableConnector } from "./table.js";
import type { ConnectorMethod, MethodContext } from "../types.js";

const method = (id: "push" | "lookup"): ConnectorMethod => {
  const m = tableConnector.methods.find((x) => x.id === id);
  if (!m) throw new Error(`table.${id} not found`);
  return m;
};

const ACCOUNTS: GatewayTableSchema = {
  id: "t-accounts",
  name: "Accounts",
  columns: [
    { id: "col-domain", name: "Domain", type: "text", kind: "manual" },
    { id: "col-owner", name: "Owner", type: "text", kind: "manual" },
    { id: "col-score", name: "Score", type: "number", kind: "manual" },
    { id: "col-enrich", name: "Enriched", type: "json", kind: "function" },
  ],
};

interface FakeGateway extends TableGateway {
  upserts: GatewayUpsertInput[];
  pushes: GatewayPushInput[];
  createdColumns: { tableId: string; name: string }[];
}

function makeGateway(
  opts: {
    schema?: GatewayTableSchema | undefined;
    rows?: GatewayRow[];
    sourceTableId?: string;
    upsertResult?: { rowId: string; created: boolean };
  } = {},
): FakeGateway {
  const upserts: GatewayUpsertInput[] = [];
  const pushes: GatewayPushInput[] = [];
  const createdColumns: { tableId: string; name: string }[] = [];
  let extraColumns = 0;
  return {
    sourceTableId: opts.sourceTableId,
    upserts,
    pushes,
    createdColumns,
    async listTables() {
      return opts.schema ? [{ id: opts.schema.id, name: opts.schema.name }] : [];
    },
    async getSchema(ref: string) {
      const schema = "schema" in opts ? opts.schema : ACCOUNTS;
      if (!schema) return undefined;
      // Freshly created columns become part of the schema (mirrors the real
      // gateway's cache invalidation after createColumn).
      const created = createdColumns.map((c, i) => ({
        id: `col-new-${i}`,
        name: c.name,
        type: "text" as const,
        kind: "manual" as const,
      }));
      return ref === schema.id || ref === schema.name
        ? { ...schema, columns: [...schema.columns, ...created] }
        : undefined;
    },
    async readRows() {
      return opts.rows ?? [];
    },
    async upsertRow(input: GatewayUpsertInput) {
      upserts.push(input);
      return opts.upsertResult ?? { rowId: "row-new", created: true };
    },
    async pushRow(input: GatewayPushInput) {
      pushes.push(input);
      return opts.upsertResult ?? { rowId: "row-new", created: true };
    },
    async createColumn(tableId: string, name: string) {
      createdColumns.push({ tableId, name });
      return { id: `col-new-${extraColumns++}` };
    },
  };
}

const ctxWith = (
  grid: TableGateway | undefined,
  // Default: a plausible row context; pass `null` explicitly for "no row".
  row: { rowId: string; tableId: string; columnId: string } | null = { rowId: "src-row-1", tableId: "t-leads", columnId: "c-push" },
): MethodContext => ({ secrets: {}, grid, ...(row === null ? {} : { row }) });

describe("table.push (webhook-style v2)", () => {
  it("delivers the CURRENT row by id with the resolved key, reports 'created'", async () => {
    const gw = makeGateway();
    const result = await method("push").run(
      { targetTable: "Accounts", keyColumn: "Domain", keyValue: "acme.com" },
      ctxWith(gw),
    );

    expect(result).toEqual({ table: "Accounts", tableId: "t-accounts", rowId: "row-new", action: "created" });
    expect(gw.pushes).toEqual([
      {
        tableId: "t-accounts",
        sourceRowId: "src-row-1",
        sourceColumnId: "c-push",
        mode: "upsert",
        keyColumnName: "Domain",
        keyValue: "acme.com",
        autoRunTarget: false,
      },
    ]);
  });

  it("reports 'updated' when the push matched an existing row", async () => {
    const gw = makeGateway({ upsertResult: { rowId: "row-7", created: false } });
    const result = (await method("push").run(
      { targetTable: "Accounts", keyColumn: "Domain", keyValue: "acme.com" },
      ctxWith(gw),
    )) as { action: string };
    expect(result.action).toBe("updated");
  });

  it("errors on an EMPTY upsert key instead of inserting a keyless duplicate", async () => {
    const gw = makeGateway();
    await expect(
      method("push").run(
        { targetTable: "Accounts", keyColumn: "Domain", keyValue: "   " },
        ctxWith(gw),
      ),
    ).rejects.toThrow(/key resolved empty/);
    expect(gw.pushes).toHaveLength(0);
  });

  it("upsert mode requires a key column; unknown or function key columns error", async () => {
    const gw = makeGateway();
    await expect(
      method("push").run({ targetTable: "Accounts" }, ctxWith(gw)),
    ).rejects.toThrow(/requires 'keyColumn'/);
    await expect(
      method("push").run(
        { targetTable: "Accounts", keyColumn: "Ghost", keyValue: "x" },
        ctxWith(gw),
      ),
    ).rejects.toThrow(/"Ghost" does not exist/);
    await expect(
      method("push").run(
        { targetTable: "Accounts", keyColumn: "Enriched", keyValue: "x" },
        ctxWith(gw),
      ),
    ).rejects.toThrow(/function column/);
  });

  it("append mode pushes with no key", async () => {
    const gw = makeGateway();
    await method("push").run(
      { targetTable: "Accounts", mode: "append", keyValue: "" },
      ctxWith(gw),
    );
    expect(gw.pushes[0]).toMatchObject({ mode: "append", keyColumnName: null });
  });

  it("rejects pushing into the run's own table (self-push, both guards)", async () => {
    // Guard 1: the gateway's source table matches the target.
    const gw1 = makeGateway({ sourceTableId: "t-accounts" });
    await expect(
      method("push").run(
        { targetTable: "Accounts", keyColumn: "Domain", keyValue: "a.com" },
        ctxWith(gw1),
      ),
    ).rejects.toThrow(/own table/);
    // Guard 2: the row context's table matches the target.
    const gw2 = makeGateway();
    await expect(
      method("push").run(
        { targetTable: "Accounts", keyColumn: "Domain", keyValue: "a.com" },
        ctxWith(gw2, { rowId: "r1", tableId: "t-accounts", columnId: "c-push" }),
      ),
    ).rejects.toThrow(/own table/);
  });

  it("errors with a human message when the target table is gone", async () => {
    const gw = makeGateway({ schema: undefined });
    await expect(
      method("push").run(
        { targetTable: "Deleted Table", keyColumn: "Domain", keyValue: "a.com" },
        ctxWith(gw),
      ),
    ).rejects.toThrow(/not found — was it renamed or deleted/);
  });

  it("errors clearly WITHOUT a row context (standalone dispatch)", async () => {
    const gw = makeGateway();
    await expect(
      method("push").run(
        { targetTable: "Accounts", mode: "append" },
        ctxWith(gw, null),
      ),
    ).rejects.toThrow(/no source row in context/);
  });

  it("passes autoRunTarget through to the gateway", async () => {
    const gw = makeGateway();
    await method("push").run(
      { targetTable: "Accounts", mode: "append", autoRunTarget: true },
      ctxWith(gw),
    );
    expect(gw.pushes[0].autoRunTarget).toBe(true);
  });

  it("fails with a clear error when no gateway is wired", async () => {
    await expect(
      method("push").run({ targetTable: "Accounts" }, ctxWith(undefined)),
    ).rejects.toThrow(/cross-table access is not available/);
  });
});

describe("table.lookup", () => {
  const ROWS: GatewayRow[] = [
    { rowId: "r1", cells: { Domain: "acme.com", Owner: "max", Score: 42 } },
    { rowId: "r2", cells: { Domain: "  Globex.com ", Owner: "sam", Score: 7 } },
    { rowId: "r3", cells: { Domain: "acme.com", Owner: "kim", Score: 9 } },
    { rowId: "r4", cells: { Owner: "empty-domain" } },
  ];

  it("returns the FIRST match with requested columns plus _rowId", async () => {
    const gw = makeGateway({ rows: ROWS });
    const result = await method("lookup").run(
      { targetTable: "Accounts", matchColumn: "Domain", matchValue: "acme.com", return: ["Owner"] },
      ctxWith(gw),
    );
    expect(result).toEqual({ Owner: "max", _rowId: "r1" });
  });

  it("returns ALL columns when 'return' is omitted", async () => {
    const gw = makeGateway({ rows: ROWS });
    const result = (await method("lookup").run(
      { targetTable: "Accounts", matchColumn: "Domain", matchValue: "acme.com" },
      ctxWith(gw),
    )) as Record<string, unknown>;
    expect(result).toEqual({ Domain: "acme.com", Owner: "max", Score: 42, Enriched: null, _rowId: "r1" });
  });

  it("multiple: 'all' returns every match; 'count' returns the number", async () => {
    const gw = makeGateway({ rows: ROWS });
    const all = (await method("lookup").run(
      { targetTable: "Accounts", matchColumn: "Domain", matchValue: "acme.com", multiple: "all", return: ["Owner"] },
      ctxWith(gw),
    )) as unknown[];
    expect(all).toEqual([
      { Owner: "max", _rowId: "r1" },
      { Owner: "kim", _rowId: "r3" },
    ]);

    await expect(
      method("lookup").run(
        { targetTable: "Accounts", matchColumn: "Domain", matchValue: "acme.com", multiple: "count" },
        ctxWith(gw),
      ),
    ).resolves.toBe(2);
  });

  it("trims and (optionally) lowercases string matches", async () => {
    const gw = makeGateway({ rows: ROWS });
    await expect(
      method("lookup").run(
        { targetTable: "Accounts", matchColumn: "Domain", matchValue: "globex.com", return: ["Owner"] },
        ctxWith(gw),
      ),
    ).resolves.toBeNull(); // case differs, sensitive by default

    await expect(
      method("lookup").run(
        {
          targetTable: "Accounts",
          matchColumn: "Domain",
          matchValue: "globex.com",
          caseInsensitive: true,
          return: ["Owner"],
        },
        ctxWith(gw),
      ),
    ).resolves.toEqual({ Owner: "sam", _rowId: "r2" });
  });

  it("matches a numeric cell against its string form (CSV-imported keys)", async () => {
    const gw = makeGateway({ rows: ROWS });
    await expect(
      method("lookup").run(
        { targetTable: "Accounts", matchColumn: "Score", matchValue: "42", return: ["Owner"] },
        ctxWith(gw),
      ),
    ).resolves.toEqual({ Owner: "max", _rowId: "r1" });
  });

  it("an EMPTY probe never matches rows with empty cells", async () => {
    const gw = makeGateway({ rows: ROWS });
    await expect(
      method("lookup").run(
        { targetTable: "Accounts", matchColumn: "Domain", matchValue: "", return: ["Owner"] },
        ctxWith(gw),
      ),
    ).resolves.toBeNull();
  });

  it("no match → null by default, [] for all, 0 for count, throw for notFound:'error'", async () => {
    const gw = makeGateway({ rows: ROWS });
    const base = { targetTable: "Accounts", matchColumn: "Domain", matchValue: "nope.com" };
    await expect(method("lookup").run({ ...base }, ctxWith(gw))).resolves.toBeNull();
    await expect(method("lookup").run({ ...base, multiple: "all" }, ctxWith(gw))).resolves.toEqual([]);
    await expect(method("lookup").run({ ...base, multiple: "count" }, ctxWith(gw))).resolves.toBe(0);
    await expect(method("lookup").run({ ...base, notFound: "error" }, ctxWith(gw))).rejects.toThrow(
      /no row in "Accounts"/,
    );
  });

  it("errors when the match column does not exist", async () => {
    const gw = makeGateway({ rows: ROWS });
    await expect(
      method("lookup").run(
        { targetTable: "Accounts", matchColumn: "Ghost", matchValue: "x" },
        ctxWith(gw),
      ),
    ).rejects.toThrow(/"Ghost" does not exist/);
  });
});

describe("end-to-end: Engine.runColumn with a table.push column", () => {
  it("threads the ROW CONTEXT (AsyncLocalStorage) and {{Column}} key template to the gateway", async () => {
    const store = makeMemoryStore();
    store.addColumn({ id: "c-email", table_id: "t1", name: "Email" });
    const pushCol = store.addColumn({
      id: "c-push",
      table_id: "t1",
      name: "Push to Accounts",
      kind: "function",
      provider: "table",
      method: "push",
      params: {
        targetTable: "Accounts",
        keyColumn: "Domain",
        keyValue: "{{Email}}",
      },
    });
    store.addRow({ id: "r1", table_id: "t1" });
    store.addRow({ id: "r2", table_id: "t1" });
    store.setCellSync("r1", "c-email", { value: "a@acme.com", status: "done" });
    store.setCellSync("r2", "c-email", { value: "b@globex.com", status: "done" });

    const gw = makeGateway({ sourceTableId: "t1" });
    const engine = new Engine({ grid: gw }, defaultRegistry(), { store, creds: store });
    const result = await engine.runColumn(pushCol.id);

    expect(result).toEqual({ ran: 2, errors: 0 });
    // Each concurrent row's dispatch saw ITS OWN row id (no context bleed).
    const byKey = new Map(gw.pushes.map((p) => [p.keyValue, p.sourceRowId]));
    expect(byKey.get("a@acme.com")).toBe("r1");
    expect(byKey.get("b@globex.com")).toBe("r2");
    expect(gw.pushes.every((p) => p.tableId === "t-accounts" && p.mode === "upsert")).toBe(true);
    const cell = store.readCell("r1", "c-push");
    expect(cell?.status).toBe("done");
    expect(cell?.value).toMatchObject({ action: "created", rowId: "row-new" });
  });

  it("a lookup column feeds a run condition-free chain and stores the matched object", async () => {
    const store = makeMemoryStore();
    store.addColumn({ id: "c-email", table_id: "t1", name: "Email" });
    const lookupCol = store.addColumn({
      id: "c-lookup",
      table_id: "t1",
      name: "Account",
      kind: "function",
      provider: "table",
      method: "lookup",
      params: {
        targetTable: "Accounts",
        matchColumn: "Domain",
        matchValue: "{{Email}}",
        return: ["Owner"],
      },
    });
    store.addRow({ id: "r1", table_id: "t1" });
    store.setCellSync("r1", "c-email", { value: "acme.com", status: "done" });

    const gw = makeGateway({
      sourceTableId: "t1",
      rows: [{ rowId: "x1", cells: { Domain: "acme.com", Owner: "max" } }],
    });
    const engine = new Engine({ grid: gw }, defaultRegistry(), { store, creds: store });
    await engine.runColumn(lookupCol.id);

    expect(store.readCell("r1", "c-lookup")?.value).toEqual({ Owner: "max", _rowId: "x1" });
  });

  it("a missing gateway surfaces as a per-cell error, not a crashed run", async () => {
    const store = makeMemoryStore();
    store.addColumn({ id: "c-email", table_id: "t1", name: "Email" });
    const pushCol = store.addColumn({
      id: "c-push",
      table_id: "t1",
      name: "Push",
      kind: "function",
      provider: "table",
      method: "push",
      params: { targetTable: "Accounts", mode: "append" },
    });
    store.addRow({ id: "r1", table_id: "t1" });

    const engine = new Engine({}, defaultRegistry(), { store, creds: store });
    const result = await engine.runColumn(pushCol.id);

    expect(result.ran).toBe(0);
    expect(result.errors).toBe(1);
    expect(store.readCell("r1", "c-push")?.error).toMatch(/cross-table access is not available/);
  });
});
