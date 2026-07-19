/**
 * `GET /api/oauth/google/callback` boundary tests, run OFFLINE against a
 * `TestLayer` runtime with a stubbed `fetch` (no live DB, no live Google).
 *
 * The load-bearing case here is `sessionUser: null`. That is the PRIMARY flow —
 * the desktop opens consent with `openExternal`, so the system browser carries
 * no gtmgrid.dev cookie and the callback genuinely lands without a session. It
 * is also the flow nobody tests by hand, which is exactly how Slack shipped a
 * version where a successful consent ended in a 502 with the single-use code
 * already burned. It gets its own test, first.
 *
 * Everything except Google's two HTTP calls runs for real in-memory: state
 * signing, code exchange, credential encrypt + persist.
 */

import type { InMemoryUser, Membership, TestLayerFixtures } from "@gtmgrid/services";
import { GOOGLE_ADAPTER, GoogleConnectionService, TestLayer } from "@gtmgrid/services";
import { Effect, ManagedRuntime, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callbackResponse, type CallbackSessionUser } from "../../../../../lib/crm/crm-callback";
import { GOOGLE_OAUTH } from "../../../../../lib/crm/oauth-providers";

const captured = vi.hoisted(() => vi.fn());
vi.mock("../../../../../lib/posthog-server", () => ({ captureServer: captured }));

const WS = "11111111-1111-1111-1111-111111111111";
const OWNER = "user_owner";

const users: readonly InMemoryUser[] = [{ id: OWNER, name: "Olive Owner", email: "owner@acme.com" }];
const workspaces = [{ id: WS, name: "Acme", ownerId: OWNER }];
const ownerMembership: Membership = { workspaceId: WS, userId: OWNER, role: "owner" };
const sessionUser: CallbackSessionUser = { id: OWNER, name: "Olive Owner", email: "owner@acme.com" };

function runtimeFor(over: Partial<TestLayerFixtures> = {}) {
  return ManagedRuntime.make(
    TestLayer({ workspaces, memberships: [ownerMembership], users, currentUserId: OWNER, ...over }),
  );
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

/** Stub the two Google calls: token exchange, then userinfo. */
function stubGoogleFetch(opts: { token?: Record<string, unknown>; userinfo?: Record<string, unknown> | null } = {}) {
  const token = opts.token ?? {
    access_token: "ya29.live",
    refresh_token: "1//live",
    expires_in: 3599,
    token_type: "Bearer",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === TOKEN_URL) {
        return new Response(JSON.stringify(token), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === USERINFO_URL) {
        if (opts.userinfo === null) return new Response("nope", { status: 500 });
        return new Response(JSON.stringify(opts.userinfo ?? { email: "morgan@trigify.io" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret";
  process.env.GOOGLE_CLIENT_ID = "google-client";
  process.env.GOOGLE_CLIENT_SECRET = "google-secret";
  process.env.SITE_URL = "https://www.gtmgrid.dev";
});

afterEach(() => {
  captured.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Mint a genuine signed state. Adapters are `R = never`, so no runtime needed. */
async function mintState() {
  const state = await Effect.runPromise(GOOGLE_ADAPTER.mintState({ workspaceId: WS, userId: OWNER }));
  if (state === null) throw new Error("expected a signed state");
  return state;
}

const connectionFor = (runtime: ReturnType<typeof runtimeFor>) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const svc = yield* GoogleConnectionService;
      return yield* svc.memberConnection(WS);
    }),
  );

describe("callbackResponse — Google, with NO browser session", () => {
  it("completes the connection when sessionUser is null — the PRIMARY desktop flow", async () => {
    // openExternal carries no cookie. The signed state is the whole trust
    // boundary; requiring a session here is what once broke Slack AFTER consent.
    stubGoogleFetch();
    const runtime = runtimeFor();
    try {
      const state = await mintState();
      const res = await callbackResponse({
        oauth: GOOGLE_OAUTH,
        runtime,
        code: "auth-code",
        state,
        error: null,
        sessionUser: null,
      });

      expect(res.status).toBe(200);
      const connection = await connectionFor(runtime);
      expect(Option.isSome(connection)).toBe(true);
      if (Option.isSome(connection)) {
        expect(connection.value.tokens.accessToken).toBe("ya29.live");
        expect(connection.value.tokens.refreshToken).toBe("1//live");
        // And the name still resolves: with no session the core falls back to a
        // DB lookup keyed on the STATE's userId, so "connected by" survives a
        // flow that has no cookie at all. The session is an optimisation here,
        // never a requirement.
        expect(connection.value.meta.connectedByName).toBe("Olive Owner");
      }
    } finally {
      await runtime.dispose();
    }
  });
});

describe("callbackResponse — Google", () => {
  it("invalid state → 400 human page, and NO token exchange", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const runtime = runtimeFor();
    try {
      const res = await callbackResponse({
        oauth: GOOGLE_OAUTH,
        runtime,
        code: "code",
        state: "garbage",
        error: null,
        sessionUser,
      });
      expect(res.status).toBe(400);
      // The CSRF gate must precede the exchange, or a forged state burns a code.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });

  it("rejects a state minted for ANOTHER provider", async () => {
    // Both providers fall back to BETTER_AUTH_SECRET, so the provider id baked
    // into the payload is what stops a Slack state opening a Google connection.
    const { SLACK_ADAPTER } = await import("@gtmgrid/services");
    const foreign = await Effect.runPromise(
      SLACK_ADAPTER.mintState({ workspaceId: WS, userId: OWNER }),
    );
    if (foreign === null) throw new Error("expected a signed state");

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const runtime = runtimeFor();
    try {
      const res = await callbackResponse({
        oauth: GOOGLE_OAUTH,
        runtime,
        code: "code",
        state: foreign,
        error: null,
        sessionUser,
      });
      expect(res.status).toBe(400);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });

  it("user cancelled → friendly page linking back to the GOOGLE authorize path", async () => {
    const runtime = runtimeFor();
    try {
      const state = await mintState();
      const res = await callbackResponse({
        oauth: GOOGLE_OAUTH,
        runtime,
        code: "",
        state,
        error: "access_denied",
        sessionUser,
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("/api/oauth/google/authorize");
    } finally {
      await runtime.dispose();
    }
  });

  it("stores the account email and records connectedBy from the session", async () => {
    stubGoogleFetch();
    const runtime = runtimeFor();
    try {
      const state = await mintState();
      await callbackResponse({
        oauth: GOOGLE_OAUTH,
        runtime,
        code: "auth-code",
        state,
        error: null,
        sessionUser,
      });

      const connection = await connectionFor(runtime);
      expect(Option.isSome(connection)).toBe(true);
      if (Option.isSome(connection)) {
        expect(connection.value.meta.googleEmail).toBe("morgan@trigify.io");
        expect(connection.value.meta.connectedByName).toBe("Olive Owner");
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("starts with NO picked files — a fresh grant can reach nothing", async () => {
    // Under drive.file this is the correct, and initially surprising, state.
    stubGoogleFetch();
    const runtime = runtimeFor();
    try {
      const state = await mintState();
      await callbackResponse({
        oauth: GOOGLE_OAUTH,
        runtime,
        code: "auth-code",
        state,
        error: null,
        sessionUser,
      });
      const connection = await connectionFor(runtime);
      expect(Option.isSome(connection) && connection.value.meta.pickedFiles).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it("still connects when the userinfo lookup FAILS — the email is cosmetic", async () => {
    // Failing here would discard a successfully exchanged grant (and burn the
    // one-time code) over a display label.
    stubGoogleFetch({ userinfo: null });
    const runtime = runtimeFor();
    try {
      const state = await mintState();
      const res = await callbackResponse({
        oauth: GOOGLE_OAUTH,
        runtime,
        code: "auth-code",
        state,
        error: null,
        sessionUser,
      });

      expect(res.status).toBe(200);
      const connection = await connectionFor(runtime);
      expect(Option.isSome(connection)).toBe(true);
      if (Option.isSome(connection)) {
        expect(connection.value.tokens.accessToken).toBe("ya29.live");
        expect(connection.value.meta.googleEmail).toBe("");
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("captures google_connected, NOT crm_connected", async () => {
    // The CRM adoption funnel must stay CRM-only.
    stubGoogleFetch();
    const runtime = runtimeFor();
    try {
      const state = await mintState();
      await callbackResponse({
        oauth: GOOGLE_OAUTH,
        runtime,
        code: "auth-code",
        state,
        error: null,
        sessionUser,
      });
      expect(captured).toHaveBeenCalledWith("google_connected", expect.anything());
      expect(captured).not.toHaveBeenCalledWith("crm_connected", expect.anything());
    } finally {
      await runtime.dispose();
    }
  });
});
