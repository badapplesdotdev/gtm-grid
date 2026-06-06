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
import { createServer, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cause, Effect, Exit } from "effect";
import {
  allowedOrigins,
  corsHeadersFor,
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
