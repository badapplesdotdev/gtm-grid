/**
 * Sidecar security tests (#22): loopback bind + CORS origin allowlist on ALL
 * routes, including the privileged agent SSE stream.
 *
 * These assert REAL behavior over a real `node:http` server wired exactly like
 * the sidecar (`index.ts`): the JSON `send()` path and the agent SSE path both
 * derive their CORS headers from the shared {@link corsHeadersFor}, and the SSE
 * route is gated by {@link isOriginAllowed} — the gap that failed the prior F4
 * attempt (it left `access-control-allow-origin: *` on the SSE route).
 *
 * The fix is proven by behavior, not mocks: a disallowed Origin is NOT reflected
 * on either a JSON route or the SSE route, while the desktop origin
 * (`http://localhost:5173`) is allowed on both. We use the real `sseClient`
 * exported from `agent.ts` so the SSE assertions exercise shipped code.
 */

import { type AddressInfo } from "node:net";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cause, Effect, Exit } from "effect";
import {
  allowedOrigins,
  corsHeadersFor,
  isLoopbackHost,
  isOriginAllowed,
  resolveCors,
  OriginNotAllowed,
} from "./cors.js";
import { __sseClientForTest } from "./agent.js";

const ALLOWED = "http://localhost:5173";
const HOSTILE = "http://evil.example.com";

describe("resolveCors (pure allowlist logic)", () => {
  it("reflects an allowlisted origin (never *) with Vary: Origin", async () => {
    const headers = await Effect.runPromise(resolveCors(ALLOWED));
    expect(headers).not.toBeNull();
    expect(headers?.["access-control-allow-origin"]).toBe(ALLOWED);
    expect(headers?.["access-control-allow-origin"]).not.toBe("*");
    expect(headers?.vary).toBe("Origin");
  });

  it("fails with OriginNotAllowed for a disallowed origin", async () => {
    const exit = await Effect.runPromiseExit(resolveCors(HOSTILE));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag).toBe("Some");
      if (err._tag === "Some") {
        expect(err.value).toBeInstanceOf(OriginNotAllowed);
        expect(err.value.origin).toBe(HOSTILE);
      }
    }
  });

  it("succeeds with no headers when there is no Origin (non-browser caller)", async () => {
    expect(await Effect.runPromise(resolveCors(undefined))).toBeNull();
    expect(await Effect.runPromise(resolveCors(""))).toBeNull();
  });

  it("honours extra origins from GTMGRID_ALLOWED_ORIGINS", () => {
    const allow = allowedOrigins({ GTMGRID_ALLOWED_ORIGINS: "http://localhost:1234, app://x" } as NodeJS.ProcessEnv);
    expect(allow).toContain("http://localhost:1234");
    expect(allow).toContain("app://x");
    expect(allow).toContain("http://localhost:5173");
  });
});

describe("corsHeadersFor / isOriginAllowed (HTTP-seam helpers)", () => {
  it("never emits a wildcard for any input", () => {
    expect(corsHeadersFor(ALLOWED)?.["access-control-allow-origin"]).toBe(ALLOWED);
    expect(corsHeadersFor(HOSTILE)).toBeNull(); // disallowed -> no ACAO header at all
    expect(corsHeadersFor(undefined)).toBeNull();
  });

  it("permits missing/allowed origins and rejects disallowed ones", () => {
    expect(isOriginAllowed(undefined)).toBe(true);
    expect(isOriginAllowed(ALLOWED)).toBe(true);
    expect(isOriginAllowed(HOSTILE)).toBe(false);
  });
});

describe("isLoopbackHost (DNS-rebinding guard)", () => {
  it("accepts loopback hosts with or without a port", () => {
    expect(isLoopbackHost("127.0.0.1:8787")).toBe(true);
    expect(isLoopbackHost("localhost:8787")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("LOCALHOST:5173")).toBe(true);
    expect(isLoopbackHost("[::1]:8787")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
  });

  it("rejects a rebound attacker host, a missing host, and LAN/public hosts", () => {
    expect(isLoopbackHost("evil.example.com:8787")).toBe(false);
    expect(isLoopbackHost("evil.example.com")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.com")).toBe(false);
    expect(isLoopbackHost("192.168.1.10:8787")).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
  });
});

/**
 * A real HTTP server wired exactly like `index.ts`: a JSON route via a `send`
 * that mirrors the sidecar's CORS application, and an SSE route via the real
 * `__sseClientForTest` (the sidecar's `sseClient`) gated by `isOriginAllowed`.
 */
function send(res: ServerResponse, status: number, data: unknown, origin?: string) {
  res.writeHead(status, { "content-type": "application/json", ...corsHeadersFor(origin) });
  res.end(JSON.stringify(data));
}

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const origin = req.headers.origin;
    if (req.url === "/json") return send(res, 200, { ok: true }, origin);
    if (req.url === "/sse") {
      // Same gate as the privileged /api/agent/chat route in index.ts.
      if (!isOriginAllowed(origin)) return send(res, 403, { error: "origin not allowed" }, origin);
      const sse = __sseClientForTest(res, origin);
      sse.write({ type: "hello" });
      return sse.end();
    }
    send(res, 404, { error: "not found" }, origin);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("end-to-end CORS over a real http server", () => {
  it("JSON route: reflects the desktop origin, never *", async () => {
    const r = await fetch(`${base}/json`, { headers: { origin: ALLOWED } });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe(ALLOWED);
  });

  it("JSON route: a disallowed origin is NOT reflected (no ACAO header)", async () => {
    const r = await fetch(`${base}/json`, { headers: { origin: HOSTILE } });
    expect(r.status).toBe(200); // request still served to non-browser tools...
    expect(r.headers.get("access-control-allow-origin")).toBeNull(); // ...but a browser page can't read it
  });

  it("SSE route: reflects the desktop origin, never * (the prior F4 gap)", async () => {
    const r = await fetch(`${base}/sse`, { headers: { origin: ALLOWED } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    expect(r.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(r.headers.get("access-control-allow-origin")).not.toBe("*");
    await r.body?.cancel();
  });

  it("SSE route: a disallowed origin is REJECTED (403) and never reflected", async () => {
    const r = await fetch(`${base}/sse`, { headers: { origin: HOSTILE } });
    expect(r.status).toBe(403);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("both routes still work for a non-browser caller (no Origin)", async () => {
    const json = await fetch(`${base}/json`);
    expect(json.status).toBe(200);
    expect(json.headers.get("access-control-allow-origin")).toBeNull();
    const sse = await fetch(`${base}/sse`);
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    await sse.body?.cancel();
  });
});

/**
 * The request guard wired exactly like the top of `index.ts`'s handler: reject a
 * non-loopback `Host` (DNS rebinding) and a present-but-disallowed `Origin`
 * (CSRF) on EVERY route, before any handler work. Proven over a real server with
 * raw `node:http` requests so we can set a custom `Host` header (undici's `fetch`
 * forbids overriding `Host`, exactly as a browser does — which is the property
 * the guard relies on).
 */
function guard(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (!isLoopbackHost(req.headers.host)) {
    send(res, 403, { error: "host not allowed" }, origin);
    return false;
  }
  if (!isOriginAllowed(origin)) {
    send(res, 403, { error: "origin not allowed" }, origin);
    return false;
  }
  return true;
}

/** Raw `node:http` GET so we can set an arbitrary `Host` header (fetch can't). */
function rawGet(
  port: number,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: "GET", path: "/json", headers },
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

describe("request guard (DNS-rebinding + CSRF) — index.ts top-of-handler", () => {
  let gserver: Server;
  let gport: number;

  beforeAll(async () => {
    gserver = createServer((req, res) => {
      if (!guard(req, res)) return;
      send(res, 200, { ok: true }, req.headers.origin);
    });
    await new Promise<void>((resolve) => gserver.listen(0, "127.0.0.1", resolve));
    gport = (gserver.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>((resolve) => gserver.close(() => resolve())));

  it("serves a loopback Host with no Origin (the desktop/CLI caller)", async () => {
    const r = await rawGet(gport, { host: `localhost:${gport}` });
    expect(r.status).toBe(200);
  });

  it("serves a loopback Host + the allowed desktop Origin", async () => {
    const r = await rawGet(gport, { host: `127.0.0.1:${gport}`, origin: ALLOWED });
    expect(r.status).toBe(200);
  });

  it("REJECTS a rebound attacker Host (403) even with no Origin", async () => {
    const r = await rawGet(gport, { host: "evil.example.com" });
    expect(r.status).toBe(403);
    expect(r.body).toContain("host not allowed");
  });

  it("REJECTS a disallowed browser Origin (403) — blocks the text/plain CSRF write", async () => {
    const r = await rawGet(gport, { host: `127.0.0.1:${gport}`, origin: HOSTILE });
    expect(r.status).toBe(403);
    expect(r.body).toContain("origin not allowed");
  });
});
