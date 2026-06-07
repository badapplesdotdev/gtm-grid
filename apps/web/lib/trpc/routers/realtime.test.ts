/**
 * Procedure tests for the `realtime` router via `createCaller`, run OFFLINE
 * against a `TestLayer` context (no PartyKit, no DB).
 *
 * Proves the acceptance-criteria invariants at the PROCEDURE boundary (TRI-3261):
 *   - realtime.token mints a WORKSPACE-SCOPED party token (`sub` = user,
 *     `workspaceId` = the requested workspace) for a MEMBER, and returns the URL,
 *   - a NON-member is rejected with FORBIDDEN (the membership gate — this is the
 *     tenant-isolation fix: no token for a workspace you don't belong to),
 *   - a signed-out caller is rejected with UNAUTHORIZED.
 */

import { verifyPartyToken } from "@gtmgrid/auth";
import type { Membership } from "@gtmgrid/services";
import { TestLayer } from "@gtmgrid/services";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext } from "../context";
import { appRouter } from "../root";
import { createCallerFactory } from "../trpc";

const createCaller = createCallerFactory(appRouter);
const SECRET = "test-party-auth-secret-which-is-long-enough!!";
const PARTY_URL = "http://127.0.0.1:1999";
const WS = "11111111-1111-1111-1111-111111111111";
const ALICE = "user_alice";

const memberships: readonly Membership[] = [
  { workspaceId: WS, userId: ALICE, role: "member" },
];

const savedSecret = process.env.PARTY_AUTH_SECRET;
const savedUrl = process.env.PARTY_URL;

beforeAll(() => {
  process.env.PARTY_AUTH_SECRET = SECRET;
  process.env.PARTY_URL = PARTY_URL;
});

afterAll(() => {
  if (savedSecret === undefined) delete process.env.PARTY_AUTH_SECRET;
  else process.env.PARTY_AUTH_SECRET = savedSecret;
  if (savedUrl === undefined) delete process.env.PARTY_URL;
  else process.env.PARTY_URL = savedUrl;
});

const callerFor = (userId: string | null) =>
  createCaller(
    createTestContext({
      layer: TestLayer({ memberships, currentUserId: userId }),
      userId,
    }),
  );

describe("realtime.token", () => {
  it("mints a workspace-scoped party token + url for a member", async () => {
    const caller = callerFor(ALICE);
    const { token, url, expiresInSeconds } = await caller.realtime.token({
      workspaceId: WS,
    });
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3);
    expect(url).toBe(PARTY_URL);
    expect(expiresInSeconds).toBeGreaterThan(0);

    // The claim that gates the connection: sub = caller, workspaceId = the room's
    // workspace. The party rejects unless this equals the room id's workspace.
    const claims = await verifyPartyToken(token, SECRET);
    expect(claims.sub).toBe(ALICE);
    expect(claims.workspaceId).toBe(WS);
  });

  it("rejects a NON-member with FORBIDDEN (no token for a foreign workspace)", async () => {
    const caller = callerFor("user_stranger");
    await expect(
      caller.realtime.token({ workspaceId: WS }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a signed-out caller with UNAUTHORIZED", async () => {
    const caller = callerFor(null);
    await expect(
      caller.realtime.token({ workspaceId: WS }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
