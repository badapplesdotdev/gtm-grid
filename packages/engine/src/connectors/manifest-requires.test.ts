// The manifest `requires` guard: a "one-of" input check run HOST-SIDE before any
// request is built. A method that needs a company identifier (LeadMagic
// emailFinder: a name AND domain|company_name) must SKIP — not fire a doomed 4xx
// — when the row has no resolvable company. The skip surfaces as a SkipCellError
// the engine turns into a clean "empty" cell, so no request is sent and no
// error-tracking noise is raised.

import { afterEach, describe, expect, it, vi } from "vitest";
import { connectorFromManifest, parseManifest } from "./manifest.js";
import { isSkipCellError } from "../skip.js";
import type { ConnectorMethod, MethodContext } from "../types.js";

const manifest = parseManifest({
  id: "leadmagic",
  name: "LeadMagic",
  baseUrl: "https://api.leadmagic.test",
  auth: null,
  methods: [
    {
      id: "emailFinder",
      description: "Find email — needs a name AND a company.",
      verb: "POST",
      path: "/v1/people/email-finder",
      input: {
        type: "object",
        properties: {
          first_name: { type: "string" },
          last_name: { type: "string" },
          full_name: { type: "string" },
          domain: { type: "string" },
          company_name: { type: "string" },
        },
      },
      requires: [
        [["first_name", "last_name"], "full_name"],
        ["domain", "company_name"],
      ],
    },
  ],
});

const emailFinder = (): ConnectorMethod => {
  const m = connectorFromManifest(manifest).methods.find((x) => x.id === "emailFinder");
  if (!m) throw new Error("emailFinder method missing");
  return m;
};
const ctx: MethodContext = { secrets: {} };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("manifest requires guard", () => {
  it("skips (no network call) when the company identifier is missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const err = await emailFinder()
      .run({ first_name: "Ada", last_name: "Lovelace" }, ctx)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(isSkipCellError(err)).toBe(true);
    expect((err as Error).message).toMatch(/domain or company_name/);
    // The doomed call was never issued.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips when the name is missing even though a company is present", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const err = await emailFinder()
      .run({ company_name: "Acme" }, ctx)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(isSkipCellError(err)).toBe(true);
    expect((err as Error).message).toMatch(/first_name\+last_name or full_name/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats an empty/whitespace string as absent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const err = await emailFinder()
      .run({ full_name: "Ada Lovelace", domain: "   " }, ctx)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(isSkipCellError(err)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("issues the request when a name and a company are both present", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ email: "ada@acme.com", status: "valid" }));

    const result = await emailFinder().run(
      { full_name: "Ada Lovelace", company_name: "Acme" },
      ctx,
    );

    expect(result).toEqual({ email: "ada@acme.com", status: "valid" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("https://api.leadmagic.test/v1/people/email-finder");
  });

  it("accepts the first_name+last_name combo as a valid name", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ email: "ada@acme.com" }));

    await emailFinder().run({ first_name: "Ada", last_name: "Lovelace", domain: "acme.com" }, ctx);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
