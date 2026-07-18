/**
 * oauth-core: the shared OAuth protocol mechanics, over a fake fetch. No live HTTP.
 *
 * The load-bearing test here is "state format is byte-identical to the
 * pre-refactor implementation". A state minted by the OLD code stays verifiable
 * for 15 minutes, so if this refactor changed the format by even a byte, every
 * OAuth handshake in flight at deploy time would fail the CSRF gate. The
 * expected value is therefore computed INDEPENDENTLY here (raw node:crypto),
 * not by calling the implementation under test — a round-trip alone would pass
 * happily against a format that drifted.
 */

import { createHmac } from "node:crypto";
import { Cause, Data, Effect, Exit, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizeUrl,
  isConfigured,
  mintState,
  resolveEnv,
  STATE_TTL_MS,
  tokenRequest,
  verifyState,
  type OAuthCoreSpec,
} from "./oauth-core.js";

class TestOAuthNotConfigured extends Data.TaggedError("TestOAuthNotConfigured")<{
  readonly missing: string;
}> {}

/** Mirrors the Attio shape: no scopes, provider-specific state secret override. */
const SPEC: OAuthCoreSpec<TestOAuthNotConfigured> = {
  displayName: "TestProvider",
  authorizeUrl: "https://app.example.com/authorize",
  tokenUrl: "https://app.example.com/oauth/token",
  clientIdEnv: "TEST_CLIENT_ID",
  clientSecretEnv: "TEST_CLIENT_SECRET",
  stateSecretEnv: "TEST_OAUTH_SECRET",
  redirectPath: "/api/oauth/test/callback",
  notConfigured: (missing) => new TestOAuthNotConfigured({ missing }),
};

/** Mirrors the HubSpot shape: space-joined scopes. */
const SCOPED_SPEC: OAuthCoreSpec<TestOAuthNotConfigured> = {
  ...SPEC,
  scopes: ["oauth", "crm.objects.contacts.read"],
  scopeSeparator: " ",
};

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);
const runExit = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromiseExit(effect);

/**
 * Read the typed failure's tag via `Cause.failureOption` rather than scraping
 * JSON: a regex over the serialized cause matches the CAUSE's own `_tag`
 * ("Fail") before the error's, which silently makes every assertion compare
 * "Fail" against itself.
 */
const failureTag = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>): string => {
  if (Exit.isSuccess(exit)) return "none";
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure) ? failure.value._tag : "unknown";
};

beforeEach(() => {
  vi.stubEnv("TEST_CLIENT_ID", "client-123");
  vi.stubEnv("TEST_CLIENT_SECRET", "secret-456");
  vi.stubEnv("BETTER_AUTH_SECRET", "test-hmac-secret");
  vi.stubEnv("SITE_URL", "https://www.gtmgrid.dev");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("state format (byte-identical to the pre-refactor implementation)", () => {
  it("mints exactly base64url(payload).base64url(hmac-sha256) with a \\n-joined payload", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T10:00:00Z"));
    const now = Date.now();
    const claims = { workspaceId: "ws_a", userId: "user_1" };

    const state = await run(mintState(SPEC, claims));

    // Computed independently of the implementation under test.
    const payload = `ws_a\nuser_1\n${now}`;
    const expected = `${Buffer.from(payload, "utf8").toString("base64url")}.${createHmac(
      "sha256",
      "test-hmac-secret",
    )
      .update(payload)
      .digest("base64url")}`;

    expect(state).toBe(expected);
  });

  it("keeps the TTL at 15 minutes", () => {
    expect(STATE_TTL_MS).toBe(15 * 60 * 1000);
  });
});

describe("state round-trip", () => {
  it("round-trips (workspaceId, userId)", async () => {
    const claims = { workspaceId: "11111111-1111-1111-1111-111111111111", userId: "user_1" };
    const state = await run(mintState(SPEC, claims));
    if (state === null) throw new Error("expected state");
    expect(await run(verifyState(SPEC, state))).toEqual(claims);
  });

  it("rejects a tampered payload carrying a valid-looking mac", async () => {
    const state = await run(mintState(SPEC, { workspaceId: "ws_a", userId: "user_1" }));
    if (state === null) throw new Error("expected state");
    const [, mac] = state.split(".");
    const forged = `${Buffer.from(`ws_EVIL\nuser_1\n${Date.now()}`, "utf8").toString("base64url")}.${mac}`;
    expect(await run(verifyState(SPEC, forged))).toBeNull();
  });

  it("rejects garbage, empty, and a mac of the WRONG LENGTH (timingSafeEqual throws on length mismatch)", async () => {
    const results = await run(
      Effect.all([
        verifyState(SPEC, "not-a-token"),
        verifyState(SPEC, ""),
        verifyState(SPEC, "a.b"),
        verifyState(SPEC, `${Buffer.from("ws\nu\n1", "utf8").toString("base64url")}.short`),
      ]),
    );
    expect(results).toEqual([null, null, null, null]);
  });

  it("expires after the TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T10:00:00Z"));
    const state = await run(mintState(SPEC, { workspaceId: "ws_a", userId: "user_1" }));
    if (state === null) throw new Error("expected state");

    vi.setSystemTime(new Date("2026-07-04T10:14:00Z")); // inside the window
    expect(await run(verifyState(SPEC, state))).not.toBeNull();

    vi.setSystemTime(new Date("2026-07-04T10:16:00Z")); // 16 min > 15 min TTL
    expect(await run(verifyState(SPEC, state))).toBeNull();
  });

  it("returns null when no signing secret exists (never emits an UNSIGNED state)", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    vi.stubEnv("TEST_OAUTH_SECRET", "");
    expect(await run(mintState(SPEC, { workspaceId: "ws_a", userId: "user_1" }))).toBeNull();
  });

  it("prefers the provider's state secret over BETTER_AUTH_SECRET", async () => {
    vi.stubEnv("TEST_OAUTH_SECRET", "provider-specific-key");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T10:00:00Z"));
    const payload = `ws_a\nuser_1\n${Date.now()}`;
    const state = await run(mintState(SPEC, { workspaceId: "ws_a", userId: "user_1" }));
    const withProviderKey = createHmac("sha256", "provider-specific-key").update(payload).digest("base64url");
    expect(state?.split(".")[1]).toBe(withProviderKey);
  });
});

describe("resolveEnv", () => {
  it("builds the redirect URI from SITE_URL + redirectPath", async () => {
    const env = await run(resolveEnv(SPEC));
    expect(env.redirectUri).toBe("https://www.gtmgrid.dev/api/oauth/test/callback");
  });

  it("fails closed with the provider's tag, naming the missing var", async () => {
    vi.stubEnv("TEST_CLIENT_ID", "");
    const exit = await runExit(resolveEnv(SPEC));
    expect(failureTag(exit)).toBe("TestOAuthNotConfigured");
    expect(JSON.stringify(exit)).toContain("TEST_CLIENT_ID");
  });

  it("isConfigured reflects the env", async () => {
    expect(await run(isConfigured(SPEC))).toBe(true);
    vi.stubEnv("TEST_CLIENT_SECRET", "");
    expect(await run(isConfigured(SPEC))).toBe(false);
  });
});

describe("authorizeUrl", () => {
  it("omits the scope param entirely when the spec declares no scopes", async () => {
    const url = new URL(await run(authorizeUrl(SPEC, "STATE_TOKEN")));
    expect(url.origin).toBe("https://app.example.com");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://www.gtmgrid.dev/api/oauth/test/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("STATE_TOKEN");
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("joins scopes with the spec's separator", async () => {
    const url = new URL(await run(authorizeUrl(SCOPED_SPEC, "S")));
    expect(url.searchParams.get("scope")).toBe("oauth crm.objects.contacts.read");
  });
});

describe("tokenRequest", () => {
  it("posts form-encoded credentials + redirect_uri and parses tokens with expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T10:00:00Z"));
    const calls: Array<{ url: string; body: string; contentType: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: String(init?.body ?? ""),
        contentType: String((init?.headers as Record<string, string>)?.["content-type"] ?? ""),
      });
      return new Response(JSON.stringify({ access_token: "at_1", refresh_token: "rt_1", expires_in: 3600 }), {
        status: 200,
      });
    });

    const tokens = await run(tokenRequest(SPEC, { grant_type: "authorization_code", code: "CODE_9" }));

    expect(tokens).toEqual({
      accessToken: "at_1",
      refreshToken: "rt_1",
      expiresAtMs: new Date("2026-07-04T11:00:00Z").getTime(),
    });
    expect(calls[0].url).toBe("https://app.example.com/oauth/token");
    expect(calls[0].contentType).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(calls[0].body);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("CODE_9");
    expect(params.get("client_id")).toBe("client-123");
    expect(params.get("client_secret")).toBe("secret-456");
    // Sent even though RFC 6749 makes it redundant on some grants — Slack
    // silently misroutes to the first configured URL without it.
    expect(params.get("redirect_uri")).toBe("https://www.gtmgrid.dev/api/oauth/test/callback");
  });

  it("handles a long-lived token response (no refresh_token / expires_in)", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ access_token: "at_only" }), { status: 200 }));
    expect(await run(tokenRequest(SPEC, { grant_type: "authorization_code", code: "C" }))).toEqual({
      accessToken: "at_only",
    });
  });

  it("a grant refusal (4xx) is CrmAuthRevoked", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const exit = await runExit(tokenRequest(SPEC, { grant_type: "refresh_token", refresh_token: "rt_dead" }));
    expect(failureTag(exit)).toBe("CrmAuthRevoked");
  });

  it("a 5xx is CrmServerError (transient), NOT a revoked connection", async () => {
    vi.stubGlobal("fetch", async () => new Response("upstream boom", { status: 503 }));
    const exit = await runExit(tokenRequest(SPEC, { grant_type: "refresh_token", refresh_token: "rt" }));
    expect(failureTag(exit)).toBe("CrmServerError");
  });

  it("a rejected fetch is CrmNetworkError (transient)", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNRESET");
    });
    const exit = await runExit(tokenRequest(SPEC, { grant_type: "refresh_token", refresh_token: "rt" }));
    expect(failureTag(exit)).toBe("CrmNetworkError");
  });

  it("a 200 with no access_token is CrmSyncError (provider violated the protocol)", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ token_type: "bearer" }), { status: 200 }));
    const exit = await runExit(tokenRequest(SPEC, { grant_type: "authorization_code", code: "C" }));
    expect(failureTag(exit)).toBe("CrmSyncError");
  });

  it("a WRONG-TYPED access_token fails loudly instead of being stored", async () => {
    // The pre-refactor `res.json() as Promise<TokenResponse>` was an unchecked
    // lie: this body would have flowed the number 123 into a string-typed token
    // and persisted it, surfacing much later as a baffling 401.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ access_token: 123 }), { status: 200 }));
    const exit = await runExit(tokenRequest(SPEC, { grant_type: "authorization_code", code: "C" }));
    expect(failureTag(exit)).toBe("CrmSyncError");
  });

  it("a non-object body (provider returned a bare string) fails loudly", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify("nope"), { status: 200 }));
    const exit = await runExit(tokenRequest(SPEC, { grant_type: "authorization_code", code: "C" }));
    expect(failureTag(exit)).toBe("CrmSyncError");
  });

  it("does not send a request at all when the OAuth app is unconfigured", async () => {
    vi.stubEnv("TEST_CLIENT_SECRET", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const exit = await runExit(tokenRequest(SPEC, { grant_type: "authorization_code", code: "C" }));
    expect(failureTag(exit)).toBe("TestOAuthNotConfigured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
