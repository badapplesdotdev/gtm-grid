/**
 * AttioAuth: OAuth state minting/verification (HMAC + TTL) and the token
 * endpoint exchange/refresh paths, over a fake fetch. No live HTTP.
 */

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttioAuth } from "./attio-auth.js";

const run = <A, E>(effect: Effect.Effect<A, E, AttioAuth>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(AttioAuth.Default)) as Effect.Effect<A, E, never>).catch((err) => {
    throw err;
  });

const runExit = <A, E>(effect: Effect.Effect<A, E, AttioAuth>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(AttioAuth.Default)) as Effect.Effect<A, E, never>);

const failureTag = (exit: Awaited<ReturnType<typeof runExit>>): string => {
  if (exit._tag !== "Failure") return "none";
  const failure = JSON.stringify(exit.cause);
  const m = failure.match(/"_tag":"(Crm[A-Za-z]+)"/);
  return m?.[1] ?? "unknown";
};

beforeEach(() => {
  vi.stubEnv("ATTIO_CLIENT_ID", "client-123");
  vi.stubEnv("ATTIO_CLIENT_SECRET", "secret-456");
  vi.stubEnv("BETTER_AUTH_SECRET", "test-hmac-secret");
  vi.stubEnv("SITE_URL", "https://www.gtmgrid.dev");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("OAuth state", () => {
  it("round-trips (workspaceId, userId)", async () => {
    const claims = { workspaceId: "11111111-1111-1111-1111-111111111111", userId: "user_1" };
    const result = await run(
      Effect.gen(function* () {
        const auth = yield* AttioAuth;
        const state = yield* auth.mintState(claims);
        if (state === null) throw new Error("expected state");
        return yield* auth.verifyState(state);
      }),
    );
    expect(result).toEqual(claims);
  });

  it("rejects a tampered payload", async () => {
    const result = await run(
      Effect.gen(function* () {
        const auth = yield* AttioAuth;
        const state = yield* auth.mintState({ workspaceId: "ws_a", userId: "user_1" });
        if (state === null) throw new Error("expected state");
        const [, mac] = state.split(".");
        const forged = `${Buffer.from("ws_EVIL\nuser_1\n" + Date.now(), "utf8").toString("base64url")}.${mac}`;
        return yield* auth.verifyState(forged);
      }),
    );
    expect(result).toBeNull();
  });

  it("rejects garbage and empty tokens", async () => {
    const result = await run(
      Effect.gen(function* () {
        const auth = yield* AttioAuth;
        return [yield* auth.verifyState("not-a-token"), yield* auth.verifyState(""), yield* auth.verifyState("a.b")];
      }),
    );
    expect(result).toEqual([null, null, null]);
  });

  it("expires after the TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T10:00:00Z"));
    const state = await run(
      Effect.gen(function* () {
        const auth = yield* AttioAuth;
        return yield* auth.mintState({ workspaceId: "ws_a", userId: "user_1" });
      }),
    );
    if (state === null) throw new Error("expected state");
    vi.setSystemTime(new Date("2026-07-04T10:16:00Z")); // 16 min > 15 min TTL
    const verified = await run(
      Effect.gen(function* () {
        const auth = yield* AttioAuth;
        return yield* auth.verifyState(state);
      }),
    );
    expect(verified).toBeNull();
  });

  it("returns null state when no signing secret exists (never an unsigned state)", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    vi.stubEnv("ATTIO_OAUTH_SECRET", "");
    const state = await run(
      Effect.gen(function* () {
        const auth = yield* AttioAuth;
        return yield* auth.mintState({ workspaceId: "ws_a", userId: "user_1" });
      }),
    );
    expect(state).toBeNull();
  });
});

describe("authorizeUrl", () => {
  it("targets app.attio.com with client id, callback redirect, and state", async () => {
    const url = new URL(
      await run(
        Effect.gen(function* () {
          const auth = yield* AttioAuth;
          return yield* auth.authorizeUrl("STATE_TOKEN");
        }),
      ),
    );
    expect(url.origin).toBe("https://app.attio.com");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://www.gtmgrid.dev/api/crm/attio/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("STATE_TOKEN");
  });
});

describe("token endpoint", () => {
  it("exchangeCode posts the code and parses tokens (with expiry)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T10:00:00Z"));
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(
        JSON.stringify({ access_token: "at_1", refresh_token: "rt_1", expires_in: 3600 }),
        { status: 200 },
      );
    });
    const tokens = await run(
      Effect.gen(function* () {
        const auth = yield* AttioAuth;
        return yield* auth.exchangeCode("CODE_9");
      }),
    );
    expect(tokens).toEqual({
      accessToken: "at_1",
      refreshToken: "rt_1",
      expiresAtMs: new Date("2026-07-04T11:00:00Z").getTime(),
    });
    expect(calls[0].url).toBe("https://app.attio.com/oauth/token");
    const params = new URLSearchParams(calls[0].body);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("CODE_9");
    expect(params.get("client_id")).toBe("client-123");
  });

  it("handles a long-lived token response (no refresh_token / expires_in)", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ access_token: "at_only" }), { status: 200 }));
    const tokens = await run(
      Effect.gen(function* () {
        const auth = yield* AttioAuth;
        return yield* auth.exchangeCode("CODE");
      }),
    );
    expect(tokens).toEqual({ accessToken: "at_only" });
  });

  it("a refresh refusal is CrmAuthRevoked", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    const exit = await runExit(
      Effect.gen(function* () {
        const auth = yield* AttioAuth;
        return yield* auth.refresh("rt_dead");
      }),
    );
    expect(failureTag(exit)).toBe("CrmAuthRevoked");
  });

  it("missing client env fails closed with AttioOAuthNotConfigured", async () => {
    vi.stubEnv("ATTIO_CLIENT_ID", "");
    const exit = await runExit(
      Effect.gen(function* () {
        const auth = yield* AttioAuth;
        return yield* auth.exchangeCode("CODE");
      }),
    );
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("AttioOAuthNotConfigured");
  });
});
