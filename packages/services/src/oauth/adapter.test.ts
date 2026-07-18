/**
 * RefreshPolicy semantics + makeAdapter wiring.
 *
 * These are the tests that encode what used to be doc comments. Each provider's
 * documented lifecycle becomes an assertion, so "Attio refreshes reactively" and
 * "Slack must serialize" are checkable claims rather than prose someone has to
 * read and remember.
 */

import { Cause, Data, Effect, Exit, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adapterFor, makeAdapter } from "./adapter.js";
import {
  needsRefresh,
  REFRESH_SKEW_MS,
  RefreshPolicy,
  requiresSerializedRefresh,
  type OAuthProviderSpec,
  type OAuthTokens,
} from "./types.js";

class TestOAuthNotConfigured extends Data.TaggedError("TestOAuthNotConfigured")<{
  readonly missing: string;
}> {}

const specWith = (refreshPolicy: RefreshPolicy, id = "test"): OAuthProviderSpec<TestOAuthNotConfigured> => ({
  id,
  displayName: "TestProvider",
  notConfiguredTag: "TestOAuthNotConfigured",
  refreshPolicy,
  authorizeUrl: "https://app.example.com/authorize",
  tokenUrl: "https://app.example.com/oauth/token",
  clientIdEnv: "TEST_CLIENT_ID",
  clientSecretEnv: "TEST_CLIENT_SECRET",
  stateSecretEnv: "TEST_OAUTH_SECRET",
  redirectPath: "/api/oauth/test/callback",
  notConfigured: (missing) => new TestOAuthNotConfigured({ missing }),
});

const NOW = new Date("2026-07-04T10:00:00Z").getTime();
const tokens = (over: Partial<OAuthTokens> = {}): OAuthTokens => ({
  accessToken: "at",
  refreshToken: "rt",
  expiresAtMs: NOW + 60 * 60 * 1000,
  ...over,
});

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
});

describe("needsRefresh — every RefreshPolicy arm", () => {
  it("None never refreshes proactively, even when plainly expired", () => {
    expect(needsRefresh(tokens({ expiresAtMs: NOW - 1 }), RefreshPolicy.None, NOW)).toBe(false);
  });

    it("Proactive refreshes once inside the skew window, not before", () => {
    const policy = RefreshPolicy.Proactive(REFRESH_SKEW_MS);
    // Expires in 6 min, skew is 5 → still fresh.
    expect(needsRefresh(tokens({ expiresAtMs: NOW + 6 * 60_000 }), policy, NOW)).toBe(false);
    // Expires in 4 min, skew is 5 → inside the window.
    expect(needsRefresh(tokens({ expiresAtMs: NOW + 4 * 60_000 }), policy, NOW)).toBe(true);
    // Already expired.
    expect(needsRefresh(tokens({ expiresAtMs: NOW - 1 }), policy, NOW)).toBe(true);
  });

  it("Rotating uses the same staleness rule as Proactive", () => {
    const policy = RefreshPolicy.Rotating(30 * 60_000);
    expect(needsRefresh(tokens({ expiresAtMs: NOW + 31 * 60_000 }), policy, NOW)).toBe(false);
    expect(needsRefresh(tokens({ expiresAtMs: NOW + 29 * 60_000 }), policy, NOW)).toBe(true);
  });

  it("without a refresh token there is nothing to refresh WITH, so no policy refreshes", () => {
    const expired = { accessToken: "at", expiresAtMs: NOW - 1 };
    for (const policy of [RefreshPolicy.Proactive(REFRESH_SKEW_MS), RefreshPolicy.Rotating(30 * 60_000)]) {
      expect(needsRefresh(expired, policy, NOW)).toBe(false);
    }
  });

  it("without a reported expiry we cannot know it is stale — fall through to the 401 backstop", () => {
    // This is Attio's documented ambiguity, now expressed as behaviour: guessing
    // would burn a single-use token under Rotating for no reason.
    const noExpiry = { accessToken: "at", refreshToken: "rt" };
    for (const policy of [RefreshPolicy.Proactive(REFRESH_SKEW_MS), RefreshPolicy.Rotating(30 * 60_000)]) {
      expect(needsRefresh(noExpiry, policy, NOW)).toBe(false);
    }
  });
});

describe("requiresSerializedRefresh", () => {
  it("is true for Rotating ONLY — the others tolerate a redundant refresh", () => {
    expect(requiresSerializedRefresh(RefreshPolicy.Rotating(1))).toBe(true);
    expect(requiresSerializedRefresh(RefreshPolicy.Proactive(1))).toBe(false);
    expect(requiresSerializedRefresh(RefreshPolicy.None)).toBe(false);
  });
});

describe("makeAdapter", () => {
  it("surfaces the spec's identity and policy as data", () => {
    const adapter = makeAdapter(specWith(RefreshPolicy.Rotating(30 * 60_000), "slack-ish"));
    expect(adapter.id).toBe("slack-ish");
    expect(adapter.displayName).toBe("TestProvider");
    expect(adapter.notConfiguredTag).toBe("TestOAuthNotConfigured");
    expect(adapter.refreshPolicy).toEqual({ _tag: "Rotating", skewMs: 30 * 60_000 });
  });

  it("exchangeCode sends grant_type=authorization_code", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ access_token: "at_1" }), { status: 200 });
    });
    const adapter = makeAdapter(specWith(RefreshPolicy.None));
    await Effect.runPromise(adapter.exchangeCode("CODE_9"));
    const params = new URLSearchParams(calls[0]);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("CODE_9");
  });

  it("refresh sends grant_type=refresh_token", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ access_token: "at_2" }), { status: 200 });
    });
    const adapter = makeAdapter(specWith(RefreshPolicy.Rotating(1)));
    await Effect.runPromise(adapter.refresh("rt_1"));
    const params = new URLSearchParams(calls[0]);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("rt_1");
  });

  it("routes a spec's parseTokens override, and passes the grant kind", async () => {
    const seen: string[] = [];
    const spec: OAuthProviderSpec<TestOAuthNotConfigured> = {
      ...specWith(RefreshPolicy.Rotating(1)),
      parseTokens: (raw, kind) => {
        seen.push(kind);
        // Prove the RAW body reaches the override untouched — Slack needs this
        // to read `ok:false` and the nested `authed_user`.
        return Effect.succeed({ accessToken: `parsed:${JSON.stringify(raw)}:${kind}` });
      },
    };
    const adapter = makeAdapter(spec);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ nested: { deep: 1 } }), { status: 200 }));

    const exchanged = await Effect.runPromise(adapter.exchangeCode("C"));
    const refreshed = await Effect.runPromise(adapter.refresh("R"));

    expect(seen).toEqual(["exchange", "refresh"]);
    expect(exchanged.accessToken).toBe('parsed:{"nested":{"deep":1}}:exchange');
    expect(refreshed.accessToken).toBe('parsed:{"nested":{"deep":1}}:refresh');
  });

  it("propagates the provider's not-configured tag without sending a request", async () => {
    vi.stubEnv("TEST_CLIENT_ID", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const adapter = makeAdapter(specWith(RefreshPolicy.None));
    const exit = await Effect.runPromiseExit(adapter.exchangeCode("C"));
    expect(failureTag(exit)).toBe("TestOAuthNotConfigured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("adapterFor", () => {
  it("returns undefined for an unknown provider rather than silently falling back", () => {
    // The ternary this replaces (`provider === "hubspot" ? HUBSPOT : ATTIO`)
    // would have run the Attio handshake for a typo'd provider id.
    const registry = { attio: makeAdapter(specWith(RefreshPolicy.None, "attio")) };
    expect(adapterFor(registry, "attio")?.id).toBe("attio");
    expect(adapterFor(registry, "atttio")).toBeUndefined();
  });
});
