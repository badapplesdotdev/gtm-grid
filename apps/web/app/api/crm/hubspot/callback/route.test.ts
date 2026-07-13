/**
 * `GET /api/crm/hubspot/callback` boundary tests, run OFFLINE against a
 * `TestLayer` runtime with a stubbed `fetch` (no live DB, no live HubSpot).
 * The provider-agnostic core is exhaustively covered by the attio callback
 * tests — these prove the HUBSPOT adapter's specifics: the hubapi.com token
 * exchange, portal identification via token introspection, the hubspot-crm
 * credential slot, and clearing PROVIDER-SCOPED auth_revoked pauses.
 */

import type { AppServices, InMemoryUser, Membership, TestLayerFixtures } from "@gtmgrid/services";
import { CrmBindingRepo, CrmConnectionService, HubspotAuth, TestLayer } from "@gtmgrid/services";
import { Effect, ManagedRuntime, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callbackResponse, type CallbackSessionUser } from "../../../../../lib/crm/crm-callback";
import { HUBSPOT_OAUTH } from "../../../../../lib/crm/oauth-providers";

type ServicesRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>;

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

/** Stub the two HubSpot HTTP calls: the token exchange and token introspection. */
function stubHubspotFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.hubapi.com/oauth/v1/token") {
        return new Response(
          JSON.stringify({ access_token: "at_live", refresh_token: "rt_live", expires_in: 1800 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://api.hubapi.com/oauth/v1/access-tokens/at_live") {
        return new Response(JSON.stringify({ hub_id: 424242, hub_domain: "acme.hubspot.com" }), {
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
  process.env.HUBSPOT_CLIENT_ID = "hubspot-client";
  process.env.HUBSPOT_CLIENT_SECRET = "hubspot-secret";
  process.env.SITE_URL = "https://www.gtmgrid.dev";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.HUBSPOT_CLIENT_ID;
  delete process.env.HUBSPOT_CLIENT_SECRET;
});

/** Mint a genuine signed state for `(WS, OWNER)` against the runtime. */
async function mintState(runtime: ServicesRuntime) {
  const state = await runtime.runPromise(
    Effect.flatMap(HubspotAuth, (a) => a.mintState({ workspaceId: WS, userId: OWNER })),
  );
  if (state === null) throw new Error("expected a signed state");
  return state;
}

describe("hubspot callbackResponse", () => {
  it("valid state → exchanges at hubapi.com, persists under the hubspot slot, and clears hubspot pauses only", async () => {
    stubHubspotFetch();
    const runtime = runtimeFor();
    try {
      const state = await mintState(runtime);

      // One paused binding per provider: only the hubspot one may resume.
      const bindingIds = await runtime.runPromise(
        Effect.gen(function* () {
          const bindings = yield* CrmBindingRepo;
          const mk = (provider: string) =>
            bindings.insert({
              workspaceId: WS,
              tableId: `tbl_${provider}`,
              provider,
              sourceKind: "object",
              sourceId: "contacts",
              sourceLabel: "Contacts",
              columns: [],
              config: {},
              schedule: "daily",
              enabled: true,
              createdAt: Date.now(),
            });
          const hubspotId = yield* mk("hubspot");
          const attioId = yield* mk("attio");
          yield* bindings.patch(hubspotId, { pausedReason: "auth_revoked", lastError: "x" });
          yield* bindings.patch(attioId, { pausedReason: "auth_revoked", lastError: "x" });
          return { hubspotId, attioId };
        }),
      );

      const res = await callbackResponse({
        oauth: HUBSPOT_OAUTH,
        runtime,
        code: "code-1",
        state,
        error: null,
        sessionUser,
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("Connected to acme.hubspot.com");
      expect(body).toContain("gtmgrid://open/crm-connected");

      const after = await runtime.runPromise(
        Effect.gen(function* () {
          const conn = yield* CrmConnectionService;
          const bindings = yield* CrmBindingRepo;
          const hubspotMeta = yield* conn.connectionMeta(WS, "hubspot");
          const attioMeta = yield* conn.connectionMeta(WS, "attio");
          const hubspot = yield* bindings.findById(bindingIds.hubspotId);
          const attio = yield* bindings.findById(bindingIds.attioId);
          return { hubspotMeta, attioMeta, hubspot, attio };
        }),
      );
      // Saved under the hubspot slot — the attio slot stays empty.
      expect(Option.isSome(after.hubspotMeta)).toBe(true);
      if (Option.isSome(after.hubspotMeta)) {
        expect(after.hubspotMeta.value.crmWorkspaceName).toBe("acme.hubspot.com");
        expect(after.hubspotMeta.value.crmWorkspaceId).toBe("424242");
      }
      expect(Option.isNone(after.attioMeta)).toBe(true);
      // Provider-scoped un-pause.
      expect(Option.isSome(after.hubspot) && after.hubspot.value.pausedReason).toBeNull();
      expect(Option.isSome(after.attio) && after.attio.value.pausedReason).toBe("auth_revoked");
    } finally {
      await runtime.dispose();
    }
  });

  it("a failed exchange renders the retry page pointing at the hubspot authorize route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid_grant", { status: 400 })),
    );
    const runtime = runtimeFor();
    try {
      const state = await mintState(runtime);
      const res = await callbackResponse({
        oauth: HUBSPOT_OAUTH,
        runtime,
        code: "bad-code",
        state,
        error: null,
        sessionUser,
      });
      expect(res.status).toBe(502);
      const body = await res.text();
      expect(body).toContain("connecting HubSpot");
      expect(body).toContain(`/api/crm/hubspot/authorize?workspace=${WS}`);
    } finally {
      await runtime.dispose();
    }
  });
});
