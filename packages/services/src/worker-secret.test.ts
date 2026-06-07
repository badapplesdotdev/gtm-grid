/**
 * Worker-secret gate tests — the constant-time `WEBHOOK_WORKER_SECRET` bearer
 * the W2 worker boundary reuses. Asserts accept (correct bearer) and reject
 * (missing / wrong / malformed bearer, and unset env = fail-closed).
 */

import { afterEach, describe, expect, it } from "vitest";
import { isAuthorizedWorker, timingSafeEqual } from "./worker-secret.js";

const SECRET = "super-secret-worker-token";

const reqWith = (auth: string | null): Request =>
  new Request("https://example.com/api/worker/resolveToken", {
    method: "POST",
    headers: auth === null ? {} : { Authorization: auth },
  });

afterEach(() => {
  delete process.env.WEBHOOK_WORKER_SECRET;
});

describe("isAuthorizedWorker", () => {
  it("accepts the correct Bearer secret", () => {
    process.env.WEBHOOK_WORKER_SECRET = SECRET;
    expect(isAuthorizedWorker(reqWith(`Bearer ${SECRET}`))).toBe(true);
  });

  it("rejects a wrong secret", () => {
    process.env.WEBHOOK_WORKER_SECRET = SECRET;
    expect(isAuthorizedWorker(reqWith("Bearer wrong-token"))).toBe(false);
  });

  it("rejects a missing Authorization header", () => {
    process.env.WEBHOOK_WORKER_SECRET = SECRET;
    expect(isAuthorizedWorker(reqWith(null))).toBe(false);
  });

  it("rejects a non-Bearer scheme", () => {
    process.env.WEBHOOK_WORKER_SECRET = SECRET;
    expect(isAuthorizedWorker(reqWith(`Basic ${SECRET}`))).toBe(false);
  });

  it("fail-closed when the env secret is unset", () => {
    expect(isAuthorizedWorker(reqWith(`Bearer ${SECRET}`))).toBe(false);
  });

  it("fail-closed when the env secret is empty", () => {
    process.env.WEBHOOK_WORKER_SECRET = "";
    expect(isAuthorizedWorker(reqWith("Bearer "))).toBe(false);
  });
});

describe("timingSafeEqual", () => {
  it("is true only for identical strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});
