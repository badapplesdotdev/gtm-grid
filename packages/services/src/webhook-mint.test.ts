import { describe, expect, it } from "vitest";
import { mintSigningSecret, mintToken } from "./webhook-mint.js";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe("webhook mint — 256-bit base64url tokens", () => {
  it("mintToken is URL-safe base64url with no padding", () => {
    const t = mintToken();
    expect(t).toMatch(BASE64URL);
    expect(t).not.toContain("=");
    expect(t).not.toContain("+");
    expect(t).not.toContain("/");
  });

  it("mintToken encodes 32 bytes → 43 base64url chars", () => {
    expect(mintToken()).toHaveLength(43);
  });

  it("mints distinct tokens (high entropy)", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => mintToken()));
    expect(tokens.size).toBe(200);
  });

  it("mintSigningSecret is whsec_-prefixed with a base64url body", () => {
    const s = mintSigningSecret();
    expect(s.startsWith("whsec_")).toBe(true);
    expect(s.slice("whsec_".length)).toMatch(BASE64URL);
    expect(s.slice("whsec_".length)).toHaveLength(43);
  });
});
