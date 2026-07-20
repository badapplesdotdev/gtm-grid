/**
 * `lib/webhook-resolve` — the webhook receivers' side of the secret-gated worker
 * boundary, run OFFLINE against a mocked `fetch`.
 *
 * This file closes a gap that was known and deliberately left open: the module
 * was extracted verbatim from a route that had no test, so it inherited none,
 * and the copy of the bearer-fetch contract it carried was UNVERIFIED while the
 * byte-identical copy in `lib/inngest/worker-client.ts` had eight tests. That is
 * the concrete cost of the duplication — not a hypothetical future drift, but
 * half of a live auth contract already unexercised.
 *
 * The HTTP contract itself (bearer, empty body, non-2xx, fails-closed, SITE_URL
 * fallback) is now owned and tested once via `lib/worker-call`. What is proved
 * HERE is the part this module actually owns: that each function calls the RIGHT
 * route with the RIGHT args, and narrows the response the way its callers assume.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveToken, slackTeamsForWorkspace } from "./webhook-resolve";

const SITE_URL = "https://app.gtmgrid.test";
const SECRET = "whk_secret_value";
const WS = "11111111-1111-1111-1111-111111111111";

function fetchReturning(status: number, body: string) {
  return vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    async () => new Response(body, { status, headers: { "Content-Type": "application/json" } }),
  );
}

const WEBHOOK = {
  webhookId: "wh_1",
  workspaceId: WS,
  tableId: "tbl_1",
  mapping: [],
  signingSecret: null,
  autoRun: true,
  mode: "create",
  upsertKey: null,
};

beforeEach(() => {
  process.env.SITE_URL = SITE_URL;
  process.env.WEBHOOK_WORKER_SECRET = SECRET;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resolveToken", () => {
  it("POSTs the token to /api/worker/resolveToken with the shared bearer", async () => {
    const f = fetchReturning(200, JSON.stringify(WEBHOOK));
    vi.stubGlobal("fetch", f);

    expect(await resolveToken("whk_abc")).toMatchObject({ webhookId: "wh_1", workspaceId: WS });

    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe(`${SITE_URL}/api/worker/resolveToken`);
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(String(init?.body))).toEqual({ token: "whk_abc" });
  });

  it("returns null for an UNKNOWN or DISABLED token (empty body), without throwing", async () => {
    // The route answers empty for both, so the receivers 404 identically and
    // cannot leak which of the two it was.
    vi.stubGlobal("fetch", fetchReturning(200, ""));
    expect(await resolveToken("whk_nope")).toBeNull();
  });

  it("returns null when the route answers a JSON null", async () => {
    vi.stubGlobal("fetch", fetchReturning(200, "null"));
    expect(await resolveToken("whk_nope")).toBeNull();
  });

  it("THROWS on a worker fault rather than resolving to null", async () => {
    // A 500 must not look like "unknown token": that would silently 404 every
    // event of a real webhook during an outage.
    vi.stubGlobal("fetch", fetchReturning(500, "boom"));
    await expect(resolveToken("whk_abc")).rejects.toThrow(/resolveToken failed: 500/);
  });

  it("fails closed when WEBHOOK_WORKER_SECRET is unset — no unauthenticated call", async () => {
    delete process.env.WEBHOOK_WORKER_SECRET;
    const f = fetchReturning(200, "{}");
    vi.stubGlobal("fetch", f);
    await expect(resolveToken("whk_abc")).rejects.toThrow(/WEBHOOK_WORKER_SECRET/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("slackTeamsForWorkspace", () => {
  it("POSTs the workspaceId to /api/worker/slackTeam and returns every team", async () => {
    const f = fetchReturning(200, JSON.stringify({ teamIds: ["T_ACME", "T_ACME_EU"] }));
    vi.stubGlobal("fetch", f);

    expect(await slackTeamsForWorkspace(WS)).toEqual(["T_ACME", "T_ACME_EU"]);

    const [url, init] = f.mock.calls[0] ?? [];
    expect(url).toBe(`${SITE_URL}/api/worker/slackTeam`);
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(String(init?.body))).toEqual({ workspaceId: WS });
  });

  it("returns an EMPTY list for no connection or a malformed body", async () => {
    // Empty is the fail-closed value: the caller tests membership, and
    // `[].includes(team)` is false, so an unreadable answer drops the event
    // rather than admitting it. A non-array `teamIds` must not slip through as
    // a truthy value either.
    for (const body of [
      "",
      "null",
      JSON.stringify({}),
      JSON.stringify({ teamIds: [] }),
      JSON.stringify({ teamIds: "T_ACME" }),
      '"nope"',
    ]) {
      vi.stubGlobal("fetch", fetchReturning(200, body));
      expect(await slackTeamsForWorkspace(WS)).toEqual([]);
    }
  });

  it("drops non-string and empty entries rather than passing them through", async () => {
    // An empty string would match a record whose `team` the receiver failed to
    // read, turning a malformed event into an accepted one.
    vi.stubGlobal(
      "fetch",
      fetchReturning(200, JSON.stringify({ teamIds: ["T_ACME", "", null, 7, "T_EU"] })),
    );
    expect(await slackTeamsForWorkspace(WS)).toEqual(["T_ACME", "T_EU"]);
  });

  it("never returns anything but team ids, even if the route leaked more", async () => {
    // Defence in depth: the receiver has no business holding a token, so even a
    // route regression that returned secrets must not hand them back.
    vi.stubGlobal(
      "fetch",
      fetchReturning(200, JSON.stringify({ teamIds: ["T_ACME"], accessToken: "xoxb-leaked" })),
    );
    expect(await slackTeamsForWorkspace(WS)).toEqual(["T_ACME"]);
  });
});
