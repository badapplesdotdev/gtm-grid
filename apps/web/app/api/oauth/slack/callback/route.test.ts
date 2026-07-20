/**
 * `GET /api/oauth/slack/callback` boundary tests, run OFFLINE against a
 * `TestLayer` runtime with a stubbed `fetch` (no live DB, no live Slack).
 *
 * Modelled on `app/api/crm/attio/callback/route.test.ts` — deliberately, since
 * the whole point of `persistConnection` was to let ONE callback core serve a
 * CRM and a plain connector. These prove the core still behaves when the
 * provider has no bindings, no sync client, and Slack's own response quirks.
 *
 * Everything except the two Slack HTTP calls runs for real in-memory: state
 * signing, `ok:false` detection, credential encrypt + persist.
 */

import type { InMemoryUser, Membership, TestLayerFixtures } from "@gtmgrid/services";
import { SLACK_ADAPTER, SlackConnectionService, TestLayer } from "@gtmgrid/services";
import { Effect, ManagedRuntime, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callbackResponse, type CallbackSessionUser } from "../../../../../lib/crm/crm-callback";
import { SLACK_OAUTH } from "../../../../../lib/crm/oauth-providers";

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

/** Stub `oauth.v2.access`. Slack answers 200 even when it is refusing. */
function stubSlackFetch(body: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://slack.com/api/oauth.v2.access") {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

const OK_EXCHANGE = {
  ok: true,
  access_token: "xoxe.xoxb-live",
  refresh_token: "xoxe-1-live",
  expires_in: 43_200,
  token_type: "bot",
  bot_user_id: "U_BOT",
  team: { id: "T_ACME", name: "Acme Slack" },
};

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret";
  process.env.SLACK_CLIENT_ID = "slack-client";
  process.env.SLACK_CLIENT_SECRET = "slack-secret";
  process.env.SITE_URL = "https://www.gtmgrid.dev";
});

afterEach(() => {
  captured.mockClear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Mint a genuine signed state.
 *
 * Straight off `SLACK_ADAPTER`, not via a service: adapters are `R = never` by
 * design, so state minting needs no runtime at all. (The CRM equivalents go
 * through `AttioAuth` only because those services predate the adapter and are
 * still in `AppServices`.)
 */
async function mintState() {
  const state = await Effect.runPromise(SLACK_ADAPTER.mintState({ workspaceId: WS, userId: OWNER }));
  if (state === null) throw new Error("expected a signed state");
  return state;
}

describe("callbackResponse — Slack", () => {
  it("invalid state → 400 human page, and NO token exchange", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const runtime = runtimeFor();
    try {
      const res = await callbackResponse({
        oauth: SLACK_OAUTH,
        runtime,
        code: "code",
        state: "garbage",
        error: null,
        sessionUser,
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("expired");
      // The CSRF gate must come BEFORE the exchange, or a forged state burns a code.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });

  it("user canceled on Slack → friendly page linking back to the SLACK authorize path", async () => {
    const runtime = runtimeFor();
    try {
      const state = await mintState();
      const res = await callbackResponse({
        oauth: SLACK_OAUTH,
        runtime,
        code: "",
        state,
        error: "access_denied",
        sessionUser,
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      // Would have been the 404 `/api/crm/slack/authorize` under the old
      // hardcoded `/api/crm/${provider}/authorize` template.
      expect(html).toContain("/api/oauth/slack/authorize");
    } finally {
      await runtime.dispose();
    }
  });

  it("valid state → exchange, persist at the 'slack' slot, and bounce via the SLACK deep link", async () => {
    stubSlackFetch(OK_EXCHANGE);
    const runtime = runtimeFor();
    try {
      const state = await mintState();
      const res = await callbackResponse({
        oauth: SLACK_OAUTH,
        runtime,
        code: "code_live",
        state,
        error: null,
        sessionUser,
      });

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Acme Slack");

      // The success page must NOT send a Slack user to the CRM route. The
      // "Open GTM Grid" button is the fallback when the browser doesn't hand off
      // the gtmgrid:// protocol — the only path where it matters — and it was
      // hardcoded to /open?to=crm-connected for every provider.
      expect(html).not.toContain("crm-connected");
      // Focus the app; the card's poll converges on its own. A slack-connected
      // destination would be dead until added to three separate allowlists.
      expect(html).toContain("gtmgrid://open");

      // The connection really landed, decryptable, with the team + bot ids.
      const stored = await runtime.runPromise(
        Effect.flatMap(SlackConnectionService, (s) => s.memberConnection(WS)),
      );
      expect(Option.isSome(stored)).toBe(true);
      if (Option.isSome(stored)) {
        expect(stored.value.tokens.accessToken).toBe("xoxe.xoxb-live");
        expect(stored.value.tokens.refreshToken).toBe("xoxe-1-live");
        expect(stored.value.meta.teamId).toBe("T_ACME");
        expect(stored.value.meta.teamName).toBe("Acme Slack");
        expect(stored.value.meta.botUserId).toBe("U_BOT");
        expect(stored.value.meta.connectedByName).toBe("Olive Owner");
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("THE DESKTOP FLOW: persists with NO browser session at all", async () => {
    // The primary flow, and the one that was never tested. The desktop opens the
    // consent URL with `openExternal`, so the system browser carries no
    // gtmgrid.dev cookie and the callback lands with sessionUser === null and no
    // resolvable identity.
    //
    // Every other test in this file supplies a session user who is a member, so
    // they all exercised a path the real desktop never takes. Meanwhile
    // saveConnection called saveCredential -> requireMember, which cannot pass
    // without an identity: consent succeeded, the code was exchanged and burned,
    // tokens were minted under rotation — and then the write failed and the user
    // got a 502. The route header calls this exact flow the trust model ("NO
    // BROWSER SESSION IS REQUIRED"); it was the only one broken.
    //
    // The signed state is what authorises the write: slack.authorizeUrl mints one
    // only after requireMember, and callbackResponse verifies it before
    // persisting.
    stubSlackFetch(OK_EXCHANGE);
    const runtime = ManagedRuntime.make(
      TestLayer({
        workspaces,
        memberships: [ownerMembership],
        users,
        // No session. Not "a stranger" — NOBODY.
        currentUserId: null,
      }),
    );
    try {
      const state = await mintState();
      const res = await callbackResponse({
        oauth: SLACK_OAUTH,
        runtime,
        code: "code_live",
        state,
        error: null,
        sessionUser: null,
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Acme Slack");

      // The connection really landed, written from a session-less browser and
      // decryptable afterwards. Read back through the WORKER path: the read is
      // member-gated too, and there is still no member here — which is precisely
      // the situation the write had to survive.
      const teams = await runtime.runPromise(
        Effect.flatMap(SlackConnectionService, (s) => s.connectedTeamIdsForWorker(WS)),
      );
      expect(teams).toEqual(["T_ACME"]);
    } finally {
      await runtime.dispose();
    }
  });

  it("fires slack_connected, NOT crm_connected — the CRM funnel stays CRM-only", async () => {
    // `crm_connected` means "a workspace connected a CRM (the wizard's step-2
    // completion)" and every dashboard keyed on it tracks CRM adoption. Slack is
    // a connector, not a CRM, so folding it in would silently change what those
    // dashboards measure — a metrics bug nothing would ever throw on. The event
    // name lives on the ADAPTER (like connectedDeepLink) precisely so it can't
    // default to the CRM one.
    stubSlackFetch(OK_EXCHANGE);
    const runtime = runtimeFor();
    try {
      const state = await mintState();
      await callbackResponse({
        oauth: SLACK_OAUTH,
        runtime,
        code: "code_live",
        state,
        error: null,
        sessionUser,
      });

      expect(captured).toHaveBeenCalledOnce();
      const [name, args] = captured.mock.calls[0] ?? [];
      expect(name).toBe("slack_connected");
      expect(name).not.toBe("crm_connected");
      expect(args).toMatchObject({ properties: { workspace_id: WS } });
      // No `provider` property: slack_connected isn't parameterised by one.
      expect(Object.keys(args?.properties ?? {})).not.toContain("provider");
    } finally {
      await runtime.dispose();
    }
  });

  it("emits NOTHING when the exchange fails — no phantom connect in the funnel", async () => {
    stubSlackFetch({ ok: false, error: "invalid_code" });
    const runtime = runtimeFor();
    try {
      const state = await mintState();
      await callbackResponse({
        oauth: SLACK_OAUTH,
        runtime,
        code: "bad_code",
        state,
        error: null,
        sessionUser,
      });
      expect(captured).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });

  it("Slack refusing with ok:false on an HTTP 200 does NOT persist a connection", async () => {
    // The trap: HTTP 200 makes this look like a successful exchange. If
    // parseTokens missed `ok:false`, we'd store `accessToken: undefined` and
    // report "connected".
    stubSlackFetch({ ok: false, error: "invalid_code" });
    const runtime = runtimeFor();
    try {
      const state = await mintState();
      const res = await callbackResponse({
        oauth: SLACK_OAUTH,
        runtime,
        code: "bad_code",
        state,
        error: null,
        sessionUser,
      });
      expect(res.status).toBe(502);

      const stored = await runtime.runPromise(
        Effect.flatMap(SlackConnectionService, (s) => s.memberConnection(WS)),
      );
      expect(Option.isNone(stored)).toBe(true);
    } finally {
      await runtime.dispose();
    }
  });
});
