import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `createAuth()` must set an EXPLICIT Better Auth signing secret and fail fast
 * when `BETTER_AUTH_SECRET` is unset — otherwise Better Auth silently falls back
 * to its hardcoded DEFAULT secret and throws a generic `BetterAuthError` in
 * production, breaking sign-in/sign-up entirely (and running on the default
 * secret is a signing-security weakness for CRM OAuth state + unsubscribe tokens
 * too). See packages/auth/src/server.ts.
 *
 * A dummy DATABASE_URL lets us import the real Drizzle client for a `Db` value;
 * postgres-js opens no connection until a query runs, and the secret check
 * throws before the db is ever touched.
 */
process.env.DATABASE_URL ??=
  "postgresql://user:pass@localhost:5432/postgres";

const { db } = await import("@gtmgrid/db/client");
const { createAuth } = await import("./server.js");

describe("createAuth signing secret", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("throws a clear error when BETTER_AUTH_SECRET is unset", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    expect(() => createAuth(db)).toThrow(/BETTER_AUTH_SECRET is not set/);
  });

  it("builds an instance when BETTER_AUTH_SECRET is set", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "unit-test-signing-secret");
    expect(() => createAuth(db)).not.toThrow();
  });
});
