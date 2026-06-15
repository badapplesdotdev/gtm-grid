/**
 * Formula columns + conditional-run gate.
 *
 *   1. compileExpression: {{Column}} → typed inputs[...] lookups, and library detection.
 *   2. runFunction + a formula prelude: lodash / moment / FormulaJS evaluate in the sandbox.
 *   3. Engine.runColumn end-to-end over a real temp SQLite DB: formula columns produce
 *      typed values; an "only run if" condition skips rows WITHOUT dispatching (proving
 *      no credits are spent), and a throwing condition surfaces as a cell error.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "./db.js";
import { Engine } from "./execute.js";
import { buildFormulaPrelude, compileExpression, detectLibs } from "./formula.js";
import { defaultRegistry, Registry } from "./registry.js";
import { runFunction } from "./sandbox.js";
import type { Connector, ConnectorMethod } from "./types.js";

const noopDispatch = async () => null;

describe("compileExpression", () => {
  it("substitutes {{Column}} with a typed inputs[...] lookup", () => {
    const { body } = compileExpression('{{Email}}.split("@")[1]');
    expect(body).toContain('inputs["Email"].split("@")[1]');
    expect(body.startsWith("function(inputs, sdk){")).toBe(true);
  });

  it("trims whitespace inside the braces and handles multiple refs", () => {
    const { body } = compileExpression("{{ First Name }} + ' ' + {{Last Name}}");
    expect(body).toContain('inputs["First Name"] + \' \' + inputs["Last Name"]');
  });

  it("yields null for an empty expression rather than a syntax error", () => {
    expect(compileExpression("   ").body).toContain("return (null)");
  });

  it("detects which helper libraries an expression uses", () => {
    expect([...detectLibs("{{A}} + 1")]).toEqual([]);
    expect(detectLibs("_.startCase({{Name}})").has("lodash")).toBe(true);
    expect(detectLibs('moment({{D}}).format("YYYY")').has("moment")).toBe(true);
    expect(detectLibs("SUM({{A}}, {{B}})").has("formulajs")).toBe(true);
    // A bare underscore inside an identifier is NOT lodash.
    expect(detectLibs("{{my_value}} + 1").has("lodash")).toBe(false);
    // JSON.* is not a FormulaJS call.
    expect(detectLibs("JSON.parse({{X}})").has("formulajs")).toBe(false);
  });
});

describe("runFunction with a formula prelude (real QuickJS sandbox)", () => {
  const run = (expr: string) => {
    const { body, libs } = compileExpression(expr);
    return runFunction({
      code: body,
      inputs: {},
      providers: {},
      dispatch: noopDispatch,
      prelude: buildFormulaPrelude(libs),
    });
  };

  it("evaluates plain JS with no libraries", async () => {
    expect(await run('"ada@acme.com".split("@")[1]')).toBe("acme.com");
  });

  it("injects lodash on demand", async () => {
    expect(await run("_.chunk([1,2,3,4], 2)")).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("injects moment on demand", async () => {
    expect(await run('moment("2020-01-02").format("YYYY/MM/DD")')).toBe("2020/01/02");
  });

  it("injects FormulaJS and exposes functions as bare names", async () => {
    expect(await run("SUM(1, 2, 3)")).toBe(6);
    expect(await run('UPPER("hello")')).toBe("HELLO");
  });
});

describe("Engine.runColumn — formula + conditional gate (temp SQLite DB)", () => {
  let dir: string;
  let db: Db;

  /** A registry whose single connector records each dispatch (to prove skip = no run). */
  let dispatched: Array<Record<string, unknown>>;
  const spyRegistry = (): Registry => {
    dispatched = [];
    const method: ConnectorMethod = {
      id: "run",
      label: "Spy",
      description: "Records its input and echoes it back.",
      inputSchema: {},
      batchSize: 1,
      credits: 1,
      run: async (inputs) => {
        dispatched.push(inputs);
        return { text: "ran" };
      },
    };
    const connector: Connector = { id: "spy", name: "Spy", category: "test", auth: null, methods: [method] };
    return new Registry([connector]);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "formula-test-"));
    db = new Db(join(dir, "project.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const formulaCol = (tableId: string, name: string, expression: string, type = "text") =>
    db.createColumn({
      tableId,
      name,
      type: type as never,
      kind: "function",
      provider: "formula",
      method: "eval",
      params: { expression },
    });

  it("evaluates a formula over typed row values", async () => {
    const table = db.createTable("Leads");
    const email = db.createColumn({ tableId: table.id, name: "Email", kind: "manual" });
    const domain = formulaCol(table.id, "Domain", '{{Email}}.split("@")[1]');
    const r1 = db.createRow(table.id);
    const r2 = db.createRow(table.id);
    db.setCell(r1.id, email.id, { value: "ada@acme.com", status: "done" });
    db.setCell(r2.id, email.id, { value: "grace@navy.mil", status: "done" });

    const engine = new Engine(db, {}, defaultRegistry());
    const res = await engine.runColumn(domain.id);

    expect(res).toEqual({ ran: 2, errors: 0 });
    expect(db.getCell(r1.id, domain.id)?.value).toBe("acme.com");
    expect(db.getCell(r2.id, domain.id)?.value).toBe("navy.mil");
  });

  it("preserves value types — a number column stays a number", async () => {
    const table = db.createTable("Scores");
    const score = db.createColumn({ tableId: table.id, name: "Score", type: "number", kind: "manual" });
    const next = formulaCol(table.id, "Next", "{{Score}} + 1", "number");
    const row = db.createRow(table.id);
    db.setCell(row.id, score.id, { value: 41, status: "done" });

    await new Engine(db, {}, defaultRegistry()).runColumn(next.id);
    expect(db.getCell(row.id, next.id)?.value).toBe(42);
  });

  it("evaluates a formula using a helper library (FormulaJS)", async () => {
    const table = db.createTable("Math");
    const a = db.createColumn({ tableId: table.id, name: "A", type: "number", kind: "manual" });
    const b = db.createColumn({ tableId: table.id, name: "B", type: "number", kind: "manual" });
    const sum = formulaCol(table.id, "Sum", "SUM({{A}}, {{B}})", "number");
    const row = db.createRow(table.id);
    db.setCell(row.id, a.id, { value: 2, status: "done" });
    db.setCell(row.id, b.id, { value: 3, status: "done" });

    await new Engine(db, {}, defaultRegistry()).runColumn(sum.id);
    expect(db.getCell(row.id, sum.id)?.value).toBe(5);
  });

  it("conditional-run skips falsy rows WITHOUT dispatching (saves credits)", async () => {
    const table = db.createTable("People");
    const email = db.createColumn({ tableId: table.id, name: "Email", kind: "manual" });
    const enrich = db.createColumn({
      tableId: table.id,
      name: "Enriched",
      kind: "function",
      provider: "spy",
      method: "run",
      params: { value: "{{Email}}" },
      condition: "Boolean({{Email}})", // only run if Email is present
    });
    const r1 = db.createRow(table.id); // has email → runs
    const r2 = db.createRow(table.id); // no email → skipped
    db.setCell(r1.id, email.id, { value: "ada@acme.com", status: "done" });

    const engine = new Engine(db, {}, spyRegistry());
    const res = await engine.runColumn(enrich.id);

    expect(res).toEqual({ ran: 1, errors: 0 });
    expect(dispatched).toHaveLength(1); // the gated-off row never reached the connector
    expect(db.getCell(r1.id, enrich.id)?.status).toBe("done");
    expect(db.getCell(r2.id, enrich.id)?.status ?? "empty").toBe("empty");
    expect(db.getCell(r2.id, enrich.id)?.value ?? null).toBeNull();
    // The gated-off cell carries a "Run condition not met" note so the grid can explain the blank.
    expect(db.getCell(r2.id, enrich.id)?.error).toBe("Run condition not met");
  });

  it("marks a cell error (not a silent skip) when the condition throws", async () => {
    const table = db.createTable("T");
    const out = db.createColumn({
      tableId: table.id,
      name: "Out",
      kind: "function",
      provider: "spy",
      method: "run",
      params: {},
      condition: "nope.alsoNope", // ReferenceError at eval time
    });
    const row = db.createRow(table.id);

    const engine = new Engine(db, {}, spyRegistry());
    const res = await engine.runColumn(out.id);

    expect(res).toMatchObject({ ran: 0, errors: 1 });
    expect(dispatched).toHaveLength(0);
    const cell = db.getCell(row.id, out.id);
    expect(cell?.status).toBe("error");
    expect(cell?.error).toContain("condition:");
  });
});
