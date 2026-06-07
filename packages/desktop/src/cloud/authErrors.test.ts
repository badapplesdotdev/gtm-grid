/**
 * Tests for `friendlyAuthError` — the auth error → human copy mapper.
 *
 * It must produce the SAME friendly copy whether the failure came from the legacy
 * Convex Auth path (server error markers in `.message`) OR the NEW Postgres-tier
 * path (TRI-3253): Better Auth error codes/messages (re-raised as `Error`s by
 * `unwrapAuthResult`) and tRPC client errors carrying a `data.code`. We assert
 * OUTCOMES (the copy) and the invariant that a raw trace NEVER leaks.
 */

import { describe, expect, it } from "vitest";
import { friendlyAuthError } from "./authErrors";

describe("friendlyAuthError — Better Auth (NEW path) markers", () => {
  it("maps invalid credentials (code + message) to the mismatch copy", () => {
    expect(
      friendlyAuthError(new Error("INVALID_EMAIL_OR_PASSWORD"), "signIn"),
    ).toMatch(/don't match/i);
    expect(
      friendlyAuthError(new Error("Invalid email or password"), "signIn"),
    ).toMatch(/don't match/i);
  });

  it("maps an existing account to the sign-in suggestion", () => {
    expect(friendlyAuthError(new Error("USER_ALREADY_EXISTS"), "signUp")).toMatch(
      /already exists/i,
    );
    expect(
      friendlyAuthError(new Error("EMAIL_ALREADY_IN_USE"), "signUp"),
    ).toMatch(/already exists/i);
  });

  it("maps an invalid/expired OTP to the retry-with-new-code copy", () => {
    expect(friendlyAuthError(new Error("INVALID_OTP"), "signUp")).toMatch(
      /invalid or has expired/i,
    );
    expect(friendlyAuthError(new Error("OTP_EXPIRED"), "signIn")).toMatch(
      /invalid or has expired/i,
    );
  });

  it("maps an unverified email to the verify prompt", () => {
    expect(
      friendlyAuthError(new Error("EMAIL_NOT_VERIFIED"), "signIn"),
    ).toMatch(/verify your email/i);
  });
});

describe("friendlyAuthError — tRPC client errors (NEW path)", () => {
  it("reads the tRPC `data.code` (e.g. on a thrown TRPCClientError-like object)", () => {
    // A TRPCClientError exposes `.message` + `.data.code`. We synthesize that
    // shape: an unrelated message but a recognizable code.
    const trpcLike = Object.assign(new Error("Request failed"), {
      data: { code: "UNAUTHORIZED" },
    });
    // No specific marker for UNAUTHORIZED → falls back to the generic copy, but
    // must NOT leak the raw message and must be flow-appropriate.
    expect(friendlyAuthError(trpcLike, "signIn")).toBe(
      "Couldn't sign you in. Please try again.",
    );
  });

  it("maps a network failure to the connection copy", () => {
    expect(friendlyAuthError(new Error("Failed to fetch"), "signIn")).toMatch(
      /check your connection/i,
    );
  });
});

describe("friendlyAuthError — legacy Convex markers still resolve", () => {
  it("maps InvalidAccountId per flow", () => {
    expect(friendlyAuthError(new Error("InvalidAccountId"), "signIn")).toMatch(
      /couldn't find an account/i,
    );
    expect(friendlyAuthError(new Error("InvalidAccountId"), "signUp")).toMatch(
      /already exists/i,
    );
  });

  it("never leaks a raw trace for an unknown error", () => {
    const raw =
      "[CONVEX A(auth:signIn)] Server Error\nUncaught Error: kaboom at x (y.js)";
    const friendly = friendlyAuthError(new Error(raw), "signIn");
    expect(friendly).not.toContain("kaboom");
    expect(friendly).toBe("Couldn't sign you in. Please try again.");
  });
});
