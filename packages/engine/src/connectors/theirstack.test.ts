import { afterEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_MANIFESTS } from "../bundled-manifests.generated.js";
import { connectorFromManifest, parseManifest } from "./manifest.js";

const raw = BUNDLED_MANIFESTS.find(
  (item) => (item as { id?: string }).id === "theirstack",
) as Record<string, unknown> | undefined;
const manifest = parseManifest(raw);

afterEach(() => vi.restoreAllMocks());

describe("TheirStack bundled connector", () => {
  it("covers every active operation in the official OpenAPI catalog", () => {
    expect(manifest.methods).toHaveLength(51);
    expect(new Set(manifest.methods.map((method) => method.id)).size).toBe(51);
    expect(manifest.methods.filter((method) => method.auth === false)).toHaveLength(10);
    expect(manifest.methods.some((method) => method.id === "get_company_lists_companies_export_v0")).toBe(false);
    expect(manifest.auth).toMatchObject({
      header: "Authorization",
      credentialLabel: "API key",
      scheme: "Bearer ",
    });
    expect(manifest.logo).toMatch(/^data:image\/png;base64,/);

    const requests = new Set(manifest.methods.map((method) => `${method.verb} ${method.path}`));
    expect(requests).toEqual(new Set([
      "GET /v0/email-preferences", "PUT /v0/email-preferences",
      "GET /v0/email-preferences/unsubscribe/{preference_key}", "POST /v0/email-preferences/unsubscribe/{preference_key}",
      "GET /v0/teams/credits_consumption", "GET /v0/company_lists", "POST /v0/company_lists",
      "GET /v0/company_lists/{list_id}", "PATCH /v0/company_lists/{list_id}", "DELETE /v0/company_lists/{list_id}",
      "GET /v0/company_lists/{list_id}/companies", "POST /v0/company_lists/{list_id}/add_companies",
      "POST /v0/company_lists/{list_id}/duplicate", "POST /v0/company_lists/{list_id}/remove_companies",
      "POST /v0/company_lists/add_companies", "POST /v0/saved_searches", "GET /v0/saved_searches",
      "GET /v0/saved_searches/{search_id}", "PATCH /v0/saved_searches/{search_id}",
      "PATCH /v0/saved_searches/{search_id}/archive", "GET /v0/saved_searches/alerts/unsubscribe",
      "POST /v0/saved_searches/alerts/unsubscribe", "POST /v0/app-urls", "GET /v0/requests/",
      "GET /v0/requests/count", "GET /v1/datasets", "POST /v1/datasets/credentials",
      "GET /v0/catalog/keywords", "GET /v0/catalog/jobs_companies_per_job_country_code",
      "GET /v0/catalog/companies_per_company_country_code", "GET /v0/catalog/locations",
      "GET /v0/catalog/industries", "GET /v0/webhooks/event-types", "GET /v0/webhooks",
      "POST /v0/webhooks", "POST /v0/webhooks/test", "GET /v0/webhooks/{webhook_id}",
      "PATCH /v0/webhooks/{webhook_id}", "PATCH /v0/webhooks/{webhook_id}/status",
      "PATCH /v0/webhooks/{webhook_id}/archive", "GET /v0/webhooks/{webhook_id}/events",
      "GET /v0/webhooks/{webhook_id}/events/count", "GET /v0/webhooks/events/count",
      "POST /v0/webhooks/events/retry", "GET /v1/catalog/keywords/categories",
      "GET /v1/catalog/keywords/subcategories", "POST /v1/jobs/search", "POST /v1/companies/search",
      "POST /v1/companies/technologies", "POST /v1/companies/buying_intents", "GET /v0/billing/credit-balance",
    ]));
  });

  it("contains self-contained schemas and official source links", () => {
    for (const method of manifest.methods) {
      expect(method.input?.type, method.id).toBe("object");
      expect(method.description, method.id).toContain("https://api.theirstack.com/openapi.json");
      expect(JSON.stringify(method.input), method.id).not.toContain('"$ref"');
    }
  });

  it("sends job filters as JSON with Bearer API-key auth", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('{"data":[{"id":"job_1","job_title":"VP Sales"}]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const method = connectorFromManifest(manifest).methods.find((item) => item.id === "search_jobs_v1")!;
    const input = { company_domain_or: ["acme.com"], posted_at_max_age_days: 30, limit: 25 };

    await expect(method.run(input, { secrets: { apiKey: "their-key" } })).resolves.toMatchObject({ data: [{ id: "job_1" }] });
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://api.theirstack.com/v1/jobs/search");
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer their-key");
    expect(JSON.parse(String(init.body))).toEqual(input);
  });

  it("encodes repeated GET query parameters without losing array values", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const method = connectorFromManifest(manifest).methods.find((item) => item.id === "get_saved_searches_v0")!;

    await method.run({ user_ids: [12, 34], order_direction: "asc" }, { secrets: { apiKey: "their-key" } });

    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.searchParams.getAll("user_ids")).toEqual(["12", "34"]);
    expect(url.searchParams.get("order_direction")).toBe("asc");
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).body).toBeUndefined();
  });

  it("runs public catalog methods without requiring or leaking a credential", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('{"data":[]}', { status: 200, headers: { "content-type": "application/json" } }),
    );
    const method = connectorFromManifest(manifest).methods.find((item) => item.id === "get_catalog_industries_v0")!;

    await expect(method.run({ industry: "software" }, { secrets: {} })).resolves.toEqual({ data: [] });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("form-encodes RFC 8058 one-click unsubscribe bodies", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }),
    );
    const method = connectorFromManifest(manifest).methods.find((item) => item.id === "unsubscribe_email_one_click_v0")!;

    await method.run(
      { preference_key: "product", token: "signed-token", list_unsubscribe: "One-Click" },
      { secrets: {} },
    );

    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.pathname).toBe("/v0/email-preferences/unsubscribe/product");
    expect(url.searchParams.get("token")).toBe("signed-token");
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(String(init.body)).toBe("list_unsubscribe=One-Click");
  });
});
