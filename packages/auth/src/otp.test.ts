import { describe, expect, it } from "vitest";
import { generateOtp, OTP_EXPIRY_SECONDS, OTP_LENGTH } from "./otp.js";

/**
 * OTP generation AC (TRI-3244): the code must be a 6-digit NUMERIC string with a
 * 15-minute window, matching the email design + verify-screen copy (ported from
 * convex/auth.ts:78-82).
 */

describe("generateOtp", () => {
  it("is a 6-digit numeric string", () => {
    for (let i = 0; i < 200; i++) {
      const otp = generateOtp();
      expect(otp).toMatch(/^\d{6}$/);
      expect(otp).toHaveLength(OTP_LENGTH);
    }
  });

  it("preserves leading zeros (always OTP_LENGTH chars)", () => {
    // Across many draws at least the length invariant must hold for every code,
    // including ones that begin with 0 (string form, not a trimmed number).
    for (let i = 0; i < 500; i++) {
      expect(generateOtp()).toHaveLength(OTP_LENGTH);
    }
  });

  it("produces varied codes (not a constant)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generateOtp());
    // 100 draws from a 1e6 space should yield many distinct values; assert it is
    // clearly not stuck on a single constant.
    expect(seen.size).toBeGreaterThan(50);
  });

  it("uses a 15-minute (900s) expiry window", () => {
    expect(OTP_EXPIRY_SECONDS).toBe(15 * 60);
  });
});
