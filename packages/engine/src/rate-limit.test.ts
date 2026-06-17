import { describe, it, expect } from "vitest";
import { RateLimiter } from "./execute.js";
import { extractOptions, connectorFromManifest, parseManifest } from "./connectors/manifest.js";

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
