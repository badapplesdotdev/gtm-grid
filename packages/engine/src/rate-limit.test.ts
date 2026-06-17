import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { RateLimiter } from "./execute.js";
import { extractOptions, connectorFromManifest, parseManifest } from "./connectors/manifest.js";
import { defineHttpConnector } from "./connectors/http.js";
import type { MethodContext } from "./types.js";

describe("RateLimiter", () => {
  it("spreads call STARTS by the min interval derived from rps", async () => {
    // 20 rps → 50ms between starts. 5 calls should take ≥ ~200ms (4 gaps).
    const rl = new RateLimiter({ rps: 20 });
    const starts: number[] = [];
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: 5 }, () => rl.run(async () => { starts.push(Date.now() - t0); })),
    );
    starts.sort((a, b) => a - b);
    expect(starts.length).toBe(5);
    // Last start is at least ~4 intervals out (allow slack for timer coarseness).
    expect(starts[4]).toBeGreaterThanOrEqual(150);
  });

  it("caps in-flight calls at `concurrency`", async () => {
    const rl = new RateLimiter({ concurrency: 2 });
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        rl.run(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 20));
          inFlight--;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("is a passthrough when no bounds are set", async () => {
    const rl = new RateLimiter({});
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 10 }, () => rl.run(async () => {})));
    expect(Date.now() - t0).toBeLessThan(50);
  });
});

describe("extractOptions", () => {
  it("maps an items[] envelope to {label,value} with default keys", () => {
    const raw = { items: [{ id: "a1", name: "Campaign A" }, { id: "b2", name: "Campaign B" }] };
    expect(extractOptions(raw, {})).toEqual([
      { label: "Campaign A", value: "a1" },
      { label: "Campaign B", value: "b2" },
    ]);
  });

  it("honours explicit keys, itemsPath and sublabel; coerces numeric ids to strings", () => {
    const raw = { data: { rows: [{ pk: 7, title: "List X", state: "active" }] } };
    expect(
      extractOptions(raw, { itemsPath: "data.rows", labelKey: "title", valueKey: "pk", sublabelKey: "state" }),
    ).toEqual([{ label: "List X", value: "7", sublabel: "active" }]);
  });

  it("skips items with no resolvable value and tolerates a bare array", () => {
    const raw = [{ id: "x", name: "X" }, { name: "no id" }];
    expect(extractOptions(raw, {})).toEqual([{ label: "X", value: "x" }]);
  });
});

describe("connectorFromManifest — options + rateLimit", () => {
  const man = parseManifest({
    id: "demo",
    name: "Demo",
    baseUrl: "https://example.com",
    auth: { type: "apiKey", header: "X-API-KEY" },
    rateLimit: { rpm: 120 },
    methods: [
      { id: "listThings", description: "list", verb: "GET", path: "/things" },
      {
        id: "useThing",
        description: "use",
        verb: "POST",
        path: "/use",
        input: { type: "object", properties: { thingId: { type: "integer" } } },
        options: { thingId: { method: "listThings", labelKey: "name", valueKey: "id" } },
        rateLimit: { rps: 1 },
      },
    ],
  });
  const conn = connectorFromManifest(man);

  it("attaches the connector-default rateLimit and per-method override", () => {
    expect(conn.rateLimit).toEqual({ rpm: 120 });
    const list = conn.methods.find((m) => m.id === "listThings")!;
    const use = conn.methods.find((m) => m.id === "useThing")!;
    // Inherited default is the SAME object reference (lets the engine detect overrides).
    expect(list.rateLimit).toBe(conn.rateLimit);
    expect(use.rateLimit).toEqual({ rps: 1 });
    expect(use.rateLimit).not.toBe(conn.rateLimit);
  });

  it("surfaces the field option source", () => {
    const use = conn.methods.find((m) => m.id === "useThing")!;
    expect(use.options?.thingId).toMatchObject({ method: "listThings", valueKey: "id" });
  });
});

describe("manifest connector — HTTP resilience (fetchWithRetry)", () => {
  const man = parseManifest({
    id: "demo",
    name: "Demo",
    baseUrl: "https://example.com",
    auth: { type: "apiKey", header: "X-API-KEY" },
    methods: [{ id: "get", description: "get a thing", verb: "GET", path: "/thing" }],
  });
  const run = connectorFromManifest(man).methods.find((m) => m.id === "get")!.run;
  const ctx = { secrets: { apiKey: "k" } } as unknown as MethodContext;

  afterEach(() => vi.unstubAllGlobals());

  it("retries a transient 429 then succeeds (routed through fetchWithRetry)", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return calls === 1
          ? new Response("slow down", { status: 429 })
          : new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
      }),
    );
    await expect(run({}, ctx)).resolves.toEqual({ ok: true });
    expect(calls).toBe(2); // first 429 was retried, second 200 returned
  });

  it("fails fast on a non-retryable 4xx (a single call, no retry)", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(run({}, ctx)).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still returns the Location for a 3xx redirect (avatar/image endpoints)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://cdn.example/x.png" } })),
    );
    await expect(run({}, ctx)).resolves.toBe("https://cdn.example/x.png");
  });
});

describe("defineHttpConnector — rateLimit propagation", () => {
  const conn = defineHttpConnector({
    id: "demo-http",
    name: "Demo HTTP",
    category: "test",
    baseUrl: "https://example.com",
    auth: null,
    rateLimit: { rps: 5, concurrency: 4 },
    methods: [
      { id: "a", label: "A", description: "a", verb: "GET", path: "/a", input: z.object({}) },
      {
        id: "b",
        label: "B",
        description: "b",
        verb: "GET",
        path: "/b",
        input: z.object({}),
        rateLimit: { rps: 1 }, // stricter per-method override
      },
    ],
  });

  it("sets the connector default and inherits it (same object ref) on un-overridden methods", () => {
    expect(conn.rateLimit).toEqual({ rps: 5, concurrency: 4 });
    const a = conn.methods.find((m) => m.id === "a")!;
    // Same reference, so Engine.throttle treats it as inherited (not a per-method gate).
    expect(a.rateLimit).toBe(conn.rateLimit);
  });

  it("lets a method override the connector default with its own object", () => {
    const b = conn.methods.find((m) => m.id === "b")!;
    expect(b.rateLimit).toEqual({ rps: 1 });
    expect(b.rateLimit).not.toBe(conn.rateLimit);
  });

  it("leaves rateLimit undefined when the connector declares none (engine applies its default)", () => {
    const bare = defineHttpConnector({
      id: "bare",
      name: "Bare",
      category: "test",
      baseUrl: "https://example.com",
      auth: null,
      methods: [{ id: "a", label: "A", description: "a", verb: "GET", path: "/a", input: z.object({}) }],
    });
    expect(bare.rateLimit).toBeUndefined();
    expect(bare.methods[0].rateLimit).toBeUndefined();
  });
});
