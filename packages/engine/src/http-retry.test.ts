// Unit tests for the plain-TS retry + timeout wrapper (TRI-3276).
//
// We stub the global `fetch` with a queue of scripted Responses/throws and inject
// an instant `sleep` + deterministic `random` so the tests are fast and stable.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchWithRetry,
  isFatalStopStatus,
  isRetryableStatus,
  parseRetryAfter,
} from "./http-retry.js";

/** Build a Response with a status and optional headers. */
function resp(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : "{}", { status, headers });
}

/** Replace global fetch with one that returns/throws scripted values in order. */
function scriptFetch(steps: Array<Response | Error>): { calls: number } {
  const state = { calls: 0 };
  const queue = [...steps];
  vi.stubGlobal("fetch", async () => {
    state.calls++;
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error("fetch called more times than scripted");
    return next;
  });
  return state;
}

/** Instant sleep + zero jitter so backoff math is deterministic and fast. */
const fast = { sleep: async () => {}, random: () => 0 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isRetryableStatus / isFatalStopStatus", () => {
  it("classifies 429/503/5xx as retryable and 402/4xx as not", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(402)).toBe(false);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isFatalStopStatus(402)).toBe(true);
    expect(isFatalStopStatus(429)).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-06-07T00:00:00Z");

  it("parses delta-seconds form into milliseconds", () => {
    expect(parseRetryAfter("5", now, 30_000)).toBe(5000);
  });

  it("parses HTTP-date form relative to now", () => {
    const future = new Date(now + 3000).toUTCString();
    expect(parseRetryAfter(future, now, 30_000)).toBe(3000);
  });

  it("clamps to the max and floors negatives at zero", () => {
    expect(parseRetryAfter("999", now, 10_000)).toBe(10_000);
    const past = new Date(now - 5000).toUTCString();
    expect(parseRetryAfter(past, now, 30_000)).toBe(0);
  });

  it("returns undefined for missing/unparseable headers", () => {
    expect(parseRetryAfter(null, now, 30_000)).toBeUndefined();
    expect(parseRetryAfter("", now, 30_000)).toBeUndefined();
    expect(parseRetryAfter("not-a-date", now, 30_000)).toBeUndefined();
  });
});

describe("fetchWithRetry", () => {
  it("retries a 503 then returns the eventual 200 (retry-then-success)", async () => {
    const state = scriptFetch([resp(503), resp(200)]);
    const res = await fetchWithRetry("https://x.test", {}, fast);
    expect(res.status).toBe(200);
    expect(state.calls).toBe(2);
  });

  it("retries a 429 then succeeds", async () => {
    const state = scriptFetch([resp(429), resp(200)]);
    const res = await fetchWithRetry("https://x.test", {}, fast);
    expect(res.status).toBe(200);
    expect(state.calls).toBe(2);
  });

  it("honours a Retry-After header for the backoff delay on 429", async () => {
    scriptFetch([resp(429, { "retry-after": "2" }), resp(200)]);
    const sleeps: number[] = [];
    const res = await fetchWithRetry(
      "https://x.test",
      {},
      { sleep: async (ms) => void sleeps.push(ms), random: () => 0 },
    );
    expect(res.status).toBe(200);
    // The 429 carried Retry-After: 2s → the single backoff must be exactly 2000ms,
    // NOT the computed exponential backoff (which would be 0 with random()=0).
    expect(sleeps).toEqual([2000]);
  });

  it("does NOT retry a 402 — returns it immediately as a fatal stop", async () => {
    const state = scriptFetch([resp(402), resp(200)]);
    const res = await fetchWithRetry("https://x.test", {}, fast);
    expect(res.status).toBe(402);
    expect(state.calls).toBe(1);
  });

  it("does NOT retry other 4xx (e.g. 400)", async () => {
    const state = scriptFetch([resp(400), resp(200)]);
    const res = await fetchWithRetry("https://x.test", {}, fast);
    expect(res.status).toBe(400);
    expect(state.calls).toBe(1);
  });

  it("returns the last retryable response after exhausting attempts", async () => {
    const state = scriptFetch([resp(503), resp(503)]);
    const res = await fetchWithRetry("https://x.test", {}, { ...fast, maxAttempts: 2 });
    expect(res.status).toBe(503);
    expect(state.calls).toBe(2);
  });

  it("retries network errors then succeeds", async () => {
    const state = scriptFetch([new Error("ECONNRESET"), resp(200)]);
    const res = await fetchWithRetry("https://x.test", {}, fast);
    expect(res.status).toBe(200);
    expect(state.calls).toBe(2);
  });

  it("re-throws when network errors exhaust all attempts", async () => {
    scriptFetch([new Error("boom"), new Error("boom")]);
    await expect(
      fetchWithRetry("https://x.test", {}, { ...fast, maxAttempts: 2 }),
    ).rejects.toThrow("boom");
  });

  it("applies a per-attempt AbortController timeout", async () => {
    // A fetch that resolves only if NOT aborted; aborts surface as a rejection.
    vi.stubGlobal("fetch", (_url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }
        // Never resolves on its own → only the timeout can end it.
      });
    });
    await expect(
      fetchWithRetry(
        "https://x.test",
        {},
        { ...fast, maxAttempts: 1, timeoutMs: 5 },
      ),
    ).rejects.toThrow();
  });
});
