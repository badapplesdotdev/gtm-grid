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
import { describe, expect, it } from "vitest";
import type { Membership } from "@gtmgrid/cloud";
import { TestLayer, type TestLayerFixtures } from "../layers.js";
import { CredentialRepo } from "../repositories/credential-repo.js";
import { CrmConnectionService } from "./crm-connection-service.js";

const WS = "11111111-1111-1111-1111-111111111111";
const memberships: readonly Membership[] = [{ workspaceId: WS, userId: "user_m", role: "member" }];

const META = {
  connectedByUserId: "user_m",
  connectedByName: "Morgan",
  attioWorkspaceId: "attio_ws_1",
  attioWorkspaceName: "Acme Attio",
};

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
          tokens: { accessToken: "at_1", refreshToken: "rt_1", expiresAtMs: 1_700_000_000_000 },
          meta: META,
        });
        const session = yield* svc.memberSession(WS);
        const meta = yield* svc.connectionMeta(WS);
        return { tokens: session.tokens, meta: Option.getOrNull(meta) };
      }),
    );
    expect(result.tokens).toEqual({ accessToken: "at_1", refreshToken: "rt_1", expiresAtMs: 1_700_000_000_000 });
    expect(result.meta).toEqual(META);
  });

  it("handles the long-lived token shape (no refresh token / expiry)", async () => {
    const tokens = await run(
      { memberships, currentUserId: "user_m" },
      Effect.gen(function* () {
        const svc = yield* CrmConnectionService;
        yield* svc.saveConnection({ workspaceId: WS, tokens: { accessToken: "at_only" }, meta: META });
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
        yield* svc.saveConnection({ workspaceId: WS, tokens: { accessToken: "at_1" }, meta: META });
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
        yield* svc.saveConnection({ workspaceId: WS, tokens: { accessToken: "at_SUPER_SECRET" }, meta: META });
        const repo = yield* CredentialRepo;
        return Option.getOrNull(yield* repo.findSharedForWorker({ workspaceId: WS, extensionId: "attio" }));
      }).pipe(
        Effect.provide(TestLayer({ memberships, currentUserId: "user_m" })),
      ) as Effect.Effect<{ extensionId: string; scope: string; secretsEnc: string } | null, never, never>,
    );
    expect(row).not.toBeNull();
    expect(row?.extensionId).toBe("attio");
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
