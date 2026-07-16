import { afterEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_MANIFESTS } from "../bundled-manifests.generated.js";
import { connectorFromManifest, parseManifest } from "./manifest.js";

const raw = BUNDLED_MANIFESTS.find(
  (item) => (item as { id?: string }).id === "peopledatalabs",
) as Record<string, unknown> | undefined;
const manifest = parseManifest(raw);

afterEach(() => vi.restoreAllMocks());

describe("People Data Labs bundled connector", () => {
  it("covers the complete current production API catalog", () => {
    expect(manifest.methods).toHaveLength(27);
    expect(new Set(manifest.methods.map((method) => method.id)).size).toBe(27);
    expect(manifest.auth).toMatchObject({ header: "X-Api-Key", credentialLabel: "API key", scheme: "" });
    expect(manifest.logo).toMatch(/^data:image\/vnd\.microsoft\.icon;base64,/);
    expect(new Set(manifest.methods.map((method) => `${method.verb} ${method.path}`))).toEqual(new Set([
      "GET /v5/person/enrich", "POST /v5/person/enrich", "GET /v5/person/identify",
      "GET /v5/person/search", "POST /v5/person/search", "GET /v5/person/retrieve/{person_id}",
      "POST /v5/person/retrieve/bulk", "POST /v5/person/bulk", "POST /v5/person/changelog",
      "GET /v5/person/subjectrequest", "GET /v5/company/clean", "POST /v5/company/clean",
      "GET /v5/school/clean", "POST /v5/school/clean", "GET /v5/location/clean",
      "POST /v5/location/clean", "GET /v5/company/enrich", "POST /v5/company/enrich/bulk",
      "GET /v5/company/search", "POST /v5/company/search", "GET /v5/autocomplete",
      "POST /v5/autocomplete", "GET /v5/ip/enrich", "GET /v5/job_title/enrich",
      "POST /v5/job_title/enrich", "GET /v5/skill/enrich", "POST /v5/job_posting/search",
    ]));
  });

  it("contains self-contained typed inputs and official source links", () => {
    for (const method of manifest.methods) {
      expect(method.input?.type, method.id).toBe("object");
      expect(method.description, method.id).toMatch(/peopledatalabs|People Data Labs|PDL/i);
      expect(JSON.stringify(method.input), method.id).not.toContain('"$ref"');
    }
    expect(manifest.methods.find((method) => method.id === "bulkPersonEnrichment")?.input)
      .toMatchObject({ properties: { requests: { minItems: 1, maxItems: 100 } } });
    expect(manifest.methods.find((method) => method.id === "searchJobPostings"))
      .toMatchObject({ rateLimit: { rpm: 20, concurrency: 1 }, credits: 1 });
  });

  it("sends GET person enrichment fields as query parameters with raw X-Api-Key auth", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('{"status":200,"likelihood":10,"data":{"id":"pdl_1","full_name":"Ada Lovelace"}}', {
        status: 200, headers: { "content-type": "application/json" },
      }),
    );
    const method = connectorFromManifest(manifest).methods.find((item) => item.id === "getPersonEnrichment")!;
    await expect(method.run(
      { email: "ada@acme.com", min_likelihood: 8, include_if_matched: true },
      { secrets: { apiKey: "pdl-key" } },
    )).resolves.toMatchObject({ likelihood: 10, data: { id: "pdl_1" } });
    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.pathname).toBe("/v5/person/enrich");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      email: "ada@acme.com", min_likelihood: "8", include_if_matched: "true",
    });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Api-Key"]).toBe("pdl-key");
    expect((init.headers as Record<string, string>)["X-Api-Key"]).not.toContain("Bearer");
    expect(init.body).toBeUndefined();
  });

  it("supports JSON POST and bulk enrichment request shapes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response('{"status":200}', { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response('[{"status":200}]', { status: 200, headers: { "content-type": "application/json" } }));
    const connector = connectorFromManifest(manifest);
    await connector.methods.find((item) => item.id === "postPersonEnrichment")!
      .run({ profile: "linkedin.com/in/ada", min_likelihood: 7 }, { secrets: { apiKey: "pdl-key" } });
    await connector.methods.find((item) => item.id === "bulkPersonEnrichment")!.run({
      requests: [
        { params: { email: "ada@acme.com" }, metadata: { row: "row_1" } },
        { params: { email: "grace@globex.com" }, metadata: { row: "row_2" } },
      ],
      data_include: "id,full_name,job_title",
    }, { secrets: { apiKey: "pdl-key" } });
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://api.peopledatalabs.com/v5/person/enrich");
    expect(JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body))).toEqual({
      profile: "linkedin.com/in/ada", min_likelihood: 7,
    });
    expect(JSON.parse(String((fetchSpy.mock.calls[1]![1] as RequestInit).body))).toMatchObject({
      requests: [{ params: { email: "ada@acme.com" } }, { params: { email: "grace@globex.com" } }],
    });
  });

  it("preserves text responses and surfaces authentication errors", async () => {
    const connector = connectorFromManifest(manifest);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("pdl_id_1\npdl_id_2\n", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    await expect(connector.methods.find((item) => item.id === "getSubjectRequests")!
      .run({}, { secrets: { apiKey: "pdl-key" } })).resolves.toBe("pdl_id_1\npdl_id_2\n");

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('{"error":{"message":"The API key is invalid."}}', {
        status: 401, headers: { "content-type": "application/json" },
      }),
    );
    const enrich = connector.methods.find((item) => item.id === "getPersonEnrichment")!;
    await expect(enrich.run({ email: "ada@acme.com" }, { secrets: { apiKey: "secret-pdl-key" } })).rejects.toThrow(/401/);
    await expect(enrich.run({}, { secrets: {} })).rejects.toThrow(/People Data Labs API key/i);
  });
});
