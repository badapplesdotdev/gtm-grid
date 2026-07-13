/**
 * Formula columns + conditional-run gate.
 *
 *   1. compileExpression: {{Column}} → typed inputs[...] lookups, and library detection.
 *   2. runFunction + a formula prelude: lodash / moment / FormulaJS evaluate in the sandbox.
 *   3. Engine.runColumn end-to-end over a real temp SQLite DB: formula columns produce
 *      typed values; an "only run if" condition skips rows WITHOUT dispatching (proving
 *      no credits are spent), and a throwing condition surfaces as a cell error.
 */

import { describe, expect, it } from "vitest";
import { Engine } from "./execute.js";
import { buildFormulaPrelude, compileExpression, detectLibs } from "./formula.js";
import { defaultRegistry, Registry } from "./registry.js";
import { runFunction } from "./sandbox.js";
import { makeMemoryStore, type MemoryStore } from "./test-helpers.js";
import type { Connector, ConnectorMethod } from "./types.js";

let colSeq = 0;
const nextColId = () => `col${colSeq++}`;

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

describe("Engine.runColumn — formula + conditional gate (in-memory store)", () => {
  let store: MemoryStore;

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

  const manualCol = (name: string, type = "text") =>
    store.addColumn({ id: nextColId(), table_id: "t", name, type: type as never, kind: "manual" });
  const formulaCol = (name: string, expression: string, type = "text", condition?: string) =>
    store.addColumn({
      id: nextColId(),
      table_id: "t",
      name,
      type: type as never,
      kind: "function",
      provider: "formula",
      method: "eval",
      params: { expression },
      ...(condition ? { condition } : {}),
    });

  it("evaluates a formula over typed row values", async () => {
    store = makeMemoryStore();
    const email = manualCol("Email");
    const domain = formulaCol("Domain", '{{Email}}.split("@")[1]');
    store.addRow({ id: "r1", table_id: "t" });
    store.addRow({ id: "r2", table_id: "t" });
    store.setCellSync("r1", email.id, { value: "ada@acme.com", status: "done" });
    store.setCellSync("r2", email.id, { value: "grace@navy.mil", status: "done" });

    const engine = new Engine({}, defaultRegistry(), { store, creds: store });
    const res = await engine.runColumn(domain.id);

    expect(res).toEqual({ ran: 2, errors: 0 });
    expect(store.readCell("r1", domain.id)?.value).toBe("acme.com");
    expect(store.readCell("r2", domain.id)?.value).toBe("navy.mil");
  });

  it("preserves value types — a number column stays a number", async () => {
    store = makeMemoryStore();
    const score = manualCol("Score", "number");
    const next = formulaCol("Next", "{{Score}} + 1", "number");
    store.addRow({ id: "r", table_id: "t" });
    store.setCellSync("r", score.id, { value: 41, status: "done" });

    await new Engine({}, defaultRegistry(), { store, creds: store }).runColumn(next.id);
    expect(store.readCell("r", next.id)?.value).toBe(42);
  });

  it("evaluates a formula using a helper library (FormulaJS)", async () => {
    store = makeMemoryStore();
    const a = manualCol("A", "number");
    const b = manualCol("B", "number");
    const sum = formulaCol("Sum", "SUM({{A}}, {{B}})", "number");
    store.addRow({ id: "r", table_id: "t" });
    store.setCellSync("r", a.id, { value: 2, status: "done" });
    store.setCellSync("r", b.id, { value: 3, status: "done" });

    await new Engine({}, defaultRegistry(), { store, creds: store }).runColumn(sum.id);
    expect(store.readCell("r", sum.id)?.value).toBe(5);
  });

  it("conditional-run skips falsy rows WITHOUT dispatching (saves credits)", async () => {
    store = makeMemoryStore();
    const email = manualCol("Email");
    const enrich = store.addColumn({
      id: nextColId(),
      table_id: "t",
      name: "Enriched",
      kind: "function",
      provider: "spy",
      method: "run",
      params: { value: "{{Email}}" },
      condition: "Boolean({{Email}})", // only run if Email is present
    });
    store.addRow({ id: "r1", table_id: "t" }); // has email → runs
    store.addRow({ id: "r2", table_id: "t" }); // no email → skipped
    store.setCellSync("r1", email.id, { value: "ada@acme.com", status: "done" });

    const engine = new Engine({}, spyRegistry(), { store, creds: store });
    const res = await engine.runColumn(enrich.id);

    expect(res).toEqual({ ran: 1, errors: 0 });
    expect(dispatched).toHaveLength(1); // the gated-off row never reached the connector
    expect(store.readCell("r1", enrich.id)?.status).toBe("done");
    expect(store.readCell("r2", enrich.id)?.status ?? "empty").toBe("empty");
    expect(store.readCell("r2", enrich.id)?.value ?? null).toBeNull();
    // The gated-off cell carries a "Run condition not met" note so the grid can explain the blank.
    expect(store.readCell("r2", enrich.id)?.error).toBe("Run condition not met");
  });

  it("marks a cell error (not a silent skip) when the condition throws", async () => {
    store = makeMemoryStore();
    const out = store.addColumn({
      id: nextColId(),
      table_id: "t",
      name: "Out",
      kind: "function",
      provider: "spy",
      method: "run",
      params: {},
      condition: "nope.alsoNope", // ReferenceError at eval time
    });
    store.addRow({ id: "r", table_id: "t" });

    const engine = new Engine({}, spyRegistry(), { store, creds: store });
    const res = await engine.runColumn(out.id);

    expect(res).toMatchObject({ ran: 0, errors: 1 });
    expect(dispatched).toHaveLength(0);
    const cell = store.readCell("r", out.id);
    expect(cell?.status).toBe("error");
    expect(cell?.error).toContain("condition:");
  });
});
