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
import { credentialRepoLayer, type CredentialRow } from "../repositories/credential-repo.js";
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

/**
 * Google's slot. The distinctive risk is NOT the token — it is the picked-file
 * list riding in the same envelope.
 *
 * Under `drive.file` that list is the only record of which spreadsheets the
 * grant can open. Google's access tokens live 1 hour, so a merge that dropped it
 * would silently empty the user's sheet list every hour, leaving a perfectly
 * valid token attached to a connection the UI believes can reach nothing — a
 * failure that looks like data loss and is trivially caused by writing the
 * obvious `merge: (_, tokens) => toSecrets(tokens, EMPTY)`.
 */
describe("the Google slot", () => {
  const googleSecrets = (over: Partial<Record<string, string>> = {}): SecretMap => ({
    accessToken: "ya29.stale",
    refreshToken: "1//rt",
    expiresAtMs: String(NOW + 60_000), // inside the 5-min skew ⇒ stale
    connectedByUserId: "user_1",
    connectedByName: "Morgan",
    googleEmail: "morgan@trigify.io",
    pickedFiles: JSON.stringify([{ id: "sheet_1", name: "Q3 Leads" }]),
    ...over,
  });

  it("is keyed on 'google' so every Google connector resolves to it", () => {
    expect(Object.keys(OAUTH_SLOTS)).toContain("google");
  });

  it("is Proactive, NOT Rotating — Google refresh tokens are reusable", () => {
    // Rotating would take a per-connection advisory lock for no reason.
    expect(OAUTH_SLOTS.google.policy._tag).toBe("Proactive");
  });

  it("PRESERVES picked files and account email across a refresh", () => {
    const merged = OAUTH_SLOTS.google.merge(googleSecrets(), {
      accessToken: "ya29.fresh",
      refreshToken: "1//rt",
      expiresAtMs: NOW + 3600_000,
    });
    expect(merged.accessToken).toBe("ya29.fresh");
    expect(merged.googleEmail).toBe("morgan@trigify.io");
    expect(JSON.parse(merged.pickedFiles ?? "[]")).toEqual([{ id: "sheet_1", name: "Q3 Leads" }]);
    expect(merged.connectedByName).toBe("Morgan");
  });

  it("keeps the picked files even when the stored blob has no usable token", () => {
    // The fallback path reconstructs meta field-by-field; it must not blank the
    // list just because the token was missing.
    const merged = OAUTH_SLOTS.google.merge({ googleEmail: "m@x.io" }, { accessToken: "ya29.fresh" });
    expect(merged.googleEmail).toBe("m@x.io");
    expect(merged.accessToken).toBe("ya29.fresh");
  });

  it("parses tokens out of a stored Google secret map", () => {
    const parsed = OAUTH_SLOTS.google.parse(googleSecrets());
    expect(parsed?.accessToken).toBe("ya29.stale");
    expect(parsed?.refreshToken).toBe("1//rt");
  });

  it("parses null when there is no access token, so freshSecrets passes through", () => {
    expect(OAUTH_SLOTS.google.parse({ pickedFiles: "[]" })).toBeNull();
  });
});
