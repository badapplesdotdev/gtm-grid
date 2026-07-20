/**
 * SlackConnectionService: the tokens+meta <-> SecretMap round trip.
 *
 * `toSecrets`/`parseConnection` are pure, so they are tested directly. The
 * interesting cases are the lossy ones: `SecretMap` is `Record<string, string>`,
 * so `expiresAtMs` survives as a STRING and every read has to parse it back.
 * Getting that wrong is silent — a `NaN` expiry compares false against every
 * bound, so the token would either never refresh or refresh on every read.
 */

import type { SecretMap } from "@gtmgrid/cloud";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import { TestLayer } from "../layers.js";
import {
  ACCOUNT_DEFAULT,
  type CredentialRow,
  CredentialRepo,
} from "../repositories/credential-repo.js";
import { CredentialService } from "./credential-service.js";
import { CryptoService, cryptoServiceLayer } from "./crypto-service.js";
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

// ── MULTI-TEAM ───────────────────────────────────────────────────────────────
//
// One gtmgrid workspace may install the Slack app into several Slack teams.
// Each install has its own token pair, so each gets its own credentials row,
// discriminated by `accountId` (Slack's team id). The cases below pin the four
// things that made the single-row design wrong: a second connect must INSERT,
// a read must name its team or fail, a disconnect must scope to one team, and
// a row written before `account_id` existed must heal itself on read.

const WS = "22222222-2222-2222-2222-222222222222";

const metaFor = (teamId: string, teamName: string) => ({
  connectedByUserId: "u1",
  connectedByName: "Morgan",
  teamId,
  teamName,
  botUserId: `U_${teamId}`,
});

const workspaceLayer = (credentials: readonly CredentialRow[] = []) =>
  TestLayer({
    workspaces: [{ id: WS, name: "WS", ownerId: "u1", currentPlanId: "team" }],
    memberships: [{ workspaceId: WS, userId: "u1", role: "owner" }],
    users: [{ id: "u1", name: "Morgan", email: "m@acme.com" }],
    currentUserId: "u1",
    credentials,
  });

/**
 * Encrypt with the SAME default master key `TestLayer` wires into its
 * CryptoService, so a hand-seeded row is one the service can genuinely decrypt.
 * Seeding ciphertext directly is the only way to model a LEGACY row: no public
 * method writes `accountId: ""` alongside a real team id any more.
 */
const seedEnc = (secrets: SecretMap) =>
  Effect.runPromise(
    Effect.provide(
      Effect.flatMap(CryptoService, (c) => c.encrypt(WS, secrets)),
      cryptoServiceLayer(),
    ),
  );

/** Connect two teams through the real OAuth-callback write path. */
const connectTwo = Effect.gen(function* () {
  const slack = yield* SlackConnectionService;
  yield* slack.saveConnection({
    workspaceId: WS,
    tokens: { accessToken: "xoxb-A", refreshToken: "r-A" },
    meta: metaFor("T_A", "Acme"),
  });
  yield* slack.saveConnection({
    workspaceId: WS,
    tokens: { accessToken: "xoxb-B", refreshToken: "r-B" },
    meta: metaFor("T_B", "Acme EU"),
  });
});

describe("connecting a second Slack team", () => {
  it("INSERTS a second credential row rather than overwriting the first", async () => {
    // THE HEADLINE BUG. Every connect used to land on one row keyed only by
    // (workspace, "slack", workspace-scope, null owner), so connecting "Acme
    // EU" rotated "Acme"'s single-use refresh token out of existence — every
    // sdk.slack.* call switched team without a word, and every inbound event
    // from Acme then failed the team-id gate and was dropped as a mismatch.
    const accounts = await Effect.runPromise(
      Effect.gen(function* () {
        yield* connectTwo;
        const repo = yield* CredentialRepo;
        return yield* repo.findSharedAccounts({
          workspaceId: WS,
          extensionId: SLACK_CONNECTION_SLOT,
        });
      }).pipe(Effect.provide(workspaceLayer())),
    );
    expect(accounts).toHaveLength(2);
    expect(accounts.map((a) => a.accountId).sort()).toEqual(["T_A", "T_B"]);
  });

  it("names each row after its team, so the UI can tell them apart", async () => {
    const names = await Effect.runPromise(
      Effect.gen(function* () {
        yield* connectTwo;
        const repo = yield* CredentialRepo;
        const accounts = yield* repo.findSharedAccounts({
          workspaceId: WS,
          extensionId: SLACK_CONNECTION_SLOT,
        });
        return accounts.map((a) => a.name).sort();
      }).pipe(Effect.provide(workspaceLayer())),
    );
    expect(names).toEqual(["Slack — Acme", "Slack — Acme EU"]);
  });

  it("keeps BOTH teams' tokens intact and distinct", async () => {
    const tokens = await Effect.runPromise(
      Effect.gen(function* () {
        const slack = yield* SlackConnectionService;
        yield* connectTwo;
        const a = yield* slack.memberConnection(WS, "T_A");
        const b = yield* slack.memberConnection(WS, "T_B");
        return {
          a: Option.isSome(a) ? a.value.tokens.accessToken : null,
          b: Option.isSome(b) ? b.value.tokens.accessToken : null,
        };
      }).pipe(Effect.provide(workspaceLayer())),
    );
    expect(tokens).toEqual({ a: "xoxb-A", b: "xoxb-B" });
  });
});

describe("listConnections", () => {
  it("returns every connected team", async () => {
    const metas = await Effect.runPromise(
      Effect.gen(function* () {
        const slack = yield* SlackConnectionService;
        yield* connectTwo;
        return yield* slack.listConnections(WS);
      }).pipe(Effect.provide(workspaceLayer())),
    );
    expect(metas.map((m) => m.teamId)).toEqual(["T_A", "T_B"]);
    expect(metas.map((m) => m.teamName)).toEqual(["Acme", "Acme EU"]);
  });

  it("returns DISPLAY META ONLY — no access or refresh token anywhere in it", async () => {
    // This value crosses the tRPC boundary into a client bundle. Returning the
    // whole SlackConnection would ship a live bot token to the browser, and it
    // would look fine in every UI test because nothing renders it.
    const metas = await Effect.runPromise(
      Effect.gen(function* () {
        const slack = yield* SlackConnectionService;
        yield* connectTwo;
        return yield* slack.listConnections(WS);
      }).pipe(Effect.provide(workspaceLayer())),
    );
    for (const meta of metas) {
      expect(meta).not.toHaveProperty("accessToken");
      expect(meta).not.toHaveProperty("refreshToken");
      expect(meta).not.toHaveProperty("tokens");
      // Pin the whole shape, so a later field addition has to be deliberate.
      expect(Object.keys(meta).sort()).toEqual([
        "botUserId",
        "connectedByName",
        "connectedByUserId",
        "teamId",
        "teamName",
      ]);
      expect(JSON.stringify(meta)).not.toContain("xoxb");
    }
  });

  it("returns an empty list when nothing is connected", async () => {
    const metas = await Effect.runPromise(
      Effect.flatMap(SlackConnectionService, (s) =>
        s.listConnections(WS),
      ).pipe(Effect.provide(workspaceLayer())),
    );
    expect(metas).toEqual([]);
  });
});

describe("memberConnection without a team id", () => {
  it("FAILS SlackAccountAmbiguous when two teams are connected", async () => {
    // Picking the first row would post a customer's message into whichever
    // team happens to sort first — silently, and differently after the next
    // connect. A typed failure is recoverable; a misdelivered message is not.
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const slack = yield* SlackConnectionService;
        yield* connectTwo;
        return yield* slack.memberConnection(WS);
      }).pipe(Effect.provide(workspaceLayer())),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.failureOption(exit.cause);
      expect(Option.isSome(error)).toBe(true);
      if (Option.isSome(error)) {
        expect(error.value._tag).toBe("SlackAccountAmbiguous");
        if (error.value._tag === "SlackAccountAmbiguous") {
          // The ids ride along so the UI can offer the choice it must make.
          expect([...error.value.teamIds].sort()).toEqual(["T_A", "T_B"]);
          expect(error.value.workspaceId).toBe(WS);
        }
      }
    }
  });

  it("resolves SILENTLY when exactly one team is connected", async () => {
    // Every caller written before multi-team keeps working untouched; that is
    // the whole reason `teamId` is optional rather than required.
    const connection = await Effect.runPromise(
      Effect.gen(function* () {
        const slack = yield* SlackConnectionService;
        yield* slack.saveConnection({
          workspaceId: WS,
          tokens: { accessToken: "xoxb-A" },
          meta: metaFor("T_A", "Acme"),
        });
        return yield* slack.memberConnection(WS);
      }).pipe(Effect.provide(workspaceLayer())),
    );
    expect(Option.isSome(connection)).toBe(true);
    if (Option.isSome(connection)) {
      expect(connection.value.tokens.accessToken).toBe("xoxb-A");
      expect(connection.value.meta.teamId).toBe("T_A");
    }
  });

  it("returns None when nothing is connected", async () => {
    const connection = await Effect.runPromise(
      Effect.flatMap(SlackConnectionService, (s) =>
        s.memberConnection(WS),
      ).pipe(Effect.provide(workspaceLayer())),
    );
    expect(Option.isNone(connection)).toBe(true);
  });
});

describe("memberConnection with a team id", () => {
  it("returns THAT team's tokens, never the other's", async () => {
    const connection = await Effect.runPromise(
      Effect.gen(function* () {
        const slack = yield* SlackConnectionService;
        yield* connectTwo;
        return yield* slack.memberConnection(WS, "T_B");
      }).pipe(Effect.provide(workspaceLayer())),
    );
    expect(Option.isSome(connection)).toBe(true);
    if (Option.isSome(connection)) {
      expect(connection.value.tokens.accessToken).toBe("xoxb-B");
      expect(connection.value.tokens.refreshToken).toBe("r-B");
      expect(connection.value.meta.teamName).toBe("Acme EU");
    }
  });

  it("returns None for a team this workspace has NOT connected", async () => {
    const connection = await Effect.runPromise(
      Effect.gen(function* () {
        const slack = yield* SlackConnectionService;
        yield* connectTwo;
        return yield* slack.memberConnection(WS, "T_STRANGER");
      }).pipe(Effect.provide(workspaceLayer())),
    );
    expect(Option.isNone(connection)).toBe(true);
  });
});

describe("legacy row healing", () => {
  /** A row as written before `account_id` existed: `""`, team id in the blob. */
  const legacyRow = async (): Promise<CredentialRow> => ({
    id: "c_legacy",
    workspaceId: WS,
    extensionId: SLACK_CONNECTION_SLOT,
    accountId: ACCOUNT_DEFAULT,
    scope: "workspace",
    name: "Slack",
    ownerUserId: null,
    secretsEnc: await seedEnc(
      toSecrets({ accessToken: "xoxb-OLD" }, metaFor("T_OLD", "Acme Classic")),
    ),
    createdAt: 1,
  });

  it("rewrites the row's accountId to the team id buried in its ciphertext", async () => {
    // SQL cannot reach the team id — it is inside the envelope — so there is no
    // backfill migration to run. This path already decrypts every row to build
    // the display meta, so healing here is free and cannot be forgotten.
    const accounts = await Effect.runPromise(
      Effect.gen(function* () {
        const slack = yield* SlackConnectionService;
        yield* slack.listConnections(WS);
        const repo = yield* CredentialRepo;
        return yield* repo.findSharedAccounts({
          workspaceId: WS,
          extensionId: SLACK_CONNECTION_SLOT,
        });
      }).pipe(Effect.provide(workspaceLayer([await legacyRow()]))),
    );
    expect(accounts.map((a) => a.accountId)).toEqual(["T_OLD"]);
  });

  it("leaves NO row at the sole-account key afterwards", async () => {
    // A surviving `""` row is indistinguishable from "the only account", so it
    // would keep answering an un-named read forever while the healed row sat
    // beside it — and would make the workspace look ambiguous with one team.
    const remaining = await Effect.runPromise(
      Effect.gen(function* () {
        const slack = yield* SlackConnectionService;
        yield* slack.listConnections(WS);
        const repo = yield* CredentialRepo;
        return yield* repo.findSharedForWorker({
          workspaceId: WS,
          extensionId: SLACK_CONNECTION_SLOT,
          accountId: ACCOUNT_DEFAULT,
        });
      }).pipe(Effect.provide(workspaceLayer([await legacyRow()]))),
    );
    expect(Option.isNone(remaining)).toBe(true);
  });

  it("keeps the connection readable BY TEAM ID once healed", async () => {
    const connection = await Effect.runPromise(
      Effect.gen(function* () {
        const slack = yield* SlackConnectionService;
        yield* slack.listConnections(WS);
        return yield* slack.memberConnection(WS, "T_OLD");
      }).pipe(Effect.provide(workspaceLayer([await legacyRow()]))),
    );
    expect(Option.isSome(connection)).toBe(true);
    if (Option.isSome(connection)) {
      expect(connection.value.tokens.accessToken).toBe("xoxb-OLD");
      expect(connection.value.meta.teamName).toBe("Acme Classic");
    }
  });

  it("is IDEMPOTENT — a second read heals nothing and duplicates nothing", async () => {
    const accounts = await Effect.runPromise(
      Effect.gen(function* () {
        const slack = yield* SlackConnectionService;
        yield* slack.listConnections(WS);
        yield* slack.listConnections(WS);
        const repo = yield* CredentialRepo;
        return yield* repo.findSharedAccounts({
          workspaceId: WS,
          extensionId: SLACK_CONNECTION_SLOT,
        });
      }).pipe(Effect.provide(workspaceLayer([await legacyRow()]))),
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0].accountId).toBe("T_OLD");
  });

  it("LEAVES a blob carrying no team id at the sole-account key", async () => {
    // Rewriting it would only move the problem: it is unusable for a
    // multi-team choice either way, and `""` is at least addressable.
    const row: CredentialRow = {
      id: "c_no_team",
      workspaceId: WS,
      extensionId: SLACK_CONNECTION_SLOT,
      accountId: ACCOUNT_DEFAULT,
      scope: "workspace",
      name: "Slack",
      ownerUserId: null,
      secretsEnc: await seedEnc({ accessToken: "xoxb-NOTEAM" }),
      createdAt: 1,
    };
    const accounts = await Effect.runPromise(
      Effect.gen(function* () {
        const slack = yield* SlackConnectionService;
        yield* slack.listConnections(WS);
        const repo = yield* CredentialRepo;
        return yield* repo.findSharedAccounts({
          workspaceId: WS,
          extensionId: SLACK_CONNECTION_SLOT,
        });
      }).pipe(Effect.provide(workspaceLayer([row]))),
    );
    expect(accounts.map((a) => a.accountId)).toEqual([ACCOUNT_DEFAULT]);
  });
});

describe("disconnect", () => {
  it("with a team id removes ONLY that team, leaving the other connected", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const slack = yield* SlackConnectionService;
        yield* connectTwo;
        const removed = yield* slack.disconnect(WS, "T_A");
        const left = yield* slack.listConnections(WS);
        return { removed, left: left.map((m) => m.teamId) };
      }).pipe(Effect.provide(workspaceLayer())),
    );
    expect(result).toEqual({ removed: true, left: ["T_B"] });
  });

  it("with NO team id removes every connection", async () => {
    // "Disconnect Slack", unqualified, can only honestly mean all of them —
    // silently dropping one of two would leave the UI showing a disconnect
    // that half-worked.
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const slack = yield* SlackConnectionService;
        yield* connectTwo;
        const removed = yield* slack.disconnect(WS);
        const left = yield* slack.listConnections(WS);
        return { removed, left };
      }).pipe(Effect.provide(workspaceLayer())),
    );
    expect(result).toEqual({ removed: true, left: [] });
  });

  it("reports false when the named team was never connected", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const slack = yield* SlackConnectionService;
        yield* connectTwo;
        const removed = yield* slack.disconnect(WS, "T_STRANGER");
        const left = yield* slack.listConnections(WS);
        return { removed, left: left.map((m) => m.teamId) };
      }).pipe(Effect.provide(workspaceLayer())),
    );
    expect(result).toEqual({ removed: false, left: ["T_A", "T_B"] });
  });

  it("reports false on a workspace with nothing connected", async () => {
    const removed = await Effect.runPromise(
      Effect.flatMap(SlackConnectionService, (s) => s.disconnect(WS)).pipe(
        Effect.provide(workspaceLayer()),
      ),
    );
    expect(removed).toBe(false);
  });
});
