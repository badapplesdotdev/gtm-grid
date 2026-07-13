/**
 * Integration test for the root cause behind "sandbox cannot read property
 * emailfinder": a connector column with NO custom code runs in the real QuickJS
 * sandbox as the generated body `sdk[provider][method](inputs)` (execute.ts), so
 * the provider MUST be in the engine's registry or `sdk[provider]` is undefined
 * and the per-cell run throws.
 *
 * This drives the FULL engine + sandbox (no mocks of the sandbox) to prove:
 *   1. With the manifest connector registered → the column runs and stores its value.
 *   2. Without it (bare defaultRegistry — the cloud-worker gap that was fixed) →
 *      the exact failure: the cell errors reading the method off an undefined sdk
 *      provider.
 */

import { describe, expect, it } from "vitest";
import { Engine } from "./execute.js";
import { Registry, defaultRegistry } from "./registry.js";
import { makeMemoryStore, type MemoryStore } from "./test-helpers.js";
import type { Connector, ConnectorMethod } from "./types.js";

/**
 * A manifest-shaped connector (what `connectorFromManifest` produces): one
 * non-batchable method (`batchSize: 1`, no `runBatch`), so the engine runs it
 * per-row through the sandbox as `sdk["leadmagic"]["emailFinder"](inputs)`.
 */
function leadmagicRegistry(): Registry {
  const emailFinder: ConnectorMethod = {
    id: "emailFinder",
    label: "Find Email",
    description: "Find a person's work email.",
    inputSchema: {},
    batchSize: 1,
    credits: 1,
    run: async (inputs) => ({ email: `${String(inputs.name)}@acme.com`, status: "valid" }),
  };
  const connector: Connector = {
    id: "leadmagic",
    name: "LeadMagic",
    category: "enrichment",
    auth: null,
    methods: [emailFinder],
  };
  return new Registry([connector]);
}

/** Seed a table with a manual Name + a no-code leadmagic.emailFinder column. */
function seedConnectorColumn(store: MemoryStore): void {
  store.addColumn({ id: "name", table_id: "t", name: "Name", kind: "manual" });
  store.addColumn({
    id: "email",
    table_id: "t",
    name: "Email",
    kind: "function",
    provider: "leadmagic",
    method: "emailFinder",
    code: null, // NO custom code → runs as sdk["leadmagic"]["emailFinder"](inputs)
    params: { name: "{{Name}}" },
  });
  store.addRow({ id: "r1", table_id: "t" });
  store.setCellSync("r1", "name", { value: "ada", status: "done" });
}

describe("connector column via the sandbox sdk[provider][method]", () => {
  it("runs when the manifest connector IS registered", async () => {
    const store = makeMemoryStore();
    seedConnectorColumn(store);

    const engine = new Engine({}, leadmagicRegistry(), { store, creds: store });
    const res = await engine.runColumn("email", { rowIds: ["r1"] });

    expect(res).toMatchObject({ ran: 1, errors: 0 });
    const cell = store.readCell("r1", "email");
    expect(cell?.status).toBe("done");
    expect(cell?.error).toBeNull();
    expect(JSON.stringify(cell?.value)).toContain("ada@acme.com");
  });

  it("reproduces the bug when the provider is NOT registered (the cloud-worker gap)", async () => {
    const store = makeMemoryStore();
    seedConnectorColumn(store);

    // defaultRegistry() has only the built-ins — no manifest connectors. This is
    // exactly the state the cloud worker was in before the workspaceRegistry fix.
    const engine = new Engine({}, defaultRegistry(), { store, creds: store });
    const res = await engine.runColumn("email", { rowIds: ["r1"] });

    expect(res.errors).toBe(1);
    const cell = store.readCell("r1", "email");
    expect(cell?.status).toBe("error");
    // sdk["leadmagic"] is undefined, so reading ["emailFinder"] off it throws.
    expect(cell?.error ?? "").toMatch(/emailFinder|cannot read|undefined/i);
  });
});
