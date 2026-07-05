/**
 * HubspotAuth: the authorize URL (scopes!), OAuth state minting/verification,
 * and the token endpoint exchange/refresh paths over a fake fetch. No live
 * HTTP. HubSpot ALWAYS returns expires_in — expiresAtMs must always land.
 */

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubspotAuth, HUBSPOT_SCOPES } from "./hubspot-auth.js";

const run = <A, E>(effect: Effect.Effect<A, E, HubspotAuth>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(HubspotAuth.Default)) as Effect.Effect<A, E, never>);

const runExit = <A, E>(effect: Effect.Effect<A, E, HubspotAuth>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(HubspotAuth.Default)) as Effect.Effect<A, E, never>);

const failureTag = (exit: Awaited<ReturnType<typeof runExit>>): string => {
  if (exit._tag !== "Failure") return "none";
  const m = JSON.stringify(exit.cause).match(/"_tag":"((?:Crm|Hubspot)[A-Za-z]+)"/);
  return m?.[1] ?? "unknown";
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.stubEnv("HUBSPOT_CLIENT_ID", "hs-client-123");
  vi.stubEnv("HUBSPOT_CLIENT_SECRET", "hs-secret-456");
  vi.stubEnv("BETTER_AUTH_SECRET", "test-hmac-secret");
  vi.stubEnv("SITE_URL", "https://www.gtmgrid.dev");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("authorize URL", () => {
  it("targets app.hubspot.com with space-separated read-only scopes + the callback redirect", async () => {
    const url = new URL(
      await run(Effect.flatMap(HubspotAuth, (a) => a.authorizeUrl("state-token"))),
    );
    expect(url.origin + url.pathname).toBe("https://app.hubspot.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("hs-client-123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://www.gtmgrid.dev/api/crm/hubspot/callback");
    expect(url.searchParams.get("state")).toBe("state-token");
    expect(url.searchParams.get("scope")).toBe(HUBSPOT_SCOPES.join(" "));
    // Every scope is read-only — the app can never write to a CRM.
    for (const scope of HUBSPOT_SCOPES) expect(scope).toMatch(/\.read$/);
  });

  it("is unconfigured without env (HubspotOAuthNotConfigured)", async () => {
    vi.stubEnv("HUBSPOT_CLIENT_ID", "");
    const exit = await runExit(Effect.flatMap(HubspotAuth, (a) => a.authorizeUrl("s")));
    expect(failureTag(exit)).toBe("HubspotOAuthNotConfigured");
    expect(await run(Effect.flatMap(HubspotAuth, (a) => a.isConfigured()))).toBe(false);
  });
});

describe("OAuth state", () => {
  it("round-trips (workspaceId, userId) and rejects tampering", async () => {
    const claims = { workspaceId: "11111111-1111-1111-1111-111111111111", userId: "user_1" };
    const result = await run(
      Effect.gen(function* () {
        const auth = yield* HubspotAuth;
        const state = yield* auth.mintState(claims);
        if (state === null) throw new Error("expected state");
        const roundTrip = yield* auth.verifyState(state);
        const [, mac] = state.split(".");
        const forged = `${Buffer.from(`ws_EVIL\nuser_1\n${Date.now()}`, "utf8").toString("base64url")}.${mac}`;
        const rejected = yield* auth.verifyState(forged);
        return { roundTrip, rejected };
      }),
    );
    expect(result.roundTrip).toEqual(claims);
    expect(result.rejected).toBeNull();
  });
});

describe("token endpoint", () => {
  it("exchanges a code form-encoded and ALWAYS lands expiresAtMs (HubSpot returns expires_in)", async () => {
    let body = "";
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.hubapi.com/oauth/v1/token");
      body = String(init?.body ?? "");
      return json({ access_token: "at_1", refresh_token: "rt_1", expires_in: 1800 });
    });
    const before = Date.now();
    const tokens = await run(Effect.flatMap(HubspotAuth, (a) => a.exchangeCode("code-xyz")));
    const params = new URLSearchParams(body);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("code-xyz");
    expect(params.get("client_id")).toBe("hs-client-123");
    expect(params.get("redirect_uri")).toBe("https://www.gtmgrid.dev/api/crm/hubspot/callback");
    expect(tokens.accessToken).toBe("at_1");
    expect(tokens.refreshToken).toBe("rt_1");
    // ~30 minutes out, computed from expires_in.
    expect(tokens.expiresAtMs).toBeGreaterThanOrEqual(before + 1800 * 1000);
  });

  it("a refresh refusal is CrmAuthRevoked (connection dead)", async () => {
    vi.stubGlobal("fetch", async () => json({ error: "invalid_grant" }, 400));
    const exit = await runExit(Effect.flatMap(HubspotAuth, (a) => a.refresh("rt_dead")));
    expect(failureTag(exit)).toBe("CrmAuthRevoked");
  });

  it("a 5xx is CrmServerError (transient, not a revocation)", async () => {
    vi.stubGlobal("fetch", async () => json({}, 503));
    const exit = await runExit(Effect.flatMap(HubspotAuth, (a) => a.refresh("rt_1")));
    expect(failureTag(exit)).toBe("CrmServerError");
  });
});
