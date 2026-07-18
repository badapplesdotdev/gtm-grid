// The manifest `oauth` auth arm. An OAuth connector's access token arrives in the
// same flat `ctx.secrets` map as a pasted key, so injection is shared with apiKey
// — what must NOT be shared is the remediation copy. An OAuth user has no key to
// paste: "update the key" would send them hunting for a field that doesn't exist,
// so a missing/rejected token must tell them to (re)CONNECT the account.
//
// The apiKey arm's own behaviour is covered in manifest-auth.test.ts; here we pin
// the oauth arm and the guarantee that widening the schema to a discriminated
// union left apiKey manifests parsing byte-identically.

import { afterEach, describe, expect, it, vi } from "vitest";
import { connectorFromManifest, parseManifest } from "./manifest.js";
import type { ConnectorMethod, MethodContext } from "../types.js";

const manifest = parseManifest({
  id: "slack",
  name: "Slack",
  baseUrl: "https://slack.com/api",
  auth: { type: "oauth", provider: "slack" },
  methods: [
    {
      id: "postMessage",
      description: "Post a message to a channel",
      verb: "POST",
      path: "/chat.postMessage",
      input: {
        type: "object",
        required: ["channel", "text"],
        properties: { channel: { type: "string" }, text: { type: "string" } },
      },
    },
  ],
});

const method = (): ConnectorMethod => {
  const m = connectorFromManifest(manifest).methods.find((x) => x.id === "postMessage");
  if (!m) throw new Error("method missing");
  return m;
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const args = { channel: "C123", text: "hello" };

afterEach(() => vi.restoreAllMocks());

describe("manifest oauth auth arm", () => {
  it("applies the bearer defaults (header/scheme/secretKey) without the manifest spelling them out", () => {
    // A manifest declaring only `{ type: "oauth", provider }` is the common case;
    // the defaults are what make that terse form work.
    expect(manifest.auth).toEqual({
      type: "oauth",
      provider: "slack",
      header: "Authorization",
      scheme: "Bearer ",
      secretKey: "accessToken",
    });
  });

  it("keeps the resolved oauth fields on the registered Connector", () => {
    // Connector["auth"] used to be narrower than the manifest's auth, silently
    // dropping secretKey/scheme — the OAuth arm is unusable if `provider` and
    // friends don't survive registration.
    expect(connectorFromManifest(manifest).auth).toMatchObject({
      type: "oauth",
      provider: "slack",
      secretKey: "accessToken",
    });
  });

  it("fails fast telling the user to CONNECT the account when no token is resolved (no request fired)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const ctx: MethodContext = { secrets: {} };

    await expect(method().run(args, ctx)).rejects.toThrow(/Slack is not connected/i);
    // Same pre-flight guarantee as apiKey: never send an unauthenticated request.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never offers key-flavoured advice for a missing oauth token", async () => {
    const ctx: MethodContext = { secrets: {} };
    await expect(method().run(args, ctx)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringMatching(/api key|update the key/i) }),
    );
  });

  it("maps a 401 to reconnect guidance, not 'check the API key'", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ error: "invalid_auth" }, 401));
    const ctx: MethodContext = { secrets: { accessToken: "revoked-token" } };

    const err = await method()
      .run(args, ctx)
      .then(() => null, (e: unknown) => e);
    expect(String(err)).toMatch(/reconnect your Slack account/i);
    expect(String(err)).not.toMatch(/api key|update the key/i);
  });

  it("reads the token from `accessToken` and sends it as an Authorization bearer", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ ok: true, ts: "1.2" }));
    const ctx: MethodContext = { secrets: { accessToken: "xoxb-good" } };

    await method().run(args, ctx);

    const init = fetchSpy.mock.calls[0]![1];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer xoxb-good");
  });

  it("honours an explicit non-Authorization header (token sent raw, no scheme prefix)", async () => {
    const custom = parseManifest({
      id: "custom-oauth",
      name: "Custom",
      baseUrl: "https://example.com",
      auth: { type: "oauth", provider: "custom", header: "X-Token", secretKey: "token" },
      methods: [{ id: "ping", description: "ping", verb: "GET", path: "/ping" }],
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ ok: true }));
    const m = connectorFromManifest(custom).methods[0]!;

    await m.run({}, { secrets: { token: "raw-token" } });

    const headers = (fetchSpy.mock.calls[0]![1]?.headers ?? {}) as Record<string, string>;
    expect(headers["X-Token"]).toBe("raw-token");
  });

  it("rejects an oauth block with no provider", () => {
    expect(() =>
      parseManifest({
        id: "bad",
        name: "Bad",
        baseUrl: "https://example.com",
        auth: { type: "oauth" },
        methods: [{ id: "ping", description: "ping", verb: "GET", path: "/ping" }],
      }),
    ).toThrow();
  });
});

describe("apiKey manifests are unaffected by the union widening", () => {
  const apiKeyManifest = parseManifest({
    id: "findymail",
    name: "FindyMail",
    baseUrl: "https://app.findymail.com",
    auth: { type: "apiKey", header: "Authorization", scheme: "Bearer ", secretKey: "apiKey" },
    methods: [{ id: "ping", description: "ping", verb: "GET", path: "/ping" }],
  });

  it("parses the apiKey arm with no injected defaults (byte-compatible)", () => {
    // Crucially the apiKey arm gains NO defaults — every bundled manifest must
    // keep parsing to exactly the object it declares.
    expect(apiKeyManifest.auth).toEqual({
      type: "apiKey",
      header: "Authorization",
      scheme: "Bearer ",
      secretKey: "apiKey",
    });
  });

  it("still tells an apiKey user to update the key, not to reconnect", async () => {
    const m = connectorFromManifest(apiKeyManifest).methods[0]!;
    await expect(m.run({}, { secrets: {} })).rejects.toThrow(/FindyMail API key not configured/i);
  });
});
