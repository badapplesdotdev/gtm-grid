/** Tests for the pending-invite deep-link token parsing. */
import { describe, expect, it } from "vitest";
import { inviteTokenFromDeepLink } from "./pendingInvite";

describe("inviteTokenFromDeepLink", () => {
  it("extracts the token from a gtmgrid://invite/<token> deep link", () => {
    expect(inviteTokenFromDeepLink("gtmgrid://invite/abc123")).toBe("abc123");
  });
  it("is case-insensitive on the scheme + ignores query/hash", () => {
    expect(inviteTokenFromDeepLink("GTMGRID://invite/tok?x=1#y")).toBe("tok");
  });
  it("url-decodes the token", () => {
    expect(inviteTokenFromDeepLink("gtmgrid://invite/a%2Fb")).toBe("a/b");
  });
  it("returns null for the OAuth callback + unrelated links", () => {
    expect(inviteTokenFromDeepLink("gtmgrid://auth/callback")).toBeNull();
    expect(inviteTokenFromDeepLink("https://example.com/invite/x")).toBeNull();
    expect(inviteTokenFromDeepLink("gtmgrid://invite/")).toBeNull();
  });
});
