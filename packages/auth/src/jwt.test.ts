import { jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mintSupabaseJwt } from "./jwt.js";

/**
 * Supabase JWT AC (TRI-3244): the minted token is HS256, carries the user id as
 * `sub`, and uses the Supabase "authenticated" role/audience so RLS works.
 */

const SECRET = "test-supabase-jwt-secret-at-least-32-bytes-long";

const savedSecret = process.env.SUPABASE_JWT_SECRET;

beforeEach(() => {
  delete process.env.SUPABASE_JWT_SECRET;
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.SUPABASE_JWT_SECRET;
  else process.env.SUPABASE_JWT_SECRET = savedSecret;
});

describe("mintSupabaseJwt", () => {
  it("mints an HS256 token verifiable with the same secret", async () => {
    const token = await mintSupabaseJwt({ userId: "user_123", secret: SECRET });
    const { payload, protectedHeader } = await jwtVerify(
      token,
      new TextEncoder().encode(SECRET),
    );
    expect(protectedHeader.alg).toBe("HS256");
    expect(payload.sub).toBe("user_123");
    expect(payload.role).toBe("authenticated");
    expect(payload.aud).toBe("authenticated");
    expect(typeof payload.exp).toBe("number");
    expect(typeof payload.iat).toBe("number");
  });

  it("reads the secret from SUPABASE_JWT_SECRET when not passed", async () => {
    process.env.SUPABASE_JWT_SECRET = SECRET;
    const token = await mintSupabaseJwt({ userId: "user_456" });
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(SECRET),
    );
    expect(payload.sub).toBe("user_456");
  });

  it("merges extra claims (e.g. email) without overriding reserved ones", async () => {
    const token = await mintSupabaseJwt({
      userId: "user_789",
      secret: SECRET,
      extraClaims: { email: "user@example.com", role: "should-be-ignored" },
    });
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(SECRET),
    );
    expect(payload.email).toBe("user@example.com");
    // The reserved `role` claim always wins.
    expect(payload.role).toBe("authenticated");
  });

  it("throws when no secret is available", async () => {
    await expect(mintSupabaseJwt({ userId: "x" })).rejects.toThrow(
      /SUPABASE_JWT_SECRET/,
    );
  });

  it("rejects verification under a wrong secret", async () => {
    const token = await mintSupabaseJwt({ userId: "user_123", secret: SECRET });
    await expect(
      jwtVerify(token, new TextEncoder().encode("a-different-wrong-secret")),
    ).rejects.toThrow();
  });
});
