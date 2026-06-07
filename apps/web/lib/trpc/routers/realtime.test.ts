/**
 * Procedure tests for the `realtime` router via `createCaller`, run OFFLINE
 * against a `TestLayer` context (no Supabase, no DB).
 *
 * Proves the acceptance-criteria invariants at the PROCEDURE boundary:
 *   - realtime.token mints a Supabase-compatible JWT for the signed-in user,
 *   - a signed-out caller is rejected with UNAUTHORIZED.
 */

import { TestLayer } from "@gtmgrid/services";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestContext } from "../context";
import { appRouter } from "../root";
import { createCallerFactory } from "../trpc";

const createCaller = createCallerFactory(appRouter);
const SECRET = "test-supabase-jwt-secret-which-is-long-enough";
const ALICE = "user_alice";

beforeAll(() => {
  process.env.SUPABASE_JWT_SECRET = SECRET;
});

const callerFor = (userId: string | null) =>
  createCaller(createTestContext({ layer: TestLayer({}), userId }));

/** Decode a JWT's payload segment without verifying (claim assertions only). */
const decodeClaims = (token: string): Record<string, unknown> => {
  const segment = token.split(".")[1];
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
};

describe("realtime.token", () => {
  it("mints a Supabase-compatible JWT for the signed-in user", async () => {
    const caller = callerFor(ALICE);
    const { token, expiresInSeconds } = await caller.realtime.token();
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3);
    expect(expiresInSeconds).toBeGreaterThan(0);

    // The claims Supabase Realtime / RLS expect: sub = user id, role/aud authenticated.
    const claims = decodeClaims(token);
    expect(claims.sub).toBe(ALICE);
    expect(claims.role).toBe("authenticated");
    expect(claims.aud).toBe("authenticated");
  });

  it("rejects a signed-out caller with UNAUTHORIZED", async () => {
    const caller = callerFor(null);
    await expect(caller.realtime.token()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
