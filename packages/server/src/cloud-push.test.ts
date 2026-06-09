/**
 * Cloud push path tests (TRI-3295) — the SIDECAR WIRING for the local→cloud
 * table push.
 *
 * Two layers, both offline (no live DB/Supabase):
 *
 *   1. {@link makeTrpcPushTransport} — the THIN tRPC transport. A scripted global
 *      `fetch` proves each non-2xx is CLASSIFIED into the right typed engine push
 *      error (429/503/5xx → TransientPushError with parsed Retry-After, 402 →
 *      CloudActionsLimitError, other 4xx → FatalPushError) and that a 2xx returns
 *      `result.data`. The transport must NOT retry (the engine orchestrator owns
 *      retry) — we assert exactly one fetch per call.
 *
 *   2. {@link runCloudPush} — the deps wiring. With a real in-memory engine `Db`
 *      and a FAKE transport, it runs the engine's CloudPushService end-to-end and
 *      re-throws the RAW typed push error (preserving `_tag`) so the route maps
 *      CloudActionsLimitError → 402 / LinkConflictError → 409.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cause, Effect, Exit } from "effect";
import { CloudActionsLimitError, Db } from "@gtmgrid/engine";
import type { CloudPushError, CloudPushTransport } from "@gtmgrid/engine";
import {
  makeTrpcPushTransport,
  runCloudPush,
  type CloudPushDeps,
} from "./cloud-push.js";

/** A scripted global fetch returning the given Responses in order. */
function scriptFetch(steps: Response[]): { calls: number } {
  const state = { calls: 0 };
  const queue = [...steps];
  vi.stubGlobal("fetch", async () => {
    state.calls++;
    const next = queue.shift();
    if (next === undefined) throw new Error("fetch over-called");
    return next;
  });
  return state;
}

const runExit = <A>(e: Effect.Effect<A, CloudPushError>) =>
  Effect.runPromiseExit(e);

/** Read the typed failure value out of an Exit's Cause. */
function failValue<A>(exit: Exit.Exit<A, CloudPushError>): CloudPushError {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const failure = Cause.failureOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") throw new Error("expected a typed failure");
  return failure.value;
}

describe("makeTrpcPushTransport — thin, NON-retrying tRPC transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("createTable returns result.data on 2xx (one fetch, no retry)", async () => {
    const state = scriptFetch([
      new Response(JSON.stringify({ result: { data: "cloud-t1" } }), {
        status: 200,
      }),
    ]);
    const t = makeTrpcPushTransport("https://app.test", "jwt", "proj1");
    const exit = await runExit(t.createTable("People"));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toBe("cloud-t1");
    expect(state.calls).toBe(1);
  });

  it("classifies 402 as CloudActionsLimitError (one fetch, no retry)", async () => {
    const state = scriptFetch([
      new Response("over quota", { status: 402, statusText: "Payment Required" }),
    ]);
    const t = makeTrpcPushTransport("https://app.test", "jwt", "proj1");
    const exit = await runExit(t.addRowsWithCells("ct", [{ c: 1 }]));
    expect(failValue(exit)._tag).toBe("CloudActionsLimitError");
    expect(state.calls).toBe(1);
  });

  it("classifies 503 as TransientPushError carrying parsed Retry-After (no retry here)", async () => {
    const state = scriptFetch([
      new Response("busy", {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "retry-after": "2" },
      }),
    ]);
    const t = makeTrpcPushTransport("https://app.test", "jwt", "proj1");
    const exit = await runExit(t.createTable("People"));
    const value = failValue(exit);
    expect(value._tag).toBe("TransientPushError");
    if (value._tag === "TransientPushError") {
      expect(value.status).toBe(503);
      expect(value.retryAfterMs).toBe(2000);
    }
    // Transport does NOT retry — exactly one fetch (the orchestrator owns retry).
    expect(state.calls).toBe(1);
  });

  it("classifies a non-quota 4xx as FatalPushError", async () => {
    scriptFetch([new Response("bad", { status: 400, statusText: "Bad Request" })]);
    const t = makeTrpcPushTransport("https://app.test", "jwt", "proj1");
    const exit = await runExit(t.addColumn("ct", { name: "n", type: "text" }));
    expect(failValue(exit)._tag).toBe("FatalPushError");
  });

  it("tableExists is true on a 2xx grid payload, false on a 404", async () => {
    scriptFetch([
      new Response(
        JSON.stringify({ result: { data: { columns: [], rows: [] } } }),
        { status: 200 },
      ),
    ]);
    const t = makeTrpcPushTransport("https://app.test", "jwt", "proj1");
    const okExit = await runExit(t.tableExists("ct"));
    expect(Exit.isSuccess(okExit) && okExit.value).toBe(true);

    scriptFetch([new Response("missing", { status: 404 })]);
    const t2 = makeTrpcPushTransport("https://app.test", "jwt", "proj1");
    const goneExit = await runExit(t2.tableExists("ct"));
    expect(Exit.isSuccess(goneExit) && goneExit.value).toBe(false);
  });
});

describe("runCloudPush — deps wiring + typed-error propagation", () => {
  let db: Db;
  beforeEach(() => {
    db = new Db(":memory:");
  });
  afterEach(() => db.close());

  /** A minimal in-memory fake transport for the end-to-end wiring test. */
  const fakeTransport = (
    overrides: Partial<CloudPushTransport> = {},
  ): CloudPushTransport => ({
    createTable: () => Effect.succeed("cloud-t1"),
    addColumn: () => Effect.succeed("cloud-c1"),
    addRowsWithCells: () => Effect.void,
    clearTable: () => Effect.void,
    tableExists: () => Effect.succeed(true),
    ...overrides,
  });

  const seed = (): string => {
    const table = db.createTable("People");
    const col = db.createColumn({ tableId: table.id, name: "Name", type: "text" });
    const row = db.createRow(table.id);
    db.setCell(row.id, col.id, { value: "Ada", status: "done" });
    return table.id;
  };

  it("first push CREATES, returns the structured result, and persists the link", async () => {
    const tableId = seed();
    const deps: CloudPushDeps = { makeTransport: () => fakeTransport(), localDb: db };
    const result = await runCloudPush(
      { apiUrl: "https://app.test", token: "jwt", projectId: "p1", localTableId: tableId },
      deps,
    );
    expect(result.outcome).toBe("created");
    expect(result.cloudTableId).toBe("cloud-t1");
    expect(result.rowCount).toBe(1);
    expect(db.getCloudTableLink(tableId)).toBe("cloud-t1");
  });

  it("re-push WITHOUT confirmation rejects with the raw LinkConflictError (_tag preserved)", async () => {
    const tableId = seed();
    const deps: CloudPushDeps = { makeTransport: () => fakeTransport(), localDb: db };
    const base = {
      apiUrl: "https://app.test",
      token: "jwt",
      projectId: "p1",
      localTableId: tableId,
    };
    await runCloudPush(base, deps); // first push links it
    await expect(runCloudPush(base, deps)).rejects.toMatchObject({
      _tag: "LinkConflictError",
    });
  });

  it("propagates a CloudActionsLimitError raw (_tag preserved) for the 402 route mapping", async () => {
    const tableId = seed();
    const deps: CloudPushDeps = {
      makeTransport: () =>
        fakeTransport({
          addRowsWithCells: () =>
            Effect.fail(new CloudActionsLimitError({ message: "quota" })),
        }),
      localDb: db,
    };
    await expect(
      runCloudPush(
        { apiUrl: "https://app.test", token: "jwt", projectId: "p1", localTableId: tableId },
        deps,
      ),
    ).rejects.toMatchObject({ _tag: "CloudActionsLimitError" });
  });
});
