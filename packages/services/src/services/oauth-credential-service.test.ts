/**
 * OAuthCredentialService: the engine gets a token that is valid NOW.
 *
 * This is the seam that makes rotation real. Everything upstream (RefreshPolicy,
 * the lock, parseTokens) is worthless if the credential handed to a run is the
 * stale one from the database.
 *
 * Real crypto (TEST_MASTER_KEY), real in-memory credential repo, real lock
 * (in-process). Only Slack's HTTP is stubbed.
 */

import type { SecretMap } from "@gtmgrid/cloud";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialRepo, credentialRepoLayer, type CredentialRow } from "../repositories/credential-repo.js";
import { CryptoService, cryptoServiceLayer, TEST_MASTER_KEY } from "./crypto-service.js";
import { OAuthCredentialService, OAUTH_SLOTS } from "./oauth-credential-service.js";
import { SLACK_CONNECTION_SLOT } from "./slack-connection-service.js";

const WS = "11111111-1111-1111-1111-111111111111";
const NOW = Date.now();
const STALE = NOW + 60_000; // inside Slack's 30-min skew ⇒ counts as stale
const FRESH = NOW + 12 * 60 * 60_000;

const cryptoLayer = cryptoServiceLayer(TEST_MASTER_KEY);

/** Encrypt for real, so the seeded row is one the service can genuinely decrypt. */
const encrypt = (secrets: SecretMap) =>
  Effect.runPromise(
    Effect.provide(
      Effect.flatMap(CryptoService, (c) => c.encrypt(WS, secrets)),
      cryptoLayer,
    ),
  );

/**
 * A layer whose repo actually HOLDS the connection.
 *
 * Seeding matters: `freshTokens` re-reads inside the lock, and an empty repo
 * reads back as "deleted concurrently" — which correctly declines to refresh.
 * An unseeded repo therefore makes every refresh test silently pass by doing
 * nothing.
 */
const layerWith = (secretsEnc: string | null) => {
  const rows: CredentialRow[] =
    secretsEnc === null
      ? []
      : [
          {
            id: "cred_1",
            workspaceId: WS,
            extensionId: SLACK_CONNECTION_SLOT,
            accountId: "",
            scope: "workspace",
            name: "Slack",
            ownerUserId: null,
            secretsEnc,
            createdAt: NOW,
          },
        ];
  return Layer.provideMerge(
    OAuthCredentialService.Default,
    Layer.merge(credentialRepoLayer(rows), cryptoLayer),
  );
};

const slackSecrets = (over: Partial<Record<string, string>> = {}): SecretMap => ({
  accessToken: "xoxe.xoxb-stale",
  refreshToken: "xoxe-1-old",
  expiresAtMs: String(STALE),
  connectedByUserId: "user_1",
  connectedByName: "Morgan",
  teamId: "T123",
  teamName: "Acme Slack",
  botUserId: "U456",
  ...over,
});

const run = <A, E>(effect: Effect.Effect<A, E, OAuthCredentialService>, seeded: string | null = null) =>
  Effect.runPromise(Effect.provide(effect, layerWith(seeded)) as Effect.Effect<A, E, never>);

const stubSlack = (body: Record<string, unknown>, onCall?: () => void) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      onCall?.();
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );

beforeEach(() => {
  vi.stubEnv("SLACK_CLIENT_ID", "slack-client");
  vi.stubEnv("SLACK_CLIENT_SECRET", "slack-secret");
  vi.stubEnv("SITE_URL", "https://www.gtmgrid.dev");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the slot registry", () => {
  it("keys Slack on its CONNECTOR id, so the engine's lookup matches", () => {
    expect(Object.keys(OAUTH_SLOTS)).toContain(SLACK_CONNECTION_SLOT);
    expect(SLACK_CONNECTION_SLOT).toBe("slack");
  });

  it("declares Slack as Rotating — the arm that forces the lock", () => {
    expect(OAUTH_SLOTS.slack.policy._tag).toBe("Rotating");
  });
});

describe("freshSecrets", () => {
  it("passes a NON-oauth slot straight through, untouched and without a request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const apiKey: SecretMap = { apiKey: "sk_live_123" };
    const out = await run(
      Effect.flatMap(OAuthCredentialService, (s) => s.freshSecrets(WS, "apollo", apiKey)),
    );
    expect(out).toEqual(apiKey);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("leaves a FRESH Slack token alone", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const out = await run(
      Effect.flatMap(OAuthCredentialService, (s) =>
        s.freshSecrets(WS, SLACK_CONNECTION_SLOT, slackSecrets({ expiresAtMs: String(FRESH) })),
      ),
    );
    expect(out.accessToken).toBe("xoxe.xoxb-stale");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("REFRESHES a stale Slack token and hands back the NEW one", async () => {
    // The whole point of step 10: the engine must not receive the DB's stale token.
    stubSlack({ ok: true, access_token: "xoxe.xoxb-NEW", refresh_token: "xoxe-1-NEW", expires_in: 43_200 });
    const seeded = await encrypt(slackSecrets());
    const out = await run(
      Effect.flatMap(OAuthCredentialService, (s) => s.freshSecrets(WS, SLACK_CONNECTION_SLOT, slackSecrets())),
      seeded,
    );
    expect(out.accessToken).toBe("xoxe.xoxb-NEW");
    expect(out.refreshToken).toBe("xoxe-1-NEW");
  });

  it("PRESERVES display meta across a refresh", async () => {
    // The refresh response carries no team name; dropping it would blank the
    // "connected to Acme Slack" label on the next status read.
    stubSlack({ ok: true, access_token: "xoxe.xoxb-NEW", refresh_token: "xoxe-1-NEW", expires_in: 43_200 });
    const seeded = await encrypt(slackSecrets());
    const out = await run(
      Effect.flatMap(OAuthCredentialService, (s) => s.freshSecrets(WS, SLACK_CONNECTION_SLOT, slackSecrets())),
      seeded,
    );
    expect(out.teamName).toBe("Acme Slack");
    expect(out.teamId).toBe("T123");
    expect(out.botUserId).toBe("U456");
    expect(out.connectedByName).toBe("Morgan");
  });

  it("a refresh REFUSAL (ok:false on HTTP 200) propagates as a dead connection", async () => {
    stubSlack({ ok: false, error: "invalid_refresh_token" });
    const seeded = await encrypt(slackSecrets());
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.flatMap(OAuthCredentialService, (s) => s.freshSecrets(WS, SLACK_CONNECTION_SLOT, slackSecrets())),
        layerWith(seeded),
      ),
    );
    // Callers turn this into "reconnect Slack" rather than retrying a dead token.
    expect(exit._tag).toBe("Failure");
  });

  it("secrets with no usable access token pass through rather than exploding", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const empty: SecretMap = { teamId: "T123" };
    const out = await run(
      Effect.flatMap(OAuthCredentialService, (s) => s.freshSecrets(WS, SLACK_CONNECTION_SLOT, empty)),
    );
    expect(out).toEqual(empty);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes ONCE when two reads race the same connection", async () => {
    // In-process only — this canNOT prove pg_try_advisory_xact_lock (that needs
    // real Postgres, plan step 14). It proves the policy takes the lock at all.
    let refreshes = 0;
    stubSlack(
      { ok: true, access_token: "xoxe.xoxb-NEW", refresh_token: "xoxe-1-NEW", expires_in: 43_200 },
      () => {
        refreshes++;
      },
    );
    const svc = Effect.flatMap(OAuthCredentialService, (s) =>
      Effect.all(
        [
          s.freshSecrets(WS, SLACK_CONNECTION_SLOT, slackSecrets()),
          s.freshSecrets(WS, SLACK_CONNECTION_SLOT, slackSecrets()),
        ],
        { concurrency: 2 },
      ),
    );
    const [a, b] = await Effect.runPromise(Effect.provide(svc, layerWith(await encrypt(slackSecrets()))));
    expect(refreshes).toBe(1);
    // The loser served the stored token, still valid inside the skew window.
    expect([a.accessToken, b.accessToken]).toContain("xoxe.xoxb-NEW");
  });
});

// ── PER-ACCOUNT REFRESH ──────────────────────────────────────────────────────
//
// A workspace may hold several Slack teams, one credentials row each. Without
// an `accountId`, a refresh re-read and persisted the `""` row while the caller
// was running team B: the fresh token got merged over the wrong secrets and
// written to a row nothing reads, and team B's SINGLE-USE rotating refresh
// token was burned in the process.

/** A row per account, so a write can be shown to land on exactly one of them. */
const layerWithAccounts = (
  seeds: readonly { accountId: string; name: string; secretsEnc: string }[],
) => {
  const rows: CredentialRow[] = seeds.map((seed, i) => ({
    id: `cred_${i}`,
    workspaceId: WS,
    extensionId: SLACK_CONNECTION_SLOT,
    accountId: seed.accountId,
    scope: "workspace",
    name: seed.name,
    ownerUserId: null,
    secretsEnc: seed.secretsEnc,
    createdAt: NOW + i,
  }));
  return Layer.provideMerge(
    OAuthCredentialService.Default,
    Layer.merge(credentialRepoLayer(rows), cryptoLayer),
  );
};

/** Read every stored row back as PLAINTEXT, keyed by account. */
const storedByAccount = Effect.gen(function* () {
  const repo = yield* CredentialRepo;
  const crypto = yield* CryptoService;
  const rows = yield* repo.findSharedAccounts({
    workspaceId: WS,
    extensionId: SLACK_CONNECTION_SLOT,
  });
  const out: Record<string, { name: string; secrets: SecretMap }> = {};
  for (const row of rows) {
    out[row.accountId] = {
      name: row.name,
      secrets: yield* crypto.decrypt(WS, row.secretsEnc),
    };
  }
  return out;
});

describe("freshSecrets targets ONE account", () => {
  it("persists the refreshed token to the NAMED account's row, not the '' row", async () => {
    stubSlack({ ok: true, access_token: "xoxe.xoxb-NEW", refresh_token: "xoxe-1-NEW", expires_in: 43_200 });
    const teamB = slackSecrets({ teamId: "T_B", teamName: "Acme EU" });
    const layer = layerWithAccounts([
      // The sole-account row a single-account connector (or a not-yet-healed
      // legacy Slack install) occupies. It must come out UNTOUCHED.
      { accountId: "", name: "Slack", secretsEnc: await encrypt(slackSecrets({ accessToken: "xoxe.xoxb-DEFAULT" })) },
      { accountId: "T_B", name: "Slack — Acme EU", secretsEnc: await encrypt(teamB) },
    ]);
    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* OAuthCredentialService;
        yield* svc.freshSecrets(WS, SLACK_CONNECTION_SLOT, teamB, "T_B");
        return yield* storedByAccount;
      }).pipe(Effect.provide(layer)),
    );
    expect(stored["T_B"].secrets.accessToken).toBe("xoxe.xoxb-NEW");
    expect(stored["T_B"].secrets.refreshToken).toBe("xoxe-1-NEW");
    // The row the un-accounted code path would have clobbered.
    expect(stored[""].secrets.accessToken).toBe("xoxe.xoxb-DEFAULT");
    expect(stored[""].secrets.refreshToken).toBe("xoxe-1-old");
  });

  it("writes exactly TWO rows back — a refresh never forks a third", async () => {
    stubSlack({ ok: true, access_token: "xoxe.xoxb-NEW", refresh_token: "xoxe-1-NEW", expires_in: 43_200 });
    const teamB = slackSecrets({ teamId: "T_B" });
    const layer = layerWithAccounts([
      { accountId: "T_A", name: "Slack — Acme", secretsEnc: await encrypt(slackSecrets({ teamId: "T_A" })) },
      { accountId: "T_B", name: "Slack — Acme EU", secretsEnc: await encrypt(teamB) },
    ]);
    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* OAuthCredentialService;
        yield* svc.freshSecrets(WS, SLACK_CONNECTION_SLOT, teamB, "T_B");
        return yield* storedByAccount;
      }).pipe(Effect.provide(layer)),
    );
    expect(Object.keys(stored).sort()).toEqual(["T_A", "T_B"]);
    // Team A never refreshed, so its stored token is still the seeded one.
    expect(stored["T_A"].secrets.accessToken).toBe("xoxe.xoxb-stale");
  });

  it("PRESERVES the row's display name — a rotation is not a reconnect", async () => {
    // Writing `slot.adapter.displayName` unconditionally renamed
    // "Slack — Acme EU" back to "Slack" every twelve hours.
    stubSlack({ ok: true, access_token: "xoxe.xoxb-NEW", refresh_token: "xoxe-1-NEW", expires_in: 43_200 });
    const teamB = slackSecrets({ teamId: "T_B" });
    const layer = layerWithAccounts([
      { accountId: "T_B", name: "Slack — Acme EU", secretsEnc: await encrypt(teamB) },
    ]);
    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* OAuthCredentialService;
        yield* svc.freshSecrets(WS, SLACK_CONNECTION_SLOT, teamB, "T_B");
        return yield* storedByAccount;
      }).pipe(Effect.provide(layer)),
    );
    expect(stored["T_B"].name).toBe("Slack — Acme EU");
  });

  it("merges over the NAMED account's stored secrets, keeping ITS display meta", async () => {
    // The re-read inside the lock must fetch team B's row. Fetching the `""`
    // row instead would silently relabel B with the other install's meta.
    stubSlack({ ok: true, access_token: "xoxe.xoxb-NEW", refresh_token: "xoxe-1-NEW", expires_in: 43_200 });
    const teamB = slackSecrets({ teamId: "T_B", teamName: "Acme EU" });
    const layer = layerWithAccounts([
      { accountId: "", name: "Slack", secretsEnc: await encrypt(slackSecrets({ teamName: "Acme Classic" })) },
      { accountId: "T_B", name: "Slack — Acme EU", secretsEnc: await encrypt(teamB) },
    ]);
    const out = await Effect.runPromise(
      Effect.flatMap(OAuthCredentialService, (s) =>
        s.freshSecrets(WS, SLACK_CONNECTION_SLOT, teamB, "T_B"),
      ).pipe(Effect.provide(layer)),
    );
    expect(out.teamId).toBe("T_B");
    expect(out.teamName).toBe("Acme EU");
    expect(out.accessToken).toBe("xoxe.xoxb-NEW");
  });

  it("still refreshes the '' row when no account is named", async () => {
    // Every single-account connector omits the argument; that must keep
    // resolving to the sole-account row exactly as it always did.
    stubSlack({ ok: true, access_token: "xoxe.xoxb-NEW", refresh_token: "xoxe-1-NEW", expires_in: 43_200 });
    const layer = layerWithAccounts([
      { accountId: "", name: "Slack", secretsEnc: await encrypt(slackSecrets()) },
    ]);
    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* OAuthCredentialService;
        yield* svc.freshSecrets(WS, SLACK_CONNECTION_SLOT, slackSecrets());
        return yield* storedByAccount;
      }).pipe(Effect.provide(layer)),
    );
    expect(stored[""].secrets.accessToken).toBe("xoxe.xoxb-NEW");
  });

  it("lets two DIFFERENT teams refresh concurrently — the lock is per account", async () => {
    // Slack's refresh tokens are single-use PER INSTALL, so team A refreshing
    // must not be serialized behind team B. One shared lock key would be safe
    // but would convoy unrelated teams behind a network round-trip each.
    let refreshes = 0;
    stubSlack({ ok: true, access_token: "xoxe.xoxb-NEW", refresh_token: "xoxe-1-NEW", expires_in: 43_200 }, () => {
      refreshes++;
    });
    const teamA = slackSecrets({ teamId: "T_A" });
    const teamB = slackSecrets({ teamId: "T_B" });
    const layer = layerWithAccounts([
      { accountId: "T_A", name: "Slack — Acme", secretsEnc: await encrypt(teamA) },
      { accountId: "T_B", name: "Slack — Acme EU", secretsEnc: await encrypt(teamB) },
    ]);
    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* OAuthCredentialService;
        yield* Effect.all(
          [
            svc.freshSecrets(WS, SLACK_CONNECTION_SLOT, teamA, "T_A"),
            svc.freshSecrets(WS, SLACK_CONNECTION_SLOT, teamB, "T_B"),
          ],
          { concurrency: 2 },
        );
        return yield* storedByAccount;
      }).pipe(Effect.provide(layer)),
    );
    // BOTH refreshed: neither was mistaken for the other's in-flight rotation.
    expect(refreshes).toBe(2);
    expect(stored["T_A"].secrets.accessToken).toBe("xoxe.xoxb-NEW");
    expect(stored["T_B"].secrets.accessToken).toBe("xoxe.xoxb-NEW");
  });
});
