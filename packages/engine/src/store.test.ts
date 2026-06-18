/**
 * GridStore + engine-over-injected-store tests.
 *
 * The engine is always cloud-store-backed: it reads/writes grid data through an
 * injected {@link GridStoreShape}, never a concrete `Db`. These tests prove the
 * `runColumn` behaviour (status/value/error, skip-done, rowIds scope, credential
 * resolution, typed-error propagation) end-to-end over an in-memory
 * {@link makeMemoryStore} double — the same run path the real cloud store drives.
 */

import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { Engine } from "./execute.js";
import { Registry } from "./registry.js";
import { GridStore, CredentialStore, GridStoreError, type GridStoreShape } from "./store.js";
import { makeMemoryStore } from "./test-helpers.js";
import type { ConnectorMethod, Connector, Credential } from "./types.js";

/** A registry whose single connector echoes its input back (no network/AI). */
const echoRegistry = (): Registry => {
  const method: ConnectorMethod = {
    id: "echo",
    label: "Echo",
    description: "Returns { text } from the input.",
    inputSchema: {},
    batchSize: 1,
    credits: 0,
    run: async (inputs) => ({ text: String(inputs.value ?? "") }),
  };
  const connector: Connector = {
    id: "test",
    name: "Test",
    category: "test",
    auth: null,
    methods: [method],
  };
  return new Registry([connector]);
};

const cred = (apiKey: string): Credential => ({
  id: "c",
  extension_id: "test",
  scope: "local",
  name: "k",
  secrets: { apiKey },
  created_at: 0,
});

describe("Engine.runColumn over an injected in-memory store", () => {
  it("writes done cells with the simplified value for a custom-code column", async () => {
    const store = makeMemoryStore();
    store.addColumn({ id: "name", table_id: "t", name: "Name", kind: "manual" });
    store.addColumn({
      id: "upper",
      table_id: "t",
      name: "Upper",
      kind: "function",
      code: "function(inputs, sdk){ return { text: String(inputs.name).toUpperCase() }; }",
      params: { name: "{{Name}}" },
    });
    store.addRow({ id: "r1", table_id: "t" });
    store.addRow({ id: "r2", table_id: "t" });
    store.setCellSync("r1", "name", { value: "ada", status: "done" });
    store.setCellSync("r2", "name", { value: "grace", status: "done" });

    const engine = new Engine({}, echoRegistry(), { store, creds: store });
    const res = await engine.runColumn("upper");

    expect(res).toEqual({ ran: 2, errors: 0 });
    // simplify() unwraps a sole { text } result to the plain string.
    expect(store.readCell("r1", "upper")?.value).toBe("ADA");
    expect(store.readCell("r1", "upper")?.status).toBe("done");
    expect(store.readCell("r1", "upper")?.error).toBeNull();
    expect(store.readCell("r2", "upper")?.value).toBe("GRACE");
    expect(store.readCell("r2", "upper")?.status).toBe("done");
  });

  it("dispatches a connector call, resolving the credential through the store", async () => {
    const store = makeMemoryStore();
    store.addColumn({ id: "input", table_id: "t", name: "Input", kind: "manual" });
    store.addColumn({
      id: "out",
      table_id: "t",
      name: "Out",
      kind: "function",
      provider: "test",
      method: "echo",
      params: { value: "{{Input}}" },
    });
    store.addRow({ id: "r", table_id: "t" });
    store.setCellSync("r", "input", { value: "hello", status: "done" });

    const engine = new Engine({}, echoRegistry(), { store, creds: store });
    const res = await engine.runColumn("out");

    expect(res).toEqual({ ran: 1, errors: 0 });
    expect(store.readCell("r", "out")?.value).toBe("hello");
    expect(store.readCell("r", "out")?.status).toBe("done");
  });

  it("records error status + message when the column body throws", async () => {
    const store = makeMemoryStore();
    store.addColumn({
      id: "bad",
      table_id: "t",
      name: "Bad",
      kind: "function",
      code: "function(inputs, sdk){ throw new Error('boom'); }",
      params: {},
    });
    store.addRow({ id: "r", table_id: "t" });

    const engine = new Engine({}, echoRegistry(), { store, creds: store });
    const res = await engine.runColumn("bad");

    expect(res).toMatchObject({ ran: 0, errors: 1 });
    // The first error message is RETURNED (so the MCP run_column tool can tell the
    // user why a run failed without a follow-up get_table read).
    expect(res.firstError).toContain("boom");
    const cell = store.readCell("r", "bad");
    expect(cell?.status).toBe("error");
    expect(cell?.error).toContain("boom");
    expect(cell?.value ?? null).toBeNull();
  });

  it("skips already-done cells unless force is set", async () => {
    const store = makeMemoryStore();
    store.addColumn({
      id: "c",
      table_id: "t",
      name: "C",
      kind: "function",
      code: "function(inputs, sdk){ return { text: 'fresh' }; }",
      params: {},
    });
    store.addRow({ id: "r", table_id: "t" });
    store.setCellSync("r", "c", { value: "stale", status: "done" });

    const engine = new Engine({}, echoRegistry(), { store, creds: store });

    const skipped = await engine.runColumn("c");
    expect(skipped).toEqual({ ran: 0, errors: 0 });
    expect(store.readCell("r", "c")?.value).toBe("stale");

    const forced = await engine.runColumn("c", { force: true });
    expect(forced).toEqual({ ran: 1, errors: 0 });
    expect(store.readCell("r", "c")?.value).toBe("fresh");
  });

  it("honours an explicit rowIds subset", async () => {
    const store = makeMemoryStore();
    store.addColumn({
      id: "c",
      table_id: "t",
      name: "C",
      kind: "function",
      code: "function(inputs, sdk){ return { text: 'x' }; }",
      params: {},
    });
    store.addRow({ id: "r1", table_id: "t" });
    store.addRow({ id: "r2", table_id: "t" });

    const engine = new Engine({}, echoRegistry(), { store, creds: store });
    const res = await engine.runColumn("c", { rowIds: ["r1"] });

    expect(res).toEqual({ ran: 1, errors: 0 });
    expect(store.readCell("r1", "c")?.status).toBe("done");
    expect(store.readCell("r2", "c")).toBeUndefined();
  });

  it("is a no-op for non-function columns", async () => {
    const store = makeMemoryStore();
    store.addColumn({ id: "m", table_id: "t", name: "M", kind: "manual" });
    store.addRow({ id: "r", table_id: "t" });

    const engine = new Engine({}, echoRegistry(), { store, creds: store });
    const res = await engine.runColumn("m");
    expect(res).toEqual({ ran: 0, errors: 0 });
  });

  it("throws for an unknown column id (unchanged behaviour)", async () => {
    const store = makeMemoryStore();
    const engine = new Engine({}, echoRegistry(), { store, creds: store });
    await expect(engine.runColumn("does-not-exist")).rejects.toThrow(/not found/);
  });

  it("marks a cell error (not silent done) when a param read throws (#23)", async () => {
    // A store whose param-resolution read (`rowCells`) fails. The GridStoreError
    // propagates into runColumn's per-row try/catch and the cell is recorded
    // status:"error", restoring the prior LOCAL semantics.
    const store = makeMemoryStore();
    store.addColumn({
      id: "c",
      table_id: "t",
      name: "C",
      kind: "function",
      code: "function(inputs, sdk){ return { text: inputs.value }; }",
      params: { value: "{{C}}" },
    });
    store.addRow({ id: "r", table_id: "t" });

    const failingStore: GridStoreShape = {
      ...store,
      rowCells: () =>
        Effect.fail(
          new GridStoreError({ message: "read blew up", operation: "rowCells" }),
        ),
    };

    const engine = new Engine({}, echoRegistry(), { store: failingStore, creds: store });
    const res = await engine.runColumn("c");

    expect(res).toMatchObject({ ran: 0, errors: 1 });
    const cell = store.readCell("r", "c");
    expect(cell?.status).toBe("error");
    expect(cell?.error).toContain("read blew up");
    expect(cell?.value ?? null).toBeNull();
  });

  it("routes credentials through a separate creds store", async () => {
    const store = makeMemoryStore();
    const creds = makeMemoryStore();
    creds.addCredential("test", cred("secret"));

    store.addColumn({
      id: "c",
      table_id: "t",
      name: "C",
      kind: "function",
      provider: "test",
      method: "needsKey",
      params: {},
    });
    store.addRow({ id: "r", table_id: "t" });

    const reg = new Registry([
      {
        id: "test",
        name: "Test",
        category: "test",
        auth: { type: "apiKey" },
        methods: [
          {
            id: "needsKey",
            label: "Needs key",
            description: "Echoes the resolved apiKey secret.",
            inputSchema: {},
            batchSize: 1,
            credits: 0,
            run: async (_inputs, ctx) => ({ text: ctx.secrets.apiKey ?? "MISSING" }),
          },
        ],
      },
    ]);

    const engine = new Engine({}, reg, { store, creds });
    const res = await engine.runColumn("c");

    expect(res).toEqual({ ran: 1, errors: 0 });
    expect(store.readCell("r", "c")?.value).toBe("secret");
  });
});

describe("GridStore service (tags + typed error channel)", () => {
  it("provides the in-memory store through the GridStore tag and reads back via Effect", async () => {
    const store = makeMemoryStore();
    store.addColumn({ id: "c", table_id: "t", name: "C", kind: "manual" });
    store.addRow({ id: "r", table_id: "t" });
    store.setCellSync("r", "c", { value: { a: 1 }, status: "done" });

    const viaStore = await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* GridStore;
        return yield* s.getCell("r", "c");
      }).pipe(Effect.provideService(GridStore, store)),
    );
    expect(viaStore?.value).toEqual({ a: 1 });
    expect(viaStore?.status).toBe("done");
  });

  it("resolves credentials through the CredentialStore tag", async () => {
    const creds = makeMemoryStore();
    creds.addCredential("x", cred("local"));

    const resolved = await Effect.runPromise(
      Effect.gen(function* () {
        const s = yield* CredentialStore;
        return yield* s.getCredential("x");
      }).pipe(Effect.provideService(CredentialStore, creds)),
    );
    expect(resolved?.secrets.apiKey).toBe("local");
  });

  it("surfaces a typed GridStoreError through the Effect failure channel", async () => {
    const store: GridStoreShape = {
      ...makeMemoryStore(),
      getCell: () =>
        Effect.fail(new GridStoreError({ message: "read blew up", operation: "getCell" })),
    };

    const exit = await Effect.runPromiseExit(store.getCell("r", "c"));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
