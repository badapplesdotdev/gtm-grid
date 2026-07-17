// A method that opts into `emptyWhenNotFound` must treat an upstream HTTP 404 as
// an expected "no data" result — resolving the call to `null` (an empty cell)
// instead of throwing. This keeps a legitimately-missing record from looking
// like a failed run and from generating error-tracking noise (e.g. Trigify's
// `enrichProfile` returning `{"code":"NOT_FOUND"}` for an unresolvable LinkedIn
// URL). Methods that do NOT opt in still throw on a 404, as before.

import { afterEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_MANIFESTS } from "../bundled-manifests.generated.js";
import { connectorFromManifest, parseManifest } from "./manifest.js";
import type { ConnectorMethod, MethodContext } from "../types.js";

const manifest = parseManifest({
  id: "example",
  name: "Example",
  baseUrl: "https://api.example.com",
  auth: { type: "apiKey", header: "x-api-key" },
  methods: [
    {
      id: "enrich",
      description: "Enrich a profile URL",
      verb: "POST",
      path: "/v1/enrich",
      emptyWhenNotFound: true,
      input: { type: "object", required: ["url"], properties: { url: { type: "string" } } },
    },
    {
      id: "fetchStrict",
      description: "Fetch a resource that must exist",
      verb: "POST",
      path: "/v1/fetch",
      input: { type: "object", required: ["url"], properties: { url: { type: "string" } } },
    },
  ],
});

const method = (id: string): ConnectorMethod => {
  const m = connectorFromManifest(manifest).methods.find((x) => x.id === id);
  if (!m) throw new Error(`method ${id} missing`);
  return m;
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("manifest emptyWhenNotFound", () => {
  const ctx: MethodContext = { secrets: { apiKey: "good-key" } };

  it("resolves a 404 to null (no throw) when the method opts in", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({ code: "NOT_FOUND", message: "Profile not found" }, 404),
    );
    await expect(method("enrich").run({ url: "https://linkedin.com/in/nobody" }, ctx)).resolves.toBeNull();
  });

  it("still throws on a 404 for a method that does not opt in", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({ code: "NOT_FOUND", message: "Profile not found" }, 404),
    );
    await expect(method("fetchStrict").run({ url: "https://linkedin.com/in/nobody" }, ctx)).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it("still throws on other non-2xx responses even when opted in", async () => {
    // A 403 is not retried by fetchWithRetry, so a single mock suffices.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ message: "forbidden" }, 403));
    await expect(method("enrich").run({ url: "https://linkedin.com/in/x" }, ctx)).rejects.toThrow(/HTTP 403/);
  });
});

describe("Trigify bundled connector enrich methods", () => {
  const raw = BUNDLED_MANIFESTS.find(
    (item) => (item as { id?: string }).id === "trigify",
  ) as Record<string, unknown> | undefined;
  const trigify = parseManifest(raw);

  it("opts enrichProfile and enrichCompany into empty-on-not-found", () => {
    for (const id of ["enrichProfile", "enrichCompany"]) {
      const m = trigify.methods.find((method) => method.id === id);
      expect(m?.emptyWhenNotFound).toBe(true);
    }
  });
});
