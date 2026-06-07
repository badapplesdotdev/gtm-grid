/**
 * Tests for {@link CredentialService}, run against the in-memory {@link TestLayer}
 * (real AES-256-GCM under a fixed master key, in-memory repo) — NO live database.
 *
 * Asserts the acceptance-criteria invariants end to end:
 *   - save → getForRun round-trips the PLAINTEXT secret map (encrypt + decrypt).
 *   - save encrypts: the stored row holds ciphertext, never the plaintext.
 *   - membership is required for save / get / list (non-member + signed-out fail).
 *   - personal scope is bound to its owner: a member cannot get/list ANOTHER
 *     member's personal key; getForRun on someone else's personal row is rejected.
 *   - list returns METADATA ONLY and NEVER `secretsEnc`.
 *   - upsert rotates a connector's key in place rather than accumulating rows.
 */

import type { Membership } from "@gtmgrid/cloud";
import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  type CredentialRow,
  CredentialRepo,
} from "../repositories/credential-repo.js";
import { TestLayer, type TestLayerFixtures } from "../layers.js";
import { CredentialService } from "./credential-service.js";

const WS = "11111111-1111-1111-1111-111111111111";
const ALICE = "user_alice";
const BOB = "user_bob";

const memberships: readonly Membership[] = [
  { workspaceId: WS, userId: ALICE, role: "member" },
  { workspaceId: WS, userId: BOB, role: "member" },
];

const runExit = <A, E>(
  fixtures: TestLayerFixtures,
  program: Effect.Effect<A, E, CredentialService | CredentialRepo>,
) => Effect.runPromiseExit(program.pipe(Effect.provide(TestLayer(fixtures))));

const failureTag = <A, E>(exit: Exit.Exit<A, E>): string | undefined =>
  Exit.isSuccess(exit)
    ? undefined
    : Option.getOrUndefined(
        Option.map(
          Cause.failureOption(exit.cause),
          (f) => (f as { _tag?: string })._tag ?? "",
        ),
      );

describe("CredentialService.saveCredential + getCredentialForRun", () => {
  it("round-trips the plaintext secret map for a member", async () => {
    const exit = await runExit(
      { memberships, currentUserId: ALICE },
      Effect.gen(function* () {
        const svc = yield* CredentialService;
        yield* svc.saveCredential({
          workspaceId: WS,
          extensionId: "ai:openai",
          scope: "workspace",
          name: "OpenAI",
          secrets: { apiKey: "sk-123" },
        });
        return yield* svc.getCredentialForRun({
          workspaceId: WS,
          extensionId: "ai:openai",
          scope: "workspace",
        });
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(Option.getOrNull(exit.value)).toEqual({ apiKey: "sk-123" });
    }
  });

  it("stores CIPHERTEXT, never the plaintext, in the repo row", async () => {
    const exit = await runExit(
      { memberships, currentUserId: ALICE },
      Effect.gen(function* () {
        const svc = yield* CredentialService;
        yield* svc.saveCredential({
          workspaceId: WS,
          extensionId: "ai:openai",
          scope: "workspace",
          name: "OpenAI",
          secrets: { apiKey: "plaintext-leak-canary" },
        });
        const repo = yield* CredentialRepo;
        return yield* repo.findForAccess({
          workspaceId: WS,
          extensionId: "ai:openai",
          scope: "workspace",
          ownerUserId: null,
        });
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit) && Option.isSome(exit.value)) {
      expect(exit.value.value.secretsEnc).not.toContain("plaintext-leak-canary");
      expect(JSON.parse(exit.value.value.secretsEnc)).toMatchObject({ v: 1 });
    } else {
      throw new Error("expected a stored row");
    }
  });

  it("rotates a connector's key in place rather than adding a row", async () => {
    const exit = await runExit(
      { memberships, currentUserId: ALICE },
      Effect.gen(function* () {
        const svc = yield* CredentialService;
        yield* svc.saveCredential({
          workspaceId: WS,
          extensionId: "ai:openai",
          scope: "workspace",
          name: "OpenAI",
          secrets: { apiKey: "v1" },
        });
        yield* svc.saveCredential({
          workspaceId: WS,
          extensionId: "ai:openai",
          scope: "workspace",
          name: "OpenAI",
          secrets: { apiKey: "v2" },
        });
        const list = yield* svc.listCredentials(WS);
        const secrets = yield* svc.getCredentialForRun({
          workspaceId: WS,
          extensionId: "ai:openai",
          scope: "workspace",
        });
        return { list, secrets: Option.getOrNull(secrets) };
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.list).toHaveLength(1);
      expect(exit.value.secrets).toEqual({ apiKey: "v2" });
    }
  });

  it("returns None from getForRun when no credential exists", async () => {
    const exit = await runExit(
      { memberships, currentUserId: ALICE },
      Effect.flatMap(CredentialService, (svc) =>
        svc.getCredentialForRun({
          workspaceId: WS,
          extensionId: "ai:missing",
          scope: "workspace",
        }),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(Option.isNone(exit.value)).toBe(true);
  });
});

describe("CredentialService membership gating", () => {
  it("rejects save by a non-member with NotAMemberError", async () => {
    const exit = await runExit(
      { memberships, currentUserId: "user_stranger" },
      Effect.flatMap(CredentialService, (svc) =>
        svc.saveCredential({
          workspaceId: WS,
          extensionId: "ai:openai",
          scope: "workspace",
          name: "OpenAI",
          secrets: { apiKey: "x" },
        }),
      ),
    );
    expect(failureTag(exit)).toBe("NotAMemberError");
  });

  it("rejects list by an unauthenticated caller with UnauthenticatedError", async () => {
    const exit = await runExit(
      { memberships, currentUserId: null },
      Effect.flatMap(CredentialService, (svc) => svc.listCredentials(WS)),
    );
    expect(failureTag(exit)).toBe("UnauthenticatedError");
  });
});

describe("CredentialService personal-scope ownership", () => {
  const aliceKey: CredentialRow = {
    id: "c_alice",
    workspaceId: WS,
    extensionId: "ai:openai",
    scope: "personal",
    name: "OpenAI (Alice)",
    ownerUserId: ALICE,
    secretsEnc: "enc",
    createdAt: 1,
  };

  it("binds a saved personal key to the caller and round-trips for them", async () => {
    const exit = await runExit(
      { memberships, currentUserId: ALICE },
      Effect.gen(function* () {
        const svc = yield* CredentialService;
        yield* svc.saveCredential({
          workspaceId: WS,
          extensionId: "ai:openai",
          scope: "personal",
          name: "OpenAI (Alice)",
          secrets: { apiKey: "alice-key" },
        });
        return yield* svc.getCredentialForRun({
          workspaceId: WS,
          extensionId: "ai:openai",
          scope: "personal",
        });
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(Option.getOrNull(exit.value)).toEqual({ apiKey: "alice-key" });
    }
  });

  it("does not let one member read another member's personal key via getForRun", async () => {
    // Alice's personal key is seeded; Bob asks for the SAME connector's personal
    // key. Owner binding scopes the lookup to Bob, so he gets None — never Alice's
    // key — even though it exists in the same workspace + connector.
    const bobExit = await runExit(
      { memberships, currentUserId: BOB, credentials: [aliceKey] },
      Effect.flatMap(CredentialService, (svc) =>
        svc.getCredentialForRun({
          workspaceId: WS,
          extensionId: "ai:openai",
          scope: "personal",
        }),
      ),
    );
    expect(Exit.isSuccess(bobExit)).toBe(true);
    if (Exit.isSuccess(bobExit)) expect(Option.isNone(bobExit.value)).toBe(true);
  });

  it("listCredentials shows shared rows + only the caller's OWN personal rows", async () => {
    const sharedRow: CredentialRow = {
      id: "c_shared",
      workspaceId: WS,
      extensionId: "ai:anthropic",
      scope: "workspace",
      name: "Anthropic (team)",
      ownerUserId: null,
      secretsEnc: "enc",
      createdAt: 1,
    };
    const bobKey: CredentialRow = {
      id: "c_bob",
      workspaceId: WS,
      extensionId: "ai:openai",
      scope: "personal",
      name: "OpenAI (Bob)",
      ownerUserId: BOB,
      secretsEnc: "enc",
      createdAt: 2,
    };
    const exit = await runExit(
      { memberships, currentUserId: ALICE, credentials: [sharedRow, aliceKey, bobKey] },
      Effect.flatMap(CredentialService, (svc) => svc.listCredentials(WS)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      const ids = exit.value.map((r) => r.id).sort();
      // Alice sees the shared row and her OWN personal row, NOT Bob's.
      expect(ids).toEqual(["c_alice", "c_shared"]);
    }
  });

  it("listCredentials returns METADATA only — never secretsEnc", async () => {
    const sharedRow: CredentialRow = {
      id: "c_shared",
      workspaceId: WS,
      extensionId: "ai:anthropic",
      scope: "workspace",
      name: "Anthropic (team)",
      ownerUserId: null,
      secretsEnc: "DO-NOT-LEAK",
      createdAt: 1,
    };
    const exit = await runExit(
      { memberships, currentUserId: ALICE, credentials: [sharedRow] },
      Effect.flatMap(CredentialService, (svc) => svc.listCredentials(WS)),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      for (const row of exit.value) {
        expect(row).not.toHaveProperty("secretsEnc");
        expect(JSON.stringify(row)).not.toContain("DO-NOT-LEAK");
      }
    }
  });
});
