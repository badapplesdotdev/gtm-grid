import { afterEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_MANIFESTS } from "../bundled-manifests.generated.js";
import { connectorFromManifest, parseManifest } from "./manifest.js";

const raw = BUNDLED_MANIFESTS.find(
  (item) => (item as { id?: string }).id === "zoominfo",
) as Record<string, unknown> | undefined;

const manifest = parseManifest(raw);

afterEach(() => vi.restoreAllMocks());

describe("ZoomInfo bundled connector", () => {
  it("covers every operation in the official API reference index", () => {
    expect(manifest.methods).toHaveLength(84);
    expect(new Set(manifest.methods.map((method) => method.id)).size).toBe(84);
    expect(manifest.auth?.credentialLabel).toBe("OAuth access token");
    expect(manifest.logo).toMatch(/^data:image\/svg\+xml;base64,/);

    const ids = new Set(manifest.methods.map((method) => method.id));
    for (const expected of [
      "searchContact",
      "enrichContact",
      "lookupEnrich",
      "getAccountSummary",
      "studioCreateAudience",
      "deleteRows",
      "marketingCreateAudience",
      "upsertContentInteractions",
      "listPulses",
    ]) {
      expect(ids.has(expected), `missing ZoomInfo endpoint ${expected}`).toBe(true);
    }
  });

  it("contains self-contained renderable input schemas and official source links", () => {
    for (const method of manifest.methods) {
      expect(method.input?.type, method.id).toBe("object");
      expect(method.description, method.id).toContain("https://docs.zoominfo.com/reference/");
      const serialized = JSON.stringify(method.input);
      expect(serialized, `${method.id} contains an unresolved schema ref`).not.toContain('"$ref"');
      expect(serialized, `${method.id} contains an unsupported allOf`).not.toContain('"allOf"');
      expect(serialized, `${method.id} contains an unsupported oneOf`).not.toContain('"oneOf"');
    }
  });

  it("sends ZoomInfo search pagination as query params and criteria as JSON:API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('{"data":[]}', { status: 200, headers: { "content-type": "application/vnd.api+json" } }),
    );
    const method = connectorFromManifest(manifest).methods.find((item) => item.id === "searchContact")!;

    await method.run(
      {
        "page[number]": 2,
        "page[size]": 25,
        data: { type: "ContactSearch", attributes: { companyName: "ZoomInfo" } },
      },
      { secrets: { apiKey: "access-token" } },
    );

    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      "https://api.zoominfo.com/gtm/data/v1/contacts/search?page%5Bnumber%5D=2&page%5Bsize%5D=25",
    );
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer access-token");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/vnd.api+json");
    expect(JSON.parse(String(init.body))).toEqual({
      data: { type: "ContactSearch", attributes: { companyName: "ZoomInfo" } },
    });
  });
});
