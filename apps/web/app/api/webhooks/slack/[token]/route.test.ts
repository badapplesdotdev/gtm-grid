/**
 * `POST /api/webhooks/slack/[token]` — the TENANT GATE.
 *
 * This file exists because a valid Slack signature is NOT an authorisation
 * decision. Slack delivers every installation of an app to ONE app-global
 * Request URL, signed with ONE app-global signing secret, so a v0 signature
 * proves "Slack sent this on behalf of this APP" and nothing more. The route was
 * previously untested and shipped without comparing the event's team to the
 * webhook's workspace — which is exactly how the hole got in.
 *
 * The load-bearing case is `rejects a PERFECTLY SIGNED event from a FOREIGN
 * team`: it is signed correctly, in-window, and well-formed. Every check the
 * route had before this fix passes it.
 */

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const TOKEN = "wh_token_abc";
const OWN_TEAM = "T_ACME";
const FOREIGN_TEAM = "T_ATTACKER";

const sent = vi.hoisted(() => vi.fn(async () => ({ ids: [] })));
vi.mock("../../../../../lib/inngest/client", () => ({ inngest: { send: sent } }));
vi.mock("../../../../../lib/posthog-server", () => ({ captureServer: vi.fn() }));
vi.mock("../../../../../lib/rate-limit", () => ({
  rateLimit: () => ({ ok: true, retryAfter: 0 }),
  clientIp: () => "1.2.3.4",
}));

const resolveToken = vi.hoisted(() => vi.fn());
const slackTeamForWorkspace = vi.hoisted(() => vi.fn());
vi.mock("../../../../../lib/webhook-resolve", () => ({ resolveToken, slackTeamForWorkspace }));

const WEBHOOK = {
  webhookId: "wh_1",
  workspaceId: "11111111-1111-1111-1111-111111111111",
  tableId: "tbl_1",
  mapping: [],
  signingSecret: null,
  autoRun: true,
  mode: "create" as const,
  upsertKey: null,
};

const messageBody = (team: string) =>
  JSON.stringify({
    type: "event_callback",
    team_id: team,
    event_id: "Ev123",
    event: { type: "message", text: "hello", user: "U1", channel: "C1", ts: "1.2", team },
  });

/** Slack's documented recipe, by hand — not via the implementation. */
const sign = (ts: string, raw: string) =>
  `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${raw}`).digest("hex")}`;

const post = async (raw: string) => {
  const ts = String(Math.floor(Date.now() / 1000));
  const req = new Request(`https://www.gtmgrid.dev/api/webhooks/slack/${TOKEN}`, {
    method: "POST",
    body: raw,
    headers: { "X-Slack-Request-Timestamp": ts, "X-Slack-Signature": sign(ts, raw) },
  });
  return POST(req, { params: Promise.resolve({ token: TOKEN }) });
};

beforeEach(() => {
  vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
  resolveToken.mockResolvedValue(WEBHOOK);
  slackTeamForWorkspace.mockResolvedValue(OWN_TEAM);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("tenant gate", () => {
  it("accepts an event from the team this workspace is CONNECTED to", async () => {
    const res = await post(messageBody(OWN_TEAM));
    expect(res.status).toBe(200);
    expect(sent).toHaveBeenCalledOnce();
  });

  it("REJECTS a perfectly signed event from a FOREIGN team, and enqueues NOTHING", async () => {
    // The attack: install the app into your own Slack workspace. Slack signs
    // your messages with the app-global secret and delivers them to the
    // app-global Request URL — i.e. some tenant's token. Signature, timestamp
    // and body are all valid; only the team differs.
    const res = await post(messageBody(FOREIGN_TEAM));

    expect(res.status).toBe(200); // ACK — a non-2xx makes Slack retry, then disable us
    expect(await res.json()).toMatchObject({ ignored: "team-mismatch" });
    // The whole point: no row, and no auto-run enrichment spending the victim's
    // cloud actions on attacker-controlled input.
    expect(sent).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when the workspace has no Slack connection", async () => {
    slackTeamForWorkspace.mockResolvedValue(null);
    const res = await post(messageBody(OWN_TEAM));
    expect(await res.json()).toMatchObject({ ignored: "team-mismatch" });
    expect(sent).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when the event carries no team at all", async () => {
    const raw = JSON.stringify({
      type: "event_callback",
      event_id: "Ev123",
      event: { type: "message", text: "hi", user: "U1", channel: "C1", ts: "1.2" },
    });
    const res = await post(raw);
    expect(await res.json()).toMatchObject({ ignored: "team-mismatch" });
    expect(sent).not.toHaveBeenCalled();
  });

  it("does not consult the team for the url_verification handshake", async () => {
    // The handshake arrives before any connection exists, and carries no team.
    const res = await post(JSON.stringify({ type: "url_verification", challenge: "c123" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ challenge: "c123" });
    expect(slackTeamForWorkspace).not.toHaveBeenCalled();
  });
});

describe("signature gate (unchanged by the tenant gate)", () => {
  it("rejects a bad signature with 401 and never resolves the token", async () => {
    const raw = messageBody(OWN_TEAM);
    const req = new Request(`https://www.gtmgrid.dev/api/webhooks/slack/${TOKEN}`, {
      method: "POST",
      body: raw,
      headers: {
        "X-Slack-Request-Timestamp": String(Math.floor(Date.now() / 1000)),
        "X-Slack-Signature": "v0=deadbeef",
      },
    });
    const res = await POST(req, { params: Promise.resolve({ token: TOKEN }) });
    expect(res.status).toBe(401);
    expect(resolveToken).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
  });
});
