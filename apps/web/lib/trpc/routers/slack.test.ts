/**
 * `slack` router procedure tests via `createCaller`, OFFLINE against a
 * `TestLayer` context (no live DB, no Slack HTTP).
 *
 * The point is the GATING contract, which is the security-relevant half: every
 * procedure is member-gated, so a stranger can neither read which Slack team a
 * workspace is connected to, mint an authorize URL binding someone else's
 * workspace, nor disconnect it.
 *
 * Also exercises `authorizeUrlWithState` — the helper that replaced two ~20-line
 * duplicated `Effect.gen` blocks in the crm router — including its
 * `"missing" in e` narrowing of the not-configured error.
 */

import type { Membership } from "@gtmgrid/services";
import { SLACK_ADAPTER, SlackConnectionService, TestLayer, type TestLayerFixtures } from "@gtmgrid/services";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestContext } from "../context";
import { appRouter } from "../root";
import { createCallerFactory } from "../trpc";

const createCaller = createCallerFactory(appRouter);

const WS = "11111111-1111-1111-1111-111111111111";
const memberships: readonly Membership[] = [{ workspaceId: WS, userId: "member", role: "member" }];

const callerFor = (fixtures: TestLayerFixtures) =>
  createCaller(
    createTestContext({
      layer: TestLayer({
        workspaces: [{ id: WS, name: "WS", ownerId: "member", currentPlanId: "team" }],
        users: [{ id: "member", name: "Morgan", email: "m@acme.com" }],
        ...fixtures,
      }),
      userId: fixtures.currentUserId ?? null,
    }),
  );

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret");
  vi.stubEnv("SITE_URL", "https://www.gtmgrid.dev");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("slack.connectionStatus", () => {
  it("reports not-configured + not-connected when the deployment has no Slack app", async () => {
    // No SLACK_CLIENT_ID: the desktop must render "isn't set up on this
    // deployment" rather than a live Connect button.
    const caller = callerFor({ memberships, currentUserId: "member" });
    expect(await caller.slack.connectionStatus({ workspaceId: WS })).toEqual({
      configured: false,
      connected: false,
    });
  });

  it("reports configured + not-connected once the app env exists", async () => {
    vi.stubEnv("SLACK_CLIENT_ID", "cid");
    vi.stubEnv("SLACK_CLIENT_SECRET", "secret");
    const caller = callerFor({ memberships, currentUserId: "member" });
    expect(await caller.slack.connectionStatus({ workspaceId: WS })).toEqual({
      configured: true,
      connected: false,
    });
  });

  it("does NOT leak a workspace's Slack team to a non-member", async () => {
    const caller = callerFor({ memberships, currentUserId: "stranger" });
    // Degrades to "not connected" rather than throwing: the panel must render.
    // What matters is that no team name or connector identity escapes.
    const status = await caller.slack.connectionStatus({ workspaceId: WS });
    expect(status.connected).toBe(false);
    expect(JSON.stringify(status)).not.toContain("Acme");
  });
});

describe("slack.authorizeUrl (member-gated)", () => {
  beforeEach(() => {
    vi.stubEnv("SLACK_CLIENT_ID", "cid");
    vi.stubEnv("SLACK_CLIENT_SECRET", "secret");
  });

  it("mints a SERVER-SIDE state and builds a real Slack authorize URL", async () => {
    const caller = callerFor({ memberships, currentUserId: "member" });
    const { url } = await caller.slack.authorizeUrl({ workspaceId: WS });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("redirect_uri")).toBe("https://www.gtmgrid.dev/api/oauth/slack/callback");
    expect(u.searchParams.get("scope")).toContain("chat:write");

    // The state is the trust for the callback (the browser carries no cookie),
    // so it must verify back to THIS workspace and user.
    const state = u.searchParams.get("state") ?? "";
    const claims = await Effect.runPromise(SLACK_ADAPTER.verifyState(state));
    expect(claims).toEqual({ workspaceId: WS, userId: "member" });
  });

  it("rejects a NON-MEMBER with FORBIDDEN — no state is minted for someone else's workspace", async () => {
    const caller = callerFor({ memberships, currentUserId: "stranger" });
    await expect(caller.slack.authorizeUrl({ workspaceId: WS })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
    const caller = callerFor({ memberships, currentUserId: null });
    await expect(caller.slack.authorizeUrl({ workspaceId: WS })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("surfaces a readable error when the OAuth app env is missing", async () => {
    // authorizeUrlWithState narrows the provider's not-configured error via
    // `"missing" in e` (the tag is per-provider data, so a literal catchTag
    // can't be used) and names the absent env var.
    vi.stubEnv("SLACK_CLIENT_ID", "");
    const caller = callerFor({ memberships, currentUserId: "member" });
    await expect(caller.slack.authorizeUrl({ workspaceId: WS })).rejects.toThrow(/SLACK_CLIENT_ID/);
  });

  it("fails rather than emitting an UNSIGNED state when no signing secret exists", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    vi.stubEnv("SLACK_OAUTH_SECRET", "");
    const caller = callerFor({ memberships, currentUserId: "member" });
    await expect(caller.slack.authorizeUrl({ workspaceId: WS })).rejects.toThrow(/state signing unavailable/i);
  });
});

describe("slack.disconnect (member-gated)", () => {
  it("rejects a non-member with FORBIDDEN", async () => {
    const caller = callerFor({ memberships, currentUserId: "stranger" });
    await expect(caller.slack.disconnect({ workspaceId: WS })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("is a no-op for a member with nothing connected", async () => {
    const caller = callerFor({ memberships, currentUserId: "member" });
    expect(await caller.slack.disconnect({ workspaceId: WS })).toEqual({ removed: false });
  });

  it("removes a stored connection, and a second read reports disconnected", async () => {
    vi.stubEnv("SLACK_CLIENT_ID", "cid");
    vi.stubEnv("SLACK_CLIENT_SECRET", "secret");
    const layer = TestLayer({
      workspaces: [{ id: WS, name: "WS", ownerId: "member", currentPlanId: "team" }],
      users: [{ id: "member", name: "Morgan", email: "m@acme.com" }],
      memberships,
      currentUserId: "member",
    });
    const ctx = createTestContext({ layer, userId: "member" });
    const caller = createCaller(ctx);

    await ctx.runtime.runPromise(
      Effect.flatMap(SlackConnectionService, (s) =>
        s.saveConnection({
          workspaceId: WS,
          tokens: { accessToken: "xoxb-live", refreshToken: "rt", expiresAtMs: Date.now() + 86_400_000 },
          meta: {
            connectedByUserId: "member",
            connectedByName: "Morgan",
            teamId: "T_ACME",
            teamName: "Acme Slack",
            botUserId: "U_BOT",
          },
        }),
      ),
    );

    const before = await caller.slack.connectionStatus({ workspaceId: WS });
    expect(before).toMatchObject({ connected: true, teamName: "Acme Slack", connectedByName: "Morgan" });

    expect(await caller.slack.disconnect({ workspaceId: WS })).toEqual({ removed: true });
    expect(await caller.slack.connectionStatus({ workspaceId: WS })).toMatchObject({ connected: false });
  });
});
