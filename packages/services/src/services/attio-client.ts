/**
 * `AttioClient` — every HTTP call GTM Grid makes to api.attio.com (TRI:
 * crm-sync). Implements the provider-neutral {@link CrmClientApi}: records
 * are pre-flattened to `FlatValue`s here (Attio's typed value entries never
 * leave this module) and paging is exposed as an opaque cursor synthesized
 * from Attio's limit/offset.
 *
 * Resilience:
 * - Transient failures (429 / 5xx / network) retry in-process with jittered
 *   exponential backoff, honoring `Retry-After` when Attio sends one. This is
 *   under the cron's outer Inngest step retries, mirroring the signal-service
 *   policy.
 * - 401 triggers ONE refresh via {@link AttioAuth} + persist via the session,
 *   then a single replay; a second 401 (or a refresh refusal, or no refresh
 *   token) is {@link CrmAuthRevoked} — the binding pauses for reconnect.
 * - Every method returns typed data; response parsing failures are
 *   {@link CrmSyncError}s, never exceptions.
 *
 * Read-only by design: nothing here can write to a user's CRM.
 */

import { Effect, Option, Schedule } from "effect";
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
import { flattenAttrValue, toAttioFilterBody, type AttioAttrType, type AttioValueEntry } from "../crm/attio-attributes.js";
import { isSupportedAttrType, type CrmFilter, type FlatValue } from "../crm/crm-values.js";
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
import { AttioAuth, type AttioTokens } from "./attio-auth.js";

const BASE = "https://api.attio.com";
/** Attio's documented page ceiling for query endpoints. */
export const ATTIO_PAGE_LIMIT = 500;

/** @deprecated The neutral {@link CrmSession} — kept as an alias for existing imports. */
export type AttioSession = CrmSession;

/** A raw Attio record: attribute slug → typed value entries. Internal only. */
interface RawAttioRecord {
  readonly recordId: string;
  readonly values: Readonly<Record<string, ReadonlyArray<AttioValueEntry>>>;
}

/** Attio's offset paging behind the neutral opaque cursor. */
const offsetOf = (cursor: string | null): number => {
  if (cursor === null) return 0;
  const n = Number(cursor);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
};
const nextCursorOf = (offset: number, pageSize: number, got: number): string | null =>
  got === pageSize ? String(offset + pageSize) : null;

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

export class AttioClient extends Effect.Service<AttioClient>()("AttioClient", {
  effect: Effect.gen(function* () {
    const auth = yield* AttioAuth;

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
          catch: (cause) => new CrmNetworkError({ provider: "Attio", cause }),
        });
        if (res.status === 401) return { unauthorized: true as const };
        if (res.status === 404 && args.notFoundLabel !== undefined) {
          return yield* Effect.fail(new CrmSourceGoneError({ provider: "Attio", sourceLabel: args.notFoundLabel }));
        }
        if (res.status === 429) {
          const after = Number(res.headers.get("retry-after"));
          return yield* Effect.fail(
            new CrmRateLimitError(Number.isFinite(after) && after > 0 ? { provider: "Attio", retryAfterMs: after * 1000 } : { provider: "Attio" }),
          );
        }
        if (res.status >= 500) return yield* Effect.fail(new CrmServerError({ provider: "Attio", status: res.status }));
        if (!res.ok) {
          const detail = yield* Effect.tryPromise({
            try: () => res.text(),
            catch: (cause) => new CrmNetworkError({ provider: "Attio", cause }),
          }).pipe(Effect.orElseSucceed(() => ""));
          // Server-side diagnostics only (path + status + body snippet — never
          // tokens): live Attio refusals must be debuggable from host logs.
          yield* Effect.logWarning("attio request refused").pipe(
            Effect.annotateLogs({ path: args.path, status: res.status, detail: detail.slice(0, 300) }),
          );
          return yield* Effect.fail(new CrmRequestError({ provider: "Attio", status: res.status, detail: detail.slice(0, 500) }));
        }
        const json = yield* Effect.tryPromise({
          try: () => res.json() as Promise<unknown>,
          catch: (cause) => new CrmSyncError({ message: "Attio response was not JSON", cause }),
        });
        return { unauthorized: false as const, json };
      });

    /**
     * Full request pipeline: attempt (with transient retry) → on 401, refresh
     * once + persist + replay → typed JSON. `retryAfterMs` from a 429 is not
     * separately awaited — the backoff schedule's growth covers Attio's small
     * windows, and the cron's outer retries cover large ones.
     */
    const request = (session: CrmSession, args: RequestArgs): Effect.Effect<unknown, CrmError> =>
      Effect.gen(function* () {
        const first = yield* attempt(args, session.tokens.accessToken).pipe(Effect.retry(transientRetry));
        if (!first.unauthorized) return first.json;

        const refreshToken = session.tokens.refreshToken;
        if (!refreshToken) {
          return yield* Effect.fail(new CrmAuthRevoked({ provider: "Attio", detail: "401 and no refresh token" }));
        }
        const refreshed = yield* auth.refresh(refreshToken).pipe(
          Effect.mapError((e) =>
            e._tag === "AttioOAuthNotConfigured"
              ? new CrmAuthRevoked({ provider: "Attio", detail: `OAuth not configured: ${e.missing}` })
              : e,
          ),
        );
        // Keep the old refresh token if Attio rotates without returning one.
        const merged: AttioTokens = { refreshToken, ...refreshed };
        yield* session.persist(merged);
        const second = yield* attempt(args, merged.accessToken).pipe(Effect.retry(transientRetry));
        if (second.unauthorized) {
          return yield* Effect.fail(new CrmAuthRevoked({ provider: "Attio", detail: "401 after refresh" }));
        }
        return second.json;
      });

    const dataArray = (json: unknown): readonly Record<string, unknown>[] => {
      const data = (json as { data?: unknown } | null)?.data;
      return Array.isArray(data)
        ? data.filter((d): d is Record<string, unknown> => d !== null && typeof d === "object")
        : [];
    };

    const idOf = (raw: Record<string, unknown>, key: string): string => {
      const id = raw.id;
      if (id && typeof id === "object") {
        const v = (id as Record<string, unknown>)[key];
        if (typeof v === "string") return v;
      }
      return "";
    };

    const valuesOf = (raw: Record<string, unknown>): Record<string, ReadonlyArray<AttioValueEntry>> => {
      const values = raw.values;
      if (values === null || typeof values !== "object") return {};
      const out: Record<string, ReadonlyArray<AttioValueEntry>> = {};
      for (const [slug, entries] of Object.entries(values as Record<string, unknown>)) {
        out[slug] = Array.isArray(entries)
          ? entries.filter((e): e is AttioValueEntry => e !== null && typeof e === "object")
          : [];
      }
      return out;
    };

    const toRaw = (raw: Record<string, unknown>): RawAttioRecord => ({
      recordId: idOf(raw, "record_id"),
      values: valuesOf(raw),
    });

    /** Pre-flatten the requested attributes — the neutral record the engine sees. */
    const toCrmRecord = (raw: RawAttioRecord, attrs: readonly CrmAttrRef[]): CrmRecord => {
      const values: Record<string, FlatValue> = {};
      for (const a of attrs) {
        values[a.slug] = isSupportedAttrType(a.type)
          ? flattenAttrValue(a.type as AttioAttrType, raw.values[a.slug])
          : { kind: "text", text: "" };
      }
      return { recordId: raw.recordId, values };
    };

    /** Query one page of an object's RAW records. */
    const queryRawObjectRecords = (
      session: CrmSession,
      args: {
        readonly object: string;
        readonly sourceLabel: string;
        readonly filter?: Record<string, unknown>;
        readonly limit: number;
        readonly offset: number;
      },
    ) =>
      request(session, {
        method: "POST",
        path: `/v2/objects/${encodeURIComponent(args.object)}/records/query`,
        notFoundLabel: args.sourceLabel,
        body: {
          limit: args.limit,
          offset: args.offset,
          ...(args.filter !== undefined ? { filter: args.filter } : {}),
        },
      }).pipe(Effect.map((json) => dataArray(json).map(toRaw)));

    // Attio's filter language does not document `$in`; live workspaces reject
    // it with a 400 (found in the first real E2E — a People sample pull with a
    // Company reference failed the whole wizard). We still TRY one bulk query
    // (cheap when it works) but remember the refusal for the process lifetime
    // and go straight to individual GETs afterwards.
    let bulkInUnsupported = false;

    const fetchRawRecordsByIds = (
      session: CrmSession,
      args: { readonly object: string; readonly sourceLabel: string; readonly ids: readonly string[] },
    ): Effect.Effect<readonly RawAttioRecord[], CrmError> => {
      if (args.ids.length === 0) return Effect.succeed([] as readonly RawAttioRecord[]);
      // Self-chunk: the bulk $in query is capped at one page, so oversized id
      // sets split here (callers used to chunk — the neutral interface says
      // clients own their batch limits).
      if (args.ids.length > ATTIO_PAGE_LIMIT) {
        const chunks: string[][] = [];
        for (let i = 0; i < args.ids.length; i += ATTIO_PAGE_LIMIT) {
          chunks.push([...args.ids.slice(i, i + ATTIO_PAGE_LIMIT)]);
        }
        return Effect.forEach(chunks, (ids) => fetchRawRecordsByIds(session, { ...args, ids })).pipe(
          Effect.map((pages) => pages.flat()),
        );
      }
      const individually = Effect.forEach(
        args.ids,
        (id) =>
          request(session, {
            method: "GET",
            path: `/v2/objects/${encodeURIComponent(args.object)}/records/${encodeURIComponent(id)}`,
          }).pipe(
            Effect.map((json) => {
              const data = (json as { data?: unknown } | null)?.data;
              return data !== null && typeof data === "object"
                ? Option.some(toRaw(data as Record<string, unknown>))
                : Option.none<RawAttioRecord>();
            }),
            // A single VANISHED record (404) must not fail the batch — but a
            // scope refusal (403) must: swallowing it turned a missing Records
            // scope into silent "ok · 0 records" syncs in the first live E2E.
            Effect.catchTag("CrmSourceGoneError", () => Effect.succeed(Option.none<RawAttioRecord>())),
            Effect.catchTag("CrmRequestError", (e) =>
              e.status === 404 ? Effect.succeed(Option.none<RawAttioRecord>()) : Effect.fail(e),
            ),
          ),
        { concurrency: 4 },
      ).pipe(Effect.map((opts) => opts.flatMap((o) => (Option.isSome(o) ? [o.value] : []))));

      if (bulkInUnsupported) return individually;
      return queryRawObjectRecords(session, {
        object: args.object,
        sourceLabel: args.sourceLabel,
        filter: { record_id: { $in: [...args.ids] } },
        limit: Math.min(args.ids.length, ATTIO_PAGE_LIMIT),
        offset: 0,
      }).pipe(
        Effect.catchTag("CrmRequestError", () =>
          Effect.suspend(() => {
            bulkInUnsupported = true;
            return individually;
          }),
        ),
      );
    };

    // List → parent object is stable metadata: memoize for the process
    // lifetime (the sync loop asks per page).
    const listParentCache = new Map<string, string>();
    const getListParent = (
      session: CrmSession,
      args: { readonly listId: string; readonly sourceLabel: string },
    ): Effect.Effect<string, CrmError> => {
      const cached = listParentCache.get(args.listId);
      if (cached !== undefined) return Effect.succeed(cached);
      return request(session, {
        method: "GET",
        path: `/v2/lists/${encodeURIComponent(args.listId)}`,
        notFoundLabel: args.sourceLabel,
      }).pipe(
        Effect.map((json) => {
          const data = (json as { data?: Record<string, unknown> } | null)?.data ?? {};
          const raw = data.parent_object;
          const parent = Array.isArray(raw)
            ? (raw.find((p): p is string => typeof p === "string") ?? "")
            : typeof raw === "string"
              ? raw
              : "";
          if (parent !== "") listParentCache.set(args.listId, parent);
          return parent;
        }),
      );
    };

    return {
      provider: "attio" as const,
      displayName: "Attio",
      pageLimit: ATTIO_PAGE_LIMIT,

      /** GET /v2/self — the connected Attio workspace's identity. */
      identifySelf: (session: CrmSession) =>
        request(session, { method: "GET", path: "/v2/self" }).pipe(
          Effect.map((json) => {
            const r = (json as Record<string, unknown> | null) ?? {};
            const ws = (r.workspace_id ?? (r as { data?: Record<string, unknown> }).data?.workspace_id) as
              | string
              | undefined;
            const name = (r.workspace_name ?? (r as { data?: Record<string, unknown> }).data?.workspace_name) as
              | string
              | undefined;
            return { workspaceId: ws ?? "", workspaceName: name ?? "" };
          }),
        ),

      /** GET /v2/objects — object summaries for the wizard's source picker. */
      listObjects: (session: CrmSession) =>
        request(session, { method: "GET", path: "/v2/objects" }).pipe(
          Effect.map((json) =>
            dataArray(json).map(
              (raw): CrmObjectSummary => ({
                slug:
                  typeof raw.api_slug === "string" && raw.api_slug !== ""
                    ? raw.api_slug
                    : idOf(raw, "object_id"),
                label:
                  typeof raw.plural_noun === "string" && raw.plural_noun !== ""
                    ? raw.plural_noun
                    : typeof raw.api_slug === "string"
                      ? raw.api_slug
                      : "Object",
              }),
            ),
          ),
        ),

      /** GET /v2/lists — list summaries for the wizard's Lists tab. */
      listLists: (session: CrmSession) =>
        request(session, { method: "GET", path: "/v2/lists" }).pipe(
          Effect.map((json) =>
            dataArray(json).map((raw): CrmListSummary => {
              const parent = Array.isArray(raw.parent_object)
                ? (raw.parent_object.find((p): p is string => typeof p === "string") ?? "")
                : typeof raw.parent_object === "string"
                  ? raw.parent_object
                  : "";
              return {
                id: idOf(raw, "list_id"),
                name: typeof raw.name === "string" ? raw.name : "List",
                parentObject: parent,
              };
            }),
          ),
        ),

      /** GET /v2/{objects|lists}/{id}/attributes — the field picker's rows. */
      getAttributes: (session: CrmSession, target: "objects" | "lists", identifier: string, sourceLabel: string) =>
        request(session, {
          method: "GET",
          path: `/v2/${target}/${encodeURIComponent(identifier)}/attributes`,
          notFoundLabel: sourceLabel,
        }).pipe(
          Effect.map((json) =>
            dataArray(json).map((raw): CrmAttribute => {
              const type = typeof raw.type === "string" ? raw.type : "";
              return {
                slug: typeof raw.api_slug === "string" ? raw.api_slug : "",
                title: typeof raw.title === "string" ? raw.title : "",
                type,
                supported: isSupportedAttrType(type),
              };
            }),
          ),
        ),

      /** One page of an object's records, pre-flattened over `attrs`. */
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
        const offset = offsetOf(args.cursor);
        return queryRawObjectRecords(session, {
          object: args.object,
          sourceLabel: args.sourceLabel,
          ...(args.filter !== undefined ? { filter: args.filter as Record<string, unknown> } : {}),
          limit: args.limit,
          offset,
        }).pipe(
          Effect.map((raws) => ({
            items: raws.map((r) => toCrmRecord(r, args.attrs)),
            nextCursor: nextCursorOf(offset, args.limit, raws.length),
          })),
        );
      },

      /** GET /v2/lists/{list} — the parent object slug from list metadata. */
      getListParent,

      /** POST /v2/lists/{list}/entries/query — one page of a list's membership. */
      queryListEntries: (
        session: CrmSession,
        args: { readonly listId: string; readonly sourceLabel: string; readonly limit: number; readonly cursor: string | null },
      ): Effect.Effect<CrmPage<CrmListEntry>, CrmError> => {
        const offset = offsetOf(args.cursor);
        return request(session, {
          method: "POST",
          path: `/v2/lists/${encodeURIComponent(args.listId)}/entries/query`,
          notFoundLabel: args.sourceLabel,
          body: { limit: args.limit, offset },
        }).pipe(
          Effect.tap((json) => {
            const rows = dataArray(json);
            // Shape diagnostic: top-level key NAMES of the first entry only
            // (never values) — catches API-shape drift from host logs.
            return Effect.logWarning("crm entries shape").pipe(
              Effect.annotateLogs({
                listId: args.listId,
                count: rows.length,
                firstEntryKeys: rows[0] === undefined ? "none" : Object.keys(rows[0]).join(","),
              }),
            );
          }),
          Effect.map((json) => {
            const items = dataArray(json).map(
              (raw): CrmListEntry => ({
                entryId: idOf(raw, "entry_id"),
                parentObject: typeof raw.parent_object === "string" ? raw.parent_object : "",
                parentRecordId: typeof raw.parent_record_id === "string" ? raw.parent_record_id : "",
              }),
            );
            return { items, nextCursor: nextCursorOf(offset, args.limit, items.length) };
          }),
        );
      },

      /**
       * Fetch specific records of an object by id, pre-flattened — the
       * list-sync path. Tries ONE bulk `record_id $in` query, then falls back
       * to bounded-concurrency individual GETs (and remembers when the live
       * API rejects `$in`, skipping the doomed attempt on later calls).
       */
      queryRecordsByIds: (
        session: CrmSession,
        args: {
          readonly object: string;
          readonly sourceLabel: string;
          readonly attrs: readonly CrmAttrRef[];
          readonly ids: readonly string[];
        },
      ): Effect.Effect<readonly CrmRecord[], CrmError> =>
        fetchRawRecordsByIds(session, { object: args.object, sourceLabel: args.sourceLabel, ids: args.ids }).pipe(
          Effect.map((raws) => raws.map((r) => toCrmRecord(r, args.attrs))),
        ),

      /**
       * Resolve record ids → display names (the "Company" cell text). Reads
       * each record's `name` attribute via the flattener; unknown ids map to "".
       */
      resolveRecordNames: (
        session: CrmSession,
        args: { readonly object: string; readonly ids: readonly string[] },
      ): Effect.Effect<ReadonlyMap<string, string>, CrmError> =>
        args.ids.length === 0
          ? Effect.succeed(new Map<string, string>())
          : fetchRawRecordsByIds(session, { object: args.object, sourceLabel: args.object, ids: args.ids }).pipe(
              Effect.map((records) => {
                const names = new Map<string, string>();
                for (const rec of records) {
                  const entries = rec.values.name ?? [];
                  const flatPersonal = flattenAttrValue("personal-name", entries);
                  const flat = flatPersonal.kind === "text" && flatPersonal.text !== ""
                    ? flatPersonal
                    : flattenAttrValue("text", entries);
                  names.set(rec.recordId, flat.kind === "text" ? flat.text : "");
                }
                return names;
              }),
            ),

      /** GET /v2/workspace_members — actor id → member name (Owner columns). */
      listMembers: (session: CrmSession): Effect.Effect<ReadonlyMap<string, string>, CrmError> =>
        request(session, { method: "GET", path: "/v2/workspace_members" }).pipe(
          Effect.map((json) => {
            const members = new Map<string, string>();
            for (const raw of dataArray(json)) {
              const id = idOf(raw, "workspace_member_id");
              const name = [raw.first_name, raw.last_name]
                .filter((p): p is string => typeof p === "string" && p !== "")
                .join(" ");
              if (id) members.set(id, name || (typeof raw.email_address === "string" ? raw.email_address : ""));
            }
            return members;
          }),
        ),

      /** Attio prefilters apply to OBJECT queries only (lists page raw entries). */
      compileServerFilter: (filters: readonly CrmFilter[], kind: "object" | "list"): unknown | undefined =>
        kind === "object" ? toAttioFilterBody(filters) : undefined,
    } as const;
  }),
  dependencies: [],
}) {}
