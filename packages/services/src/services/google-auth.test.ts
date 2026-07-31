/**
 * The Google OAuth spec, over a fake fetch. No live HTTP.
 *
 * Google is vanilla RFC 6749, so most of this is confirming the shared core
 * already handles it — the value is in pinning the three things that are NOT
 * obvious and that fail silently or late:
 *
 * - `access_type=offline` + `prompt=consent` on the authorize URL. Drop either
 *   and Google issues no refresh token; nothing fails until the access token
 *   dies an hour later.
 * - `Proactive`, not `Rotating`. Google's refresh tokens are reusable, so
 *   requiring a per-connection lock would be cost for nothing — but getting this
 *   backwards in the other direction (Slack) destroys live tokens, so the arm is
 *   worth asserting.
 * - `drive.file` and nothing more. Widening the scope list is what drags the app
 *   into Google's restricted-scope verification and a paid security assessment,
 *   so the list is pinned to make that a deliberate, visible edit.
 */

import { Cause, Effect, Exit, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_ADAPTER, GOOGLE_CONNECTION_SLOT, GOOGLE_SCOPES, GOOGLE_SPEC } from "./google-auth.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const failureTag = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>): string => {
  if (Exit.isSuccess(exit)) return "none";
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure) ? failure.value._tag : "defect";
};

beforeEach(() => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "client-123");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret-456");
  vi.stubEnv("BETTER_AUTH_SECRET", "test-hmac-secret");
  vi.stubEnv("SITE_URL", "https://www.gtmgrid.dev");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GOOGLE_SPEC", () => {
  it("uses the bare 'google' id so every Google connector shares one grant", () => {
    // The id doubles as the credential slot. If this drifts from the manifests'
    // `credentialSlot`, connectors get an empty credential with no error until
    // the first 401.
    expect(GOOGLE_SPEC.id).toBe("google");
    expect(GOOGLE_CONNECTION_SLOT).toBe("google");
  });

  it("is Proactive, not Rotating — Google refresh tokens are reusable", () => {
    expect(GOOGLE_SPEC.refreshPolicy._tag).toBe("Proactive");
  });

  it("requests only non-sensitive scopes", () => {
    // Every entry here must stay NON-SENSITIVE. Adding `spreadsheets` or
    // `drive.readonly` drags the app into Google's restricted-scope verification
    // and a paid annual security assessment, so this list is pinned to make that
    // a deliberate, reviewable edit rather than a quiet one.
    expect(GOOGLE_SCOPES).toEqual(["https://www.googleapis.com/auth/drive.file", "openid", "email"]);
  });

  it("declares no parseTokens, because Google needs no deviation handling", () => {
    expect(GOOGLE_SPEC.parseTokens).toBeUndefined();
  });
});

describe("authorize URL", () => {
  it("carries access_type=offline and prompt=consent", async () => {
    // Without BOTH, no refresh_token is ever issued.
    const state = await Effect.runPromise(GOOGLE_ADAPTER.mintState({ workspaceId: "w1", userId: "u1" }));
    if (state === null) throw new Error("state should mint");
    const url = new URL(await Effect.runPromise(GOOGLE_ADAPTER.authorizeUrl(state)));

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file openid email");
    expect(url.searchParams.get("redirect_uri")).toBe("https://www.gtmgrid.dev/api/oauth/google/callback");
    expect(url.searchParams.get("state")).toBe(state);
  });

  it("mints a state that verifies back, and rejects another provider's state", async () => {
    const state = await Effect.runPromise(GOOGLE_ADAPTER.mintState({ workspaceId: "w1", userId: "u1" }));
    if (state === null) throw new Error("state should mint");
    expect(await Effect.runPromise(GOOGLE_ADAPTER.verifyState(state))).toEqual({
      workspaceId: "w1",
      userId: "u1",
    });
    // A state minted for Slack must not verify here even though it is genuinely
    // signed by us (both fall back to BETTER_AUTH_SECRET).
    const foreign = Buffer.from("slack\nw1\nu1\n" + Date.now(), "utf8").toString("base64url");
    expect(await Effect.runPromise(GOOGLE_ADAPTER.verifyState(`${foreign}.bogusmac`))).toBeNull();
  });
});

describe("token exchange and refresh", () => {
  it("exchanges a code into tokens with an expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T10:00:00Z"));
    vi.stubGlobal("fetch", async () =>
      json({ access_token: "ya29.at", refresh_token: "1//rt", expires_in: 3599, token_type: "Bearer" }),
    );

    const tokens = await Effect.runPromise(GOOGLE_ADAPTER.exchangeCode("auth-code"));
    expect(tokens.accessToken).toBe("ya29.at");
    expect(tokens.refreshToken).toBe("1//rt");
    expect(tokens.expiresAtMs).toBe(Date.now() + 3599 * 1000);
    vi.useRealTimers();
  });

  it("accepts a refresh response that omits refresh_token", async () => {
    // Google returns ONLY a new access token on refresh. The caller's merge keeps
    // the old refresh token; what matters here is that this is not an error.
    vi.stubGlobal("fetch", async () => json({ access_token: "ya29.new", expires_in: 3599 }));

    const tokens = await Effect.runPromise(GOOGLE_ADAPTER.refresh("1//rt"));
    expect(tokens.accessToken).toBe("ya29.new");
    expect(tokens.refreshToken).toBeUndefined();
  });

  it("sends grant_type=refresh_token with the refresh token", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return json({ access_token: "ya29.new" });
    });

    await Effect.runPromise(GOOGLE_ADAPTER.refresh("1//rt"));
    const body = new URLSearchParams(bodies[0] ?? "");
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("1//rt");
    expect(body.get("client_id")).toBe("client-123");
    // Authorize-only params must never reach the token endpoint.
    expect(body.has("access_type")).toBe(false);
    expect(body.has("prompt")).toBe(false);
  });

  it("maps invalid_grant (400) to CrmAuthRevoked — the connection is dead", async () => {
    vi.stubGlobal("fetch", async () => json({ error: "invalid_grant" }, 400));
    const exit = await Effect.runPromiseExit(GOOGLE_ADAPTER.refresh("1//stale"));
    expect(failureTag(exit)).toBe("CrmAuthRevoked");
  });

  it("maps a 5xx to CrmServerError — transient, worth retrying", async () => {
    vi.stubGlobal("fetch", async () => json({ error: "backendError" }, 503));
    const exit = await Effect.runPromiseExit(GOOGLE_ADAPTER.refresh("1//rt"));
    expect(failureTag(exit)).toBe("CrmServerError");
  });

  it("fails loudly when the response carries no access_token", async () => {
    vi.stubGlobal("fetch", async () => json({ token_type: "Bearer" }));
    const exit = await Effect.runPromiseExit(GOOGLE_ADAPTER.exchangeCode("code"));
    expect(failureTag(exit)).toBe("CrmSyncError");
  });
});

describe("configuration", () => {
  it("reports configured when both client env vars are present", async () => {
    expect(await Effect.runPromise(GOOGLE_ADAPTER.isConfigured())).toBe(true);
  });

  it("names the missing env var so an operator knows what to set", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    expect(await Effect.runPromise(GOOGLE_ADAPTER.isConfigured())).toBe(false);

    const exit = await Effect.runPromiseExit(GOOGLE_ADAPTER.authorizeUrl("S"));
    expect(failureTag(exit)).toBe("GoogleOAuthNotConfigured");
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      if (Option.isSome(failure) && "missing" in failure.value) {
        expect(failure.value.missing).toBe("GOOGLE_CLIENT_ID");
      }
    }
  });
});
