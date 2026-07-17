// Required-field pre-flight guard: a manifest method must enforce its declared
// `required` inputs locally BEFORE firing a request. A row with an empty input
// (e.g. LeadMagic emailValidation over a blank `{{Email}}`) must fail fast with
// an actionable local error instead of firing `{ email: "" }` and surfacing the
// upstream's cryptic 400 — which also wastes the user's API credits.

import { afterEach, describe, expect, it, vi } from "vitest";
import { connectorFromManifest, parseManifest } from "./manifest.js";
import type { ConnectorMethod, MethodContext } from "../types.js";

const manifest = parseManifest({
  id: "leadmagic",
  name: "LeadMagic",
  baseUrl: "https://api.leadmagic.io",
  auth: { type: "apiKey", header: "X-API-Key" },
  methods: [
    {
      id: "emailValidation",
      label: "Validate Email",
      description: "Validate an email address",
      verb: "POST",
      path: "/v1/people/email-validation",
      input: { type: "object", required: ["email"], properties: { email: { type: "string" } } },
    },
    {
      id: "profileSearch",
      label: "Enrich LinkedIn Profile",
      description: "Enrich from a profile URL in the path",
      verb: "GET",
      path: "/v1/people/{profile_url}",
      input: { type: "object", required: ["profile_url"], properties: { profile_url: { type: "string" } } },
    },
    {
      id: "optionalOnly",
      description: "No required fields declared",
      verb: "POST",
      path: "/v1/optional",
      input: { type: "object", properties: { note: { type: "string" } } },
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
const ctx: MethodContext = { secrets: { apiKey: "good-key" } };

afterEach(() => vi.restoreAllMocks());

describe("manifest required-field pre-flight guard", () => {
  it("fails fast, naming the field, when a required input is an empty string (no request fired)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(method("emailValidation").run({ email: "" }, ctx)).rejects.toThrow(
      /LeadMagic Validate Email: required field is missing or empty: email/i,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails fast when a required input is whitespace-only or absent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(method("emailValidation").run({ email: "   " }, ctx)).rejects.toThrow(/email/i);
    await expect(method("emailValidation").run({}, ctx)).rejects.toThrow(/email/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("enforces required path params too", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(method("profileSearch").run({ profile_url: "" }, ctx)).rejects.toThrow(/profile_url/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lets a call through once every required field is present", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ email_status: "valid" }));

    await method("emailValidation").run({ email: "a@acme.com" }, ctx);

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("does not block methods that declare no required fields", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ ok: true }));

    await method("optionalOnly").run({}, ctx);

    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
