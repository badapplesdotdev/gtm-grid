// The generic `http.request` connector: builds an arbitrary request from its
// inputs (method/url/query/headers/body), parses the response, and throws on
// non-2xx. Also proves nested {{Column}} templating reaches `headers`/`body`
// end-to-end through `Engine.runColumn` (the whole point of the HTTP column).

import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../execute.js";
import { Registry } from "../registry.js";
import { httpRequestConnector } from "./http-request.js";
import { SsrfBlockedError } from "../ssrf.js";
import { makeMemoryStore } from "../test-helpers.js";
import type { Connector, ConnectorMethod, MethodContext } from "../types.js";

const method = (): ConnectorMethod => {
  const m = httpRequestConnector.methods.find((x) => x.id === "request");
  if (!m) throw new Error("http.request not found");
  return m;
};
const ctx: MethodContext = { secrets: {} };

afterEach(() => vi.restoreAllMocks());

describe("http.request connector", () => {
  it("GETs a URL, merges query params, and returns parsed JSON", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await method().run(
      { url: "https://api.example.com/v1/users", query: { id: "42", active: "true" } },
      ctx,
    );

    expect(result).toEqual({ ok: true });
    const [calledUrl, init] = fetchSpy.mock.calls[0]!;
    expect(String(calledUrl)).toBe("https://api.example.com/v1/users?id=42&active=true");
    expect(init?.method).toBe("GET");
  });

  it("POSTs a JSON object body with content-type set, plus custom headers", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ created: 1 }), { status: 201, headers: { "content-type": "application/json" } }));

    await method().run(
      {
        url: "https://api.example.com/v1/people/search",
        method: "POST",
        headers: { "X-API-Key": "secret-123" },
        body: { company_domain: "stripe.com", limit: 10 },
      },
      ctx,
    );

    const init = fetchSpy.mock.calls[0]![1]!;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ company_domain: "stripe.com", limit: 10 }));
    const headers = init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("secret-123");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("sends a raw string body unchanged and respects a caller-provided content-type", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }));

    const result = await method().run(
      {
        url: "https://api.example.com/raw",
        method: "PUT",
        headers: { "Content-Type": "text/csv" },
        body: "a,b,c",
      },
      ctx,
    );

    expect(result).toBe("ok"); // non-JSON response returned as text
    const init = fetchSpy.mock.calls[0]![1]!;
    expect(init.body).toBe("a,b,c");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("text/csv");
    expect(headers["content-type"]).toBeUndefined(); // we did not double-add it
  });

  it("throws on a non-2xx response with the status and body detail", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "nope" }), { status: 422 }),
    );
    await expect(method().run({ url: "https://api.example.com/x", method: "POST", body: {} }, ctx)).rejects.toThrow(
      /HTTP 422/,
    );
  });

  it("rejects an invalid method and a missing url", async () => {
    await expect(method().run({ url: "https://x.com", method: "TRACE" }, ctx)).rejects.toThrow(/unsupported method/);
    await expect(method().run({ url: "  " }, ctx)).rejects.toThrow(/'url' is required/);
  });

  it("enforces the SSRF guard on server-side runs before any fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      method().run({ url: "http://169.254.169.254/latest/meta-data" }, { secrets: {}, guardSsrf: true }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("picks only the requested responseFields (by dot-path)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ email: "a@b.com", company: { name: "Stripe", id: 9 }, results: [{ id: 7 }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const result = await method().run(
      { url: "https://api.example.com/p", responseFields: ["email", "company.name", "results.0.id"] },
      ctx,
    );
    expect(result).toEqual({ email: "a@b.com", "company.name": "Stripe", "results.0.id": 7 });
  });

  it("removes empty values by default, and keeps them when removeEmpty is false", async () => {
    const payload = { a: 1, b: null, c: "", d: [], e: { x: "" }, f: false, g: 0 };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const pruned = await method().run({ url: "https://api.example.com/p" }, ctx);
    expect(pruned).toEqual({ a: 1, f: false, g: 0 }); // null/""/[]/{} dropped, falsy-meaningful kept

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const kept = await method().run({ url: "https://api.example.com/p", removeEmpty: false }, ctx);
    expect(kept).toEqual(payload);
  });

  it("wraps the response with metadata when returnMetadata is true", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, statusText: "OK", headers: { "content-type": "application/json", "x-trace": "abc" } }),
    );
    const result = (await method().run(
      { url: "https://api.example.com/p", returnMetadata: true },
      ctx,
    )) as any;
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(result.headers["x-trace"]).toBe("abc");
  });

  it("disables retries when retryOnFailure is false (single attempt on a 503)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("busy", { status: 503 }));
    await expect(
      method().run({ url: "https://api.example.com/p", retryOnFailure: false }, ctx),
    ).rejects.toThrow(/HTTP 503/);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // no retry storm
  });

  it("follows a redirect on a local (unguarded) run up to maxRedirects", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://api.example.com/final" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ arrived: true }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await method().run({ url: "https://api.example.com/start" }, ctx);
    expect(result).toEqual({ arrived: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[1]![0])).toBe("https://api.example.com/final");
  });

  it("does NOT follow redirects when followRedirects is false (returns the 3xx body)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 301, headers: { location: "https://elsewhere.com" } }));
    await method().run({ url: "https://api.example.com/start", followRedirects: false }, ctx);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // did not chase the Location
  });
});

// ── End-to-end: nested {{Column}} templating through Engine.runColumn ──
describe("http.request nested templating via runColumn", () => {
  it("interpolates cell values inside `url`, `headers`, and `body`", async () => {
    // A stub http connector that echoes the (already-resolved) inputs into the cell,
    // so we can assert templating reached the nested objects.
    const echoRequest: ConnectorMethod = {
      id: "request",
      label: "HTTP Request",
      description: "echo",
      inputSchema: {},
      batchSize: 1,
      credits: 0,
      run: async (inputs) => inputs,
    };
    const stub: Connector = { id: "http", name: "HTTP", category: "http", auth: null, methods: [echoRequest] };

    const store = makeMemoryStore();
    store.addColumn({ id: "token", table_id: "t", name: "Token", kind: "manual" });
    store.addColumn({ id: "domain", table_id: "t", name: "Domain", kind: "manual" });
    store.addColumn({
      id: "out",
      table_id: "t",
      name: "Resp",
      kind: "function",
      provider: "http",
      method: "request",
      params: {
        url: "https://api.example.com/search?domain={{Domain}}",
        method: "POST",
        headers: { Authorization: "Bearer {{Token}}" },
        body: { company_domain: "{{Domain}}", limit: 10 },
      },
    });
    store.addRow({ id: "r", table_id: "t" });
    store.setCellSync("r", "token", { value: "tok_abc", status: "done" });
    store.setCellSync("r", "domain", { value: "stripe.com", status: "done" });

    const engine = new Engine({}, new Registry([stub]), { store, creds: store });
    const res = await engine.runColumn("out", { force: true });
    expect(res).toEqual({ ran: 1, errors: 0 });

    const cell = store.readCell("r", "out");
    const value = cell?.value as { url: string; headers: Record<string, string>; body: Record<string, unknown> };
    expect(value.url).toBe("https://api.example.com/search?domain=stripe.com");
    expect(value.headers.Authorization).toBe("Bearer tok_abc");
    expect(value.body.company_domain).toBe("stripe.com");
    expect(value.body.limit).toBe(10); // non-string leaf preserved, stays a number
  });
});

// ── "Try on N rows" preview — Engine.previewColumn ──
describe("Engine.previewColumn (Try on N rows)", () => {
  const stubWith = (run: ConnectorMethod["run"]): Connector => ({
    id: "http", name: "HTTP", category: "http", auth: null,
    methods: [{ id: "request", label: "HTTP Request", description: "stub", inputSchema: {}, batchSize: 1, credits: 0, run }],
  });

  it("dry-runs the first N rows with templated params and writes NO cells", async () => {
    const store = makeMemoryStore();
    store.addColumn({ id: "domain", table_id: "t", name: "Domain", kind: "manual" });
    const rows = ["a.com", "b.com", "c.com"].map((d, i) => {
      const id = `r${i}`;
      store.addRow({ id, table_id: "t" });
      store.setCellSync(id, "domain", { value: d, status: "done" });
      return { id };
    });

    const engine = new Engine({}, new Registry([stubWith(async (i) => ({ hit: i.url }))]), { store, creds: store });
    const results = await engine.previewColumn(
      { provider: "http", method: "request", table_id: "t", params: { url: "https://x/{{Domain}}" } },
      2,
    );

    expect(results).toHaveLength(2); // limited to first 2 of 3 rows
    expect(results[0]).toMatchObject({ rowId: rows[0].id, value: { hit: "https://x/a.com" } });
    expect(results[1].value).toEqual({ hit: "https://x/b.com" });
    // Preview must not persist anything: the existing Domain cells are untouched
    // and the transient column id never appears in the store.
    expect(store.readCell(rows[0].id, "domain")?.value).toBe("a.com");
    expect(store.readCell(rows[0].id, "__preview__")).toBeUndefined();
  });

  it("captures a per-row error instead of throwing", async () => {
    const store = makeMemoryStore();
    store.addColumn({ id: "domain", table_id: "t", name: "Domain", kind: "manual" });
    store.addRow({ id: "r", table_id: "t" });
    const engine = new Engine({}, new Registry([stubWith(async () => { throw new Error("kaboom"); })]), { store, creds: store });
    const results = await engine.previewColumn(
      { provider: "http", method: "request", table_id: "t", params: { url: "https://x" } },
      5,
    );
    expect(results).toHaveLength(1);
    expect(results[0].error).toMatch(/kaboom/);
    expect(results[0].value).toBeUndefined();
  });
});
