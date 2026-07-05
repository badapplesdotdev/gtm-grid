/**
 * AttioClient over a scripted fake fetch: response parsing, the
 * refresh-on-401-once policy, transient retry, and the $in-fallback for
 * fetching records by id. No live HTTP; no real backoff beyond one retry.
 */

import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttioAuth, type AttioTokens } from "./attio-auth.js";
import { AttioClient, type AttioSession } from "./attio-client.js";

type Scripted = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** Install a fetch that consumes `steps` in order (repeating the last one). */
function scriptFetch(steps: Scripted[]): Array<{ url: string; auth: string; body: string }> {
  const calls: Array<{ url: string; auth: string; body: string }> = [];
  let i = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), auth: headers.authorization ?? "", body: String(init?.body ?? "") });
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return step(String(url), init);
  });
  return calls;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const layer = AttioClient.Default.pipe(Layer.provide(AttioAuth.Default));

const run = <A, E>(effect: Effect.Effect<A, E, AttioClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>);

const runExit = <A, E>(effect: Effect.Effect<A, E, AttioClient>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>);

const failureTag = (exit: Awaited<ReturnType<typeof runExit>>): string => {
  if (exit._tag !== "Failure") return "none";
  const m = JSON.stringify(exit.cause).match(/"_tag":"(Attio[A-Za-z]+|CrmSyncError|CrmConnectionMissing)"/);
  return m?.[1] ?? "unknown";
};

function session(tokens: AttioTokens): { session: AttioSession; persisted: AttioTokens[] } {
  const persisted: AttioTokens[] = [];
  return {
    persisted,
    session: {
      workspaceId: "11111111-1111-1111-1111-111111111111",
      tokens,
      persist: (t) =>
        Effect.sync(() => {
          persisted.push(t);
        }),
    },
  };
}

beforeEach(() => {
  vi.stubEnv("ATTIO_CLIENT_ID", "client-123");
  vi.stubEnv("ATTIO_CLIENT_SECRET", "secret-456");
  vi.stubEnv("SITE_URL", "https://www.gtmgrid.dev");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("parsing", () => {
  it("listObjects maps slugs + plural labels", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    const calls = scriptFetch([
      () =>
        json({
          data: [
            { id: { object_id: "obj_1" }, api_slug: "people", plural_noun: "People" },
            { id: { object_id: "obj_2" }, api_slug: "companies", plural_noun: "Companies" },
          ],
        }),
    ]);
    const objects = await run(Effect.flatMap(AttioClient, (c) => c.listObjects(s)));
    expect(objects).toEqual([
      { slug: "people", label: "People" },
      { slug: "companies", label: "Companies" },
    ]);
    expect(calls[0].url).toBe("https://api.attio.com/v2/objects");
    expect(calls[0].auth).toBe("Bearer at_1");
  });

  it("getAttributes marks unsupported types", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    scriptFetch([
      () =>
        json({
          data: [
            { api_slug: "email_addresses", title: "Email addresses", type: "email-address" },
            { api_slug: "interactions", title: "Interactions", type: "interaction" },
          ],
        }),
    ]);
    const attrs = await run(Effect.flatMap(AttioClient, (c) => c.getAttributes(s, "objects", "people", "People")));
    expect(attrs).toEqual([
      { slug: "email_addresses", title: "Email addresses", type: "email-address", supported: true },
      { slug: "interactions", title: "Interactions", type: "interaction", supported: false },
    ]);
  });

  it("queryObjectRecords extracts record ids + value arrays", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    const calls = scriptFetch([
      () =>
        json({
          data: [
            { id: { record_id: "rec_1" }, values: { name: [{ value: "Vercel" }], junk: "not-an-array" } },
          ],
        }),
    ]);
    const records = await run(
      Effect.flatMap(AttioClient, (c) =>
        c.queryObjectRecords(s, { object: "companies", sourceLabel: "Companies", limit: 500, offset: 0 }),
      ),
    );
    expect(records).toEqual([{ recordId: "rec_1", values: { name: [{ value: "Vercel" }], junk: [] } }]);
    expect(JSON.parse(calls[0].body)).toEqual({ limit: 500, offset: 0 });
  });
});

describe("refresh-on-401", () => {
  it("401 → refresh once → persist merged tokens → replay with the new token", async () => {
    const { session: s, persisted } = session({ accessToken: "at_old", refreshToken: "rt_1" });
    const calls = scriptFetch([
      () => json({}, 401), // first attempt
      () => json({ access_token: "at_new" }), // token endpoint (no rotated refresh)
      () => json({ data: [] }), // replay
    ]);
    const result = await run(Effect.flatMap(AttioClient, (c) => c.listObjects(s)));
    expect(result).toEqual([]);
    expect(calls[1].url).toBe("https://app.attio.com/oauth/token");
    expect(calls[2].auth).toBe("Bearer at_new");
    // Old refresh token survives when Attio doesn't return a new one.
    expect(persisted).toEqual([{ accessToken: "at_new", refreshToken: "rt_1" }]);
  });

  it("401 with no refresh token → AttioAuthRevoked without touching the token endpoint", async () => {
    const { session: s } = session({ accessToken: "at_old" });
    const calls = scriptFetch([() => json({}, 401)]);
    const exit = await runExit(Effect.flatMap(AttioClient, (c) => c.listObjects(s)));
    expect(failureTag(exit)).toBe("AttioAuthRevoked");
    expect(calls).toHaveLength(1);
  });

  it("401 → refresh refused → AttioAuthRevoked", async () => {
    const { session: s } = session({ accessToken: "at_old", refreshToken: "rt_dead" });
    scriptFetch([() => json({}, 401), () => json({ error: "invalid_grant" }, 400)]);
    const exit = await runExit(Effect.flatMap(AttioClient, (c) => c.listObjects(s)));
    expect(failureTag(exit)).toBe("AttioAuthRevoked");
  });

  it("401 → refresh ok → still 401 → AttioAuthRevoked (never loops)", async () => {
    const { session: s } = session({ accessToken: "at_old", refreshToken: "rt_1" });
    const calls = scriptFetch([
      () => json({}, 401),
      () => json({ access_token: "at_new" }),
      () => json({}, 401),
    ]);
    const exit = await runExit(Effect.flatMap(AttioClient, (c) => c.listObjects(s)));
    expect(failureTag(exit)).toBe("AttioAuthRevoked");
    expect(calls).toHaveLength(3);
  });
});

describe("failure mapping + retry", () => {
  it("one 429 is retried and then succeeds", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    const calls = scriptFetch([
      () => new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
      () => json({ data: [] }),
    ]);
    const result = await run(Effect.flatMap(AttioClient, (c) => c.listObjects(s)));
    expect(result).toEqual([]);
    expect(calls).toHaveLength(2);
  }, 15_000);

  it("a 400 is AttioRequestError immediately (no retry)", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    const calls = scriptFetch([() => new Response("bad filter", { status: 400 })]);
    const exit = await runExit(
      Effect.flatMap(AttioClient, (c) =>
        c.queryObjectRecords(s, { object: "people", sourceLabel: "People", limit: 10, offset: 0 }),
      ),
    );
    expect(failureTag(exit)).toBe("AttioRequestError");
    expect(calls).toHaveLength(1);
  });

  it("a 404 on a source becomes AttioSourceGoneError carrying the label", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    scriptFetch([() => new Response("gone", { status: 404 })]);
    const exit = await runExit(
      Effect.flatMap(AttioClient, (c) =>
        c.queryObjectRecords(s, { object: "people", sourceLabel: "MQLs — Q3", limit: 10, offset: 0 }),
      ),
    );
    expect(failureTag(exit)).toBe("AttioSourceGoneError");
    expect(JSON.stringify(exit)).toContain("MQLs — Q3");
  });
});

describe("queryRecordsByIds", () => {
  it("uses one bulk $in query when Attio accepts it", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    const calls = scriptFetch([
      () => json({ data: [{ id: { record_id: "rec_1" }, values: {} }, { id: { record_id: "rec_2" }, values: {} }] }),
    ]);
    const records = await run(
      Effect.flatMap(AttioClient, (c) =>
        c.queryRecordsByIds(s, { object: "companies", sourceLabel: "Companies", ids: ["rec_1", "rec_2"] }),
      ),
    );
    expect(records.map((r) => r.recordId)).toEqual(["rec_1", "rec_2"]);
    expect(JSON.parse(calls[0].body).filter).toEqual({ record_id: { $in: ["rec_1", "rec_2"] } });
  });

  it("falls back to individual GETs when the $in filter is rejected", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    const calls = scriptFetch([
      () => new Response("unknown filter", { status: 400 }),
      (url) =>
        url.endsWith("/rec_1")
          ? json({ data: { id: { record_id: "rec_1" }, values: {} } })
          : json({ data: { id: { record_id: "rec_2" }, values: {} } }),
    ]);
    const records = await run(
      Effect.flatMap(AttioClient, (c) =>
        c.queryRecordsByIds(s, { object: "companies", sourceLabel: "Companies", ids: ["rec_1", "rec_2"] }),
      ),
    );
    expect(records.map((r) => r.recordId).sort()).toEqual(["rec_1", "rec_2"]);
    expect(calls.length).toBe(3);
    expect(calls[1].url).toContain("/v2/objects/companies/records/");
  });

  it("resolveRecordNames flattens personal names and plain names", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    scriptFetch([
      () =>
        json({
          data: [
            { id: { record_id: "rec_p" }, values: { name: [{ full_name: "Sarah Chen" }] } },
            { id: { record_id: "rec_c" }, values: { name: [{ value: "Vercel" }] } },
          ],
        }),
    ]);
    const names = await run(
      Effect.flatMap(AttioClient, (c) => c.resolveRecordNames(s, { object: "companies", ids: ["rec_p", "rec_c"] })),
    );
    expect(names.get("rec_p")).toBe("Sarah Chen");
    expect(names.get("rec_c")).toBe("Vercel");
  });

  it("empty ids short-circuit without HTTP", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    const calls = scriptFetch([() => json({ data: [] })]);
    const records = await run(
      Effect.flatMap(AttioClient, (c) => c.queryRecordsByIds(s, { object: "companies", sourceLabel: "x", ids: [] })),
    );
    expect(records).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
