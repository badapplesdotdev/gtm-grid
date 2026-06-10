/**
 * `openProject` credential-wiring regression tests.
 *
 * Since the global-db split, connector + AI credentials live in the SHARED
 * global db (`~/gtmgrid/global.db`), NOT in each project's `.db`. The desktop
 * sidecar wires this correctly (`new Engine(projectDb, …, globalDb)`), but
 * `openProject` (the lane the MCP server and CLI use) originally built
 * `new Engine(db, config, registry)` with no `credsDb`, so credentials defaulted
 * to the PROJECT db. Every key stored only in the global db then resolved to
 * `undefined` and the connector fired keyless — the Exa 402 (`X402_PAYMENT_
 * REQUIRED`) that surfaced this bug.
 *
 * These tests pin the invariant: a credential saved in the global db (and absent
 * from the project db) is the one the engine injects, the project db's copy is
 * NOT used, and the returned `credsDb` is the global db. `GTMGRID_HOME` redirects
 * all state to a temp dir so the real global db is never touched.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "./db.js";
import { Registry } from "./registry.js";
import { openProject, globalDbPath, projectPath } from "./index.js";
import type { Connector } from "./types.js";

let home: string;
let prevHome: string | undefined;

/** A connector whose single method echoes the api key the engine injected. */
function probeRegistry(): Registry {
  const probe: Connector = {
    id: "probe",
    name: "Probe",
    category: "test",
    auth: { type: "apiKey", header: "x-api-key", secretKey: "apiKey" },
    methods: [
      {
        id: "whoami",
        label: "whoami",
        description: "Echo the resolved apiKey secret.",
        inputSchema: {},
        batchSize: 1,
        credits: 0,
        run: async (_input, ctx) => ({ key: ctx.secrets.apiKey ?? "NO_KEY" }),
      },
    ],
  };
  return new Registry([probe]);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gtmgrid-home-"));
  prevHome = process.env.GTMGRID_HOME;
  process.env.GTMGRID_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.GTMGRID_HOME;
  else process.env.GTMGRID_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe("openProject credential wiring", () => {
  it("resolves connector secrets from the GLOBAL db, not the project db", async () => {
    // Key lives ONLY in the global db — exactly how the desktop saves it.
    const global = new Db(globalDbPath());
    global.saveCredential({
      extensionId: "probe",
      scope: "local",
      name: "default",
      secrets: { apiKey: "GLOBAL_KEY" },
    });
    global.close();

    const { engine, db } = openProject("proj-a", { registry: probeRegistry() });
    // The project db must NOT carry the credential.
    expect(db.getCredential("probe")).toBeUndefined();

    const res = (await engine.dispatch("probe", "whoami", {})) as { key: string };
    expect(res.key).toBe("GLOBAL_KEY");
  });

  it("ignores a stale credential that exists only in the project db", async () => {
    // A key in the project db must NOT be picked up (pre-fix behaviour) — the
    // engine resolves the global db, which here has none.
    const { engine, db } = openProject("proj-b", { registry: probeRegistry() });
    db.saveCredential({
      extensionId: "probe",
      scope: "local",
      name: "default",
      secrets: { apiKey: "PROJECT_ONLY_KEY" },
    });

    const res = (await engine.dispatch("probe", "whoami", {})) as { key: string };
    expect(res.key).toBe("NO_KEY");
  });

  it("returns credsDb pointing at the global db (distinct from the project db)", () => {
    const { db, credsDb } = openProject("proj-c", { registry: probeRegistry() });
    expect(credsDb).not.toBe(db);
    // A write through credsDb is visible to a fresh open of the same project —
    // the CLI `connect` → `run` flow.
    credsDb.saveCredential({
      extensionId: "probe",
      scope: "local",
      name: "default",
      secrets: { apiKey: "VIA_CREDS_DB" },
    });
    const reopened = openProject("proj-c", { registry: probeRegistry() });
    expect(reopened.credsDb.getCredential("probe")?.secrets.apiKey).toBe("VIA_CREDS_DB");
  });

  it("reuses the same handle for credsDb when the project IS the global db", () => {
    const { db, credsDb } = openProject(globalDbPath(), { registry: probeRegistry() });
    expect(credsDb).toBe(db);
    expect(projectPath("anything")).not.toBe(globalDbPath());
  });
});
