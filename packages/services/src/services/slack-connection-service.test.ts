/**
 * SlackConnectionService: the tokens+meta <-> SecretMap round trip.
 *
 * `toSecrets`/`parseConnection` are pure, so they are tested directly. The
 * interesting cases are the lossy ones: `SecretMap` is `Record<string, string>`,
 * so `expiresAtMs` survives as a STRING and every read has to parse it back.
 * Getting that wrong is silent — a `NaN` expiry compares false against every
 * bound, so the token would either never refresh or refresh on every read.
 */

import { describe, expect, it } from "vitest";
import { parseConnection, SLACK_CONNECTION_SLOT, toSecrets } from "./slack-connection-service.js";

const META = {
  connectedByUserId: "user_1",
  connectedByName: "Morgan",
  teamId: "T123",
  teamName: "Trigify GTM",
  botUserId: "U456",
};

describe("the credential slot", () => {
  it("is bare 'slack' — it MUST equal the connector id in extensions/slack.json", () => {
    // The engine resolves a connector's credential by connector id. If this ever
    // becomes "slack-crm" (mirroring crmConnectionSlot), every sdk.slack.* call
    // silently finds no credential and reports "not connected".
    expect(SLACK_CONNECTION_SLOT).toBe("slack");
  });
});

describe("round trip", () => {
  it("preserves tokens and meta", () => {
    const tokens = { accessToken: "xoxe.xoxb-1", refreshToken: "xoxe-1-r", expiresAtMs: 1_800_000_000_000 };
    const parsed = parseConnection(toSecrets(tokens, META));
    expect(parsed?.tokens.accessToken).toBe("xoxe.xoxb-1");
    expect(parsed?.tokens.refreshToken).toBe("xoxe-1-r");
    expect(parsed?.tokens.expiresAtMs).toBe(1_800_000_000_000);
    expect(parsed?.meta).toEqual(META);
  });

  it("carries team/bot ids into tokens.extra, where the refresh merge preserves them", () => {
    const parsed = parseConnection(toSecrets({ accessToken: "at" }, META));
    expect(parsed?.tokens.extra).toEqual({ teamId: "T123", teamName: "Trigify GTM", botUserId: "U456" });
  });

  it("expiresAtMs survives the string round trip as a NUMBER", () => {
    const secrets = toSecrets({ accessToken: "at", expiresAtMs: 1_800_000_000_000 }, META);
    // Pin the lossy step explicitly: the envelope stores strings only.
    expect(secrets.expiresAtMs).toBe("1800000000000");
    expect(parseConnection(secrets)?.tokens.expiresAtMs).toBe(1_800_000_000_000);
  });

  it("omits refreshToken and expiresAtMs when absent (rotation off = non-expiring token)", () => {
    const secrets = toSecrets({ accessToken: "xoxb-plain" }, META);
    expect(secrets.refreshToken).toBeUndefined();
    expect(secrets.expiresAtMs).toBeUndefined();
    const parsed = parseConnection(secrets);
    expect(parsed?.tokens.refreshToken).toBeUndefined();
    expect(parsed?.tokens.expiresAtMs).toBeUndefined();
  });
});

describe("parseConnection is total", () => {
  it("returns null when there is no usable access token", () => {
    expect(parseConnection({})).toBeNull();
    expect(parseConnection({ accessToken: "" })).toBeNull();
  });

  it("drops a CORRUPT expiry rather than yielding NaN", () => {
    // NaN compares false against every bound, so a NaN expiry would make
    // needsRefresh answer "no" forever — a dead token nobody ever renews.
    // Absent is the honest answer: no known expiry, fall back to the 401 path.
    expect(parseConnection({ accessToken: "at", expiresAtMs: "not-a-number" })?.tokens.expiresAtMs).toBeUndefined();
    expect(parseConnection({ accessToken: "at", expiresAtMs: "-1" })?.tokens.expiresAtMs).toBeUndefined();
  });

  it("defaults missing meta to empty strings rather than throwing", () => {
    const parsed = parseConnection({ accessToken: "at" });
    expect(parsed?.meta).toEqual({
      connectedByUserId: "",
      connectedByName: "",
      teamId: "",
      teamName: "",
      botUserId: "",
    });
  });
});
