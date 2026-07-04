/**
 * `GET /api/crm/attio/callback` boundary tests, run OFFLINE against a `TestLayer`
 * runtime with a stubbed `fetch` (no live DB, no live Attio). Proves the CSRF
 * gate and the happy path:
 *   - invalid/expired state → 400 human page, and no token exchange happens
 *   - valid state           → exchange + identify + persist the connection, then
 *     a page that bounces into the app via `gtmgrid://open/crm-connected`
 *
 * The token + `/v2/self` HTTP calls are stubbed on `global.fetch`; everything
 * else (state signing, credential encrypt/persist) runs for real in-memory.
 */

import type { AppServices, InMemoryUser, Membership, TestLayerFixtures } from "@gtmgrid/services";
import { AttioAuth, CrmConnectionService, TestLayer } from "@gtmgrid/services";
import { Effect, ManagedRuntime, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callbackResponse, type CallbackSessionUser } from "../../../../../lib/crm/attio-callback";

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

/** Stub the two Attio HTTP calls: the token exchange and `GET /v2/self`. */
function stubAttioFetch(self: { workspace_id: string; workspace_name: string }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://app.attio.com/oauth/token") {
        return new Response(JSON.stringify({ access_token: "at_live", refresh_token: "rt_live", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://api.attio.com/v2/self") {
        return new Response(JSON.stringify({ data: self }), {
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
  process.env.ATTIO_CLIENT_ID = "attio-client";
  process.env.ATTIO_CLIENT_SECRET = "attio-secret";
  process.env.SITE_URL = "https://www.gtmgrid.dev";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Mint a genuine signed state for `(WS, OWNER)` against the runtime. */
async function mintState(runtime: ServicesRuntime) {
  const state = await runtime.runPromise(Effect.flatMap(AttioAuth, (a) => a.mintState({ workspaceId: WS, userId: OWNER })));
  if (state === null) throw new Error("expected a signed state");
  return state;
}

describe("callbackResponse", () => {
  it("invalid state → 400 human page, no token exchange", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const runtime = runtimeFor();
    try {
      const res = await callbackResponse({ runtime, code: "code", state: "garbage", error: null, sessionUser });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("expired");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });

  it("user canceled on Attio (error=access_denied) → friendly page with retry", async () => {
    const runtime = runtimeFor();
    try {
      const state = await mintState(runtime);
      const res = await callbackResponse({ runtime, code: "", state, error: "access_denied", sessionUser });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("You canceled the connection");
      expect(body).toContain(`/api/crm/attio/authorize?workspace=${WS}`);
    } finally {
      await runtime.dispose();
    }
  });

  it("valid state → persists the connection and bounces into the app", async () => {
    stubAttioFetch({ workspace_id: "attio_ws_1", workspace_name: "Acme CRM" });
    const runtime = runtimeFor();
    try {
      const state = await mintState(runtime);
      const res = await callbackResponse({ runtime, code: "auth_code", state, error: null, sessionUser });

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("gtmgrid://open/crm-connected");
      expect(body).toContain("/open?to=crm-connected");
      expect(body).toContain("Acme CRM");

      // The connection was actually persisted (read it back through the service).
      const meta = await runtime.runPromise(
        Effect.flatMap(CrmConnectionService, (c) => c.connectionMeta(WS)),
      );
      expect(Option.isSome(meta)).toBe(true);
      if (Option.isSome(meta)) {
        expect(meta.value.attioWorkspaceName).toBe("Acme CRM");
        expect(meta.value.attioWorkspaceId).toBe("attio_ws_1");
        expect(meta.value.connectedByUserId).toBe(OWNER);
        expect(meta.value.connectedByName).toBe("Olive Owner");
      }
    } finally {
      await runtime.dispose();
    }
  });
});
