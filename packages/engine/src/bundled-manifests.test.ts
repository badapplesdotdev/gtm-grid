/**
 * Coverage for the bundled-connector fix behind webhook auto-enrich failing with
 * "sandbox: cannot read property <method>".
 *
 * The cloud webhook worker (apps/web Inngest) has no disk access to the repo's
 * `extensions/*.json`, so it registers the app's shipped connectors via
 * {@link bundledConnectors} (sourced from the generated {@link BUNDLED_MANIFESTS}).
 * If that set ever stops covering a shipped connector — or a manifest stops
 * parsing — a webhook column using it silently breaks again. These tests pin:
 *
 *   1. EVERY bundled manifest parses into a connector (no silent skips).
 *   2. The connectors that were failing in the field (leadmagic/trigify/apollo/…)
 *      are present with their expected methods.
 *   3. END-TO-END through the REAL QuickJS sandbox: a no-code column for a BUNDLED
 *      connector resolves `sdk[provider][method]` and dispatches — it no longer
 *      throws the "undefined sdk provider" error the cloud worker used to hit.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_MANIFESTS } from "./bundled-manifests.generated.js";
import { Engine } from "./execute.js";
import { Registry, bundledConnectors, defaultRegistry } from "./registry.js";
import { makeMemoryStore, type MemoryStore } from "./test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bundledConnectors", () => {
  it("builds a connector from EVERY bundled manifest (no silent skips)", () => {
    const connectors = bundledConnectors();
    // A length mismatch means a shipped `extensions/*.json` failed to parse and
    // was dropped — exactly the silent gap this guards against. Regenerate with
    // `pnpm --filter @gtmgrid/engine gen:bundled-manifests` after adding one.
    expect(connectors.length).toBe(BUNDLED_MANIFESTS.length);
    expect(connectors.length).toBeGreaterThan(0);
  });

  it("every bundled connector has a non-empty id and at least one method", () => {
    for (const connector of bundledConnectors()) {
      expect(connector.id, "connector id must be non-empty").toBeTruthy();
      expect(
        connector.methods.length,
        `${connector.id} must expose at least one method`,
      ).toBeGreaterThan(0);
    }
  });

  it("includes the connectors that were failing in the webhook path, with their methods", () => {
    const byId = new Map(bundledConnectors().map((c) => [c.id, c]));

    // The featured/most-used connectors that broke when the cloud worker had only
    // the built-ins (packages/server/src/index.ts FEATURED_TOOLS + common ones).
    for (const provider of ["leadmagic", "trigify", "apollo", "smuggler", "avtrz"]) {
      expect(byId.has(provider), `bundled connectors must include ${provider}`).toBe(true);
    }

    const hasMethod = (provider: string, method: string): boolean =>
      byId.get(provider)?.methods.some((m) => m.id === method) ?? false;

    expect(hasMethod("leadmagic", "emailFinder")).toBe(true);
    expect(hasMethod("apollo", "enrichPerson")).toBe(true);
    expect(hasMethod("trigify", "enrichProfile")).toBe(true);
  });

  it("exposes the same providers through a Registry's providerMap", () => {
    const registry = new Registry(bundledConnectors());
    const providers = registry.providerMap();
    expect(Object.keys(providers)).toContain("leadmagic");
    expect(providers.leadmagic).toContain("emailFinder");
  });
});

/** Seed a manual Name + a no-code `leadmagic.emailFinder` column over one row. */
function seedLeadmagicColumn(store: MemoryStore): void {
  store.addColumn({ id: "name", table_id: "t", name: "Name", kind: "manual" });
  store.addColumn({
    id: "email",
    table_id: "t",
    name: "Email",
    kind: "function",
    provider: "leadmagic",
    method: "emailFinder",
    code: null, // NO custom code → runs as sdk["leadmagic"]["emailFinder"](inputs)
    params: { first_name: "Ada", last_name: "Lovelace", domain: "acme.com" },
  });
  store.addRow({ id: "r1", table_id: "t" });
  store.setCellSync("r1", "name", { value: "Ada Lovelace", status: "done" });
  // The bundled leadmagic manifest authenticates with an apiKey header; provide a
  // decrypted credential so the run reaches the HTTP call (the workspace-shared
  // secret in production) rather than failing on a missing key.
  store.addCredential("leadmagic", {
    id: "cred-1",
    extension_id: "leadmagic",
    scope: "team",
    name: "test key",
    secrets: { apiKey: "test-key" },
    created_at: Date.now(),
  });
}

describe("bundled connector through the real sandbox (regression)", () => {
  it("resolves sdk[provider][method] and dispatches the HTTP call", async () => {
    // The fetch the manifest connector ultimately makes. If the provider were
    // missing from the registry, the QuickJS guest would throw on `sdk["leadmagic"]`
    // BEFORE any dispatch — so fetch being called proves the connector resolved.
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ email: "ada@acme.com", status: "valid" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const store = makeMemoryStore();
    seedLeadmagicColumn(store);

    // The EXACT registry shape the cloud worker now builds: built-ins + bundled.
    const registry = new Registry([
      ...defaultRegistry().list(),
      ...bundledConnectors(),
    ]);
    const engine = new Engine({}, registry, { store, creds: store });
    const res = await engine.runColumn("email", { rowIds: ["r1"] });

    // The provider resolved → the method dispatched its HTTP call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // And specifically NOT the "undefined sdk provider" failure mode.
    const cell = store.readCell("r1", "email");
    expect(cell?.error ?? "").not.toMatch(/cannot read|is not a function|undefined/i);
    expect(res).toMatchObject({ ran: 1, errors: 0 });
    expect(cell?.status).toBe("done");
  });
});
