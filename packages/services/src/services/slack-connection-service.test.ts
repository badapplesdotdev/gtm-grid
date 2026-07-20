/**
 * SlackConnectionService: the tokens+meta <-> SecretMap round trip.
 *
 * `toSecrets`/`parseConnection` are pure, so they are tested directly. The
 * interesting cases are the lossy ones: `SecretMap` is `Record<string, string>`,
 * so `expiresAtMs` survives as a STRING and every read has to parse it back.
 * Getting that wrong is silent — a `NaN` expiry compares false against every
 * bound, so the token would either never refresh or refresh on every read.
 */

import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { TestLayer } from "../layers.js";
import { CredentialService } from "./credential-service.js";
import {
  parseConnection,
  SLACK_CONNECTION_SLOT,
  SlackConnectionService,
  toSecrets,
} from "./slack-connection-service.js";

const META = {
  connectedByUserId: "user_1",
  connectedByName: "Morgan",
  teamId: "T123",
  teamName: "Trigify GTM",
  botUserId: "U456",
};

describe("the credential slot", () => {
  it("is bare 'slack' — it MUST equal the connector id in extensions/slack.json", () => {
    // The engine resolves a connector's credential by connector id. If this ever
    // becomes "slack-crm" (mirroring crmConnectionSlot), every sdk.slack.* call
    // silently finds no credential and reports "not connected".
    expect(SLACK_CONNECTION_SLOT).toBe("slack");
  });

  it("SHARES ITS ROW with the engine's apiKey slot — so any UI offering to write it DESTROYS the grant", () => {
    // Pinning the HAZARD, not a behaviour to keep. The test above forces this
    // slot to be the bare connector id; `crmConnectionSlot` suffixes the CRM
    // equivalents ("attio-crm") for exactly the reason spelled out there — "a
    // shared id let the Tools panel's 'Replace key' overwrite OAuth tokens".
    // Slack cannot take that escape: the engine looks the credential up by
    // manifest id, so the slot MUST collide.
    //
    // The consequence is proved in the sibling test below. The only defence is
    // that no api-key UI is offered for an oauth manifest — see the
    // `detail.auth?.type !== "oauth"` gate in packages/desktop/src/Panels.tsx,
    // which is load-bearing, not cosmetic.
    expect(SLACK_CONNECTION_SLOT).toBe("slack");
    // If someone "fixes" the collision by suffixing, sdk.slack.* breaks instead —
    // both tests must be read together.
  });

  it("an apiKey save at this slot ANNIHILATES a live OAuth grant (why the UI must not offer one)", async () => {
    const WS = "11111111-1111-1111-1111-111111111111";
    const layer = TestLayer({
      workspaces: [{ id: WS, name: "WS", ownerId: "u1", currentPlanId: "team" }],
      memberships: [{ workspaceId: WS, userId: "u1", role: "owner" }],
      users: [{ id: "u1", name: "Morgan", email: "m@acme.com" }],
      currentUserId: "u1",
    });

    const { before, after } = await Effect.runPromise(
      Effect.gen(function* () {
        const slack = yield* SlackConnectionService;
        const credentials = yield* CredentialService;

        yield* slack.saveConnection({
          workspaceId: WS,
          tokens: {
            accessToken: "xoxe.xoxb-live",
            refreshToken: "xoxe-1-single-use",
            expiresAtMs: 4_102_444_800_000,
          },
          meta: META,
        });
        const before = yield* slack.memberConnection(WS);

        // EXACTLY what ConnectionsSection's workspace save does: same slot, same
        // scope, a fresh `{ apiKey }` map. saveCredential encrypts the map it is
        // given and upserts it — there is no merge.
        yield* credentials.saveCredential({
          workspaceId: WS,
          extensionId: SLACK_CONNECTION_SLOT,
          scope: "workspace",
          name: "Slack",
          secrets: { apiKey: "pasted-by-a-user-who-saw-Replace-key" },
        });
        const after = yield* slack.memberConnection(WS);

        return { before: Option.isSome(before), after: Option.isSome(after) };
      }).pipe(Effect.provide(layer)),
    );

    expect(before).toBe(true);
    // Not "degraded" — GONE. The single-use refreshToken cannot be re-derived, so
    // under Rotating(30min) the workspace's grant is unrecoverable by any means
    // except a full reconnect through Slack's consent screen.
    expect(after).toBe(false);
  });
});

describe("round trip", () => {
  it("preserves tokens and meta", () => {
    const tokens = { accessToken: "xoxe.xoxb-1", refreshToken: "xoxe-1-r", expiresAtMs: 1_800_000_000_000 };
    const parsed = parseConnection(toSecrets(tokens, META));
    expect(parsed?.tokens.accessToken).toBe("xoxe.xoxb-1");
    expect(parsed?.tokens.refreshToken).toBe("xoxe-1-r");
    expect(parsed?.tokens.expiresAtMs).toBe(1_800_000_000_000);
    expect(parsed?.meta).toEqual(META);
  });

  it("preserves connectedAt across the string round trip as a NUMBER", () => {
    // The desktop card's reconnect signal: a reconnect to the same team moves
    // nothing else, so this timestamp is how it confirms a fresh grant landed.
    const secrets = toSecrets({ accessToken: "at" }, { ...META, connectedAt: 1_700_000_000_000 });
    expect(secrets.connectedAt).toBe("1700000000000");
    expect(parseConnection(secrets)?.meta.connectedAt).toBe(1_700_000_000_000);
  });

  it("drops a missing or corrupt connectedAt rather than yielding NaN", () => {
    expect(parseConnection(toSecrets({ accessToken: "at" }, META))?.meta.connectedAt).toBeUndefined();
    expect(parseConnection({ accessToken: "at", connectedAt: "nope" })?.meta.connectedAt).toBeUndefined();
  });

  it("carries team/bot ids into tokens.extra, where the refresh merge preserves them", () => {
    const parsed = parseConnection(toSecrets({ accessToken: "at" }, META));
    expect(parsed?.tokens.extra).toEqual({ teamId: "T123", teamName: "Trigify GTM", botUserId: "U456" });
  });

  it("expiresAtMs survives the string round trip as a NUMBER", () => {
    const secrets = toSecrets({ accessToken: "at", expiresAtMs: 1_800_000_000_000 }, META);
    // Pin the lossy step explicitly: the envelope stores strings only.
    expect(secrets.expiresAtMs).toBe("1800000000000");
    expect(parseConnection(secrets)?.tokens.expiresAtMs).toBe(1_800_000_000_000);
  });

  it("omits refreshToken and expiresAtMs when absent (rotation off = non-expiring token)", () => {
    const secrets = toSecrets({ accessToken: "xoxb-plain" }, META);
    expect(secrets.refreshToken).toBeUndefined();
    expect(secrets.expiresAtMs).toBeUndefined();
    const parsed = parseConnection(secrets);
    expect(parsed?.tokens.refreshToken).toBeUndefined();
    expect(parsed?.tokens.expiresAtMs).toBeUndefined();
  });
});

describe("parseConnection is total", () => {
  it("returns null when there is no usable access token", () => {
    expect(parseConnection({})).toBeNull();
    expect(parseConnection({ accessToken: "" })).toBeNull();
  });

  it("drops a CORRUPT expiry rather than yielding NaN", () => {
    // NaN compares false against every bound, so a NaN expiry would make
    // needsRefresh answer "no" forever — a dead token nobody ever renews.
    // Absent is the honest answer: no known expiry, fall back to the 401 path.
    expect(parseConnection({ accessToken: "at", expiresAtMs: "not-a-number" })?.tokens.expiresAtMs).toBeUndefined();
    expect(parseConnection({ accessToken: "at", expiresAtMs: "-1" })?.tokens.expiresAtMs).toBeUndefined();
  });

  it("defaults missing meta to empty strings rather than throwing", () => {
    const parsed = parseConnection({ accessToken: "at" });
    expect(parsed?.meta).toEqual({
      connectedByUserId: "",
      connectedByName: "",
      teamId: "",
      teamName: "",
      botUserId: "",
    });
  });
});
