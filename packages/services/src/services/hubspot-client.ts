/**
 * `HubspotClient` — every HTTP call GTM Grid makes to api.hubapi.com (TRI:
 * crm-sync). Implements the provider-neutral {@link CrmClientApi}: HubSpot's
 * flat property strings are flattened to `FlatValue`s here and paging is the
 * native `after` cursor passed through opaquely.
 *
 * HubSpot specifics vs the Attio client:
 * - v1 exposes CONTACTS + COMPANIES (plus v3 lists over both) — `listObjects`
 *   is static, not discovered.
 * - Batch reads (`/batch/read`, ≤100 ids) hydrate list memberships and
 *   resolve reference names — no per-record GET fallback needed.
 * - Rate limits are per-app+portal bursts (≈100 req/10s): 429s honor
 *   `Retry-After` inside the same jittered transient retry policy.
 * - Access tokens expire (~30 min): proactive refresh happens at session
 *   mint (CrmConnectionService); the refresh-on-401 here is the backstop.
 *
 * Read-only by design: nothing here can write to a user's CRM.
 */

import { Effect, Schedule } from "effect";
import {
  CrmAuthRevoked,
  CrmNetworkError,
  CrmRateLimitError,
  CrmRequestError,
  CrmServerError,
  CrmSourceGoneError,
  CrmSyncError,
  isTransientCrmError,
  type CrmError,
} from "../crm/errors.js";
import {
  flattenHubspotValue,
  mapHubspotPropertyType,
  toHubspotSearchBody,
} from "../crm/hubspot-attributes.js";
import type { CrmAttrType, CrmFilter, FlatValue } from "../crm/crm-values.js";
import { isSupportedAttrType } from "../crm/crm-values.js";
import type {
  CrmAttrRef,
  CrmAttribute,
  CrmListEntry,
  CrmListSummary,
  CrmObjectSummary,
  CrmPage,
  CrmRecord,
  CrmSession,
} from "./crm-client.js";
import { HubspotAuth } from "./hubspot-auth.js";

const BASE = "https://api.hubapi.com";
/** HubSpot's v3 objects/lists page ceiling. */
export const HUBSPOT_PAGE_LIMIT = 100;
/** Batch-read input ceiling. */
const BATCH_LIMIT = 100;

/** v3 list objectTypeIds ↔ the object slugs v1 supports. */
const OBJECT_TYPE_IDS: Readonly<Record<string, string>> = {
  "0-1": "contacts",
  "0-2": "companies",
};

/** Display-name properties per object (reference resolution). */
const NAME_PROPS: Readonly<Record<string, readonly string[]>> = {
  contacts: ["firstname", "lastname", "email"],
  companies: ["name", "domain"],
};

/** Jittered exponential backoff over transient failures (≤4 retries). */
const transientRetry = Schedule.exponential("500 millis").pipe(
  Schedule.jittered,
  Schedule.intersect(Schedule.recurs(4)),
  Schedule.whileInput(isTransientCrmError),
);

interface RequestArgs {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
  /** 404 handling: map to CrmSourceGoneError with this label when set. */
  readonly notFoundLabel?: string;
}

interface RawHubspotRecord {
  readonly id: string;
  readonly properties: Readonly<Record<string, string | null>>;
}

export class HubspotClient extends Effect.Service<HubspotClient>()("HubspotClient", {
  effect: Effect.gen(function* () {
    const auth = yield* HubspotAuth;

    /** One raw attempt with a specific access token. */
    const attempt = (args: RequestArgs, accessToken: string) =>
      Effect.gen(function* () {
        const res = yield* Effect.tryPromise({
          try: () =>
            fetch(`${BASE}${args.path}`, {
              method: args.method,
              headers: {
                authorization: `Bearer ${accessToken}`,
                ...(args.body !== undefined ? { "content-type": "application/json" } : {}),
              },
              ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
            }),
          catch: (cause) => new CrmNetworkError({ provider: "HubSpot", cause }),
        });
        if (res.status === 401) return { unauthorized: true as const };
        if (res.status === 404 && args.notFoundLabel !== undefined) {
          return yield* Effect.fail(new CrmSourceGoneError({ provider: "HubSpot", sourceLabel: args.notFoundLabel }));
        }
        if (res.status === 429) {
          const after = Number(res.headers.get("retry-after"));
          return yield* Effect.fail(
            new CrmRateLimitError(Number.isFinite(after) && after > 0 ? { provider: "HubSpot", retryAfterMs: after * 1000 } : { provider: "HubSpot" }),
          );
        }
        if (res.status >= 500) return yield* Effect.fail(new CrmServerError({ provider: "HubSpot", status: res.status }));
        if (!res.ok) {
          const detail = yield* Effect.tryPromise({
            try: () => res.text(),
            catch: (cause) => new CrmNetworkError({ provider: "HubSpot", cause }),
          }).pipe(Effect.orElseSucceed(() => ""));
          // Server-side diagnostics only (path + status + body snippet — never
          // tokens): live HubSpot refusals must be debuggable from host logs.
          yield* Effect.logWarning("hubspot request refused").pipe(
            Effect.annotateLogs({ path: args.path, status: res.status, detail: detail.slice(0, 300) }),
          );
          return yield* Effect.fail(new CrmRequestError({ provider: "HubSpot", status: res.status, detail: detail.slice(0, 500) }));
        }
        const json = yield* Effect.tryPromise({
          try: () => res.json() as Promise<unknown>,
          catch: (cause) => new CrmSyncError({ message: "HubSpot response was not JSON", cause }),
        });
        return { unauthorized: false as const, json };
      });

    /** Full request pipeline: transient retry → refresh-on-401 backstop → JSON. */
    const request = (session: CrmSession, args: RequestArgs): Effect.Effect<unknown, CrmError> =>
      Effect.gen(function* () {
        const first = yield* attempt(args, session.tokens.accessToken).pipe(Effect.retry(transientRetry));
        if (!first.unauthorized) return first.json;

        const refreshToken = session.tokens.refreshToken;
        if (!refreshToken) {
          return yield* Effect.fail(new CrmAuthRevoked({ provider: "HubSpot", detail: "401 and no refresh token" }));
        }
        const refreshed = yield* auth.refresh(refreshToken).pipe(
          Effect.mapError((e) =>
            e._tag === "HubspotOAuthNotConfigured"
              ? new CrmAuthRevoked({ provider: "HubSpot", detail: `OAuth not configured: ${e.missing}` })
              : e,
          ),
        );
        // HubSpot does not rotate refresh tokens on refresh — keep the old one.
        const merged = { refreshToken, ...refreshed };
        yield* session.persist(merged);
        const second = yield* attempt(args, merged.accessToken).pipe(Effect.retry(transientRetry));
        if (second.unauthorized) {
          return yield* Effect.fail(new CrmAuthRevoked({ provider: "HubSpot", detail: "401 after refresh" }));
        }
        return second.json;
      });

    const resultsOf = (json: unknown): readonly Record<string, unknown>[] => {
      const results = (json as { results?: unknown } | null)?.results;
      return Array.isArray(results)
        ? results.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
        : [];
    };

    const nextCursorOf = (json: unknown): string | null => {
      const after = (json as { paging?: { next?: { after?: unknown } } } | null)?.paging?.next?.after;
      return typeof after === "string" && after !== "" ? after : null;
    };

    const toRaw = (raw: Record<string, unknown>): RawHubspotRecord => ({
      id: typeof raw.id === "string" ? raw.id : String(raw.id ?? ""),
      properties:
        raw.properties !== null && typeof raw.properties === "object"
          ? (raw.properties as Record<string, string | null>)
          : {},
    });

    /** Pre-flatten the requested attributes — the neutral record the engine sees. */
    const toCrmRecord = (raw: RawHubspotRecord, attrs: readonly CrmAttrRef[]): CrmRecord => {
      const values: Record<string, FlatValue> = {};
      for (const a of attrs) {
        values[a.slug] = isSupportedAttrType(a.type)
          ? flattenHubspotValue(a.type as CrmAttrType, raw.properties[a.slug])
          : { kind: "text", text: "" };
      }
      return { recordId: raw.id, values };
    };

    const chunk = <A>(items: readonly A[], size: number): A[][] => {
      const out: A[][] = [];
      for (let i = 0; i < items.length; i += size) out.push([...items.slice(i, i + size)]);
      return out;
    };

    /** POST /crm/v3/objects/{object}/batch/read — raw records for specific ids. */
    const batchReadRaw = (
      session: CrmSession,
      args: { readonly object: string; readonly sourceLabel: string; readonly properties: readonly string[]; readonly ids: readonly string[] },
    ): Effect.Effect<readonly RawHubspotRecord[], CrmError> =>
      args.ids.length === 0
        ? Effect.succeed([] as readonly RawHubspotRecord[])
        : Effect.forEach(
            chunk(args.ids, BATCH_LIMIT),
            (ids) =>
              request(session, {
                method: "POST",
                path: `/crm/v3/objects/${encodeURIComponent(args.object)}/batch/read`,
                notFoundLabel: args.sourceLabel,
                body: { properties: args.properties, inputs: ids.map((id) => ({ id })) },
              }).pipe(Effect.map((json) => resultsOf(json).map(toRaw))),
            { concurrency: 2 },
          ).pipe(Effect.map((pages) => pages.flat()));

    // List → objectTypeId is stable metadata: memoize for the process lifetime
    // (memberships don't carry the parent object, the engine needs it).
    const listParentCache = new Map<string, string>();

    const listParentOf = (
      session: CrmSession,
      listId: string,
      sourceLabel: string,
    ): Effect.Effect<string, CrmError> => {
      const cached = listParentCache.get(listId);
      if (cached !== undefined) return Effect.succeed(cached);
      return request(session, {
        method: "GET",
        path: `/crm/v3/lists/${encodeURIComponent(listId)}`,
        notFoundLabel: sourceLabel,
      }).pipe(
        Effect.map((json) => {
          const list = (json as { list?: { objectTypeId?: unknown } } | null)?.list;
          const typeId = typeof list?.objectTypeId === "string" ? list.objectTypeId : "";
          const parent = OBJECT_TYPE_IDS[typeId] ?? "";
          if (parent !== "") listParentCache.set(listId, parent);
          return parent;
        }),
      );
    };

    return {
      provider: "hubspot" as const,
      displayName: "HubSpot",
      pageLimit: HUBSPOT_PAGE_LIMIT,

      /** GET /oauth/v1/access-tokens/{token} — the connected portal's identity. */
      identifySelf: (session: CrmSession) =>
        request(session, {
          method: "GET",
          path: `/oauth/v1/access-tokens/${encodeURIComponent(session.tokens.accessToken)}`,
        }).pipe(
          Effect.map((json) => {
            const r = (json as Record<string, unknown> | null) ?? {};
            const hubId = r.hub_id;
            const domain = r.hub_domain;
            return {
              workspaceId: hubId === undefined || hubId === null ? "" : String(hubId),
              workspaceName: typeof domain === "string" ? domain : "",
            };
          }),
        ),

      /** v1 sources are fixed: Contacts + Companies (Deals deferred). */
      listObjects: (_session: CrmSession): Effect.Effect<readonly CrmObjectSummary[], CrmError> =>
        Effect.succeed([
          { slug: "contacts", label: "Contacts" },
          { slug: "companies", label: "Companies" },
        ]),

      /** POST /crm/v3/lists/search — contact + company lists for the Lists tab. */
      listLists: (session: CrmSession): Effect.Effect<readonly CrmListSummary[], CrmError> =>
        request(session, {
          method: "POST",
          path: "/crm/v3/lists/search",
          body: { query: "", count: 100, offset: 0 },
        }).pipe(
          Effect.map((json) => {
            const lists = (json as { lists?: unknown } | null)?.lists;
            const rows = Array.isArray(lists)
              ? lists.filter((l): l is Record<string, unknown> => l !== null && typeof l === "object")
              : [];
            return rows.flatMap((raw): CrmListSummary[] => {
              const parent = OBJECT_TYPE_IDS[typeof raw.objectTypeId === "string" ? raw.objectTypeId : ""];
              if (parent === undefined) return []; // deal/custom-object lists: out of v1 scope
              const id = typeof raw.listId === "string" ? raw.listId : String(raw.listId ?? "");
              if (id === "") return [];
              return [{ id, name: typeof raw.name === "string" ? raw.name : "List", parentObject: parent }];
            });
          }),
        ),

      /**
       * GET /crm/v3/properties/{object} — the field picker's rows. `type` is
       * the NEUTRAL attr type (HubSpot property types map into the shared
       * vocabulary here, and round-trip through `attrs` when querying).
       * List-scoped attributes don't exist in HubSpot — the parent object's
       * properties are the schema (target "lists" is an empty set).
       */
      getAttributes: (session: CrmSession, target: "objects" | "lists", identifier: string, sourceLabel: string) =>
        target === "lists"
          ? Effect.succeed([] as readonly CrmAttribute[])
          : request(session, {
              method: "GET",
              path: `/crm/v3/properties/${encodeURIComponent(identifier)}`,
              notFoundLabel: sourceLabel,
            }).pipe(
              Effect.map((json) =>
                resultsOf(json).flatMap((raw): CrmAttribute[] => {
                  const name = typeof raw.name === "string" ? raw.name : "";
                  if (name === "") return [];
                  if (raw.hidden === true) return [];
                  const mapped = mapHubspotPropertyType({
                    name,
                    type: typeof raw.type === "string" ? raw.type : "",
                    fieldType: typeof raw.fieldType === "string" ? raw.fieldType : "",
                    referencedObjectType:
                      typeof raw.referencedObjectType === "string" ? raw.referencedObjectType : null,
                  });
                  return [
                    {
                      slug: name,
                      title: typeof raw.label === "string" && raw.label !== "" ? raw.label : name,
                      type: mapped ?? (typeof raw.type === "string" ? raw.type : ""),
                      supported: mapped !== null,
                    },
                  ];
                }),
              ),
            ),

      /**
       * One page of an object's records, pre-flattened over `attrs`. Plain
       * cursor paging by default; a compiled prefilter switches to the CRM
       * search endpoint (10k-result cap — acceptable for narrowed pulls; the
       * worker predicate re-checks every record either way).
       */
      queryObjectRecords: (
        session: CrmSession,
        args: {
          readonly object: string;
          readonly sourceLabel: string;
          readonly attrs: readonly CrmAttrRef[];
          readonly filter?: unknown;
          readonly limit: number;
          readonly cursor: string | null;
        },
      ): Effect.Effect<CrmPage<CrmRecord>, CrmError> => {
        const properties = args.attrs.map((a) => a.slug);
        const req =
          args.filter !== undefined
            ? request(session, {
                method: "POST",
                path: `/crm/v3/objects/${encodeURIComponent(args.object)}/search`,
                notFoundLabel: args.sourceLabel,
                body: {
                  ...(args.filter as Record<string, unknown>),
                  properties,
                  limit: args.limit,
                  ...(args.cursor !== null ? { after: args.cursor } : {}),
                },
              })
            : request(session, {
                method: "GET",
                path: `/crm/v3/objects/${encodeURIComponent(args.object)}?${new URLSearchParams({
                  limit: String(args.limit),
                  archived: "false",
                  ...(properties.length > 0 ? { properties: properties.join(",") } : {}),
                  ...(args.cursor !== null ? { after: args.cursor } : {}),
                }).toString()}`,
                notFoundLabel: args.sourceLabel,
              });
        return req.pipe(
          Effect.map((json) => ({
            items: resultsOf(json).map((raw) => toCrmRecord(toRaw(raw), args.attrs)),
            nextCursor: nextCursorOf(json),
          })),
        );
      },

      /** GET /crm/v3/lists/{list}/memberships — one page of member record ids. */
      queryListEntries: (
        session: CrmSession,
        args: { readonly listId: string; readonly sourceLabel: string; readonly limit: number; readonly cursor: string | null },
      ): Effect.Effect<CrmPage<CrmListEntry>, CrmError> =>
        Effect.gen(function* () {
          const parent = yield* listParentOf(session, args.listId, args.sourceLabel);
          const json = yield* request(session, {
            method: "GET",
            path: `/crm/v3/lists/${encodeURIComponent(args.listId)}/memberships?${new URLSearchParams({
              limit: String(args.limit),
              ...(args.cursor !== null ? { after: args.cursor } : {}),
            }).toString()}`,
            notFoundLabel: args.sourceLabel,
          });
          const items = resultsOf(json).flatMap((raw): CrmListEntry[] => {
            const recordId = typeof raw.recordId === "string" ? raw.recordId : String(raw.recordId ?? "");
            if (recordId === "") return [];
            return [{ entryId: recordId, parentObject: parent, parentRecordId: recordId }];
          });
          return { items, nextCursor: nextCursorOf(json) };
        }),

      /** Batch-read specific records, pre-flattened (list hydration). */
      queryRecordsByIds: (
        session: CrmSession,
        args: {
          readonly object: string;
          readonly sourceLabel: string;
          readonly attrs: readonly CrmAttrRef[];
          readonly ids: readonly string[];
        },
      ): Effect.Effect<readonly CrmRecord[], CrmError> =>
        batchReadRaw(session, {
          object: args.object,
          sourceLabel: args.sourceLabel,
          properties: args.attrs.map((a) => a.slug),
          ids: args.ids,
        }).pipe(Effect.map((raws) => raws.map((r) => toCrmRecord(r, args.attrs)))),

      /** Resolve record ids → display names via one batch read of name props. */
      resolveRecordNames: (
        session: CrmSession,
        args: { readonly object: string; readonly ids: readonly string[] },
      ): Effect.Effect<ReadonlyMap<string, string>, CrmError> => {
        if (args.ids.length === 0) return Effect.succeed(new Map<string, string>());
        const props = NAME_PROPS[args.object] ?? ["name"];
        return batchReadRaw(session, {
          object: args.object,
          sourceLabel: args.object,
          properties: props,
          ids: args.ids,
        }).pipe(
          Effect.map((records) => {
            const names = new Map<string, string>();
            for (const rec of records) {
              const parts = props
                .map((p) => rec.properties[p] ?? "")
                .filter((v) => v !== "");
              // First non-empty prop wins for single-prop objects; contacts
              // join first+last and fall back to email.
              const display =
                args.object === "contacts"
                  ? [rec.properties.firstname ?? "", rec.properties.lastname ?? ""].filter((v) => v !== "").join(" ") ||
                    (rec.properties.email ?? "")
                  : (parts[0] ?? "");
              names.set(rec.id, display ?? "");
            }
            return names;
          }),
        );
      },

      /** GET /crm/v3/owners — owner id → name (Owner columns). Paginates fully. */
      listMembers: (session: CrmSession): Effect.Effect<ReadonlyMap<string, string>, CrmError> => {
        const page = (
          after: string | null,
          acc: Map<string, string>,
        ): Effect.Effect<ReadonlyMap<string, string>, CrmError> =>
          request(session, {
            method: "GET",
            path: `/crm/v3/owners?${new URLSearchParams({
              limit: "100",
              ...(after !== null ? { after } : {}),
            }).toString()}`,
          }).pipe(
            Effect.flatMap((json) => {
              for (const raw of resultsOf(json)) {
                const id = typeof raw.id === "string" ? raw.id : String(raw.id ?? "");
                if (id === "") continue;
                const name = [raw.firstName, raw.lastName]
                  .filter((p): p is string => typeof p === "string" && p !== "")
                  .join(" ");
                acc.set(id, name || (typeof raw.email === "string" ? raw.email : ""));
              }
              const next = nextCursorOf(json);
              return next === null ? Effect.succeed(acc) : page(next, acc);
            }),
          );
        return page(null, new Map<string, string>());
      },

      /** Prefilters compile only for OBJECT pulls (lists page raw memberships). */
      compileServerFilter: (filters: readonly CrmFilter[], kind: "object" | "list"): unknown | undefined =>
        kind === "object" ? toHubspotSearchBody(filters) : undefined,
    } as const;
  }),
  dependencies: [],
}) {}
