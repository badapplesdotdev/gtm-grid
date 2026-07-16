import { afterEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_MANIFESTS } from "../bundled-manifests.generated.js";
import { connectorFromManifest, parseManifest } from "./manifest.js";

const raw = BUNDLED_MANIFESTS.find(
  (item) => (item as { id?: string }).id === "surfe",
) as Record<string, unknown> | undefined;

const manifest = parseManifest(raw);

afterEach(() => vi.restoreAllMocks());

describe("Surfe bundled connector", () => {
  it("covers every current endpoint in the official API catalog", () => {
    expect(manifest.methods).toHaveLength(12);
    expect(new Set(manifest.methods.map((method) => method.id)).size).toBe(12);
    expect(manifest.auth).toMatchObject({
      header: "Authorization",
      credentialLabel: "API key",
      scheme: "Bearer ",
    });
    expect(manifest.rateLimit).toMatchObject({ rps: 10, concurrency: 3 });
    expect(manifest.logo).toMatch(/^data:image\/png;base64,/);

    const requests = new Set(manifest.methods.map((method) => `${method.verb} ${method.path}`));
    expect(requests).toEqual(new Set([
      "POST /v2/people/search",
      "POST /v2/people/enrich",
      "GET /v2/people/enrich/{id}",
      "POST /v2/people/find-by-email",
      "POST /v2/companies/search",
      "POST /v2/companies/enrich",
      "GET /v2/companies/enrich/{id}",
      "POST /v2/recommendations/icp",
      "POST /v2/recommendations/fetch",
      "GET /v2/recommendations/icp",
      "GET /v1/credits",
      "GET /v1/people/search/filters",
    ]));
  });

  it("contains self-contained schemas and a source link for every endpoint", () => {
    for (const method of manifest.methods) {
      expect(method.input?.type, method.id).toBe("object");
      expect(method.description, method.id).toContain("https://developers.surfe.com/public-");
      expect(JSON.stringify(method.input), method.id).not.toContain('"$ref"');
    }
  });

  it("sends nested search filters as JSON with Bearer API-key auth", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('{"people":[]}', { status: 200, headers: { "content-type": "application/json" } }),
    );
    const method = connectorFromManifest(manifest).methods.find((item) => item.id === "searchPeople")!;

    await method.run(
      { limit: 10, companies: { domains: ["surfe.com"] }, people: { jobTitles: ["CTO"] } },
      { secrets: { apiKey: "surfe-key" } },
    );

    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://api.surfe.com/v2/people/search");
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer surfe-key");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      limit: 10,
      companies: { domains: ["surfe.com"] },
      people: { jobTitles: ["CTO"] },
    });
  });

  it("places externalUserId in the ICP GET query string", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('{"icpFilters":[]}', { status: 200, headers: { "content-type": "application/json" } }),
    );
    const method = connectorFromManifest(manifest).methods.find((item) => item.id === "getRecommendationIcps")!;

    await method.run({ externalUserId: "customer-42" }, { secrets: { apiKey: "surfe-key" } });

    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      "https://api.surfe.com/v2/recommendations/icp?externalUserId=customer-42",
    );
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).body).toBeUndefined();
  });
});
