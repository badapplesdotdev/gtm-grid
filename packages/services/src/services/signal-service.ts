/**
 * `SignalService` — cloud Social Signals. Creates a Trigify saved search for a
 * bound table and pulls its results into rows on demand (the Inngest cron worker
 * calls {@link SignalService.syncForWorker}; the tRPC layer calls the membership-
 * gated variants). Reuses {@link WebhookRepo}'s grid primitives for row/cell
 * inserts and {@link CredentialService} for the workspace Trigify key.
 *
 * Mirrors {@link WebhookService}: CRUD methods assert membership first; the
 * worker method skips membership (its caller's worker-secret bearer is the trust
 * boundary).
 */

import { CredentialCryptoService, MembershipService } from "@gtmgrid/cloud";
import { Data, Effect, Option, Schedule } from "effect";
import {
  getSignalSource,
  getPath,
  MAX_RESULTS_PER_SYNC,
  normalizeResults,
  resultKey,
  toCellValue,
  TRIGIFY_BASE,
} from "../signals/catalog.js";
import { CredentialService } from "./credential-service.js";
import { EntitlementService } from "./entitlement-service.js";
import {
  SignalRepo,
  type SignalBinding,
  type SignalBindingColumn,
  type SignalDueCursor,
} from "../repositories/signal-repo.js";
import { WebhookRepo } from "../repositories/webhook-repo.js";

/** Raised for Trigify/source failures (bad source id, search not created, HTTP error). */
export class SignalError extends Data.TaggedError("SignalError")<{
  readonly message: string;
  readonly cause?: unknown;
  /**
   * HTTP status of the underlying Trigify call, when the failure came from one
   * (0 = network/connectivity error). Absent for non-HTTP failures (e.g. unknown
   * source, missing search id). Drives {@link isTransientSignalError} so only
   * retryable failures get re-attempted.
   */
  readonly status?: number;
}> {}

/**
 * A Trigify HTTP failure that carries its status code, so the Effect retry policy
 * can tell a transient 429/5xx (worth retrying) from a permanent 4xx (not). Status
 * `0` is a network/connectivity failure (the `fetch` itself rejected) — transient.
 */
class TrigifyHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TrigifyHttpError";
  }
}

/** A Trigify failure worth retrying: 429, 503, any 5xx, or a network error (status 0). */
const isTransientSignalError = (e: SignalError): boolean =>
  e.status !== undefined && (e.status === 0 || e.status === 429 || e.status >= 500);

/**
 * Retry transient Trigify failures with capped exponential backoff + jitter
 * (mirrors the engine's resilience policy; Trigify documents no `Retry-After`, so
 * jittered backoff is the right shape). This is in-process resilience under the
 * cron's outer Inngest step-retries: it absorbs a brief 429/5xx blip without
 * burning a whole step replay. Permanent failures (4xx, unknown source) fall
 * through unretried.
 */
const trigifyRetry = Schedule.exponential("500 millis").pipe(
  Schedule.jittered,
  Schedule.intersect(Schedule.recurs(3)),
);

/** Map any error thrown by a Trigify fetch helper into a typed {@link SignalError}. */
const toSignalError = (fallback: string) => (cause: unknown): SignalError =>
  new SignalError({
    message: cause instanceof Error ? cause.message : fallback,
    cause,
    status: cause instanceof TrigifyHttpError ? cause.status : undefined,
  });

interface CreateArgs {
  readonly tableId: string;
  readonly sourceId: string;
  readonly name: string;
  readonly config: Record<string, unknown>;
  readonly schedule: string;
  /** field-path → columnId (resolved by the client after creating the columns). */
  readonly columns: readonly SignalBindingColumn[];
}

/** Issue a Trigify request, mapping a network rejection to a transient (status 0) error. */
function trigifyFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init).catch((e) => {
    throw new TrigifyHttpError(`Trigify network error: ${e instanceof Error ? e.message : String(e)}`, 0);
  });
}

/** Trigify REST: create a search; returns its id. */
function createTrigifySearch(apiKey: string, createPath: string, body: Record<string, unknown>): Promise<string> {
  return trigifyFetch(`${TRIGIFY_BASE}${createPath}`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  }).then(async (res) => {
    const text = await res.text();
    if (!res.ok) throw new TrigifyHttpError(`Trigify create ${res.status}: ${text.slice(0, 200)}`, res.status);
    const data = text ? JSON.parse(text) : {};
    const id = data?.id ?? data?.search_id ?? data?.data?.id ?? data?.search?.id ?? null;
    if (!id) throw new Error("Trigify create returned no search id");
    return String(id);
  });
}

/** Trigify REST: fetch results for a search. */
function fetchTrigifyResults(apiKey: string, resultsPath: string, searchId: string): Promise<unknown> {
  const path = resultsPath.replace("{id}", encodeURIComponent(searchId));
  return trigifyFetch(`${TRIGIFY_BASE}${path}?limit=100`, {
    headers: { "x-api-key": apiKey, accept: "application/json" },
  }).then(async (res) => {
    const text = await res.text();
    if (!res.ok) throw new TrigifyHttpError(`Trigify results ${res.status}: ${text.slice(0, 200)}`, res.status);
    return text ? JSON.parse(text) : [];
  });
}

export class SignalService extends Effect.Service<SignalService>()("SignalService", {
  effect: Effect.gen(function* () {
    const repo = yield* SignalRepo;
    const grid = yield* WebhookRepo;
    const credentials = yield* CredentialService;
    const crypto = yield* CredentialCryptoService;
    const membership = yield* MembershipService;
    const entitlement = yield* EntitlementService;

    const NO_KEY = "No Trigify API key connected for this workspace.";

    /**
     * Member path: decrypt the workspace-shared Trigify key via the
     * membership-gated {@link CredentialService} (the caller already asserted
     * membership). Use only where a `currentUserId` is present.
     */
    const trigifyKey = (workspaceId: string) =>
      Effect.gen(function* () {
        const credOpt = yield* credentials.getCredentialForRun({
          workspaceId,
          extensionId: "trigify",
          scope: "workspace",
        });
        const secrets = Option.getOrNull(credOpt);
        const apiKey = (secrets?.apiKey as string | undefined) ?? (secrets?.key as string | undefined) ?? "";
        if (!apiKey) return yield* Effect.fail(new SignalError({ message: NO_KEY }));
        return apiKey;
      });

    /**
     * Worker path: read the SHARED (workspace-scope, `ownerUserId IS NULL`)
     * Trigify key WITHOUT membership — mirrors {@link WebhookService}'s worker
     * credential read. The cron runs with `userId: null`, so the membership-gated
     * {@link trigifyKey} would always fail closed; the trust boundary here is the
     * cron's worker secret. Repo/decrypt failures map to {@link SignalError}.
     */
    const workerTrigifyKey = (workspaceId: string) =>
      Effect.gen(function* () {
        const enc = yield* grid.findSharedCredentialEnc(workspaceId, "trigify");
        if (Option.isNone(enc)) return yield* Effect.fail(new SignalError({ message: NO_KEY }));
        const secrets = yield* crypto.decrypt(workspaceId, enc.value);
        const apiKey = (secrets.apiKey as string | undefined) ?? (secrets.key as string | undefined) ?? "";
        if (!apiKey) return yield* Effect.fail(new SignalError({ message: NO_KEY }));
        return apiKey;
      }).pipe(
        Effect.catchTags({
          WebhookRepoError: (e) =>
            Effect.fail(new SignalError({ message: "Could not read Trigify credential", cause: e })),
          DecryptError: (e) =>
            Effect.fail(new SignalError({ message: "Could not decrypt Trigify credential", cause: e })),
        }),
      );

    /** Pull new results for a binding into its table. Records lastError on failure. */
    const runSync = (binding: SignalBinding, apiKey: string) =>
      Effect.gen(function* () {
        const source = getSignalSource(binding.sourceId);
        if (!source) return yield* Effect.fail(new SignalError({ message: `Unknown signal source ${binding.sourceId}` }));
        if (binding.kind === "search" && !binding.searchId) {
          return yield* Effect.fail(new SignalError({ message: "Search not created yet" }));
        }

        const resp = yield* Effect.tryPromise({
          try: () => fetchTrigifyResults(apiKey, source.resultsPath, binding.searchId ?? ""),
          catch: toSignalError("Trigify results failed"),
        }).pipe(Effect.retry({ schedule: trigifyRetry, while: isTransientSignalError }));
        // Cap the payload so one binding can't enqueue an unbounded insert burst
        // in a single step (a slow/large search would otherwise time the step out
        // and retry-replay the whole thing).
        const results = normalizeResults(resp).slice(0, MAX_RESULTS_PER_SYNC);

        // First non-empty occurrence per dedupe key within THIS payload — so a
        // payload that repeats a key inserts it at most once.
        const byKey = new Map<string, unknown>();
        for (const r of results) {
          const k = resultKey(r);
          if (!byKey.has(k)) byKey.set(k, r);
        }

        // Durable cross-poll dedupe: atomically record the keys and learn which
        // were genuinely NEW. Correct for a binding of any size (no 1000-key cap).
        const newKeys = yield* repo.recordSeenKeys(binding.id, [...byKey.keys()]);

        let added = 0;
        let insertedRowIds: readonly string[] = [];
        if (newKeys.length > 0) {
          const base = yield* grid.maxRowPosition(binding.tableId);
          const now = Date.now();
          // Bulk-insert the rows in one statement, ids returned in input order.
          const rowIds = yield* grid.insertRowsBulk(
            newKeys.map((_k, i) => ({
              workspaceId: binding.workspaceId,
              tableId: binding.tableId,
              position: base + i + 1,
              createdAt: now,
            })),
          );
          // Build every cell across every new row, then bulk-insert in one
          // statement (was N rows × M columns serial round-trips).
          const cells = newKeys.flatMap((k, i) => {
            const r = byKey.get(k);
            const rowId = rowIds[i];
            if (rowId === undefined) return [];
            return binding.columns.flatMap((col) => {
              const value = toCellValue(getPath(r, col.key));
              if (value === "") return [];
              return [
                {
                  workspaceId: binding.workspaceId,
                  tableId: binding.tableId,
                  rowId,
                  columnId: col.columnId,
                  cell: { value, status: "done", error: null, updatedAt: now },
                },
              ];
            });
          });
          yield* grid.insertCellsBulk(cells);
          added = rowIds.length;
          insertedRowIds = rowIds;
        }

        // Stamp `lastSyncedAt` only once the binding has EVER pulled data.
        // Trigify searches take ~10-30s to start returning results, so the
        // create-time pull is almost always 0 — stamping it deferred the next
        // pull by the full schedule interval (a "daily" binding sat empty for
        // 24h). While `rowsPulled` is still 0 the binding keeps `lastSyncedAt`
        // NULL, which the cron's due-predicate (`isNull(lastSyncedAt)` branch)
        // treats as always-due — so the hourly tick retries until first data
        // lands, then normal schedule semantics resume. Bounded cost: ≤24
        // results-calls/day per still-empty binding.
        const totalPulled = (binding.rowsPulled ?? 0) + added;
        yield* repo.patch(binding.id, {
          lastSyncedAt: totalPulled > 0 ? Date.now() : null,
          lastError: null,
          rowsPulled: totalPulled,
        });
        // Return the new rowIds (+ table/workspace) so the worker can enqueue
        // dependency-ordered enrichment for exactly the rows it just inserted.
        return {
          added,
          rowIds: insertedRowIds,
          tableId: binding.tableId,
          workspaceId: binding.workspaceId,
        };
      }).pipe(
        Effect.catchTag("SignalError", (e) =>
          repo.patch(binding.id, { lastError: e.message }).pipe(Effect.flatMap(() => Effect.fail(e))),
        ),
      );

    const create = (args: CreateArgs) =>
      Effect.gen(function* () {
        const table = yield* grid.findTable(args.tableId);
        if (Option.isNone(table)) return yield* Effect.fail(new SignalError({ message: "Table not found" }));
        const workspaceId = table.value.workspaceId;
        yield* membership.requireMember(workspaceId);
        yield* entitlement.requireCloudAccess(workspaceId);

        const source = getSignalSource(args.sourceId);
        if (!source) return yield* Effect.fail(new SignalError({ message: `Unknown signal source ${args.sourceId}` }));

        const apiKey = yield* trigifyKey(workspaceId);
        const config = { name: args.name, ...args.config };
        const searchId = yield* Effect.tryPromise({
          try: () => createTrigifySearch(apiKey, source.createPath, config),
          catch: toSignalError("Trigify create failed"),
        }).pipe(Effect.retry({ schedule: trigifyRetry, while: isTransientSignalError }));

        const bindingId = yield* repo.insert({
          workspaceId,
          tableId: args.tableId,
          sourceId: source.id,
          label: source.label,
          kind: source.kind,
          searchId,
          config,
          schedule: args.schedule,
          columns: args.columns,
          enabled: true,
          createdAt: Date.now(),
        });

        // Best-effort initial pull (search may still be scraping → 0; the cron fills it).
        const binding = yield* repo.findById(bindingId);
        let added = 0;
        if (Option.isSome(binding)) {
          const r = yield* runSync(binding.value, apiKey).pipe(
            Effect.catchTag("SignalError", () =>
              Effect.succeed({ added: 0, rowIds: [] as readonly string[], tableId: args.tableId, workspaceId }),
            ),
          );
          added = r.added;
        }
        // `workspaceId` rides along so the caller (the tRPC router) can key the
        // post-create warm-up event without re-resolving the table.
        return { bindingId, searchId, added, workspaceId };
      });

    const listByTable = (tableId: string) =>
      Effect.gen(function* () {
        const table = yield* grid.findTable(tableId);
        if (Option.isNone(table)) return [] as readonly SignalBinding[];
        yield* membership.requireMember(table.value.workspaceId);
        yield* entitlement.requireCloudAccess(table.value.workspaceId);
        return yield* repo.listByTable(tableId);
      });

    const remove = (bindingId: string) =>
      Effect.gen(function* () {
        const binding = yield* repo.findById(bindingId);
        if (Option.isNone(binding)) return;
        yield* membership.requireMember(binding.value.workspaceId);
        yield* entitlement.requireCloudAccess(binding.value.workspaceId);
        yield* repo.remove(bindingId);
      });

    /** Membership-gated, entitlement-gated manual "pull now". */
    const sync = (bindingId: string) =>
      Effect.gen(function* () {
        const binding = yield* repo.findById(bindingId);
        if (Option.isNone(binding)) return yield* Effect.fail(new SignalError({ message: "Binding not found" }));
        yield* membership.requireMember(binding.value.workspaceId);
        yield* entitlement.requireCloudAccess(binding.value.workspaceId);
        const apiKey = yield* trigifyKey(binding.value.workspaceId);
        // Manual "pull now" preserves its numeric contract (rows added).
        return (yield* runSync(binding.value, apiKey)).added;
      });

    /**
     * Worker path (NO membership) — the cron's trust boundary is its worker
     * secret. Still entitlement-gated: a workspace whose trial lapsed (Free) must
     * not get server-side pulls of a paid feature, so {@link requireCloudAccess}
     * skips it (the worker caller treats the resulting failure as "skip binding").
     * Reads the key via the membership-free {@link workerTrigifyKey}.
     */
    const syncForWorker = (bindingId: string) =>
      Effect.gen(function* () {
        const binding = yield* repo.findById(bindingId);
        if (Option.isNone(binding)) {
          return { added: 0, rowIds: [] as readonly string[], tableId: null, workspaceId: null };
        }
        yield* entitlement.requireCloudAccess(binding.value.workspaceId);
        const apiKey = yield* workerTrigifyKey(binding.value.workspaceId);
        // Returns the new rowIds so the cron can enqueue per-row enrichment.
        return yield* runSync(binding.value, apiKey);
      });

    /**
     * One keyset page of DUE bindings — the cron's fan-out source. The due
     * predicate (enabled + schedule interval) is resolved in SQL with a LIMIT, so
     * the worker enqueues bounded batches instead of scanning + JS-filtering the
     * whole enabled population.
     */
    const listDuePage = (args: { now: number; limit: number; cursor: SignalDueCursor | null }) =>
      repo.listDuePage(args);

    return { create, listByTable, remove, sync, syncForWorker, listDuePage } as const;
  }),
}) {}
