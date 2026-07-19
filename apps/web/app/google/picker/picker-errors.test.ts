/**
 * The Picker page's retry policy and error copy.
 *
 * The retry predicate is the reason this page uses React Query rather than a
 * hand-rolled effect, and it is also the part a future edit can silently revert:
 * delete `retry: isRetryable` and everything still compiles, still renders the
 * right message, and merely takes several seconds longer while re-asking a
 * question that was answered definitively the first time. Nothing about the UI
 * would reveal it. So the policy gets pinned here.
 */

import { describe, expect, it } from "vitest";
import { errorCode, errorCopy, isRetryable, MAX_RETRIES, PickerError } from "./picker-errors";

describe("isRetryable", () => {
  it("retries a TRANSPORT failure (no code) — the request never got an answer", () => {
    expect(isRetryable(0, new PickerError(null))).toBe(true);
  });

  it("stops after MAX_RETRIES", () => {
    expect(isRetryable(MAX_RETRIES - 1, new PickerError(null))).toBe(true);
    expect(isRetryable(MAX_RETRIES, new PickerError(null))).toBe(false);
  });

  it("does NOT retry an expired state — re-asking cannot change the answer", () => {
    expect(isRetryable(0, new PickerError("invalid_or_expired_state"))).toBe(false);
  });

  it("does NOT retry a revoked connection", () => {
    expect(isRetryable(0, new PickerError("not_connected"))).toBe(false);
  });

  it("does NOT retry picker_not_configured, even though it arrives as a 500", () => {
    // The key case. A status-based rule ("retry 5xx") would hammer a permanent
    // operator misconfiguration three times over; keying on the CODE does not.
    expect(isRetryable(0, new PickerError("picker_not_configured"))).toBe(false);
  });

  it("does NOT retry an error of an unknown shape", () => {
    // Anything that isn't a PickerError never went through our classification,
    // so we cannot claim it is transient.
    expect(isRetryable(0, new Error("boom"))).toBe(false);
    expect(isRetryable(0, undefined)).toBe(false);
  });
});

describe("errorCode", () => {
  it("reads a named code off a response body", () => {
    expect(errorCode({ error: "not_connected" })).toBe("not_connected");
  });

  it("returns null for a body that names nothing, so the failure counts as transport", () => {
    expect(errorCode({})).toBeNull();
    expect(errorCode(null)).toBeNull();
    expect(errorCode("nope")).toBeNull();
    expect(errorCode({ error: 42 })).toBeNull();
  });
});

describe("errorCopy", () => {
  it("gives each recoverable failure its OWN next action", () => {
    // One generic apology would leave the user with nothing to do; each of these
    // is fixed by a different action, so each says which.
    expect(errorCopy(new PickerError("invalid_or_expired_state"))).toMatch(/expired/i);
    expect(errorCopy(new PickerError("not_connected"))).toMatch(/reconnect/i);
    expect(errorCopy(new PickerError("picker_not_configured"))).toMatch(/administrator/i);
  });

  it("never echoes the raw code or an HTTP status back to the user", () => {
    // NOT "contains no underscore": `picker_not_configured` deliberately names
    // GOOGLE_PICKER_API_KEY, because the person reading that one is an operator
    // who needs the variable name. What must never appear is the CODE itself —
    // it describes our trust model and means nothing to a user.
    for (const code of [
      "invalid_or_expired_state",
      "not_connected",
      "picker_not_configured",
      "no_valid_files",
      "something_new",
    ]) {
      const copy = errorCopy(new PickerError(code));
      expect(copy).not.toContain(code);
      expect(copy).not.toMatch(/\b[45]\d\d\b/);
    }
  });

  it("falls back to a generic message for an unclassified error", () => {
    expect(errorCopy(new Error("boom"))).toMatch(/something went wrong/i);
    expect(errorCopy(null)).toMatch(/something went wrong/i);
  });
});
