/**
 * Procedure test for the W4 `auth` router via `createCaller`, run OFFLINE with no
 * live DB and no live Better Auth instance.
 *
 * `auth.enabledProviders` is a stateless, env-derived public read (it just
 * forwards `@gtmgrid/auth`'s pure `enabledProviders()`), so we exercise it by
 * toggling the gating env vars around a `createCaller` invocation and asserting
 * the booleans-only contract the desktop `useEnabledProviders` depends on:
 *   - all off when no creds are present,
 *   - a provider flips on only when BOTH its id + secret are set,
 *   - `emailAuth` flips on when the Resend key is present,
 *   - NO secret value is ever echoed back (booleans only).
 */

import { TestLayer } from "@gtmgrid/services";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext } from "../context";
import { appRouter } from "../root";
import { createCallerFactory } from "../trpc";

const createCaller = createCallerFactory(appRouter);

// `enabledProviders` resolves no service (it is a pure env read), but the test
// context still needs a Layer; an empty `TestLayer` suffices, signed out.
const caller = () =>
  createCaller(createTestContext({ layer: TestLayer({}), userId: null }));

const PROVIDER_ENV = [
  "AUTH_GITHUB_ID",
  "AUTH_GITHUB_SECRET",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "AUTH_RESEND_KEY",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of PROVIDER_ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of PROVIDER_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("auth.enabledProviders", () => {
  it("reports everything off when no creds are configured", async () => {
    await expect(caller().auth.enabledProviders()).resolves.toEqual({
      github: false,
      google: false,
      emailAuth: false,
    });
  });

  it("enables a provider only when BOTH its id and secret are present", async () => {
    process.env.AUTH_GITHUB_ID = "gh-id";
    // Secret missing → still off (half-configured is treated as off).
    await expect(caller().auth.enabledProviders()).resolves.toMatchObject({
      github: false,
    });

    process.env.AUTH_GITHUB_SECRET = "gh-secret";
    await expect(caller().auth.enabledProviders()).resolves.toMatchObject({
      github: true,
    });
  });

  it("enables emailAuth when the Resend key is present", async () => {
    process.env.AUTH_RESEND_KEY = "re_test";
    await expect(caller().auth.enabledProviders()).resolves.toMatchObject({
      emailAuth: true,
    });
  });

  it("returns booleans only — never a secret value", async () => {
    process.env.AUTH_GOOGLE_ID = "g-id";
    process.env.AUTH_GOOGLE_SECRET = "g-secret";
    const result = await caller().auth.enabledProviders();
    expect(result).toEqual({ github: false, google: true, emailAuth: false });
    for (const value of Object.values(result)) {
      expect(typeof value).toBe("boolean");
    }
  });
});
