/**
 * CrmConnectionService — the Attio connection's storage + session seams, over
 * the in-memory TestLayer (REAL AES-256-GCM under the fixed test key):
 *   - saveConnection → memberSession/connectionMeta round-trip
 *   - the worker path needs NO current user (worker-secret trust boundary)
 *   - tokens are stored as ciphertext, never plaintext
 *   - persistTokens (session.persist) rotates tokens but keeps display metadata
 *   - a missing connection is CrmConnectionMissing, not a crash
 */

import { Effect, Exit, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Membership } from "@gtmgrid/cloud";
import { TestLayer, type TestLayerFixtures } from "../layers.js";
import { CredentialRepo } from "../repositories/credential-repo.js";
import { CrmConnectionService } from "./crm-connection-service.js";

const WS = "11111111-1111-1111-1111-111111111111";
const memberships: readonly Membership[] = [{ workspaceId: WS, userId: "user_m", role: "member" }];

const META = {
  connectedByUserId: "user_m",
  connectedByName: "Morgan",
  crmWorkspaceId: "attio_ws_1",
  crmWorkspaceName: "Acme Attio",
};

/** Comfortably outside the 5-minute proactive-refresh skew. */
const FUTURE = Date.now() + 60 * 60 * 1000;

const run = <A, E>(fixtures: TestLayerFixtures, program: Effect.Effect<A, E, CrmConnectionService>) =>
  Effect.runPromise(program.pipe(Effect.provide(TestLayer(fixtures))) as Effect.Effect<A, E, never>);

const runExit = <A, E>(fixtures: TestLayerFixtures, program: Effect.Effect<A, E, CrmConnectionService>) =>
  Effect.runPromiseExit(program.pipe(Effect.provide(TestLayer(fixtures))) as Effect.Effect<A, E, never>);

describe("saveConnection → sessions", () => {
  it("round-trips tokens + display metadata for a member", async () => {
    const result = await run(
      { memberships, currentUserId: "user_m" },
      Effect.gen(function* () {
        const svc = yield* CrmConnectionService;
        yield* svc.saveConnection({
          workspaceId: WS,
          provider: "attio",
          tokens: { accessToken: "at_1", refreshToken: "rt_1", expiresAtMs: FUTURE },
          meta: META,
        });
        const session = yield* svc.memberSession(WS);
        const meta = yield* svc.connectionMeta(WS);
        return { tokens: session.tokens, meta: Option.getOrNull(meta) };
      }),
    );
    expect(result.tokens).toEqual({ accessToken: "at_1", refreshToken: "rt_1", expiresAtMs: FUTURE });
    expect(result.meta).toEqual(META);
  });

  it("handles the long-lived token shape (no refresh token / expiry)", async () => {
    const tokens = await run(
      { memberships, currentUserId: "user_m" },
      Effect.gen(function* () {
        const svc = yield* CrmConnectionService;
        yield* svc.saveConnection({ workspaceId: WS, provider: "attio", tokens: { accessToken: "at_only" }, meta: META });
        const session = yield* svc.memberSession(WS);
        return session.tokens;
      }),
    );
    expect(tokens).toEqual({ accessToken: "at_only" });
  });

  it("workerSession needs NO current user (the cron path)", async () => {
    // The ENTIRE flow runs signed-out: saveConnection (callback trust = the
    // verified state, not a session) then the worker read.
    const tokens = await run(
      { memberships, currentUserId: null },
      Effect.gen(function* () {
        const svc = yield* CrmConnectionService;
        yield* svc.saveConnection({ workspaceId: WS, provider: "attio", tokens: { accessToken: "at_1" }, meta: META });
        const session = yield* svc.workerSession(WS);
        return session.tokens;
      }),
    );
    expect(tokens.accessToken).toBe("at_1");
  });

  it("stores CIPHERTEXT — the credential row never contains the plaintext token", async () => {
    const row = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* CrmConnectionService;
        yield* svc.saveConnection({ workspaceId: WS, provider: "attio", tokens: { accessToken: "at_SUPER_SECRET" }, meta: META });
        const repo = yield* CredentialRepo;
        return Option.getOrNull(yield* repo.findSharedForWorker({ workspaceId: WS, extensionId: "attio-crm" }));
      }).pipe(
        Effect.provide(TestLayer({ memberships, currentUserId: "user_m" })),
      ) as Effect.Effect<{ extensionId: string; scope: string; secretsEnc: string } | null, never, never>,
    );
    expect(row).not.toBeNull();
    expect(row?.extensionId).toBe("attio-crm");
    expect(row?.scope).toBe("workspace");
    expect(row?.secretsEnc).not.toContain("at_SUPER_SECRET");
  });
});

describe("persistTokens (session.persist)", () => {
  it("rotates tokens while preserving the display metadata", async () => {
    // One TestLayer instance end to end (in-memory credential stores are
    // instance-isolated by design): save → refresh-persist → re-read.
    const result = await run(
      { memberships, currentUserId: "user_m" },
      Effect.gen(function* () {
        const svc = yield* CrmConnectionService;
        yield* svc.saveConnection({
          workspaceId: WS,
          provider: "attio",
          tokens: { accessToken: "at_old", refreshToken: "rt_1" },
          meta: META,
        });
        const session = yield* svc.workerSession(WS);
        // The refresh path persists rotated tokens through the session.
        yield* session.persist({ accessToken: "at_new", refreshToken: "rt_1" });
        const reread = yield* svc.workerSession(WS);
        const meta = yield* svc.connectionMeta(WS);
        return { tokens: reread.tokens, meta: Option.getOrNull(meta) };
      }),
    );
    expect(result.tokens).toEqual({ accessToken: "at_new", refreshToken: "rt_1" });
    // Metadata survives rotation ("connected by Morgan" still renders).
    expect(result.meta).toEqual(META);
  });
});

describe("removeConnection (disconnect)", () => {
  it("deletes the stored connection; sessions then fail closed", async () => {
    const result = await runExit(
      { memberships, currentUserId: "user_m" },
      Effect.gen(function* () {
        const svc = yield* CrmConnectionService;
        yield* svc.saveConnection({ workspaceId: WS, provider: "attio", tokens: { accessToken: "at_1" }, meta: META });
        const removed = yield* svc.removeConnection(WS);
        return { removed, session: yield* svc.memberSession(WS) };
      }),
    );
    expect(Exit.isFailure(result)).toBe(true); // memberSession after removal
    expect(JSON.stringify(result)).toContain("CrmConnectionMissing");
  });

  it("returns false when there was nothing to remove", async () => {
    const removed = await run(
      { memberships, currentUserId: "user_m" },
      Effect.gen(function* () {
        const svc = yield* CrmConnectionService;
        return yield* svc.removeConnection(WS);
      }),
    );
    expect(removed).toBe(false);
  });
});

describe("missing connections fail closed (and human-readably upstream)", () => {
  it("memberSession without a connection is CrmConnectionMissing", async () => {
    const exit = await runExit(
      { memberships, currentUserId: "user_m" },
      Effect.gen(function* () {
        const svc = yield* CrmConnectionService;
        return yield* svc.memberSession(WS);
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("CrmConnectionMissing");
  });

  it("workerSession without a connection is CrmConnectionMissing", async () => {
    const exit = await runExit(
      { memberships, currentUserId: null },
      Effect.gen(function* () {
        const svc = yield* CrmConnectionService;
        return yield* svc.workerSession(WS);
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("CrmConnectionMissing");
  });

  it("connectionMeta is None (not an error) when disconnected", async () => {
    const meta = await run(
      { memberships, currentUserId: "user_m" },
      Effect.gen(function* () {
        const svc = yield* CrmConnectionService;
        return yield* svc.connectionMeta(WS);
      }),
    );
    expect(Option.isNone(meta)).toBe(true);
  });
});

describe("proactive refresh at session mint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("an expiring-soon token refreshes up front and persists the rotation", async () => {
    vi.stubEnv("ATTIO_CLIENT_ID", "client-123");
    vi.stubEnv("ATTIO_CLIENT_SECRET", "secret-456");
    vi.stubGlobal("fetch", async (url: string) => {
      expect(String(url)).toBe("https://app.attio.com/oauth/token");
      return new Response(JSON.stringify({ access_token: "at_fresh", expires_in: 1800 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const result = await run(
      { memberships, currentUserId: "user_m" },
      Effect.gen(function* () {
        const svc = yield* CrmConnectionService;
        yield* svc.saveConnection({
          workspaceId: WS,
          provider: "attio",
          tokens: { accessToken: "at_stale", refreshToken: "rt_1", expiresAtMs: Date.now() + 30_000 },
          meta: META,
        });
        const session = yield* svc.memberSession(WS, "attio");
        // The rotation persisted: a SECOND mint sees the fresh token without
        // another refresh (its new expiry is beyond the skew window).
        const again = yield* svc.memberSession(WS, "attio");
        return { first: session.tokens, second: again.tokens };
      }),
    );
    expect(result.first.accessToken).toBe("at_fresh");
    // The refresh token survives when the provider doesn't rotate it.
    expect(result.first.refreshToken).toBe("rt_1");
    expect(result.second.accessToken).toBe("at_fresh");
  });

  it("a refresh REFUSAL fails the mint as CrmAuthRevoked (dead connection)", async () => {
    vi.stubEnv("ATTIO_CLIENT_ID", "client-123");
    vi.stubEnv("ATTIO_CLIENT_SECRET", "secret-456");
    vi.stubGlobal("fetch", async () => new Response("invalid_grant", { status: 400 }));
    const exit = await runExit(
      { memberships, currentUserId: "user_m" },
      Effect.gen(function* () {
        const svc = yield* CrmConnectionService;
        yield* svc.saveConnection({
          workspaceId: WS,
          provider: "attio",
          tokens: { accessToken: "at_stale", refreshToken: "rt_dead", expiresAtMs: Date.now() - 1000 },
          meta: META,
        });
        return yield* svc.memberSession(WS, "attio");
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("CrmAuthRevoked");
  });

  it("a token with no expiry (Attio's long-lived shape) never refreshes up front", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("no HTTP expected");
    });
    const tokens = await run(
      { memberships, currentUserId: "user_m" },
      Effect.gen(function* () {
        const svc = yield* CrmConnectionService;
        yield* svc.saveConnection({ workspaceId: WS, provider: "attio", tokens: { accessToken: "at_only" }, meta: META });
        return (yield* svc.memberSession(WS, "attio")).tokens;
      }),
    );
    expect(tokens).toEqual({ accessToken: "at_only" });
  });
});

describe("per-provider slots", () => {
  it("attio and hubspot connections coexist in one workspace, fully isolated", async () => {
    const result = await run(
      { memberships, currentUserId: "user_m" },
      Effect.gen(function* () {
        const svc = yield* CrmConnectionService;
        yield* svc.saveConnection({
          workspaceId: WS,
          provider: "attio",
          tokens: { accessToken: "at_attio" },
          meta: META,
        });
        yield* svc.saveConnection({
          workspaceId: WS,
          provider: "hubspot",
          tokens: { accessToken: "at_hubspot", expiresAtMs: FUTURE },
          meta: { ...META, crmWorkspaceId: "424242", crmWorkspaceName: "acme.hubspot.com" },
        });
        const attio = yield* svc.memberSession(WS, "attio");
        const hubspot = yield* svc.memberSession(WS, "hubspot");
        const hubspotMeta = yield* svc.connectionMeta(WS, "hubspot");
        // Disconnecting HubSpot must NOT touch Attio.
        yield* svc.removeConnection(WS, "hubspot");
        const attioAfter = yield* svc.memberSession(WS, "attio");
        const hubspotAfter = yield* svc.connectionMeta(WS, "hubspot");
        return { attio, hubspot, hubspotMeta, attioAfter, hubspotAfter };
      }),
    );
    expect(result.attio.tokens.accessToken).toBe("at_attio");
    expect(result.hubspot.tokens.accessToken).toBe("at_hubspot");
    expect(Option.isSome(result.hubspotMeta) && result.hubspotMeta.value.crmWorkspaceName).toBe("acme.hubspot.com");
    expect(result.attioAfter.tokens.accessToken).toBe("at_attio");
    expect(Option.isNone(result.hubspotAfter)).toBe(true);
  });
});
