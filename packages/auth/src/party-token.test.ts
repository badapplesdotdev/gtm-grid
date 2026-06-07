/**
 * Party-token AC (TRI-3261) — the tenant-isolation guarantee, OFFLINE.
 *
 * Proves:
 *   - mint/verify round-trips the `{ sub, workspaceId, exp }` claims,
 *   - `authorizeGridConnection` ACCEPTS a member token for the matching room,
 *   - and REJECTS each leak vector: wrong-workspace room, expired token, bad
 *     signature, and a missing token.
 */

import { describe, expect, it } from "vitest";
import {
  authorizeGridConnection,
  gridRoomId,
  mintPartyToken,
  verifyPartyToken,
  workspaceIdFromRoomId,
} from "./party-token.js";

const SECRET = "test-party-auth-secret-at-least-32-bytes-long!!";
const WS = "ws_acme";
const TABLE = "tbl_leads";
const USER = "user_alice";
// Real-aligned clock (seconds): tokens are minted against the real wall-clock
// (jose setExpirationTime / jwtVerify enforce exp in real time), so the pinned
// nowSeconds we pass to authorizeGridConnection must track real now for the
// expiry assertions to be consistent with jose's own exp enforcement.
const NOW = Math.floor(Date.now() / 1000);

const mintFor = (
  overrides: Partial<{
    userId: string;
    workspaceId: string;
    secret: string;
    expiresInSeconds: number;
  }> = {},
) =>
  mintPartyToken({
    userId: overrides.userId ?? USER,
    workspaceId: overrides.workspaceId ?? WS,
    secret: overrides.secret ?? SECRET,
    expiresInSeconds: overrides.expiresInSeconds ?? 3600,
  });

describe("mintPartyToken / verifyPartyToken", () => {
  it("round-trips the sub + workspaceId + exp claims", async () => {
    const token = await mintFor();
    const claims = await verifyPartyToken(token, SECRET);
    expect(claims.sub).toBe(USER);
    expect(claims.workspaceId).toBe(WS);
    expect(typeof claims.exp).toBe("number");
    expect(typeof claims.iat).toBe("number");
    expect(claims.exp).toBeGreaterThan(claims.iat);
  });

  it("reads PARTY_AUTH_SECRET from env when no secret is passed", async () => {
    const saved = process.env.PARTY_AUTH_SECRET;
    process.env.PARTY_AUTH_SECRET = SECRET;
    try {
      const token = await mintPartyToken({ userId: USER, workspaceId: WS });
      const claims = await verifyPartyToken(token, SECRET);
      expect(claims.workspaceId).toBe(WS);
    } finally {
      if (saved === undefined) delete process.env.PARTY_AUTH_SECRET;
      else process.env.PARTY_AUTH_SECRET = saved;
    }
  });

  it("throws when no secret is available", async () => {
    const saved = process.env.PARTY_AUTH_SECRET;
    delete process.env.PARTY_AUTH_SECRET;
    try {
      await expect(
        mintPartyToken({ userId: USER, workspaceId: WS }),
      ).rejects.toThrow(/PARTY_AUTH_SECRET/);
    } finally {
      if (saved !== undefined) process.env.PARTY_AUTH_SECRET = saved;
    }
  });

  it("rejects verification under a wrong secret", async () => {
    const token = await mintFor();
    await expect(
      verifyPartyToken(token, "a-totally-different-wrong-secret-value"),
    ).rejects.toThrow();
  });
});

describe("room id helpers", () => {
  it("builds and splits the room id on the FIRST colon only", () => {
    expect(gridRoomId(WS, TABLE)).toBe(`${WS}:${TABLE}`);
    expect(workspaceIdFromRoomId(`${WS}:${TABLE}`)).toBe(WS);
    // table ids may contain colons; only the first segment is the workspace.
    expect(workspaceIdFromRoomId(`${WS}:a:b:c`)).toBe(WS);
    expect(workspaceIdFromRoomId("no-colon")).toBeNull();
  });
});

describe("authorizeGridConnection — tenant isolation", () => {
  const room = gridRoomId(WS, TABLE);

  it("ACCEPTS a member token for the matching room", async () => {
    const token = await mintFor();
    const decision = await authorizeGridConnection({
      token,
      roomId: room,
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(decision).toMatchObject({ ok: true });
    if (decision.ok) {
      expect(decision.claims.sub).toBe(USER);
      expect(decision.claims.workspaceId).toBe(WS);
    }
  });

  it("REJECTS a token minted for a DIFFERENT workspace (the leak)", async () => {
    // Alice is a member of ws_other and mints a valid token there, then tries to
    // subscribe to ws_acme's room — the exact cross-tenant eavesdrop vector.
    const token = await mintFor({ workspaceId: "ws_other" });
    const decision = await authorizeGridConnection({
      token,
      roomId: room,
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(decision).toEqual({ ok: false, reason: "workspace-mismatch" });
  });

  it("REJECTS an expired token", async () => {
    const token = await mintFor({ expiresInSeconds: 1 });
    // Verify the room/workspace match so the ONLY failing dimension is expiry.
    const decision = await authorizeGridConnection({
      token,
      roomId: room,
      secret: SECRET,
      nowSeconds: NOW + 10_000, // far past the 1s ttl
    });
    expect(decision).toEqual({ ok: false, reason: "expired" });
  });

  it("REJECTS a token signed with the wrong secret (bad signature)", async () => {
    const token = await mintFor({ secret: "an-attacker-controlled-secret-xx" });
    const decision = await authorizeGridConnection({
      token,
      roomId: room,
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(decision).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("REJECTS a missing token", async () => {
    for (const token of [null, undefined, ""]) {
      const decision = await authorizeGridConnection({
        token,
        roomId: room,
        secret: SECRET,
        nowSeconds: NOW,
      });
      expect(decision).toEqual({ ok: false, reason: "missing-token" });
    }
  });

  it("REJECTS a malformed room id", async () => {
    const token = await mintFor();
    const decision = await authorizeGridConnection({
      token,
      roomId: "no-colon-room",
      secret: SECRET,
      nowSeconds: NOW,
    });
    expect(decision).toEqual({ ok: false, reason: "malformed-room" });
  });
});
