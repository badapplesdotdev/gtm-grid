/**
 * Cloud run path tests (T9).
 *
 * Proves the load-bearing acceptance criterion: running a column on a CLOUD
 * project executes via the LOCAL engine reading inputs from / writing results
 * back to Postgres through the cloud GridStore (the `/api/worker/*` routes) —
 * without any real backend. We inject a FAKE cloud client (a `CloudClientLike`)
 * that:
 *   - serves `/api/worker/getTable` from an in-memory grid, and
 *   - records `/api/worker/setCell` / `/api/worker/setCellStatus` / batched
 *     `/api/worker/setCells` mutations.
 * Then we assert the engine produced the right `{ ran, errors }` and that the
 * terminal cell write carried the computed value + `done` status (flushed via
 * the batched setCells route, with the interim `running` write coalesced away)
 * — i.e. the run really flowed through the cloud store, not local SQLite.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Registry,
  type ConnectorMethod,
  type Connector,
  type CloudClientLike,
} from "@gtmgrid/engine";
import {
  CloudActionsLimitError,
  DEFAULT_CLOUD_RUN_CONCURRENCY,
  MAX_CLOUD_RUN_CONCURRENCY,
  clampConcurrency,
  makeWorkerClient,
  resolveWorkspaceId,
  runCloudColumn,
  type CloudRunDeps,
} from "./cloud-run.js";

/** A registry whose single connector upper-cases its `value` input. */
const upperRegistry = (): Registry => {
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
};

/** A recorded mutation call against the fake Convex client. */
interface RecordedMutation {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/**
 * Build a fake {@link CloudClientLike} backed by an in-memory grid. `getTable`
 * returns the grid (Convex camelCase shape); the cell mutations apply COALESCE
 * merge to the in-memory cells AND record the call so tests can assert ordering.
 */
function fakeConvex(
  grid: {
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
  },
  /** Optional decrypt-for-run secrets, keyed by connector extension id (#18). */
  credentials: Record<string, Record<string, string>> = {},
  /**
   * Optional pre-flight quota gate (TRI-3277). Invoked for the
   * `/api/worker/assertColumnRunQuota` ref with the run args; throw to simulate
   * the server's 402 rejection. Defaults to a no-op (always within quota).
   */
  quotaGate: (args: Record<string, unknown>) => void = () => {},
): {
  client: CloudClientLike;
  mutations: RecordedMutation[];
  credentialCalls: Array<Record<string, unknown>>;
  queryRefs: string[];
} {
  const mutations: RecordedMutation[] = [];
  const credentialCalls: Array<Record<string, unknown>> = [];
  const queryRefs: string[] = [];

  const upsert = (args: Record<string, unknown>) => {
    const rowId = args.rowId as string;
    const columnId = args.columnId as string;
    let cell = grid.cells.find(
      (c) => c.rowId === rowId && c.columnId === columnId,
    );
    if (!cell) {
      cell = { rowId, columnId, value: null, status: "empty", error: null, updatedAt: null };
      grid.cells.push(cell);
    }
    if ("value" in args) cell.value = args.value;
    if (args.status !== undefined) cell.status = args.status as string;
    if (args.error !== undefined) cell.error = args.error as string | null;
    cell.updatedAt = Date.now();
  };

  // Refs are now `/api/worker/*` route-path strings; the fake matches on those.
  const client: CloudClientLike = {
    query: async (ref, args) => {
      const name = String(ref);
      queryRefs.push(name);
      if (name === "/api/worker/assertColumnRunQuota") {
        // The pre-flight quota gate (TRI-3277): the server computes the cells the
        // run would meter and 402s when over quota. The fake delegates to the
        // injected `quotaGate` so a test can simulate the rejection.
        quotaGate((args ?? {}) as Record<string, unknown>);
        return null;
      }
      if (name === "/api/worker/getTableMeta") {
        // The metadata-only fast path: resolveWorkspaceId reads ONLY the table's
        // workspace id from here — no columns/rows/cells (TRI-3273).
        return { table: { id: "t1", workspaceId: "wks_1" } };
      }
      if (name === "/api/worker/getTable") {
        return {
          // The run resolves the workspace it should decrypt shared creds for
          // from the table doc, so getTable must carry the workspace id (#18).
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
      // Batched path: apply every cell write in the array (the cloud store
      // flushes terminal writes here in chunks).
      if (name === "/api/worker/setCells") {
        const cells = (args.cells ?? []) as Array<Record<string, unknown>>;
        for (const c of cells) upsert(c);
        return { written: cells.length };
      }
      throw new Error(`unexpected mutation ${name}`);
    },
    action: async (ref, args) => {
      const name = String(ref);
      if (name === "/api/worker/getCredential") {
        credentialCalls.push(args);
        const secrets = credentials[String(args.extensionId)];
        return secrets === undefined ? null : { secrets };
      }
      throw new Error(`unexpected action ${name}`);
    },
  };

  return { client, mutations, credentialCalls, queryRefs };
}

/** Deps whose `makeClient` ignores url/token and returns the given fake client. */
const depsFor = (client: CloudClientLike, registry: Registry): CloudRunDeps => ({
  makeClient: () => client,
  registry,
  config: {},
});

describe("runCloudColumn", () => {
  it("reads inputs from Convex and writes the computed value + done status back", async () => {
    const grid = {
      columns: [
        { _id: "c_name", tableId: "t1", name: "Name", type: "text", kind: "manual", provider: null, method: null, code: null, params: {}, position: 0, createdAt: 1 },
        {
          _id: "c_upper",
          tableId: "t1",
          name: "Upper",
          type: "text",
          kind: "function",
          provider: "test",
          method: "upper",
          code: null,
          params: { value: "{{Name}}" },
          position: 1,
          createdAt: 2,
        },
      ],
      rows: [
        { _id: "r1", tableId: "t1", position: 0, createdAt: 1 },
        { _id: "r2", tableId: "t1", position: 1, createdAt: 2 },
      ],
      cells: [
        { rowId: "r1", columnId: "c_name", value: "ada", status: "done", error: null, updatedAt: 1 },
        { rowId: "r2", columnId: "c_name", value: "grace", status: "done", error: null, updatedAt: 1 },
      ],
    };
    const { client, mutations } = fakeConvex(grid);

    const res = await runCloudColumn(
      { apiUrl: "https://app.gtmgrid.dev", token: "jwt", tableId: "t1", columnId: "c_upper" },
      depsFor(client, upperRegistry()),
    );

    expect(res).toEqual({ ran: 2, errors: 0 });

    // The final values were written back to Convex via setCell (simplify() unwraps {text}).
    const r1Upper = grid.cells.find((c) => c.rowId === "r1" && c.columnId === "c_upper");
    const r2Upper = grid.cells.find((c) => c.rowId === "r2" && c.columnId === "c_upper");
    expect(r1Upper?.value).toBe("ADA");
    expect(r1Upper?.status).toBe("done");
    expect(r2Upper?.value).toBe("GRACE");
    expect(r2Upper?.status).toBe("done");

    // Terminal writes flush through the BATCHED setCells route — not one POST
    // per cell — and the interim `running` write is coalesced away (no separate
    // setCellStatus running write), so a cell is a single write.
    const statusCalls = mutations.filter((m) => m.name === "/api/worker/setCellStatus");
    expect(statusCalls).toHaveLength(0);
    const batchCalls = mutations.filter((m) => m.name === "/api/worker/setCells");
    expect(batchCalls.length).toBeGreaterThan(0);
    const writtenStatuses = batchCalls.flatMap((m) =>
      ((m.args.cells ?? []) as Array<{ status?: string }>).map((c) => c.status),
    );
    expect(writtenStatuses).toEqual(["done", "done"]);
    expect(writtenStatuses).not.toContain("running");
    // The run flowed entirely through the injected cloud store — there is no
    // local SQLite grid for it to touch (the local paradigm has been removed).
  });

  it("records an error status back to Convex when the column body throws", async () => {
    const grid = {
      columns: [
        {
          _id: "c_bad",
          tableId: "t1",
          name: "Bad",
          type: "text",
          kind: "function",
          provider: null,
          method: null,
          code: "function(inputs, sdk){ throw new Error('boom'); }",
          params: {},
          position: 0,
          createdAt: 1,
        },
      ],
      rows: [{ _id: "r1", tableId: "t1", position: 0, createdAt: 1 }],
      cells: [] as Array<{ rowId: string; columnId: string; value: unknown; status: string; error: string | null; updatedAt: number | null }>,
    };
    const { client } = fakeConvex(grid);

    const res = await runCloudColumn(
      { apiUrl: "https://app.gtmgrid.dev", token: "jwt", tableId: "t1", columnId: "c_bad" },
      depsFor(client, upperRegistry()),
    );

    expect(res).toMatchObject({ ran: 0, errors: 1 });
    const cell = grid.cells.find((c) => c.rowId === "r1" && c.columnId === "c_bad");
    expect(cell?.status).toBe("error");
    expect(cell?.error).toContain("boom");
  });

  it("honours an explicit rowIds subset (only those rows are written)", async () => {
    const grid = {
      columns: [
        {
          _id: "c_x",
          tableId: "t1",
          name: "X",
          type: "text",
          kind: "function",
          provider: null,
          method: null,
          code: "function(inputs, sdk){ return { text: 'x' }; }",
          params: {},
          position: 0,
          createdAt: 1,
        },
      ],
      rows: [
        { _id: "r1", tableId: "t1", position: 0, createdAt: 1 },
        { _id: "r2", tableId: "t1", position: 1, createdAt: 2 },
      ],
      cells: [] as Array<{ rowId: string; columnId: string; value: unknown; status: string; error: string | null; updatedAt: number | null }>,
    };
    const { client } = fakeConvex(grid);

    const res = await runCloudColumn(
      { apiUrl: "https://app.gtmgrid.dev", token: "jwt", tableId: "t1", columnId: "c_x", rowIds: ["r1"] },
      depsFor(client, upperRegistry()),
    );

    expect(res).toEqual({ ran: 1, errors: 0 });
    expect(grid.cells.find((c) => c.rowId === "r1" && c.columnId === "c_x")?.value).toBe("x");
    expect(grid.cells.find((c) => c.rowId === "r2" && c.columnId === "c_x")).toBeUndefined();
  });
});

/** A connector whose `run` echoes back the secret it was given, to prove wiring. */
const secretEchoRegistry = (): Registry => {
  const method: ConnectorMethod = {
    id: "whoami",
    label: "Who am I",
    description: "Returns the apiKey it received in secrets.",
    inputSchema: {},
    batchSize: 1,
    credits: 0,
    // The engine passes the resolved credential's secrets to `run` via ctx.
    run: async (_inputs, ctx) => ({ text: ctx.secrets.apiKey ?? "<none>" }),
  };
  const connector: Connector = {
    id: "secret",
    name: "Secret",
    category: "test",
    auth: { type: "apiKey" },
    methods: [method],
  };
  return new Registry([connector]);
};

describe("runCloudColumn — workspace-shared credentials (#18)", () => {
  /** A one-column grid whose function column runs `secret.whoami` on one row. */
  const secretGrid = () => ({
    columns: [
      {
        _id: "c_key",
        tableId: "t1",
        name: "Key",
        type: "text",
        kind: "function",
        provider: "secret",
        method: "whoami",
        code: null,
        params: {},
        position: 0,
        createdAt: 1,
      },
    ],
    rows: [{ _id: "r1", tableId: "t1", position: 0, createdAt: 1 }],
    cells: [] as Array<{
      rowId: string;
      columnId: string;
      value: unknown;
      status: string;
      error: string | null;
      updatedAt: number | null;
    }>,
  });

  it("decrypts the workspace's shared secret and supplies it to the connector", async () => {
    const grid = secretGrid();
    // The decrypt-for-run action will return this secret for the `secret` connector.
    const { client, credentialCalls } = fakeConvex(grid, {
      secret: { apiKey: "sk-workspace-shared" },
    });

    const res = await runCloudColumn(
      { apiUrl: "https://app.gtmgrid.dev", token: "jwt", tableId: "t1", columnId: "c_key" },
      depsFor(client, secretEchoRegistry()),
    );

    expect(res).toEqual({ ran: 1, errors: 0 });
    // The connector received the DECRYPTED workspace secret (proves end-to-end).
    expect(grid.cells.find((c) => c.rowId === "r1" && c.columnId === "c_key")?.value).toBe(
      "sk-workspace-shared",
    );
    // It was resolved via the decrypt-for-run action, scoped to the workspace +
    // connector + the WORKSPACE (shared) scope — never the personal scope.
    expect(credentialCalls).toContainEqual({
      workspaceId: "wks_1",
      extensionId: "secret",
      scope: "workspace",
    });
  });

  it("runs with no secret when the workspace has no stored credential (action → null)", async () => {
    const grid = secretGrid();
    const { client } = fakeConvex(grid, {}); // no credential stored for `secret`

    const res = await runCloudColumn(
      { apiUrl: "https://app.gtmgrid.dev", token: "jwt", tableId: "t1", columnId: "c_key" },
      depsFor(client, secretEchoRegistry()),
    );

    expect(res).toEqual({ ran: 1, errors: 0 });
    // No credential → empty secrets → the connector's fallback marker.
    expect(grid.cells.find((c) => c.rowId === "r1" && c.columnId === "c_key")?.value).toBe(
      "<none>",
    );
  });
});

describe("resolveWorkspaceId — metadata-only fast path (TRI-3273)", () => {
  /** An empty grid; resolveWorkspaceId must never need its cells. */
  const emptyGrid = () => ({
    columns: [] as Array<Record<string, unknown>>,
    rows: [] as Array<Record<string, unknown>>,
    cells: [] as Array<{
      rowId: string;
      columnId: string;
      value: unknown;
      status: string;
      error: string | null;
      updatedAt: number | null;
    }>,
  });

  it("reads the workspace id from getTableMeta WITHOUT calling the full-grid getTable", async () => {
    const { client, queryRefs } = fakeConvex(emptyGrid());

    const workspaceId = await resolveWorkspaceId(client, "t1");

    expect(workspaceId).toBe("wks_1");
    // The regression: it must hit the metadata-only ref and NEVER the full grid.
    expect(queryRefs).toContain("/api/worker/getTableMeta");
    expect(queryRefs).not.toContain("/api/worker/getTable");
  });
});

describe("makeWorkerClient — member auth + transient retry + 402 fatal (TRI-3276)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * A scripted global fetch returning the given Responses in order, recording
   * each call's request init so tests can assert the auth headers. The client
   * authenticates as the signed-in MEMBER (`X-Gtmgrid-Member`) and presents NO
   * shared worker secret — it never reads `WEBHOOK_WORKER_SECRET`.
   */
  function scriptFetch(steps: Response[]): {
    calls: number;
    inits: RequestInit[];
  } {
    const state: { calls: number; inits: RequestInit[] } = {
      calls: 0,
      inits: [],
    };
    const queue = [...steps];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      state.calls++;
      state.inits.push(init);
      const next = queue.shift();
      if (next === undefined) throw new Error("fetch over-called");
      return next;
    });
    return state;
  }

  it("authenticates as the member (X-Gtmgrid-Member) with NO worker-secret Authorization header", async () => {
    const state = scriptFetch([
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ]);
    const client = makeWorkerClient("https://app.test", "member-jwt");
    await client.query("/api/worker/getTableMeta", { tableId: "t1" });
    const headers = (state.inits[0]?.headers ?? {}) as Record<string, string>;
    expect(headers["X-Gtmgrid-Member"]).toBe("member-jwt");
    expect(headers.Authorization).toBeUndefined();
  });

  it("retries a 503 then returns the eventual success payload", async () => {
    const state = scriptFetch([
      new Response("{}", { status: 503 }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ]);
    const client = makeWorkerClient("https://app.test", "jwt");
    const out = await client.query("/api/worker/getTableMeta", { tableId: "t1" });
    expect(out).toEqual({ ok: true });
    expect(state.calls).toBe(2);
  });

  it("does NOT retry a 402 and surfaces it as a CloudActionsLimitError fatal stop", async () => {
    const state = scriptFetch([
      new Response("over quota", { status: 402, statusText: "Payment Required" }),
      new Response("{}", { status: 200 }),
    ]);
    const client = makeWorkerClient("https://app.test", "jwt");
    await expect(
      client.mutation("/api/worker/setCells", { cells: [] }),
    ).rejects.toThrow("CloudActionsLimitError");
    // Exactly one attempt — a 402 is fatal, never retried.
    expect(state.calls).toBe(1);
  });
});

describe("runCloudColumn — pre-flight quota gate (TRI-3277)", () => {
  /** A one-function-column, two-row grid the run would fan out over. */
  const twoRowGrid = () => ({
    columns: [
      {
        _id: "c_x",
        tableId: "t1",
        name: "X",
        type: "text",
        kind: "function",
        provider: null,
        method: null,
        code: "function(inputs, sdk){ return { text: 'x' }; }",
        params: {},
        position: 0,
        createdAt: 1,
      },
    ],
    rows: [
      { _id: "r1", tableId: "t1", position: 0, createdAt: 1 },
      { _id: "r2", tableId: "t1", position: 1, createdAt: 2 },
    ],
    cells: [] as Array<{
      rowId: string;
      columnId: string;
      value: unknown;
      status: string;
      error: string | null;
      updatedAt: number | null;
    }>,
  });

  it("rejects an over-quota run up-front and never fans out (no cell writes)", async () => {
    const grid = twoRowGrid();
    // The server's pre-flight 402s the run; the worker HTTP client tags 402 with
    // `CloudActionsLimitError:`, so the fake throws that tagged error.
    const { client, mutations, queryRefs } = fakeConvex(grid, {}, () => {
      throw new Error(
        "CloudActionsLimitError: Worker route /api/worker/assertColumnRunQuota failed: 402 Payment Required",
      );
    });

    await expect(
      runCloudColumn(
        { apiUrl: "https://app.gtmgrid.dev", token: "jwt", tableId: "t1", columnId: "c_x" },
        depsFor(client, upperRegistry()),
      ),
    ).rejects.toBeInstanceOf(CloudActionsLimitError);

    // The gate ran BEFORE fan-out: no cell was written, and the full grid was
    // never fetched for the rejected run.
    expect(mutations).toHaveLength(0);
    expect(grid.cells).toHaveLength(0);
    expect(queryRefs).toContain("/api/worker/assertColumnRunQuota");
    expect(queryRefs).not.toContain("/api/worker/getTable");
  });

  it("lets a run within quota proceed unchanged", async () => {
    const grid = twoRowGrid();
    // Default quotaGate is a no-op → within quota → the run proceeds.
    const { client, queryRefs } = fakeConvex(grid);

    const res = await runCloudColumn(
      { apiUrl: "https://app.gtmgrid.dev", token: "jwt", tableId: "t1", columnId: "c_x" },
      depsFor(client, upperRegistry()),
    );

    expect(res).toEqual({ ran: 2, errors: 0 });
    expect(queryRefs).toContain("/api/worker/assertColumnRunQuota");
    expect(grid.cells.filter((c) => c.columnId === "c_x")).toHaveLength(2);
  });
});

describe("clampConcurrency — safe per-run fan-out ceiling (M6 / TRI-3282)", () => {
  it("defaults an absent value to DEFAULT_CLOUD_RUN_CONCURRENCY", () => {
    expect(clampConcurrency(undefined)).toBe(DEFAULT_CLOUD_RUN_CONCURRENCY);
  });

  it("caps an over-ceiling value at MAX_CLOUD_RUN_CONCURRENCY", () => {
    expect(clampConcurrency(MAX_CLOUD_RUN_CONCURRENCY + 1)).toBe(
      MAX_CLOUD_RUN_CONCURRENCY,
    );
    expect(clampConcurrency(1000)).toBe(MAX_CLOUD_RUN_CONCURRENCY);
  });

  it("passes through an in-range value unchanged (floored to an integer)", () => {
    expect(clampConcurrency(3)).toBe(3);
    expect(clampConcurrency(MAX_CLOUD_RUN_CONCURRENCY)).toBe(
      MAX_CLOUD_RUN_CONCURRENCY,
    );
    expect(clampConcurrency(4.9)).toBe(4);
  });

  it("falls back to the default for non-finite or sub-1 values (never 0, which would stall)", () => {
    expect(clampConcurrency(0)).toBe(DEFAULT_CLOUD_RUN_CONCURRENCY);
    expect(clampConcurrency(-5)).toBe(DEFAULT_CLOUD_RUN_CONCURRENCY);
    expect(clampConcurrency(Number.NaN)).toBe(DEFAULT_CLOUD_RUN_CONCURRENCY);
    expect(clampConcurrency(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_CLOUD_RUN_CONCURRENCY,
    );
  });

  it("a cloud run with an absurd requested concurrency still completes correctly (clamp is behaviour-preserving)", async () => {
    const grid = {
      columns: [
        {
          _id: "c_x",
          tableId: "t1",
          name: "X",
          type: "text",
          kind: "function",
          provider: null,
          method: null,
          code: "function(inputs, sdk){ return { text: 'x' }; }",
          params: {},
          position: 0,
          createdAt: 1,
        },
      ],
      rows: [
        { _id: "r1", tableId: "t1", position: 0, createdAt: 1 },
        { _id: "r2", tableId: "t1", position: 1, createdAt: 2 },
      ],
      cells: [] as Array<{
        rowId: string;
        columnId: string;
        value: unknown;
        status: string;
        error: string | null;
        updatedAt: number | null;
      }>,
    };
    const { client } = fakeConvex(grid);

    const res = await runCloudColumn(
      {
        apiUrl: "https://app.gtmgrid.dev",
        token: "jwt",
        tableId: "t1",
        columnId: "c_x",
        concurrency: 10_000,
      },
      depsFor(client, upperRegistry()),
    );

    // Despite the absurd requested concurrency, every row still ran exactly once.
    expect(res).toEqual({ ran: 2, errors: 0 });
    expect(grid.cells.filter((c) => c.columnId === "c_x")).toHaveLength(2);
  });
});
