/**
 * SlackAuth: the authorize URL, and the `oauth.v2.access` exchange/refresh paths
 * over a fake fetch. No live HTTP.
 *
 * The load-bearing test is "`ok:false` on an HTTP 200 is a typed FAILURE". Slack
 * reports nearly every token error that way, and `tokenRequest` only reaches
 * `parseTokens` on the HTTP success path — so if `parseSlackTokens` didn't gate
 * on `ok`, a refusal would be stored as a successful connection and surface much
 * later as an inexplicably dead integration.
 *
 * Failures are read via `Cause.failureOption`, never by regex over
 * `JSON.stringify(cause)`: the CAUSE's own `_tag` ("Fail") matches such a regex
 * before the error's does, which silently makes every assertion compare "Fail"
 * against itself and pass regardless of the tag under test.
 */

import { Cause, Effect, Exit, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefreshPolicy, requiresSerializedRefresh } from "../oauth/types.js";
import { SLACK_ADAPTER, SLACK_SPEC, parseSlackTokens } from "./slack-auth.js";

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);
const runExit = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromiseExit(effect);

const failureTag = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>): string => {
  if (Exit.isSuccess(exit)) return "none";
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure) ? failure.value._tag : "unknown";
};

/** Respond with `body` as JSON at `status` (default 200 — Slack's error status). */
const stubFetch = (body: unknown, status = 200): void => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status }));
};

/** A complete, realistic exchange response: bot token at the ROOT, user nested. */
const EXCHANGE_BODY = {
  ok: true,
  app_id: "A0KRD7HC3",
  access_token: "xoxe.xoxb-1-bot-token",
  token_type: "bot",
  scope: "chat:write,users:read",
  bot_user_id: "U0BOT",
  refresh_token: "xoxe-1-bot-refresh",
  expires_in: 43200,
  team: { id: "T9TK3CUKW", name: "Slack Softball Team" },
  authed_user: {
    id: "U0KRQLJ9H",
    access_token: "xoxe.xoxp-1-user-token",
    refresh_token: "xoxe-1-user-refresh",
    token_type: "user",
  },
  is_enterprise_install: false,
};

/** A refresh response: FLAT — no `authed_user` envelope. */
const REFRESH_BODY = {
  ok: true,
  app_id: "A0KRD7HC3",
  access_token: "xoxe.xoxb-2-rotated-bot-token",
  token_type: "bot",
  refresh_token: "xoxe-1-rotated-bot-refresh",
  expires_in: 43200,
  bot_user_id: "U0BOT",
  team_id: "T9TK3CUKW",
  team_name: "Slack Softball Team",
  is_enterprise_install: false,
};

beforeEach(() => {
  vi.stubEnv("SLACK_CLIENT_ID", "client-123");
  vi.stubEnv("SLACK_CLIENT_SECRET", "secret-456");
  vi.stubEnv("BETTER_AUTH_SECRET", "test-hmac-secret");
  vi.stubEnv("SITE_URL", "https://www.gtmgrid.dev");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("spec identity", () => {
  it("uses the BARE connector id as the credential slot", () => {
    // Not "slack-crm": the engine resolves credentials by connector id, so a
    // decorated id hands the connector an empty credential at run time.
    expect(SLACK_SPEC.id).toBe("slack");
    expect(SLACK_ADAPTER.id).toBe("slack");
  });

  it("declares Rotating, which is what forces callers to serialize refresh", () => {
    // Single-use refresh tokens: a redundant refresh REVOKES a live token, so
    // this must not degrade to Proactive.
    expect(SLACK_SPEC.refreshPolicy).toEqual(RefreshPolicy.Rotating(30 * 60 * 1000));
    expect(requiresSerializedRefresh(SLACK_SPEC.refreshPolicy)).toBe(true);
  });
});

describe("authorizeUrl", () => {
  it("targets slack.com/oauth/v2/authorize with COMMA-separated scopes, state, and redirect_uri", async () => {
    const url = new URL(await run(SLACK_ADAPTER.authorizeUrl("STATE_TOKEN")));

    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://www.gtmgrid.dev/api/oauth/slack/callback");
    expect(url.searchParams.get("state")).toBe("STATE_TOKEN");
    // Slack is the odd one out: HubSpot joins with " ", Slack with ",".
    expect(url.searchParams.get("scope")).toBe(
      "chat:write,chat:write.public,channels:read,groups:read,im:read,mpim:read,users:read,users:read.email",
    );
  });
});

describe("ok:false on an HTTP 200 (Slack's deviation from RFC 6749)", () => {
  it("is a typed FAILURE, never a success", async () => {
    stubFetch({ ok: false, error: "invalid_code" }, 200);
    const exit = await runExit(SLACK_ADAPTER.exchangeCode("CODE"));
    expect(Exit.isSuccess(exit)).toBe(false);
  });

  it("reports Slack's reason, not a misleading 'no access_token'", async () => {
    stubFetch({ ok: false, error: "missing_scope" }, 200);
    const exit = await runExit(SLACK_ADAPTER.exchangeCode("CODE"));
    expect(failureTag(exit)).toBe("CrmSyncError");
    expect(JSON.stringify(exit)).toContain("missing_scope");
  });

  it("fails even when ok:false is paired with a token-shaped body", async () => {
    // The nightmare case: gate on the token and this reads as a clean success.
    stubFetch({ ok: false, error: "invalid_auth", access_token: "xoxb-looks-real" }, 200);
    const exit = await runExit(SLACK_ADAPTER.exchangeCode("CODE"));
    expect(failureTag(exit)).toBe("CrmAuthRevoked");
  });

  it("fails when `ok` is absent entirely (never assume success)", async () => {
    const exit = await runExit(parseSlackTokens({ access_token: "xoxb-1" }, "exchange"));
    expect(failureTag(exit)).toBe("CrmSyncError");
  });

  it("fails when ok:false names no error at all", async () => {
    const exit = await runExit(parseSlackTokens({ ok: false }, "refresh"));
    expect(failureTag(exit)).toBe("CrmSyncError");
    expect(JSON.stringify(exit)).toContain("named no error");
  });
});

describe("error taxonomy", () => {
  it.each([
    "invalid_auth",
    "token_revoked",
    "token_expired",
    "account_inactive",
    "invalid_grant_type",
    "bad_client_secret",
    "invalid_code",
    "invalid_refresh_token",
  ])("%s is CrmAuthRevoked (re-auth)", async (code) => {
    const exit = await runExit(parseSlackTokens({ ok: false, error: code }, "refresh"));
    expect(failureTag(exit)).toBe("CrmAuthRevoked");
  });

  it.each(["ratelimited", "service_unavailable", "internal_error", "request_timeout", "fatal_error"])(
    "%s is CrmServerError (transient, retried — NOT a dead connection)",
    async (code) => {
      const exit = await runExit(parseSlackTokens({ ok: false, error: code }, "refresh"));
      expect(failureTag(exit)).toBe("CrmServerError");
    },
  );

  it.each(["missing_scope", "bad_redirect_uri", "oauth_authorization_url_mismatch", "some_future_slack_error"])(
    "%s is CrmSyncError naming the Slack code",
    async (code) => {
      const exit = await runExit(parseSlackTokens({ ok: false, error: code }, "exchange"));
      expect(failureTag(exit)).toBe("CrmSyncError");
      expect(JSON.stringify(exit)).toContain(code);
    },
  );

  it("keeps a transient error distinguishable from a revoked grant", async () => {
    // The distinction the sync loop turns into "retry" vs "disconnect the
    // workspace" — the whole point of the taxonomy.
    const rate = await runExit(parseSlackTokens({ ok: false, error: "ratelimited" }, "refresh"));
    const dead = await runExit(parseSlackTokens({ ok: false, error: "token_revoked" }, "refresh"));
    expect(failureTag(rate)).not.toBe(failureTag(dead));
  });
});

describe("exchange (root/nested shape)", () => {
  it("reads the BOT token from the ROOT and drops the user token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T10:00:00Z"));
    stubFetch(EXCHANGE_BODY);

    const tokens = await run(SLACK_ADAPTER.exchangeCode("CODE_9"));

    expect(tokens.accessToken).toBe("xoxe.xoxb-1-bot-token");
    expect(tokens.refreshToken).toBe("xoxe-1-bot-refresh");
    // The user token and its own rotation chain are deliberately not persisted.
    expect(JSON.stringify(tokens)).not.toContain("user-token");
    expect(JSON.stringify(tokens)).not.toContain("user-refresh");
  });

  it("turns expires_in: 43200 into an absolute expiry (12h)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T10:00:00Z"));
    stubFetch(EXCHANGE_BODY);

    const tokens = await run(SLACK_ADAPTER.exchangeCode("CODE_9"));

    expect(tokens.expiresAtMs).toBe(new Date("2026-07-04T22:00:00Z").getTime());
  });

  it("lands team id/name and bot_user_id in extra", async () => {
    stubFetch(EXCHANGE_BODY);
    const tokens = await run(SLACK_ADAPTER.exchangeCode("CODE_9"));
    expect(tokens.extra).toEqual({
      teamId: "T9TK3CUKW",
      teamName: "Slack Softball Team",
      botUserId: "U0BOT",
    });
  });

  it("posts the authorization_code grant to oauth.v2.access", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response(JSON.stringify(EXCHANGE_BODY), { status: 200 });
    });

    await run(SLACK_ADAPTER.exchangeCode("CODE_9"));

    expect(calls[0].url).toBe("https://slack.com/api/oauth.v2.access");
    const params = new URLSearchParams(calls[0].body);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("code")).toBe("CODE_9");
    expect(params.get("client_id")).toBe("client-123");
    expect(params.get("client_secret")).toBe("secret-456");
    // Slack silently routes to the FIRST configured redirect URL without it.
    expect(params.get("redirect_uri")).toBe("https://www.gtmgrid.dev/api/oauth/slack/callback");
  });

  it("rejects a user-token-only install instead of half-connecting", async () => {
    stubFetch({ ok: true, authed_user: { id: "U1", access_token: "xoxe.xoxp-1-user", token_type: "user" } });
    const exit = await runExit(SLACK_ADAPTER.exchangeCode("CODE"));
    expect(failureTag(exit)).toBe("CrmSyncError");
    expect(JSON.stringify(exit)).toContain("bot token");
  });
});

describe("refresh (FLAT shape — same endpoint, different body)", () => {
  it("parses the flat response and rotates BOTH tokens", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T10:00:00Z"));
    stubFetch(REFRESH_BODY);

    const tokens = await run(SLACK_ADAPTER.refresh("xoxe-1-bot-refresh"));

    expect(tokens).toEqual({
      accessToken: "xoxe.xoxb-2-rotated-bot-token",
      // Single-use: the response's NEW refresh token must be the one we keep,
      // or the next refresh replays a spent one.
      refreshToken: "xoxe-1-rotated-bot-refresh",
      expiresAtMs: new Date("2026-07-04T22:00:00Z").getTime(),
      extra: { teamId: "T9TK3CUKW", teamName: "Slack Softball Team", botUserId: "U0BOT" },
    });
  });

  it("posts the refresh_token grant", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push(String(init?.body ?? ""));
      return new Response(JSON.stringify(REFRESH_BODY), { status: 200 });
    });

    await run(SLACK_ADAPTER.refresh("xoxe-1-bot-refresh"));

    const params = new URLSearchParams(calls[0]);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("xoxe-1-bot-refresh");
  });
});

describe("malformed bodies fail loudly rather than persisting garbage", () => {
  it("a wrong-typed access_token is CrmSyncError, not a stored number", async () => {
    stubFetch({ ok: true, access_token: 123 });
    const exit = await runExit(SLACK_ADAPTER.exchangeCode("CODE"));
    expect(failureTag(exit)).toBe("CrmSyncError");
  });

  it("a non-object body is CrmSyncError", async () => {
    stubFetch("nope");
    const exit = await runExit(SLACK_ADAPTER.exchangeCode("CODE"));
    expect(failureTag(exit)).toBe("CrmSyncError");
  });

  it("omits extra entirely when the body carries no identity fields", async () => {
    stubFetch({ ok: true, access_token: "xoxb-bare" });
    const tokens = await run(SLACK_ADAPTER.exchangeCode("CODE"));
    expect(tokens).toEqual({ accessToken: "xoxb-bare" });
  });

  it("ignores wrong-typed identity fields rather than coercing them", async () => {
    stubFetch({ ok: true, access_token: "xoxb-1", bot_user_id: 42, team: { id: "T1", name: null } });
    const tokens = await run(SLACK_ADAPTER.exchangeCode("CODE"));
    expect(tokens.extra).toEqual({ teamId: "T1" });
  });
});

describe("transport-level failures still come from the shared core", () => {
  it("a real 5xx is CrmServerError", async () => {
    vi.stubGlobal("fetch", async () => new Response("upstream boom", { status: 503 }));
    const exit = await runExit(SLACK_ADAPTER.refresh("rt"));
    expect(failureTag(exit)).toBe("CrmServerError");
  });

  it("a rejected fetch is CrmNetworkError", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNRESET");
    });
    const exit = await runExit(SLACK_ADAPTER.refresh("rt"));
    expect(failureTag(exit)).toBe("CrmNetworkError");
  });
});

describe("unconfigured env", () => {
  it.each(["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET"])(
    "missing %s fails closed with SlackOAuthNotConfigured and never calls fetch",
    async (envVar) => {
      vi.stubEnv(envVar, "");
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const exit = await runExit(SLACK_ADAPTER.exchangeCode("CODE"));

      expect(failureTag(exit)).toBe("SlackOAuthNotConfigured");
      expect(JSON.stringify(exit)).toContain(envVar);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("isConfigured reflects the env", async () => {
    expect(await run(SLACK_ADAPTER.isConfigured())).toBe(true);
    vi.stubEnv("SLACK_CLIENT_SECRET", "");
    expect(await run(SLACK_ADAPTER.isConfigured())).toBe(false);
  });

  it("mints a state that round-trips, and never an unsigned one", async () => {
    const claims = { workspaceId: "ws_a", userId: "user_1" };
    const state = await run(SLACK_ADAPTER.mintState(claims));
    if (state === null) throw new Error("expected state");
    expect(await run(SLACK_ADAPTER.verifyState(state))).toEqual(claims);

    vi.stubEnv("BETTER_AUTH_SECRET", "");
    vi.stubEnv("SLACK_OAUTH_SECRET", "");
    expect(await run(SLACK_ADAPTER.mintState(claims))).toBeNull();
  });
});
