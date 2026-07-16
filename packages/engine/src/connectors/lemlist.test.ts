import { afterEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_MANIFESTS } from "../bundled-manifests.generated.js";
import { connectorFromManifest, parseManifest } from "./manifest.js";

const raw = BUNDLED_MANIFESTS.find(
  (item) => (item as { id?: string }).id === "lemlist",
) as Record<string, unknown> | undefined;
const manifest = parseManifest(raw);

afterEach(() => vi.restoreAllMocks());

describe("Lemlist bundled connector", () => {
  it("covers every operation in the official catalog", () => {
    expect(manifest.methods).toHaveLength(140);
    expect(new Set(manifest.methods.map((method) => method.id)).size).toBe(140);
    expect(new Set(manifest.methods.map((method) => `${method.verb} ${method.path}`)).size).toBe(140);
    expect(new Set(manifest.methods.map((method) => method.path)).size).toBe(99);
    expect(manifest.methods.filter((method) => method.description.includes("Deprecated by Lemlist"))).toHaveLength(5);
    expect(manifest.methods.some((method) => method.id === "unsubscribeAllCampaignLeads")).toBe(true);
    expect(manifest.auth).toMatchObject({
      header: "Authorization", scheme: "Basic ", basicUsername: "", credentialLabel: "API key",
    });
    expect(manifest.rateLimit).toEqual({ rps: 10, concurrency: 3 });
    expect(manifest.logo).toMatch(/^data:image\/png;base64,/);
  });

  it("has self-contained schemas and official documentation links", () => {
    for (const method of manifest.methods) {
      expect(method.input?.type, method.id).toBe("object");
      expect(method.description, method.id).toContain("https://developer.lemlist.com/");
      expect(JSON.stringify(method.input), method.id).not.toContain('"$ref"');
    }
    expect(manifest.methods.find((method) => method.id === "bulkEnrichData")).toMatchObject({
      bodyFrom: "items",
      contentType: "application/json",
      input: { properties: { items: { type: "array", maxItems: 500 } } },
    });
    expect(manifest.methods.find((method) => method.id === "uploadAudioForVoiceMessageStep"))
      .toMatchObject({ contentType: "multipart/form-data" });
  });

  it("uses Basic auth with an empty username and separates lead query fields from JSON", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('{"_id":"lea_1","email":"ada@acme.com"}', {
        status: 200, headers: { "content-type": "application/json" },
      }),
    );
    const method = connectorFromManifest(manifest).methods.find((item) => item.id === "createLeadInCampaign")!;
    await method.run({
      campaignId: "cam_1", deduplicate: true, findEmail: false,
      email: "ada@acme.com", firstName: "Ada", companyName: "Acme",
    }, { secrets: { apiKey: "lem-key" } });

    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.pathname).toBe("/api/campaigns/cam_1/leads/");
    expect(Object.fromEntries(url.searchParams)).toEqual({ deduplicate: "true", findEmail: "false" });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization)
      .toBe(`Basic ${Buffer.from(":lem-key").toString("base64")}`);
    expect(JSON.parse(String(init.body))).toEqual({ email: "ada@acme.com", firstName: "Ada", companyName: "Acme" });
  });

  it("sends bulk enrichment as a top-level JSON array", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('{"enrichmentId":"enr_1"}', { status: 200, headers: { "content-type": "application/json" } }),
    );
    const method = connectorFromManifest(manifest).methods.find((item) => item.id === "bulkEnrichData")!;
    const items = [
      { input: { firstName: "Ada", lastName: "Lovelace", companyDomain: "acme.com" }, enrichmentRequests: ["find_email"] },
      { input: { linkedinUrl: "https://linkedin.com/in/grace" }, enrichmentRequests: ["find_phone", "verify"] },
    ];
    await method.run({ items, webhookUrl: "https://example.com/hook" }, { secrets: { apiKey: "lem-key" } });

    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(url.searchParams.get("webhookUrl")).toBe("https://example.com/hook");
    expect(JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body))).toEqual(items);
  });

  it("constructs multipart audio uploads without overriding the generated boundary", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }),
    );
    const method = connectorFromManifest(manifest).methods.find((item) => item.id === "uploadAudioForVoiceMessageStep")!;
    await method.run({
      leadId: "lea_1", stepId: "stp_1", file: "data:audio/wav;base64,SGVsbG8=",
    }, { secrets: { apiKey: "lem-key" } });

    const url = new URL(String(fetchSpy.mock.calls[0]![0]));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ leadId: "lea_1", stepId: "stp_1" });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("file")).toBeInstanceOf(Blob);
    expect((init.headers as Record<string, string>)["content-type"]).toBeUndefined();
  });

  it("maps missing and rejected credentials to actionable errors", async () => {
    const method = connectorFromManifest(manifest).methods.find((item) => item.id === "getTeam")!;
    await expect(method.run({}, { secrets: {} })).rejects.toThrow(/Lemlist API key not configured/i);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401, headers: { "content-type": "text/plain" } }),
    );
    await expect(method.run({}, { secrets: { apiKey: "secret-key" } })).rejects.toThrow(/invalid or expired.*401/i);
  });
});
