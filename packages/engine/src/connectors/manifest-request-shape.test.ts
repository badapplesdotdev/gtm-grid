import { afterEach, describe, expect, it, vi } from "vitest";
import { connectorFromManifest, parseManifest } from "./manifest.js";
import type { MethodContext } from "../types.js";

const manifest = parseManifest({
  id: "request-shapes",
  name: "Request Shapes",
  baseUrl: "https://api.example.test",
  auth: null,
  methods: [
    {
      id: "search",
      description: "POST with pagination in the query string",
      verb: "POST",
      path: "/contacts/search",
      query: ["page[number]", "page[size]"],
      bodyOmit: ["page[number]", "page[size]"],
      contentType: "application/vnd.api+json",
      input: { type: "object", properties: {} },
    },
    {
      id: "bulkDelete",
      description: "DELETE with a JSON body",
      verb: "DELETE",
      path: "/audiences/{audienceId}/rows",
      body: true,
      contentType: "application/vnd.api+json",
      input: { type: "object", properties: {} },
    },
  ],
});

const ctx: MethodContext = { secrets: {} };
const json = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("manifest request shapes", () => {
  it("keeps declared query fields out of a POST JSON body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json());
    const method = connectorFromManifest(manifest).methods.find((item) => item.id === "search")!;

    await method.run({ "page[number]": 2, "page[size]": 100, data: { type: "ContactSearch" } }, ctx);

    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      "https://api.example.test/contacts/search?page%5Bnumber%5D=2&page%5Bsize%5D=100",
    );
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe(JSON.stringify({ data: { type: "ContactSearch" } }));
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/vnd.api+json");
  });

  it("supports a DELETE request with a JSON body and omits path fields", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json());
    const method = connectorFromManifest(manifest).methods.find((item) => item.id === "bulkDelete")!;

    await method.run({ audienceId: "aud-1", data: [{ type: "Row", id: "row-1" }] }, ctx);

    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://api.example.test/audiences/aud-1/rows");
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect(init.body).toBe(JSON.stringify({ data: [{ type: "Row", id: "row-1" }] }));
  });
});
