/**
 * `GET /api/crm/attio/authorize` boundary tests, run OFFLINE against a
 * `TestLayer` runtime (no live DB, no Attio). Proves the three outcomes the OAuth
 * start leg must guarantee:
 *   - signed out            → 302 to sign-in, carrying `returnTo`
 *   - not a workspace member → 403 human page (never a stack trace)
 *   - member + configured    → 302 to app.attio.com with a signed `state`
 *
 * `authorizeResponse` takes an already-built runtime + resolved userId, so these
 * exercise the exact service path the `GET` handler runs, minus the live db/auth.
 */

import type { InMemoryUser, Membership, TestLayerFixtures } from "@gtmgrid/services";
import { TestLayer } from "@gtmgrid/services";
import { ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authorizeResponse } from "./route";

const WS = "11111111-1111-1111-1111-111111111111";
const OTHER_WS = "99999999-9999-9999-9999-999999999999";
const OWNER = "user_owner";
const SITE = "https://www.gtmgrid.dev";

const users: readonly InMemoryUser[] = [{ id: OWNER, name: "Olive Owner", email: "owner@acme.com" }];
const workspaces = [{ id: WS, name: "Acme", ownerId: OWNER }];
const ownerMembership: Membership = { workspaceId: WS, userId: OWNER, role: "owner" };

function runtimeFor(over: Partial<TestLayerFixtures> = {}) {
  return ManagedRuntime.make(
    TestLayer({
      workspaces,
      memberships: [ownerMembership],
      users,
      currentUserId: OWNER,
      ...over,
    }),
  );
}

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret";
  process.env.ATTIO_CLIENT_ID = "attio-client";
  process.env.ATTIO_CLIENT_SECRET = "attio-secret";
  process.env.SITE_URL = SITE;
});

afterEach(() => {
  delete process.env.ATTIO_CLIENT_ID;
  delete process.env.ATTIO_CLIENT_SECRET;
});

describe("authorizeResponse", () => {
  it("signed out → 302 to sign-in carrying returnTo", async () => {
    const runtime = runtimeFor({ currentUserId: null });
    try {
      const returnTo = `${SITE}/api/crm/attio/authorize?workspace=${WS}`;
      const res = await authorizeResponse({ runtime, userId: null, workspaceId: WS, siteUrl: SITE, returnTo });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`${SITE}/?returnTo=${encodeURIComponent(returnTo)}`);
    } finally {
      await runtime.dispose();
    }
  });

  it("not a member of the target workspace → 403 human page", async () => {
    const runtime = runtimeFor();
    try {
      const res = await authorizeResponse({
        runtime,
        userId: OWNER,
        workspaceId: OTHER_WS,
        siteUrl: SITE,
        returnTo: `${SITE}/api/crm/attio/authorize?workspace=${OTHER_WS}`,
      });
      expect(res.status).toBe(403);
      const body = await res.text();
      expect(body).toContain("You can't connect this workspace");
      expect(body).not.toContain("NotAMemberError");
    } finally {
      await runtime.dispose();
    }
  });

  it("malformed workspace id → 400 human page", async () => {
    const runtime = runtimeFor();
    try {
      const res = await authorizeResponse({
        runtime,
        userId: OWNER,
        workspaceId: "not-a-uuid",
        siteUrl: SITE,
        returnTo: `${SITE}/api/crm/attio/authorize?workspace=not-a-uuid`,
      });
      expect(res.status).toBe(400);
    } finally {
      await runtime.dispose();
    }
  });

  it("member + configured → 302 to app.attio.com with a signed state", async () => {
    const runtime = runtimeFor();
    try {
      const res = await authorizeResponse({
        runtime,
        userId: OWNER,
        workspaceId: WS,
        siteUrl: SITE,
        returnTo: `${SITE}/api/crm/attio/authorize?workspace=${WS}`,
      });
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location.startsWith("https://app.attio.com/authorize")).toBe(true);
      const url = new URL(location);
      expect(url.searchParams.get("client_id")).toBe("attio-client");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("redirect_uri")).toBe(`${SITE}/api/crm/attio/callback`);
      expect((url.searchParams.get("state") ?? "").length).toBeGreaterThan(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("Attio app not configured → 503 'not set up' page, never a redirect", async () => {
    delete process.env.ATTIO_CLIENT_ID;
    const runtime = runtimeFor();
    try {
      const res = await authorizeResponse({
        runtime,
        userId: OWNER,
        workspaceId: WS,
        siteUrl: SITE,
        returnTo: `${SITE}/api/crm/attio/authorize?workspace=${WS}`,
      });
      expect(res.status).toBe(503);
      expect(await res.text()).toContain("Attio isn't set up yet");
    } finally {
      await runtime.dispose();
    }
  });
});
