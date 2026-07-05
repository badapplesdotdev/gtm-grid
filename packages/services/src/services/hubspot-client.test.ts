/**
 * HubspotClient over a scripted fake fetch: cursor paging (`after`), the
 * search-vs-plain-paging split, batch/read hydration + name resolution,
 * owners pagination, 429 Retry-After mapping, and the refresh-on-401
 * backstop. No live HTTP.
 */

import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CrmSession, CrmTokens } from "./crm-client.js";
import { HubspotAuth } from "./hubspot-auth.js";
import { HubspotClient } from "./hubspot-client.js";

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

const layer = HubspotClient.Default.pipe(Layer.provide(HubspotAuth.Default));

const run = <A, E>(effect: Effect.Effect<A, E, HubspotClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>);

const runExit = <A, E>(effect: Effect.Effect<A, E, HubspotClient>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>);

const failureTag = (exit: Awaited<ReturnType<typeof runExit>>): string => {
  if (exit._tag !== "Failure") return "none";
  const m = JSON.stringify(exit.cause).match(/"_tag":"(Crm[A-Za-z]+|RowCapReached)"/);
  return m?.[1] ?? "unknown";
};

function session(tokens: CrmTokens): { session: CrmSession; persisted: CrmTokens[] } {
  const persisted: CrmTokens[] = [];
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const ATTRS = [
  { slug: "firstname", type: "text" },
  { slug: "email", type: "email-address" },
  { slug: "hs_lead_status", type: "select" },
] as const;

describe("queryObjectRecords — plain cursor paging", () => {
  it("GETs the objects endpoint with properties + after, pre-flattening values", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    const calls = scriptFetch([
      () =>
        json({
          results: [
            { id: "101", properties: { firstname: "Sarah", email: "sarah@acme.dev", hs_lead_status: "NEW;OPEN" } },
          ],
          paging: { next: { after: "cursor-2" } },
        }),
    ]);
    const page = await run(
      Effect.flatMap(HubspotClient, (c) =>
        c.queryObjectRecords(s, {
          object: "contacts",
          sourceLabel: "Contacts",
          attrs: [...ATTRS],
          limit: 100,
          cursor: null,
        }),
      ),
    );
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/crm/v3/objects/contacts");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("properties")).toBe("firstname,email,hs_lead_status");
    expect(url.searchParams.get("after")).toBeNull();
    expect(page.items).toEqual([
      {
        recordId: "101",
        values: {
          firstname: { kind: "text", text: "Sarah" },
          email: { kind: "text", text: "sarah@acme.dev" },
          hs_lead_status: { kind: "text", text: "NEW, OPEN" },
        },
      },
    ]);
    expect(page.nextCursor).toBe("cursor-2");
  });

  it("passes the cursor through and reports exhaustion as nextCursor null", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    const calls = scriptFetch([() => json({ results: [] })]);
    const page = await run(
      Effect.flatMap(HubspotClient, (c) =>
        c.queryObjectRecords(s, { object: "contacts", sourceLabel: "Contacts", attrs: [], limit: 100, cursor: "cursor-2" }),
      ),
    );
    expect(new URL(calls[0].url).searchParams.get("after")).toBe("cursor-2");
    expect(page.nextCursor).toBeNull();
  });

  it("a compiled prefilter switches to the search endpoint", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    const calls = scriptFetch([() => json({ results: [] })]);
    const filter = { filterGroups: [{ filters: [{ propertyName: "lifecyclestage", operator: "EQ", value: "customer" }] }] };
    await run(
      Effect.flatMap(HubspotClient, (c) =>
        c.queryObjectRecords(s, { object: "contacts", sourceLabel: "Contacts", attrs: [], filter, limit: 100, cursor: null }),
      ),
    );
    expect(calls[0].url).toBe("https://api.hubapi.com/crm/v3/objects/contacts/search");
    expect(JSON.parse(calls[0].body).filterGroups).toEqual(filter.filterGroups);
  });

  it("a 404 on the source becomes CrmSourceGoneError carrying the label", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    scriptFetch([() => new Response("not found", { status: 404 })]);
    const exit = await runExit(
      Effect.flatMap(HubspotClient, (c) =>
        c.queryObjectRecords(s, { object: "contacts", sourceLabel: "Customers", attrs: [], limit: 100, cursor: null }),
      ),
    );
    expect(failureTag(exit)).toBe("CrmSourceGoneError");
    expect(JSON.stringify(exit)).toContain("Customers");
  });
});

describe("lists — memberships with the parent object resolved once", () => {
  it("resolves the list's objectTypeId, then pages memberships (parent cached)", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    const calls = scriptFetch([
      () => json({ list: { listId: "7", objectTypeId: "0-1" } }),
      () => json({ results: [{ recordId: "201" }, { recordId: "202" }], paging: { next: { after: "m2" } } }),
      () => json({ results: [{ recordId: "203" }] }),
    ]);
    // Both pages in ONE program: the parent memo is per service instance
    // (process-lifetime in production), and each run() builds a fresh layer.
    const { first, second } = await run(
      Effect.gen(function* () {
        const c = yield* HubspotClient;
        const a = yield* c.queryListEntries(s, { listId: "7", sourceLabel: "MQLs", limit: 100, cursor: null });
        const b = yield* c.queryListEntries(s, { listId: "7", sourceLabel: "MQLs", limit: 100, cursor: "m2" });
        return { first: a, second: b };
      }),
    );
    expect(first.items).toEqual([
      { entryId: "201", parentObject: "contacts", parentRecordId: "201" },
      { entryId: "202", parentObject: "contacts", parentRecordId: "202" },
    ]);
    expect(first.nextCursor).toBe("m2");
    expect(second.items[0]?.parentRecordId).toBe("203");
    expect(second.nextCursor).toBeNull();
    // 1 list-detail + 2 membership pages — the parent lookup is memoized.
    expect(calls.filter((c) => !c.url.includes("memberships"))).toHaveLength(1);
  });
});

describe("batch reads", () => {
  it("queryRecordsByIds batch-reads with the requested properties", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    const calls = scriptFetch([
      () => json({ results: [{ id: "201", properties: { firstname: "Priya", email: "priya@figma.com", hs_lead_status: null } }] }),
    ]);
    const records = await run(
      Effect.flatMap(HubspotClient, (c) =>
        c.queryRecordsByIds(s, { object: "contacts", sourceLabel: "MQLs", attrs: [...ATTRS], ids: ["201"] }),
      ),
    );
    expect(calls[0].url).toBe("https://api.hubapi.com/crm/v3/objects/contacts/batch/read");
    expect(JSON.parse(calls[0].body)).toEqual({
      properties: ["firstname", "email", "hs_lead_status"],
      inputs: [{ id: "201" }],
    });
    expect(records[0]?.values.hs_lead_status).toEqual({ kind: "text", text: "" });
  });

  it("self-chunks id sets beyond the 100-input batch limit", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    const calls = scriptFetch([() => json({ results: [] })]);
    const ids = Array.from({ length: 150 }, (_v, i) => String(i));
    await run(
      Effect.flatMap(HubspotClient, (c) =>
        c.queryRecordsByIds(s, { object: "contacts", sourceLabel: "Contacts", attrs: [], ids }),
      ),
    );
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0].body).inputs).toHaveLength(100);
    expect(JSON.parse(calls[1].body).inputs).toHaveLength(50);
  });

  it("resolveRecordNames joins contact first+last (email fallback) and company name", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    scriptFetch([
      () =>
        json({
          results: [
            { id: "201", properties: { firstname: "Sarah", lastname: "Chen", email: "s@acme.dev" } },
            { id: "202", properties: { firstname: null, lastname: null, email: "anon@acme.dev" } },
          ],
        }),
    ]);
    const names = await run(
      Effect.flatMap(HubspotClient, (c) => c.resolveRecordNames(s, { object: "contacts", ids: ["201", "202"] })),
    );
    expect(names.get("201")).toBe("Sarah Chen");
    expect(names.get("202")).toBe("anon@acme.dev");
  });
});

describe("owners", () => {
  it("paginates all owners into an id → name map", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    scriptFetch([
      () => json({ results: [{ id: "9", firstName: "Morgan", lastName: "Parry" }], paging: { next: { after: "o2" } } }),
      () => json({ results: [{ id: "10", firstName: "", lastName: "", email: "ops@acme.dev" }] }),
    ]);
    const members = await run(Effect.flatMap(HubspotClient, (c) => c.listMembers(s)));
    expect(members.get("9")).toBe("Morgan Parry");
    expect(members.get("10")).toBe("ops@acme.dev");
  });
});

describe("failure mapping + auth", () => {
  it("a 429 honors Retry-After into CrmRateLimitError after retries exhaust", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    scriptFetch([() => new Response("slow down", { status: 429, headers: { "retry-after": "7" } })]);
    const exit = await runExit(Effect.flatMap(HubspotClient, (c) => c.listLists(s)));
    expect(failureTag(exit)).toBe("CrmRateLimitError");
    expect(JSON.stringify(exit)).toContain("7000");
  }, 30_000);

  it("401 → refresh once via the token endpoint → persist → replay", async () => {
    vi.stubEnv("HUBSPOT_CLIENT_ID", "hs-client-123");
    vi.stubEnv("HUBSPOT_CLIENT_SECRET", "hs-secret-456");
    const { session: s, persisted } = session({ accessToken: "at_old", refreshToken: "rt_1" });
    const calls = scriptFetch([
      () => json({}, 401),
      () => json({ access_token: "at_new", expires_in: 1800 }),
      () => json({ lists: [{ listId: "7", name: "MQLs", objectTypeId: "0-1" }] }),
    ]);
    const lists = await run(Effect.flatMap(HubspotClient, (c) => c.listLists(s)));
    expect(calls[1].url).toBe("https://api.hubapi.com/oauth/v1/token");
    expect(calls[2].auth).toBe("Bearer at_new");
    // The old refresh token survives (HubSpot doesn't rotate it).
    expect(persisted[0]?.refreshToken).toBe("rt_1");
    expect(lists).toEqual([{ id: "7", name: "MQLs", parentObject: "contacts" }]);
  });

  it("deal/custom-object lists are filtered out of listLists (v1 scope)", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    scriptFetch([
      () =>
        json({
          lists: [
            { listId: "1", name: "Customers", objectTypeId: "0-2" },
            { listId: "2", name: "Big deals", objectTypeId: "0-3" },
          ],
        }),
    ]);
    const lists = await run(Effect.flatMap(HubspotClient, (c) => c.listLists(s)));
    expect(lists).toEqual([{ id: "1", name: "Customers", parentObject: "companies" }]);
  });

  it("getAttributes maps property metadata into the neutral vocabulary (hidden props dropped)", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    scriptFetch([
      () =>
        json({
          results: [
            { name: "email", label: "Email", type: "string", fieldType: "text" },
            { name: "hubspot_owner_id", label: "Contact owner", type: "enumeration", fieldType: "select", referencedObjectType: "OWNER" },
            { name: "hs_internal", label: "Internal", type: "string", fieldType: "text", hidden: true },
            { name: "hs_geo", label: "Coordinates", type: "object_coordinates", fieldType: "text" },
          ],
        }),
    ]);
    const attrs = await run(
      Effect.flatMap(HubspotClient, (c) => c.getAttributes(s, "objects", "contacts", "Contacts")),
    );
    expect(attrs).toEqual([
      { slug: "email", title: "Email", type: "email-address", supported: true },
      { slug: "hubspot_owner_id", title: "Contact owner", type: "actor-reference", supported: true },
      { slug: "hs_geo", title: "Coordinates", type: "object_coordinates", supported: false },
    ]);
  });

  it("list attributes are the parent object's — the lists target is empty", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    scriptFetch([() => json({})]);
    const attrs = await run(Effect.flatMap(HubspotClient, (c) => c.getAttributes(s, "lists", "7", "MQLs")));
    expect(attrs).toEqual([]);
  });

  it("identifySelf reads the portal from token introspection", async () => {
    const { session: s } = session({ accessToken: "at_1" });
    const calls = scriptFetch([() => json({ hub_id: 424242, hub_domain: "acme.hubspot.com" })]);
    const self = await run(Effect.flatMap(HubspotClient, (c) => c.identifySelf(s)));
    expect(calls[0].url).toBe("https://api.hubapi.com/oauth/v1/access-tokens/at_1");
    expect(self).toEqual({ workspaceId: "424242", workspaceName: "acme.hubspot.com" });
  });
});
