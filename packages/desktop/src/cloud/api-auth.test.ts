/**
 * NEW-path Better Auth OAuth + sidecar-token logic tests (TRI-3252).
 *
 * Pure logic, fully offline — no webview, no live Better Auth session:
 *   1. OAUTH CALLBACK — `isApiOAuthCallback` recognizes the `gtmgrid://` deep
 *      link (and only that), and `apiOAuthCallbackUrl` returns the shared
 *      scheme so a single URL scheme is registered with the OS.
 *   2. TOKEN RESOLUTION — `sidecarTokenFromSession` (the `useAuthToken()`
 *      replacement) derives the sidecar bearer token from a Better Auth session
 *      and returns `null` for every loading / signed-out / empty state.
 */

import { describe, expect, it } from "vitest";
import { OAUTH_REDIRECT_URL } from "./desktop-oauth";
import {
  apiOAuthCallbackUrl,
  isApiOAuthCallback,
  sidecarTokenFromSession,
  unwrapAuthResult,
} from "./api-auth";

describe("apiOAuthCallbackUrl", () => {
  it("reuses the single registered gtmgrid:// scheme", () => {
    expect(apiOAuthCallbackUrl()).toBe(OAUTH_REDIRECT_URL);
    expect(apiOAuthCallbackUrl()).toBe("gtmgrid://auth/callback");
  });
});

describe("isApiOAuthCallback", () => {
  it("matches our callback deep link (with or without query params)", () => {
    expect(isApiOAuthCallback("gtmgrid://auth/callback")).toBe(true);
    // Better Auth completes the session server-side, so no `code` is required —
    // but extra query params must still match.
    expect(isApiOAuthCallback("gtmgrid://auth/callback?state=abc")).toBe(true);
  });

  it("rejects unrelated schemes, hosts, and paths", () => {
    expect(isApiOAuthCallback("https://example.com/auth/callback")).toBe(false);
    expect(isApiOAuthCallback("gtmgrid://other/path")).toBe(false);
    expect(isApiOAuthCallback("gtmgrid://auth/other")).toBe(false);
  });

  it("rejects malformed URLs without throwing", () => {
    expect(isApiOAuthCallback("not a url")).toBe(false);
    expect(isApiOAuthCallback("")).toBe(false);
  });
});

describe("sidecarTokenFromSession — useAuthToken() replacement", () => {
  it("returns the session token when authenticated", () => {
    expect(sidecarTokenFromSession({ session: { token: "tok_abc" } })).toBe(
      "tok_abc",
    );
  });

  it("returns null while loading / signed out", () => {
    expect(sidecarTokenFromSession(null)).toBeNull();
    expect(sidecarTokenFromSession(undefined)).toBeNull();
    expect(sidecarTokenFromSession({ session: null })).toBeNull();
    expect(sidecarTokenFromSession({})).toBeNull();
  });

  it("treats an empty/absent token as no token", () => {
    expect(sidecarTokenFromSession({ session: { token: "" } })).toBeNull();
    expect(sidecarTokenFromSession({ session: { token: null } })).toBeNull();
    expect(sidecarTokenFromSession({ session: {} })).toBeNull();
  });
});

// ─── unwrapAuthResult — the Better Auth → throw-on-error bridge (TRI-3253) ────
//
// The NEW account actions run every Better Auth client call through this so the
// UI's existing try/catch + friendlyAuthError contract keeps working (Better
// Auth RESOLVES `{ error }` rather than rejecting). The key outcomes: success
// returns the data; any error is re-raised as a real Error carrying the best
// available message.

describe("unwrapAuthResult", () => {
  it("returns the data on success", () => {
    expect(unwrapAuthResult({ data: { token: "tok" } })).toEqual({
      token: "tok",
    });
  });

  it("returns null when data is null/absent but no error", () => {
    expect(unwrapAuthResult({ data: null })).toBeNull();
    expect(unwrapAuthResult({})).toBeNull();
  });

  it("throws with the server message when an error carries one", () => {
    expect(() =>
      unwrapAuthResult({ error: { message: "Invalid email or password" } }),
    ).toThrow("Invalid email or password");
  });

  it("falls back to the error code when there is no message", () => {
    expect(() =>
      unwrapAuthResult({ error: { code: "INVALID_OTP" } }),
    ).toThrow("INVALID_OTP");
  });

  it("throws a generic message when the error is empty", () => {
    expect(() => unwrapAuthResult({ error: {} })).toThrow(
      "Authentication failed.",
    );
  });
});
