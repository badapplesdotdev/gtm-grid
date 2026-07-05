/**
 * CrmSyncService wizard metadata — listSources / describeSource / estimate —
 * over the TestLayer with a URL-routed fake Attio. These feed the desktop
 * wizard's source picker, field list (samples + Recommended), match-key
 * suggestion, and the "Est. N records" footer.
 */

import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Membership } from "@gtmgrid/cloud";
import { TestLayer, type TestLayerFixtures } from "../layers.js";
import { CrmConnectionService } from "./crm-connection-service.js";
import { CrmSyncService } from "./crm-sync-service.js";

const WS = "11111111-1111-1111-1111-111111111111";
const memberships: readonly Membership[] = [{ workspaceId: WS, userId: "user_m", role: "member" }];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Fake Attio routed by URL substring (order-independent). */
function routeFetch(routes: Array<[match: string, body: () => unknown]>): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const hit = routes.find(([m]) => String(url).includes(m));
    if (!hit) throw new Error(`unrouted fetch: ${String(url)}`);
    return json(hit[1]());
  });
}

// Wizard reads are entitlement-gated, so the test workspace needs a live plan.
const fixtures = (): TestLayerFixtures => ({
  memberships,
  workspaces: [{ id: WS, name: "WS", ownerId: "user_m", currentPlanId: "team" }],
  currentUserId: "user_m",
});

/** Connect Attio, then run `use` against CrmSyncService. */
const withService = <A>(
  fx: TestLayerFixtures,
  use: (svc: Effect.Effect.Success<typeof CrmSyncService>) => Effect.Effect<A, unknown, never>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const connections = yield* CrmConnectionService;
      yield* connections.saveConnection({
        workspaceId: WS,
        provider: "attio",
        tokens: { accessToken: "at_test" },
        meta: {
          connectedByUserId: "user_m",
          connectedByName: "Morgan",
          crmWorkspaceId: "aw",
          crmWorkspaceName: "Acme",
        },
      });
      const svc = yield* CrmSyncService;
      return yield* use(svc);
    }).pipe(Effect.provide(TestLayer(fx))) as Effect.Effect<A, never, never>,
  );

beforeEach(() => {
  vi.stubEnv("ATTIO_CLIENT_ID", "client-123");
  vi.stubEnv("ATTIO_CLIENT_SECRET", "secret-456");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("listSources", () => {
  it("merges objects and lists into one picker feed", async () => {
    routeFetch([
      [
        "/v2/objects",
        () => ({
          data: [
            { id: { object_id: "o1" }, api_slug: "people", plural_noun: "People" },
            { id: { object_id: "o2" }, api_slug: "companies", plural_noun: "Companies" },
          ],
        }),
      ],
      [
        "/v2/lists",
        () => ({ data: [{ id: { list_id: "l1" }, name: "MQLs — Q3", parent_object: ["people"] }] }),
      ],
    ]);
    const sources = await withService(fixtures(), (svc) => svc.listSources(WS));
    expect(sources).toEqual([
      { kind: "object", id: "people", label: "People", parentObject: null },
      { kind: "object", id: "companies", label: "Companies", parentObject: null },
      { kind: "list", id: "l1", label: "MQLs — Q3", parentObject: "people" },
    ]);
  });

  it("rejects a non-member", async () => {
    routeFetch([["/v2/", () => ({ data: [] })]]);
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const svc = yield* CrmSyncService;
        return yield* svc.listSources(WS);
      }).pipe(Effect.provide(TestLayer({ memberships, currentUserId: "stranger" }))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("describeSource", () => {
  const PEOPLE_ATTRS = {
    data: [
      { api_slug: "name", title: "Name", type: "personal-name" },
      { api_slug: "email_addresses", title: "Email addresses", type: "email-address" },
      { api_slug: "phone_numbers", title: "Phone numbers", type: "phone-number" },
      // Unsupported type — must be EXCLUDED from the picker entirely.
      { api_slug: "interactions", title: "Interactions", type: "interaction" },
    ],
  };
  const SAMPLE_RECORDS = {
    data: [
      {
        id: { record_id: "r1" },
        values: {
          name: [{ full_name: "Sarah Chen" }],
          email_addresses: [{ email_address: "sarah@vercel.com" }],
          phone_numbers: [],
        },
      },
      {
        id: { record_id: "r2" },
        values: {
          name: [{ full_name: "Marcus Webb" }],
          email_addresses: [{ email_address: "m@stripe.com" }],
          phone_numbers: [{ phone_number: "+1 415 555 0142" }],
        },
      },
    ],
  };

  it("returns supported fields with samples, Recommended flags, and the match-key suggestion", async () => {
    routeFetch([
      ["/records/query", () => SAMPLE_RECORDS],
      ["/attributes", () => PEOPLE_ATTRS],
    ]);
    const desc = await withService(fixtures(), (svc) =>
      svc.describeSource(WS, { kind: "object", id: "people", label: "People" }),
    );
    expect(desc.fields.map((f) => f.slug)).toEqual(["name", "email_addresses", "phone_numbers"]);
    const name = desc.fields[0];
    expect(name.recommended).toBe(true); // curated slug + personal-name type
    expect(name.sample).toBe("Sarah Chen  ·  Marcus Webb");
    const email = desc.fields[1];
    expect(email.recommended).toBe(true); // email-address type
    expect(email.sample).toBe("sarah@vercel.com  ·  m@stripe.com");
    const phone = desc.fields[2];
    expect(phone.recommended).toBe(false); // neither curated slug nor favored type
    expect(phone.sample).toBe("+1 415 555 0142"); // empty first record skipped
    expect(desc.suggestedMatchKey).toBe("email_addresses");
  });

  it("suggests a domain match key when no email attribute exists (Companies)", async () => {
    routeFetch([
      ["/records/query", () => ({ data: [] })],
      [
        "/attributes",
        () => ({
          data: [
            { api_slug: "name", title: "Name", type: "text" },
            { api_slug: "domains", title: "Domains", type: "domain" },
          ],
        }),
      ],
    ]);
    const desc = await withService(fixtures(), (svc) =>
      svc.describeSource(WS, { kind: "object", id: "companies", label: "Companies" }),
    );
    expect(desc.suggestedMatchKey).toBe("domains");
  });

  it("a list source describes its PARENT object's attributes (via its entries)", async () => {
    routeFetch([
      [
        "/entries/query",
        () => ({
          data: [{ id: { entry_id: "e1" }, parent_object: "people", parent_record_id: "r1" }],
        }),
      ],
      ["/objects/people/records/query", () => ({ data: [] })],
      ["/attributes", () => PEOPLE_ATTRS],
    ]);
    const desc = await withService(fixtures(), (svc) =>
      svc.describeSource(WS, { kind: "list", id: "l1", label: "MQLs — Q3" }),
    );
    expect(desc.fields.map((f) => f.slug)).toContain("email_addresses");
  });
});

describe("estimate", () => {
  const record = (id: string, title: string) => ({
    id: { record_id: id },
    values: { job_title: [{ value: title }] },
  });

  it("applies worker-side filters to the probe page", async () => {
    routeFetch([
      [
        "/records/query",
        () => ({ data: [record("r1", "VP Engineering"), record("r2", "CFO"), record("r3", "VP Sales")] }),
      ],
    ]);
    const est = await withService(fixtures(), (svc) =>
      svc.estimate(WS, {
        kind: "object",
        id: "people",
        label: "People",
        filters: [{ attrSlug: "job_title", attrType: "text", op: "contains", value: "vp" }],
      }),
    );
    expect(est).toEqual({ count: 2, isLowerBound: false });
  });

  it("flags a lower bound when the probe page is full", async () => {
    routeFetch([
      ["/records/query", () => ({ data: Array.from({ length: 500 }, (_x, i) => record(`r${i}`, "VP")) })],
    ]);
    const est = await withService(fixtures(), (svc) =>
      svc.estimate(WS, { kind: "object", id: "people", label: "People", filters: [] }),
    );
    expect(est.count).toBe(500);
    expect(est.isLowerBound).toBe(true);
  });
});
