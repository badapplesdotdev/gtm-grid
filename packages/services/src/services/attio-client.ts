/**
 * `AttioClient` — every HTTP call GTM Grid makes to api.attio.com (TRI:
 * crm-sync). One typed, resilient seam:
 *
 * - Tokens are passed per call via an {@link AttioSession} (member and worker
 *   paths read them differently — see CrmConnectionService).
 * - Transient failures (429 / 5xx / network) retry in-process with jittered
 *   exponential backoff, honoring `Retry-After` when Attio sends one. This is
 *   under the cron's outer Inngest step retries, mirroring the signal-service
 *   policy.
 * - 401 triggers ONE refresh via {@link AttioAuth} + persist via the session,
 *   then a single replay; a second 401 (or a refresh refusal, or no refresh
 *   token) is {@link AttioAuthRevoked} — the binding pauses for reconnect.
 * - Every method returns typed data; response parsing failures are
 *   {@link CrmSyncError}s, never exceptions.
 *
 * Read-only by design: nothing here can write to a user's CRM.
 */

import { Effect, Option, Schedule } from "effect";
import {
  AttioAuthRevoked,
  AttioNetworkError,
  AttioRateLimitError,
  AttioRequestError,
  AttioServerError,
  AttioSourceGoneError,
  CrmSyncError,
  isTransientCrmError,
  type CrmError,
} from "../crm/errors.js";
import { flattenAttrValue, isSupportedAttrType, type AttioValueEntry } from "../crm/attio-attributes.js";
import { AttioAuth, type AttioTokens } from "./attio-auth.js";

const BASE = "https://api.attio.com";
/** Attio's documented page ceiling for query endpoints. */
export const ATTIO_PAGE_LIMIT = 500;

/** One workspace's live Attio access: current tokens + how to persist a refresh. */
export interface AttioSession {
  readonly workspaceId: string;
  readonly tokens: AttioTokens;
  /**
   * Persist refreshed tokens. Failures are swallowed by the client (the
   * refreshed token still works in-memory for this run; the next run will
   * refresh again) — persistence must never fail a sync.
   */
  readonly persist: (tokens: AttioTokens) => Effect.Effect<void, never>;
}

export interface AttioObjectSummary {
  readonly slug: string;
  readonly label: string;
}

export interface AttioListSummary {
  readonly id: string;
  readonly name: string;
  /** The object slug this list's entries reference (e.g. "people"). */
  readonly parentObject: string;
}

export interface AttioAttribute {
  readonly slug: string;
  readonly title: string;
  readonly type: string;
  readonly supported: boolean;
}

export interface AttioRecord {
  readonly recordId: string;
  readonly values: Readonly<Record<string, ReadonlyArray<AttioValueEntry>>>;
}

export interface AttioListEntry {
  readonly entryId: string;
  readonly parentObject: string;
  readonly parentRecordId: string;
}

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
  /** 404 handling: map to AttioSourceGoneError with this label when set. */
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
          catch: (cause) => new AttioNetworkError({ cause }),
        });
        if (res.status === 401) return { unauthorized: true as const };
        if (res.status === 404 && args.notFoundLabel !== undefined) {
          return yield* Effect.fail(new AttioSourceGoneError({ sourceLabel: args.notFoundLabel }));
        }
        if (res.status === 429) {
          const after = Number(res.headers.get("retry-after"));
          return yield* Effect.fail(
            new AttioRateLimitError(Number.isFinite(after) && after > 0 ? { retryAfterMs: after * 1000 } : {}),
          );
        }
        if (res.status >= 500) return yield* Effect.fail(new AttioServerError({ status: res.status }));
        if (!res.ok) {
          const detail = yield* Effect.tryPromise({
            try: () => res.text(),
            catch: (cause) => new AttioNetworkError({ cause }),
          }).pipe(Effect.orElseSucceed(() => ""));
          // Server-side diagnostics only (path + status + body snippet — never
          // tokens): live Attio refusals must be debuggable from host logs.
          yield* Effect.logWarning("attio request refused").pipe(
            Effect.annotateLogs({ path: args.path, status: res.status, detail: detail.slice(0, 300) }),
          );
          return yield* Effect.fail(new AttioRequestError({ status: res.status, detail: detail.slice(0, 500) }));
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
    const request = (session: AttioSession, args: RequestArgs): Effect.Effect<unknown, CrmError> =>
      Effect.gen(function* () {
        const first = yield* attempt(args, session.tokens.accessToken).pipe(Effect.retry(transientRetry));
        if (!first.unauthorized) return first.json;

        const refreshToken = session.tokens.refreshToken;
        if (!refreshToken) {
          return yield* Effect.fail(new AttioAuthRevoked({ detail: "401 and no refresh token" }));
        }
        const refreshed = yield* auth.refresh(refreshToken).pipe(
          Effect.mapError((e) =>
            e._tag === "AttioOAuthNotConfigured"
              ? new AttioAuthRevoked({ detail: `OAuth not configured: ${e.missing}` })
              : e,
          ),
        );
        // Keep the old refresh token if Attio rotates without returning one.
        const merged: AttioTokens = { refreshToken, ...refreshed };
        yield* session.persist(merged);
        const second = yield* attempt(args, merged.accessToken).pipe(Effect.retry(transientRetry));
        if (second.unauthorized) {
          return yield* Effect.fail(new AttioAuthRevoked({ detail: "401 after refresh" }));
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

    const toRecord = (raw: Record<string, unknown>): AttioRecord => ({
      recordId: idOf(raw, "record_id"),
      values: valuesOf(raw),
    });

    /** Query one page of an object's records. */
    const queryObjectRecords = (
      session: AttioSession,
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
      }).pipe(Effect.map((json) => dataArray(json).map(toRecord)));

    // Attio's filter language does not document `$in`; live workspaces reject
    // it with a 400 (found in the first real E2E — a People sample pull with a
    // Company reference failed the whole wizard). We still TRY one bulk query
    // (cheap when it works) but remember the refusal for the process lifetime
    // and go straight to individual GETs afterwards.
    let bulkInUnsupported = false;

    const fetchRecordsByIds = (
      session: AttioSession,
      args: { readonly object: string; readonly sourceLabel: string; readonly ids: readonly string[] },
    ): Effect.Effect<readonly AttioRecord[], CrmError> => {
      if (args.ids.length === 0) return Effect.succeed([] as readonly AttioRecord[]);
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
                ? Option.some(toRecord(data as Record<string, unknown>))
                : Option.none<AttioRecord>();
            }),
            // A single vanished record must not fail the batch.
            Effect.catchTag("AttioSourceGoneError", () => Effect.succeed(Option.none<AttioRecord>())),
            Effect.catchTag("AttioRequestError", () => Effect.succeed(Option.none<AttioRecord>())),
          ),
        { concurrency: 4 },
      ).pipe(Effect.map((opts) => opts.flatMap((o) => (Option.isSome(o) ? [o.value] : []))));

      if (bulkInUnsupported) return individually;
      return queryObjectRecords(session, {
        object: args.object,
        sourceLabel: args.sourceLabel,
        filter: { record_id: { $in: [...args.ids] } },
        limit: Math.min(args.ids.length, ATTIO_PAGE_LIMIT),
        offset: 0,
      }).pipe(
        Effect.catchTag("AttioRequestError", () =>
          Effect.suspend(() => {
            bulkInUnsupported = true;
            return individually;
          }),
        ),
      );
    };

    return {
      /** GET /v2/self — the connected Attio workspace's identity. */
      identifySelf: (session: AttioSession) =>
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
      listObjects: (session: AttioSession) =>
        request(session, { method: "GET", path: "/v2/objects" }).pipe(
          Effect.map((json) =>
            dataArray(json).map(
              (raw): AttioObjectSummary => ({
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
      listLists: (session: AttioSession) =>
        request(session, { method: "GET", path: "/v2/lists" }).pipe(
          Effect.map((json) =>
            dataArray(json).map((raw): AttioListSummary => {
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
      getAttributes: (session: AttioSession, target: "objects" | "lists", identifier: string, sourceLabel: string) =>
        request(session, {
          method: "GET",
          path: `/v2/${target}/${encodeURIComponent(identifier)}/attributes`,
          notFoundLabel: sourceLabel,
        }).pipe(
          Effect.map((json) =>
            dataArray(json).map((raw): AttioAttribute => {
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

      queryObjectRecords,

      /** POST /v2/lists/{list}/entries/query — one page of a list's membership. */
      queryListEntries: (
        session: AttioSession,
        args: { readonly listId: string; readonly sourceLabel: string; readonly limit: number; readonly offset: number },
      ) =>
        request(session, {
          method: "POST",
          path: `/v2/lists/${encodeURIComponent(args.listId)}/entries/query`,
          notFoundLabel: args.sourceLabel,
          body: { limit: args.limit, offset: args.offset },
        }).pipe(
          Effect.map((json) =>
            dataArray(json).map(
              (raw): AttioListEntry => ({
                entryId: idOf(raw, "entry_id"),
                parentObject: typeof raw.parent_object === "string" ? raw.parent_object : "",
                parentRecordId: typeof raw.parent_record_id === "string" ? raw.parent_record_id : "",
              }),
            ),
          ),
        ),

      /**
       * Fetch specific records of an object by id — the list-sync + reference-
       * name path. Tries ONE bulk `record_id $in` query, then falls back to
       * bounded-concurrency individual GETs (and remembers when the live API
       * rejects `$in`, skipping the doomed attempt on later calls).
       */
      queryRecordsByIds: (
        session: AttioSession,
        args: { readonly object: string; readonly sourceLabel: string; readonly ids: readonly string[] },
      ): Effect.Effect<readonly AttioRecord[], CrmError> => fetchRecordsByIds(session, args),

      /**
       * Resolve record ids → display names (the "Company" cell text). Reads
       * each record's `name` attribute via the flattener; unknown ids map to "".
       */
      resolveRecordNames: (
        session: AttioSession,
        args: { readonly object: string; readonly ids: readonly string[] },
      ): Effect.Effect<ReadonlyMap<string, string>, CrmError> =>
        args.ids.length === 0
          ? Effect.succeed(new Map<string, string>())
          : fetchRecordsByIds(session, { object: args.object, sourceLabel: args.object, ids: args.ids }).pipe(
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
      listMembers: (session: AttioSession): Effect.Effect<ReadonlyMap<string, string>, CrmError> =>
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
    } as const;
  }),
  dependencies: [],
}) {}
