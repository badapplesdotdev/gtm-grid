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
/**
 * `disconnect` is ADMIN-gated (reading status and adding a connection are not),
 * so the destructive tests need a caller who actually holds the role. Deleting
 * a shared workspace credential breaks every teammate's columns and cannot be
 * undone without a fresh consent round-trip.
 */
const adminMemberships: readonly Membership[] = [
  { workspaceId: WS, userId: "member", role: "member" },
  { workspaceId: WS, userId: "boss", role: "admin" },
];

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
      connections: [],
      canDisconnect: false,
      connectedByName: "",
      teamName: "",
      teamId: "",
    });
  });

  it("reports configured + not-connected once the app env exists", async () => {
    vi.stubEnv("SLACK_CLIENT_ID", "cid");
    vi.stubEnv("SLACK_CLIENT_SECRET", "secret");
    const caller = callerFor({ memberships, currentUserId: "member" });
    expect(await caller.slack.connectionStatus({ workspaceId: WS })).toEqual({
      configured: true,
      connected: false,
      connections: [],
      canDisconnect: false,
      connectedByName: "",
      teamName: "",
      teamId: "",
    });
  });

  it("REJECTS a non-member with FORBIDDEN — it does not answer them at all", async () => {
    // This test used to assert the opposite ("degrades to not-connected rather
    // than throwing: the panel must render"), which is how a swallowed authz
    // error survived review: the suite had blessed it as intent. A non-member is
    // not entitled to a cheerful 200 describing someone else's workspace, and
    // `crm.connectionStatus` has always answered them with a 403.
    const caller = callerFor({ memberships, currentUserId: "stranger" });
    await expect(caller.slack.connectionStatus({ workspaceId: WS })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("still leaks nothing about the workspace when it rejects", async () => {
    // The original test's INSTINCT was right even though its assertion wasn't.
    const caller = callerFor({ memberships, currentUserId: "stranger" });
    const err = await caller.slack.connectionStatus({ workspaceId: WS }).catch((e: unknown) => e);
    expect(JSON.stringify(err)).not.toContain("Acme");
  });

  it("an UNDECRYPTABLE credential degrades to not-connected but KEEPS configured: true", async () => {
    // The one failure worth degrading, and the exact thing the old blanket
    // catchAll got wrong. The stored secret is unusable, so "Not connected" is
    // honest and the user can fix it by reconnecting — but the deployment IS
    // configured, and saying otherwise renders "Slack isn't set up on this
    // deployment yet" AND disables the Connect button, removing the only control
    // that could recover. `configured` is read before the credential and must
    // survive its failure.
    vi.stubEnv("SLACK_CLIENT_ID", "cid");
    vi.stubEnv("SLACK_CLIENT_SECRET", "secret");
    const caller = callerFor({
      memberships,
      currentUserId: "member",
      credentials: [
        {
          id: "cred_slack_1",
          workspaceId: WS,
          extensionId: "slack",
          accountId: "",
          scope: "workspace" as const,
          name: "Slack",
          ownerUserId: null,
          createdAt: 0,
          // Real ciphertext would decrypt; this cannot, which is the point.
          secretsEnc: "not-a-valid-envelope",
        },
      ],
    });

    expect(await caller.slack.connectionStatus({ workspaceId: WS })).toEqual({
      configured: true,
      connected: false,
      connections: [],
      canDisconnect: false,
      connectedByName: "",
      teamName: "",
      teamId: "",
    });
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

describe("slack.connectionStatus — canDisconnect", () => {
  it("is FALSE for a plain member, so the UI never offers the control", async () => {
    // The flag is derived from the SAME role the mutation enforces and returned
    // rather than recomputed client-side, so the button cannot drift out of
    // agreement with the server. A UI that hides it for the wrong people is
    // confusing; one that shows it for the wrong people is a 403 dressed up as
    // a feature.
    const caller = callerFor({ memberships: adminMemberships, currentUserId: "member" });
    const status = await caller.slack.connectionStatus({ workspaceId: WS });
    expect(status.canDisconnect).toBe(false);
  });

  it("is TRUE for an admin", async () => {
    const caller = callerFor({ memberships: adminMemberships, currentUserId: "boss" });
    const status = await caller.slack.connectionStatus({ workspaceId: WS });
    expect(status.canDisconnect).toBe(true);
  });
});

describe("slack.connectionStatus — multiple connected teams", () => {
  it("lists EVERY connected team, and disconnecting one leaves the other", async () => {
    // The headline bug this replaced: a second connect overwrote the first row,
    // so a workspace could hold exactly one Slack team and connecting another
    // silently repointed every column in the grid.
    vi.stubEnv("SLACK_CLIENT_ID", "cid");
    vi.stubEnv("SLACK_CLIENT_SECRET", "secret");
    const layer = TestLayer({
      workspaces: [{ id: WS, name: "WS", ownerId: "member", currentPlanId: "team" }],
      users: [
        { id: "member", name: "Morgan", email: "m@acme.com" },
        { id: "boss", name: "Sam", email: "s@acme.com" },
      ],
      memberships: adminMemberships,
      currentUserId: "boss",
    });
    const ctx = createTestContext({ layer, userId: "boss" });
    const caller = createCaller(ctx);

    const connect = (teamId: string, teamName: string) =>
      ctx.runtime.runPromise(
        Effect.flatMap(SlackConnectionService, (s) =>
          s.saveConnection({
            workspaceId: WS,
            tokens: { accessToken: `xoxb-${teamId}`, refreshToken: `rt-${teamId}` },
            meta: {
              connectedByUserId: "boss",
              connectedByName: "Sam",
              teamId,
              teamName,
              botUserId: "U_BOT",
            },
          }),
        ),
      );

    await connect("T_ACME", "Acme Slack");
    await connect("T_EU", "Acme EU");

    const status = await caller.slack.connectionStatus({ workspaceId: WS });
    expect(status.connected).toBe(true);
    expect(status.connections.map((c) => c.teamId).sort()).toEqual(["T_ACME", "T_EU"]);
    // Display meta only — a token must never reach a client bundle.
    expect(JSON.stringify(status)).not.toContain("xoxb-");

    expect(await caller.slack.disconnect({ workspaceId: WS, teamId: "T_ACME" })).toEqual({
      removed: true,
    });
    const after = await caller.slack.connectionStatus({ workspaceId: WS });
    expect(after.connections.map((c) => c.teamId)).toEqual(["T_EU"]);
  });
});

describe("slack.connectionStatus — canDisconnect", () => {
  it("is FALSE for a plain member, so the UI never offers the button", async () => {
    // The mutation refuses a member anyway; this is what stops the desktop
    // rendering a Disconnect that can only ever come back 403. Derived from the
    // same role check, server-side, so the two cannot drift apart.
    const caller = callerFor({ memberships: adminMemberships, currentUserId: "member" });
    const status = await caller.slack.connectionStatus({ workspaceId: WS });
    expect(status.canDisconnect).toBe(false);
  });

  it("is TRUE for an admin", async () => {
    const caller = callerFor({ memberships: adminMemberships, currentUserId: "boss" });
    const status = await caller.slack.connectionStatus({ workspaceId: WS });
    expect(status.canDisconnect).toBe(true);
  });

  it("is TRUE for the workspace owner", async () => {
    const owners: readonly Membership[] = [{ workspaceId: WS, userId: "member", role: "owner" }];
    const caller = callerFor({ memberships: owners, currentUserId: "member" });
    const status = await caller.slack.connectionStatus({ workspaceId: WS });
    expect(status.canDisconnect).toBe(true);
  });
});

describe("slack.disconnect (admin-gated)", () => {
  it("rejects a non-member with FORBIDDEN", async () => {
    const caller = callerFor({ memberships, currentUserId: "stranger" });
    await expect(caller.slack.disconnect({ workspaceId: WS })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a plain MEMBER with FORBIDDEN", async () => {
    // The connection is workspace-shared: every teammate's Slack columns run
    // against it, and the tokens cannot be recovered locally once deleted. That
    // is not a decision any member should be able to make alone — status reads
    // and new connections stay member-level because both are additive.
    const caller = callerFor({ memberships: adminMemberships, currentUserId: "member" });
    await expect(caller.slack.disconnect({ workspaceId: WS })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("is a no-op for an admin with nothing connected", async () => {
    const caller = callerFor({ memberships: adminMemberships, currentUserId: "boss" });
    expect(await caller.slack.disconnect({ workspaceId: WS })).toEqual({ removed: false });
  });

  it("removes a stored connection, and a second read reports disconnected", async () => {
    vi.stubEnv("SLACK_CLIENT_ID", "cid");
    vi.stubEnv("SLACK_CLIENT_SECRET", "secret");
    const layer = TestLayer({
      workspaces: [{ id: WS, name: "WS", ownerId: "member", currentPlanId: "team" }],
      users: [
        { id: "member", name: "Morgan", email: "m@acme.com" },
        { id: "boss", name: "Sam", email: "s@acme.com" },
      ],
      memberships: adminMemberships,
      currentUserId: "boss",
    });
    const ctx = createTestContext({ layer, userId: "boss" });
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
