/**
 * Unsubscribe-token suite: mint/verify round-trip, tamper rejection, category
 * whitelist, and the no-secret degradation (mint → null so the guard refuses
 * non-transactional sends rather than shipping a dead opt-out link).
 *
 * The secret comes from env (`EMAIL_UNSUBSCRIBE_SECRET` → `BETTER_AUTH_SECRET`
 * fallback), so each case pins the env explicitly and restores it after.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  mintUnsubscribeToken,
  unsubscribeUrl,
  verifyUnsubscribeToken,
} from "./unsubscribe-token";

const ENV_KEYS = [
  "EMAIL_UNSUBSCRIBE_SECRET",
  "BETTER_AUTH_SECRET",
  "SITE_URL",
] as const;
const saved = new Map<string, string | undefined>();
for (const k of ENV_KEYS) saved.set(k, process.env[k]);

function setEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const k of ENV_KEYS) {
    const v = env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("mint + verify", () => {
  it("round-trips (userId, category) through a signed token", () => {
    setEnv({ EMAIL_UNSUBSCRIBE_SECRET: "s3cret" });
    const token = mintUnsubscribeToken("user_42", "digest");
    expect(token).toBeTruthy();
    expect(verifyUnsubscribeToken(token as string)).toEqual({
      userId: "user_42",
      category: "digest",
    });
  });

  it("falls back to BETTER_AUTH_SECRET when the dedicated secret is unset", () => {
    setEnv({ BETTER_AUTH_SECRET: "auth-secret" });
    const token = mintUnsubscribeToken("user_42", "activation");
    expect(verifyUnsubscribeToken(token as string)).toEqual({
      userId: "user_42",
      category: "activation",
    });
  });

  it("returns null from mint when NO secret is configured (guard refuses the send)", () => {
    setEnv({});
    expect(mintUnsubscribeToken("user_42", "digest")).toBeNull();
    expect(unsubscribeUrl("user_42", "digest")).toBeNull();
  });
});

describe("verify — rejection paths", () => {
  it("rejects a tampered payload (userId swapped after signing)", () => {
    setEnv({ EMAIL_UNSUBSCRIBE_SECRET: "s3cret" });
    const token = mintUnsubscribeToken("user_42", "digest") as string;
    const [, mac] = token.split(".");
    const forgedBody = Buffer.from("user_43\ndigest", "utf8").toString("base64url");
    expect(verifyUnsubscribeToken(`${forgedBody}.${mac}`)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    setEnv({ EMAIL_UNSUBSCRIBE_SECRET: "s3cret" });
    const token = mintUnsubscribeToken("user_42", "digest") as string;
    const [body] = token.split(".");
    expect(verifyUnsubscribeToken(`${body}.AAAA`)).toBeNull();
  });

  it("rejects a token minted with a DIFFERENT secret", () => {
    setEnv({ EMAIL_UNSUBSCRIBE_SECRET: "old-secret" });
    const token = mintUnsubscribeToken("user_42", "digest") as string;
    setEnv({ EMAIL_UNSUBSCRIBE_SECRET: "new-secret" });
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it("rejects garbage and structurally invalid tokens", () => {
    setEnv({ EMAIL_UNSUBSCRIBE_SECRET: "s3cret" });
    for (const bad of ["", "no-dot", "a.b.c", "..", "%%%.%%%"]) {
      expect(verifyUnsubscribeToken(bad)).toBeNull();
    }
  });

  it("rejects a signed token whose category is not a real lifecycle category", () => {
    setEnv({ EMAIL_UNSUBSCRIBE_SECRET: "s3cret" });
    // Forge a correctly-signed token for a bogus category via the real signer:
    // mint for a valid category, then rebuild the payload — the MAC no longer
    // matches, so this ALSO exercises the tamper path; additionally verify a
    // directly-signed bogus payload is rejected by the category whitelist.
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const payload = "user_42\nmarketing-blast";
    const body = Buffer.from(payload, "utf8").toString("base64url");
    const mac = createHmac("sha256", "s3cret").update(payload).digest("base64url");
    expect(verifyUnsubscribeToken(`${body}.${mac}`)).toBeNull();
  });

  it("returns null when verifying with no secret configured", () => {
    setEnv({ EMAIL_UNSUBSCRIBE_SECRET: "s3cret" });
    const token = mintUnsubscribeToken("user_42", "digest") as string;
    setEnv({});
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });
});

describe("unsubscribeUrl", () => {
  it("builds an absolute URL on SITE_URL with the encoded token", () => {
    setEnv({ EMAIL_UNSUBSCRIBE_SECRET: "s3cret", SITE_URL: "https://app.example" });
    const url = unsubscribeUrl("user_42", "status");
    expect(url).toMatch(/^https:\/\/app\.example\/email\/unsubscribe\?token=/);
    const token = decodeURIComponent((url as string).split("token=")[1] ?? "");
    expect(verifyUnsubscribeToken(token)).toEqual({
      userId: "user_42",
      category: "status",
    });
  });
});
