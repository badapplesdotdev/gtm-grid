// The cloud TableGateway: memoized schema/row reads, write invalidation,
// in-flight column-create dedupe, and — the correctness keystone — per-key
// upsert serialization, so two concurrent rows pushing the same key can never
// race find-or-insert into a duplicate.

import { describe, expect, it } from "vitest";
import { cloudTableGateway, type TableGatewayRefs } from "./table-gateway.js";
import type { CloudClientLike } from "./store-cloud.js";

const REFS: TableGatewayRefs = {
  listProjectTables: "/api/worker/listProjectTables",
  getTableSchema: "/api/worker/getTableSchema",
  getTableRows: "/api/worker/getTableRows",
  upsertRowInTable: "/api/worker/upsertRowInTable",
  createColumnInTable: "/api/worker/createColumnInTable",
};

interface Call {
  readonly kind: "query" | "mutation";
  readonly ref: unknown;
  readonly args: Record<string, unknown>;
}

/** A scriptable fake client that records every call. */
function makeClient(handler: (call: Call) => unknown | Promise<unknown>): {
  client: CloudClientLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const invoke = (kind: Call["kind"]) => async (ref: unknown, args: Record<string, unknown>) => {
    const call: Call = { kind, ref, args };
    calls.push(call);
    return handler(call);
  };
  return {
    client: { query: invoke("query"), mutation: invoke("mutation"), action: invoke("query") },
    calls,
  };
}

const SCHEMA_PAYLOAD = {
  table: { id: "t2", name: "Accounts" },
  columns: [
    { id: "c1", name: "Domain", type: "text", kind: "manual" },
    { id: "c2", name: "Score", type: "number", kind: "manual" },
  ],
};

describe("cloudTableGateway", () => {
  it("memoizes getSchema per ref and bakes sourceTableId into requests", async () => {
    const { client, calls } = makeClient(() => SCHEMA_PAYLOAD);
    const gw = cloudTableGateway({ client, refs: REFS, sourceTableId: "t1" });

    const a = await gw.getSchema("Accounts");
    const b = await gw.getSchema("Accounts");

    expect(a).toEqual({ id: "t2", name: "Accounts", columns: SCHEMA_PAYLOAD.columns });
    expect(b).toBe(a === undefined ? b : a); // same memoized result object
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ sourceTableId: "t1", targetRef: "Accounts" });
  });

  it("does not cache a FAILED schema fetch as a permanent miss", async () => {
    let attempts = 0;
    const { client } = makeClient(() => {
      attempts++;
      if (attempts === 1) throw new Error("transient");
      return SCHEMA_PAYLOAD;
    });
    const gw = cloudTableGateway({ client, refs: REFS });

    await expect(gw.getSchema("Accounts")).rejects.toThrow("transient");
    await expect(gw.getSchema("Accounts")).resolves.toMatchObject({ id: "t2" });
  });

  it("returns undefined for an unknown table (null payload)", async () => {
    const { client } = makeClient(() => null);
    const gw = cloudTableGateway({ client, refs: REFS });
    await expect(gw.getSchema("Ghost")).resolves.toBeUndefined();
  });

  it("readRows maps cells by column NAME and memoizes until a write invalidates", async () => {
    const grid = {
      columns: [
        { _id: "c1", name: "Domain", type: "text", kind: "manual" },
        { _id: "c2", name: "Score", type: "number", kind: "manual" },
      ],
      rows: [{ _id: "r1" }, { _id: "r2" }],
      cells: [
        { rowId: "r1", columnId: "c1", value: "acme.com" },
        { rowId: "r1", columnId: "c2", value: 42 },
        { rowId: "r2", columnId: "c1", value: "globex.com" },
      ],
    };
    const { client, calls } = makeClient((call) =>
      call.ref === REFS.getTableRows ? grid : { rowId: "r3", created: true },
    );
    const gw = cloudTableGateway({ client, refs: REFS, sourceTableId: "t1" });

    const rows = await gw.readRows("t2");
    expect(rows).toEqual([
      { rowId: "r1", cells: { Domain: "acme.com", Score: 42 } },
      { rowId: "r2", cells: { Domain: "globex.com" } },
    ]);

    await gw.readRows("t2"); // memoized — no second fetch
    expect(calls.filter((c) => c.ref === REFS.getTableRows)).toHaveLength(1);

    await gw.upsertRow({ tableId: "t2", keyColumnId: null, keyValue: null, cells: { c1: "x.com" } });
    await gw.readRows("t2"); // invalidated by the write — refetches
    expect(calls.filter((c) => c.ref === REFS.getTableRows)).toHaveLength(2);
  });

  it("SERIALIZES same-key upserts and runs different keys concurrently", async () => {
    const events: string[] = [];
    let inFlightSameKey = 0;
    let maxInFlightSameKey = 0;
    const { client } = makeClient(async (call) => {
      if (call.ref !== REFS.upsertRowInTable) return SCHEMA_PAYLOAD;
      const key = String((call.args.keyValue as string) ?? "");
      if (key === "dup@x.com") {
        inFlightSameKey++;
        maxInFlightSameKey = Math.max(maxInFlightSameKey, inFlightSameKey);
      }
      events.push(`start:${key}`);
      await new Promise((r) => setTimeout(r, 5));
      events.push(`end:${key}`);
      if (key === "dup@x.com") inFlightSameKey--;
      return { rowId: `row-${key}`, created: true };
    });
    const gw = cloudTableGateway({ client, refs: REFS });

    const upsert = (keyValue: string) =>
      gw.upsertRow({ tableId: "t2", keyColumnId: "c1", keyValue, cells: { c1: keyValue } });

    await Promise.all([upsert("dup@x.com"), upsert("dup@x.com"), upsert("other@x.com")]);

    // The two same-key upserts never overlapped; the different key was free to.
    expect(maxInFlightSameKey).toBe(1);
    const dupStarts = events.filter((e) => e === "start:dup@x.com").length;
    expect(dupStarts).toBe(2);
  });

  it("keeps serving same-key upserts after one in the chain fails", async () => {
    let attempts = 0;
    const { client } = makeClient((call) => {
      if (call.ref !== REFS.upsertRowInTable) return SCHEMA_PAYLOAD;
      attempts++;
      if (attempts === 1) throw new Error("quota");
      return { rowId: "r9", created: false };
    });
    const gw = cloudTableGateway({ client, refs: REFS });
    const input = { tableId: "t2", keyColumnId: "c1", keyValue: "a@x.com", cells: {} };

    await expect(gw.upsertRow(input)).rejects.toThrow("quota");
    await expect(gw.upsertRow(input)).resolves.toEqual({ rowId: "r9", created: false });
  });

  it("dedupes concurrent createColumn calls for the same (table, name)", async () => {
    let creates = 0;
    const { client } = makeClient(async (call) => {
      if (call.ref !== REFS.createColumnInTable) return SCHEMA_PAYLOAD;
      creates++;
      await new Promise((r) => setTimeout(r, 5));
      return { id: `col-${creates}` };
    });
    const gw = cloudTableGateway({ client, refs: REFS });

    const [a, b] = await Promise.all([
      gw.createColumn("t2", "Email"),
      gw.createColumn("t2", "Email"),
    ]);
    expect(creates).toBe(1);
    expect(a).toEqual(b);
  });

  it("listTables unwraps the worker payload", async () => {
    const { client, calls } = makeClient(() => ({ tables: [{ id: "t2", name: "Accounts" }] }));
    const gw = cloudTableGateway({ client, refs: REFS, sourceTableId: "t1" });
    await expect(gw.listTables()).resolves.toEqual([{ id: "t2", name: "Accounts" }]);
    expect(calls[0].args).toEqual({ sourceTableId: "t1" });
  });
});
