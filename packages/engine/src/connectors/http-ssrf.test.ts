/**
 * Proves the SSRF guard is wired into the HTTP connector's request path: with
 * `ctx.guardSsrf` a private/reserved `baseUrl` is refused BEFORE any `fetch`,
 * while a local (unguarded) run is unaffected — exactly the server-vs-sidecar
 * split. A literal-IP host is used so the check needs no DNS.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineHttpConnector } from "./http.js";
import { SsrfBlockedError } from "../ssrf.js";

const connector = (baseUrl: string) =>
  defineHttpConnector({
    id: "demo",
    name: "Demo",
    category: "enrichment",
    baseUrl,
    auth: { type: "apiKey", header: "x-api-key" },
    methods: [
      {
        id: "ping",
        label: "Ping",
        description: "test",
        verb: "GET",
        path: "/ping",
        input: z.object({}),
      },
    ],
  });

const ping = (baseUrl: string) => {
  const m = connector(baseUrl).methods.find((x) => x.id === "ping");
  if (!m) throw new Error("method not found");
  return m;
};

afterEach(() => vi.restoreAllMocks());

describe("http connector SSRF guard", () => {
  it("BLOCKS a private baseUrl on a guarded (server-side) run, before any fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      ping("http://169.254.169.254").run({}, { secrets: {}, guardSsrf: true }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT guard a local run (guardSsrf unset) — the request proceeds to fetch", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const result = await ping("http://127.0.0.1:9999").run({}, { secrets: {} });
    expect(result).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("sets redirect:'error' on a guarded request so a 3xx can't bypass the guard", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    // Public literal IP passes the guard, so the request reaches fetch — assert the
    // fail-closed redirect mode was applied.
    await ping("http://1.1.1.1").run({}, { secrets: {}, guardSsrf: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.redirect).toBe("error");
  });
});
