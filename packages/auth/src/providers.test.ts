import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  enabledProviders,
  githubEnabled,
  googleEnabled,
} from "./providers.js";

/**
 * Provider-enable gating AC (TRI-3244): a provider is enabled ONLY when its full
 * credential set is present; the accessor returns booleans only — no secrets
 * (ported from convex/auth.ts:46-69,153).
 */

const ENV_KEYS = [
  "AUTH_GITHUB_ID",
  "AUTH_GITHUB_SECRET",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "AUTH_RESEND_KEY",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("githubEnabled", () => {
  it("is false with no creds", () => {
    expect(githubEnabled()).toBe(false);
  });

  it("is false when only the id is set (half-configured = off)", () => {
    process.env.AUTH_GITHUB_ID = "id";
    expect(githubEnabled()).toBe(false);
  });

  it("is true only when BOTH id and secret are set", () => {
    process.env.AUTH_GITHUB_ID = "id";
    process.env.AUTH_GITHUB_SECRET = "secret";
    expect(githubEnabled()).toBe(true);
  });
});

describe("googleEnabled", () => {
  it("is false when only the secret is set", () => {
    process.env.AUTH_GOOGLE_SECRET = "secret";
    expect(googleEnabled()).toBe(false);
  });

  it("is true only when BOTH id and secret are set", () => {
    process.env.AUTH_GOOGLE_ID = "id";
    process.env.AUTH_GOOGLE_SECRET = "secret";
    expect(googleEnabled()).toBe(true);
  });
});

describe("enabledProviders", () => {
  it("is all-false with no env configured", () => {
    expect(enabledProviders()).toEqual({
      github: false,
      google: false,
      emailAuth: false,
    });
  });

  it("reflects each independently-gated flag", () => {
    process.env.AUTH_GITHUB_ID = "id";
    process.env.AUTH_GITHUB_SECRET = "secret";
    process.env.AUTH_RESEND_KEY = "re_key";
    expect(enabledProviders()).toEqual({
      github: true,
      google: false,
      emailAuth: true,
    });
  });

  it("exposes booleans only — no secret values leak", () => {
    process.env.AUTH_GITHUB_ID = "super-secret-id";
    process.env.AUTH_GITHUB_SECRET = "super-secret-secret";
    const result = enabledProviders();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("super-secret");
    for (const v of Object.values(result)) {
      expect(typeof v).toBe("boolean");
    }
  });
});
