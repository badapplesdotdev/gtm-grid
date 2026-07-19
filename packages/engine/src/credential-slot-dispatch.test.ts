/**
 * `credentialSlot` through the REAL engine + QuickJS sandbox.
 *
 * `credential-slot.test.ts` proves `credentialSlotFor` in isolation, which is
 * necessary and not sufficient: the whole feature turns on `Engine.dispatch`
 * ACTUALLY calling it before `creds.getCredential(...)`. Wire that up wrong and
 * every unit test still passes while every Google column gets an empty
 * credential — and the symptom is a 401 from Google, which reads as "your grant
 * expired" rather than "we looked up the wrong row".
 *
 * So this drives a column end to end: sandbox → dispatch → credential lookup →
 * method, and asserts on the token the method actually RECEIVED.
 */

import { describe, expect, it } from "vitest";
import { Engine } from "./execute.js";
import { Registry } from "./registry.js";
import { makeMemoryStore, type MemoryStore } from "./test-helpers.js";
import type { Connector, ConnectorMethod, MethodContext } from "./types.js";

/** Records the secrets each call was handed, so we can assert on the lookup. */
const seen: { secrets: Record<string, unknown> }[] = [];

function googleSheetsRegistry(credentialSlot: string | undefined): Registry {
  const appendRow: ConnectorMethod = {
    id: "appendRow",
    label: "Append Row",
    description: "Append a row.",
    inputSchema: {},
    batchSize: 1,
    credits: 0,
    run: async (_inputs, ctx: MethodContext) => {
      seen.push({ secrets: { ...ctx.secrets } });
      return { updatedRange: `Sheet1!A2 (token=${String(ctx.secrets.accessToken ?? "NONE")})` };
    },
  };
  const connector: Connector = {
    id: "googlesheets",
    name: "Google Sheets",
    category: "productivity",
    auth: {
      type: "oauth",
      provider: "google",
      ...(credentialSlot === undefined ? {} : { credentialSlot }),
    },
    methods: [appendRow],
  };
  return new Registry([connector]);
}

function seedColumn(store: MemoryStore): void {
  store.addColumn({ id: "name", table_id: "t", name: "Name", kind: "manual" });
  store.addColumn({
    id: "push",
    table_id: "t",
    name: "Push",
    kind: "function",
    provider: "googlesheets",
    method: "appendRow",
    code: null, // NO custom code → runs as sdk["googlesheets"]["appendRow"](inputs)
    params: { range: "{{Name}}" },
  });
  store.addRow({ id: "r1", table_id: "t" });
  store.setCellSync("r1", "name", { value: "Sheet1", status: "done" });
}

describe("Engine.dispatch resolves the credential by SLOT", () => {
  it("reads the shared 'google' row for the 'googlesheets' connector", async () => {
    seen.length = 0;
    const store = makeMemoryStore();
    seedColumn(store);
    // The grant lives at "google" — NOT at the connector's own id. This is the
    // whole point: one Google connection serving many Google connectors.
    store.addCredential("google", { secrets: { accessToken: "ya29.shared" } });

    const engine = new Engine({}, googleSheetsRegistry("google"), { store, creds: store });
    const res = await engine.runColumn("push", { rowIds: ["r1"] });

    expect(res).toMatchObject({ ran: 1, errors: 0 });
    expect(store.readCell("r1", "push")?.status).toBe("done");
    // The method genuinely received the shared token.
    expect(seen[0]?.secrets.accessToken).toBe("ya29.shared");
  });

  it("gets NOTHING when the grant sits at the connector id instead", async () => {
    // Pins the failure the slot exists to prevent. A credential saved at
    // "googlesheets" is invisible to a connector whose slot is "google" — the
    // method runs with empty secrets and Google answers 401, which looks like an
    // expired grant rather than a lookup miss.
    seen.length = 0;
    const store = makeMemoryStore();
    seedColumn(store);
    store.addCredential("googlesheets", { secrets: { accessToken: "ya29.wrong-row" } });

    const engine = new Engine({}, googleSheetsRegistry("google"), { store, creds: store });
    await engine.runColumn("push", { rowIds: ["r1"] });

    expect(seen[0]?.secrets.accessToken).toBeUndefined();
  });

  it("falls back to the connector id when NO slot is declared — every existing connector", async () => {
    // The regression guard: absent `credentialSlot` must behave exactly as before
    // the field existed.
    seen.length = 0;
    const store = makeMemoryStore();
    seedColumn(store);
    store.addCredential("googlesheets", { secrets: { accessToken: "ya29.own-row" } });

    const engine = new Engine({}, googleSheetsRegistry(undefined), { store, creds: store });
    const res = await engine.runColumn("push", { rowIds: ["r1"] });

    expect(res).toMatchObject({ ran: 1, errors: 0 });
    expect(seen[0]?.secrets.accessToken).toBe("ya29.own-row");
  });

  it("lets TWO Google connectors share one grant", async () => {
    // The end state the feature is for: connect Google once, use it everywhere.
    seen.length = 0;
    const store = makeMemoryStore();
    store.addColumn({ id: "name", table_id: "t", name: "Name", kind: "manual" });
    store.addRow({ id: "r1", table_id: "t" });
    store.setCellSync("r1", "name", { value: "Sheet1", status: "done" });
    store.addCredential("google", { secrets: { accessToken: "ya29.one-grant" } });

    for (const id of ["googlesheets", "googledocs"]) {
      const registry = googleSheetsRegistry("google");
      // Re-register the same connector under a second Google id.
      const base = registry.get("googlesheets");
      if (base === undefined) throw new Error("connector missing");
      registry.add({ ...base, id });

      store.addColumn({
        id: `col-${id}`,
        table_id: "t",
        name: id,
        kind: "function",
        provider: id,
        method: "appendRow",
        code: null,
        params: { range: "{{Name}}" },
      });

      const engine = new Engine({}, registry, { store, creds: store });
      const res = await engine.runColumn(`col-${id}`, { rowIds: ["r1"] });
      expect(res).toMatchObject({ ran: 1, errors: 0 });
    }

    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.secrets.accessToken === "ya29.one-grant")).toBe(true);
  });
});
