// Pre-flight credential guard: an apiKey connector invoked with no resolved
// secret must fail fast with an actionable message — never fire an
// unauthenticated request and surface the upstream's cryptic 401 body. A 401
// from a configured-but-invalid key is mapped to the same friendly guidance.

import { afterEach, describe, expect, it, vi } from "vitest";
import { connectorFromManifest, parseManifest } from "./manifest.js";
import type { ConnectorMethod, MethodContext } from "../types.js";

const manifest = parseManifest({
  id: "findymail",
  name: "FindyMail",
  baseUrl: "https://app.findymail.com",
  auth: { type: "apiKey", header: "Authorization", scheme: "Bearer " },
  methods: [
    {
      id: "findFromLinkedin",
      description: "Find an email from a LinkedIn URL",
      verb: "POST",
      path: "/api/search/linkedin",
      input: { type: "object", required: ["linkedin_url"], properties: { linkedin_url: { type: "string" } } },
    },
  ],
});

const method = (): ConnectorMethod => {
  const m = connectorFromManifest(manifest).methods.find((x) => x.id === "findFromLinkedin");
  if (!m) throw new Error("method missing");
  return m;
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("manifest apiKey pre-flight guard", () => {
  it("fails fast with an actionable message when no secret is configured (no request fired)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const ctx: MethodContext = { secrets: {} };

    await expect(method().run({ linkedin_url: "https://linkedin.com/in/x" }, ctx)).rejects.toThrow(
      /FindyMail API key not configured/i,
    );
    // The whole point: we never sent an unauthenticated request.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("maps a 401 from a configured-but-invalid key to friendly guidance", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ message: "Unauthenticated." }, 401));
    const ctx: MethodContext = { secrets: { apiKey: "stale-key" } };

    await expect(method().run({ linkedin_url: "https://linkedin.com/in/x" }, ctx)).rejects.toThrow(
      /FindyMail API key invalid or expired/i,
    );
  });

  it("sends the Authorization header when a secret is present", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ contact: { email: "x@acme.com" } }));
    const ctx: MethodContext = { secrets: { apiKey: "good-key" } };

    await method().run({ linkedin_url: "https://linkedin.com/in/x" }, ctx);

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer good-key");
  });
});
