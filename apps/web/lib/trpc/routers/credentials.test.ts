/**
 * Procedure tests for the `credentials` router via `createCaller`, run OFFLINE
 * against a `TestLayer` context (real AES-256-GCM, in-memory repo, no live DB).
 *
 * Proves the acceptance-criteria invariants at the PROCEDURE boundary:
 *   - `save` then `getForRun` round-trips the plaintext for a member.
 *   - `getForRun` is the ONLY plaintext path; `list` returns metadata only and
 *     never `secretsEnc`.
 *   - non-members get FORBIDDEN, signed-out callers get UNAUTHORIZED (the
 *     `workspaceProcedure` membership gate).
 *   - personal scope is bound to the caller: a member's `list`/`getForRun` never
 *     surfaces another member's personal key.
 */

import type { CredentialRow, Membership } from "@gtmgrid/services";
import { TestLayer, type TestLayerFixtures } from "@gtmgrid/services";
import { describe, expect, it } from "vitest";
import { createTestContext } from "../context";
import { appRouter } from "../root";
import { createCallerFactory } from "../trpc";

const createCaller = createCallerFactory(appRouter);

const WS = "11111111-1111-1111-1111-111111111111";
const ALICE = "user_alice";
const BOB = "user_bob";

const memberships: readonly Membership[] = [
  { workspaceId: WS, userId: ALICE, role: "member" },
  { workspaceId: WS, userId: BOB, role: "member" },
];

const callerFor = (fixtures: TestLayerFixtures) =>
  createCaller(
    createTestContext({
      layer: TestLayer(fixtures),
      userId: fixtures.currentUserId ?? null,
    }),
  );

describe("credentials.save + credentials.getForRun", () => {
  it("round-trips the plaintext secret map for a member", async () => {
    const caller = callerFor({ memberships, currentUserId: ALICE });
    await caller.credentials.save({
      workspaceId: WS,
      extensionId: "ai:openai",
      scope: "workspace",
      name: "OpenAI",
      secrets: { apiKey: "sk-abc" },
    });
    const secrets = await caller.credentials.getForRun({
      workspaceId: WS,
      extensionId: "ai:openai",
      scope: "workspace",
    });
    expect(secrets).toEqual({ apiKey: "sk-abc" });
  });

  it("getForRun returns null when no credential exists", async () => {
    const caller = callerFor({ memberships, currentUserId: ALICE });
    const secrets = await caller.credentials.getForRun({
      workspaceId: WS,
      extensionId: "ai:missing",
      scope: "workspace",
    });
    expect(secrets).toBeNull();
  });

  it("rejects save by a non-member with FORBIDDEN", async () => {
    const caller = callerFor({ memberships, currentUserId: "user_stranger" });
    await expect(
      caller.credentials.save({
        workspaceId: WS,
        extensionId: "ai:openai",
        scope: "workspace",
        name: "OpenAI",
        secrets: { apiKey: "x" },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects getForRun by an unauthenticated caller with UNAUTHORIZED", async () => {
    const caller = callerFor({ memberships, currentUserId: null });
    await expect(
      caller.credentials.getForRun({
        workspaceId: WS,
        extensionId: "ai:openai",
        scope: "workspace",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("credentials.list", () => {
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
  const aliceKey: CredentialRow = {
    id: "c_alice",
    workspaceId: WS,
    extensionId: "ai:openai",
    scope: "personal",
    name: "OpenAI (Alice)",
    ownerUserId: ALICE,
    secretsEnc: "enc-alice",
    createdAt: 2,
  };
  const bobKey: CredentialRow = {
    id: "c_bob",
    workspaceId: WS,
    extensionId: "ai:openai",
    scope: "personal",
    name: "OpenAI (Bob)",
    ownerUserId: BOB,
    secretsEnc: "enc-bob",
    createdAt: 3,
  };
  const credentials = [sharedRow, aliceKey, bobKey] as const;

  it("returns metadata ONLY — never secretsEnc", async () => {
    const caller = callerFor({ memberships, currentUserId: ALICE, credentials });
    const rows = await caller.credentials.list({ workspaceId: WS });
    for (const row of rows) {
      expect(row).not.toHaveProperty("secretsEnc");
      expect(JSON.stringify(row)).not.toContain("DO-NOT-LEAK");
    }
  });

  it("shows shared rows + only the caller's OWN personal rows", async () => {
    const caller = callerFor({ memberships, currentUserId: ALICE, credentials });
    const rows = await caller.credentials.list({ workspaceId: WS });
    expect(rows.map((r) => r.id).sort()).toEqual(["c_alice", "c_shared"]);
  });

  it("rejects a non-member with FORBIDDEN", async () => {
    const caller = callerFor({
      memberships,
      currentUserId: "user_stranger",
      credentials,
    });
    await expect(
      caller.credentials.list({ workspaceId: WS }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("credentials personal-scope ownership at the procedure boundary", () => {
  const aliceKey: CredentialRow = {
    id: "c_alice",
    workspaceId: WS,
    extensionId: "ai:openai",
    scope: "personal",
    name: "OpenAI (Alice)",
    ownerUserId: ALICE,
    secretsEnc: "enc-alice",
    createdAt: 1,
  };

  it("getForRun never returns another member's personal key", async () => {
    // Bob asks for the personal key; only Alice's exists. Owner binding scopes
    // the lookup to Bob, so he gets null — never Alice's key.
    const caller = callerFor({
      memberships,
      currentUserId: BOB,
      credentials: [aliceKey],
    });
    const secrets = await caller.credentials.getForRun({
      workspaceId: WS,
      extensionId: "ai:openai",
      scope: "personal",
    });
    expect(secrets).toBeNull();
  });
});
