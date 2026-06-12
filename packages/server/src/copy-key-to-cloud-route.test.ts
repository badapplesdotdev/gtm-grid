/**
 * POST /api/credentials/copy-to-cloud — the desktop "Use my local key" action.
 *
 * SECURITY contract proven here (by behaviour over the wire, no mocks):
 *   1. The LOCAL plaintext is revealed only in-process and forwarded to the cloud
 *      `/api/worker/saveCredential` route as the signed-in MEMBER
 *      (`X-Gtmgrid-Member` bearer) — never returned to the caller (the renderer).
 *   2. The HTTP RESPONSE body never contains the secret value.
 *   3. No local key ⇒ a clean error and NO forward (nothing leaks).
 *   4. The route inherits the SAME loopback-`Host` / allowed-`Origin` gate every
 *      route is wrapped in (not LAN-reachable / not callable cross-origin).
 *
 * Like `cloud-table-links-route.test.ts`, `index.ts` binds a port on import, so we
 * don't import it: we wire a real `node:http` server with the SAME top-of-handler
 * gate and the SAME copy-route body, over a real temp Db, and a fake "cloud"
 * server that captures the forwarded request.
 */

import { type AddressInfo } from "node:net";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Db } from "@gtmgrid/engine";
import { corsHeadersFor, isLoopbackHost, isOriginAllowed } from "./cors.js";

const HOSTILE = "http://evil.example.com";
const LOCAL_SECRET = "sk-local-super-secret-value";

function send(res: ServerResponse, status: number, data: unknown, origin?: string) {
  res.writeHead(status, { "content-type": "application/json", ...corsHeadersFor(origin) });
  res.end(JSON.stringify(data));
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body === "" ? {} : JSON.parse(body)));
  });
}

let dir: string;
let globalDb: Db;
let sidecar: Server;
let sidecarPort: number;

// Fake apps/web "cloud": records the forwarded saveCredential request.
let cloud: Server;
let cloudUrl: string;
let cloudReceived: { headers: Record<string, string | string[] | undefined>; body: any } | null;
let cloudStatus = 200;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "copy-key-route-test-"));
  globalDb = new Db(join(dir, "global.db"));
  // A LOCAL key the user already has on this machine.
  globalDb.saveCredential({
    extensionId: "ai:anthropic",
    scope: "local",
    name: "Anthropic",
    secrets: { apiKey: LOCAL_SECRET },
  });

  cloud = createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/worker/saveCredential") {
      cloudReceived = { headers: req.headers, body: await readJson(req) };
      return send(res, cloudStatus, cloudStatus === 200 ? { id: "cred_1" } : { error: "nope" });
    }
    send(res, 404, { error: "not found" });
  });
  await new Promise<void>((r) => cloud.listen(0, "127.0.0.1", r));
  cloudUrl = `http://127.0.0.1:${(cloud.address() as AddressInfo).port}`;

  sidecar = createServer(async (req, res) => {
    const origin = req.headers.origin;
    // EXACT top-of-handler gate from index.ts.
    if (!isLoopbackHost(req.headers.host)) return send(res, 403, { error: "host not allowed" }, origin);
    if (!isOriginAllowed(origin)) return send(res, 403, { error: "origin not allowed" }, origin);

    if (req.method === "POST" && req.url === "/api/credentials/copy-to-cloud") {
      const body = await readJson(req);
      // ── The exact copy-route body registered in index.ts ──────────────────
      const credId = String(body?.credId ?? "").trim();
      const extensionId = String(body?.extensionId ?? credId).trim() || credId;
      const apiUrl = String(body?.apiUrl ?? "").trim();
      const token = String(body?.token ?? "").trim();
      const workspaceId = String(body?.workspaceId ?? "").trim();
      const name = String(body?.name ?? extensionId).trim() || extensionId;
      if (!credId || !apiUrl || !token || !workspaceId)
        return send(res, 200, { error: "credId, apiUrl, token and workspaceId are required" }, origin);
      const secrets = globalDb.getCredential(credId)?.secrets ?? null;
      if (!secrets || Object.keys(secrets).length === 0)
        return send(res, 200, { error: "No local key found to copy to the cloud." }, origin);
      const base = apiUrl.replace(/\/+$/, "");
      const fwd = await fetch(`${base}/api/worker/saveCredential`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Gtmgrid-Member": token },
        body: JSON.stringify({ workspaceId, extensionId, name, secrets }),
      });
      if (!fwd.ok) {
        const text = await fwd.text().catch(() => "");
        return send(res, 200, { error: `Cloud save failed (${fwd.status} ${fwd.statusText}). ${text}`.trim() }, origin);
      }
      return send(res, 200, { ok: true }, origin);
    }
    send(res, 404, { error: "not found" }, origin);
  });
  await new Promise<void>((r) => sidecar.listen(0, "127.0.0.1", r));
  sidecarPort = (sidecar.address() as AddressInfo).port;
});

afterAll(() => {
  sidecar.close();
  cloud.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  cloudReceived = null;
  cloudStatus = 200;
});

/** Raw POST so we can set an arbitrary `Host` header. */
function rawPost(
  bodyObj: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: sidecarPort,
        method: "POST",
        path: "/api/credentials/copy-to-cloud",
        headers: { "content-type": "application/json", host: `127.0.0.1:${sidecarPort}`, ...headers },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const okBody = {
  credId: "ai:anthropic",
  extensionId: "ai:anthropic",
  name: "Anthropic",
  apiUrl: "",
  token: "member-jwt",
  workspaceId: "ws_1",
};

describe("POST /api/credentials/copy-to-cloud", () => {
  it("forwards the local plaintext to the cloud as the member, and NEVER returns it", async () => {
    const r = await rawPost({ ...okBody, apiUrl: cloudUrl });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });
    // The response body must not leak the secret.
    expect(r.body).not.toContain(LOCAL_SECRET);

    // The cloud got the secret map + the member bearer + the shared extension id.
    expect(cloudReceived).not.toBeNull();
    expect(cloudReceived!.headers["x-gtmgrid-member"]).toBe("member-jwt");
    expect(cloudReceived!.body.secrets).toEqual({ apiKey: LOCAL_SECRET });
    expect(cloudReceived!.body.extensionId).toBe("ai:anthropic");
    expect(cloudReceived!.body.workspaceId).toBe("ws_1");
  });

  it("returns a clean error and does NOT forward when no local key exists", async () => {
    const r = await rawPost({ ...okBody, credId: "ai:openai", extensionId: "ai:openai", apiUrl: cloudUrl });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).error).toMatch(/No local key/i);
    expect(cloudReceived).toBeNull();
  });

  it("surfaces a cloud-save failure without leaking the secret", async () => {
    cloudStatus = 403;
    const r = await rawPost({ ...okBody, apiUrl: cloudUrl });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).error).toMatch(/Cloud save failed/i);
    expect(r.body).not.toContain(LOCAL_SECRET);
  });

  it("REJECTS a rebound attacker Host (403) — gate not bypassed", async () => {
    const r = await rawPost({ ...okBody, apiUrl: cloudUrl }, { host: "evil.example.com" });
    expect(r.status).toBe(403);
    expect(r.body).toContain("host not allowed");
    expect(cloudReceived).toBeNull();
  });

  it("REJECTS a disallowed browser Origin (403) — gate not bypassed", async () => {
    const r = await rawPost({ ...okBody, apiUrl: cloudUrl }, { origin: HOSTILE });
    expect(r.status).toBe(403);
    expect(r.body).toContain("origin not allowed");
    expect(cloudReceived).toBeNull();
  });
});
