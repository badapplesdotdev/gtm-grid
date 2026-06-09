/**
 * GET /api/cloud/tables/links (TRI-3311).
 *
 * The sidecar exposes the CURRENT project's persisted local↔cloud links from
 * SQLite meta (`Db.listCloudTableLinks`) so the desktop hydrates synced-table
 * status from the source of truth instead of a drift-prone localStorage mirror.
 *
 * `index.ts` binds a port on import (side effects), so — like `cors.test.ts` and
 * `auto-sync-setting.test.ts` — we don't import it. Instead we wire a REAL
 * `node:http` server exactly like `index.ts`: the SAME top-of-handler
 * loopback-`Host` / allowed-`Origin` guard wraps the SAME handler body, which
 * returns `current.projectDb.listCloudTableLinks()` over a real temp Db. This
 * proves the route's data contract AND that it inherits the security gate (it is
 * not bypassed), by behaviour over the wire — no mocks.
 */

import { type AddressInfo } from "node:net";
import {
  createServer,
  request as httpRequest,
  type Server,
  type ServerResponse,
} from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Db } from "@gtmgrid/engine";
import { corsHeadersFor, isLoopbackHost, isOriginAllowed } from "./cors.js";

const ALLOWED = "http://localhost:5173";
const HOSTILE = "http://evil.example.com";

function send(res: ServerResponse, status: number, data: unknown, origin?: string) {
  res.writeHead(status, { "content-type": "application/json", ...corsHeadersFor(origin) });
  res.end(JSON.stringify(data));
}

let dir: string;
let projectDb: Db;
let server: Server;
let port: number;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "cloud-links-route-test-"));
  projectDb = new Db(join(dir, "project.db"));
  // Two links + unrelated meta — the route must return ONLY the links map.
  projectDb.setCloudTableLink("local-a", "cloud-a");
  projectDb.setCloudTableLink("local-b", "cloud-b");
  projectDb.setMeta("favorite_tables", JSON.stringify(["local-a"]));

  server = createServer((req, res) => {
    const origin = req.headers.origin;
    // EXACT top-of-handler gate from index.ts (DNS-rebinding + CSRF), applied to
    // every route before any work — including this one.
    if (!isLoopbackHost(req.headers.host)) {
      return send(res, 403, { error: "host not allowed" }, origin);
    }
    if (!isOriginAllowed(origin)) {
      return send(res, 403, { error: "origin not allowed" }, origin);
    }
    if (req.method === "GET" && req.url === "/api/cloud/tables/links") {
      // The exact route body registered in index.ts.
      return send(res, 200, projectDb.listCloudTableLinks(), origin);
    }
    send(res, 404, { error: "not found" }, origin);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Raw GET so we can set an arbitrary `Host` header (undici's fetch can't). */
function rawGet(
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: "GET", path: "/api/cloud/tables/links", headers },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("GET /api/cloud/tables/links", () => {
  it("returns the project's { localTableId: cloudTableId } map (links only)", async () => {
    const r = await rawGet({ host: `127.0.0.1:${port}` });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ "local-a": "cloud-a", "local-b": "cloud-b" });
  });

  it("reflects the allowed desktop origin, never *", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/cloud/tables/links`, {
      headers: { origin: ALLOWED },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(r.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(await r.json()).toEqual({ "local-a": "cloud-a", "local-b": "cloud-b" });
  });

  it("REJECTS a rebound attacker Host (403) — gate not bypassed", async () => {
    const r = await rawGet({ host: "evil.example.com" });
    expect(r.status).toBe(403);
    expect(r.body).toContain("host not allowed");
  });

  it("REJECTS a disallowed browser Origin (403) — gate not bypassed", async () => {
    const r = await rawGet({ host: `127.0.0.1:${port}`, origin: HOSTILE });
    expect(r.status).toBe(403);
    expect(r.body).toContain("origin not allowed");
  });
});
