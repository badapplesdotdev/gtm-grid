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

import { MembershipService } from "@gtmgrid/cloud";
import { Data, Effect, Option } from "effect";
import {
  getSignalSource,
  getPath,
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
} from "../repositories/signal-repo.js";
import { WebhookRepo } from "../repositories/webhook-repo.js";

const SEEN_CAP = 1000;

/** Raised for Trigify/source failures (bad source id, search not created, HTTP error). */
export class SignalError extends Data.TaggedError("SignalError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface CreateArgs {
  readonly tableId: string;
  readonly sourceId: string;
  readonly name: string;
  readonly config: Record<string, unknown>;
  readonly schedule: string;
  /** field-path → columnId (resolved by the client after creating the columns). */
  readonly columns: readonly SignalBindingColumn[];
}

/** Trigify REST: create a search; returns its id. */
function createTrigifySearch(apiKey: string, createPath: string, body: Record<string, unknown>): Promise<string> {
  return fetch(`${TRIGIFY_BASE}${createPath}`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  }).then(async (res) => {
    const text = await res.text();
    if (!res.ok) throw new Error(`Trigify create ${res.status}: ${text.slice(0, 200)}`);
    const data = text ? JSON.parse(text) : {};
    const id = data?.id ?? data?.search_id ?? data?.data?.id ?? data?.search?.id ?? null;
    if (!id) throw new Error("Trigify create returned no search id");
    return String(id);
  });
}

/** Trigify REST: fetch results for a search. */
function fetchTrigifyResults(apiKey: string, resultsPath: string, searchId: string): Promise<unknown> {
  const path = resultsPath.replace("{id}", encodeURIComponent(searchId));
  return fetch(`${TRIGIFY_BASE}${path}?limit=100`, {
    headers: { "x-api-key": apiKey, accept: "application/json" },
  }).then(async (res) => {
    const text = await res.text();
    if (!res.ok) throw new Error(`Trigify results ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : [];
  });
}

export class SignalService extends Effect.Service<SignalService>()("SignalService", {
  effect: Effect.gen(function* () {
    const repo = yield* SignalRepo;
    const grid = yield* WebhookRepo;
    const credentials = yield* CredentialService;
    const membership = yield* MembershipService;
    const entitlement = yield* EntitlementService;

    /** Decrypt the workspace-shared Trigify API key (membership-free run path). */
    const trigifyKey = (workspaceId: string) =>
      Effect.gen(function* () {
        const credOpt = yield* credentials.getCredentialForRun({
          workspaceId,
          extensionId: "trigify",
          scope: "workspace",
        });
        const secrets = Option.getOrNull(credOpt);
        const apiKey = (secrets?.apiKey as string | undefined) ?? (secrets?.key as string | undefined) ?? "";
        if (!apiKey) return yield* Effect.fail(new SignalError({ message: "No Trigify API key connected for this workspace." }));
        return apiKey;
      });

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
          catch: (cause) => new SignalError({ message: cause instanceof Error ? cause.message : "Trigify results failed", cause }),
        });
        const results = normalizeResults(resp);

        const seen = new Set(binding.seen ?? []);
        const fresh = results.filter((r) => {
          const k = resultKey(r);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });

        let added = 0;
        if (fresh.length > 0) {
          const existing = yield* grid.listRows(binding.tableId);
          let pos = existing.reduce((m, r) => Math.max(m, r.position), 0);
          const now = Date.now();
          for (const r of fresh) {
            pos += 1;
            const rowId = yield* grid.insertRow({
              workspaceId: binding.workspaceId,
              tableId: binding.tableId,
              position: pos,
              createdAt: now,
            });
            for (const col of binding.columns) {
              const value = toCellValue(getPath(r, col.key));
              if (value === "") continue;
              yield* grid.insertCell({
                workspaceId: binding.workspaceId,
                tableId: binding.tableId,
                rowId,
                columnId: col.columnId,
                cell: { value, status: "done", error: null, updatedAt: now },
              });
            }
            added += 1;
          }
        }

        yield* repo.patch(binding.id, {
          lastSyncedAt: Date.now(),
          lastError: null,
          rowsPulled: (binding.rowsPulled ?? 0) + added,
          seen: [...seen].slice(-SEEN_CAP),
        });
        return added;
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
          catch: (cause) => new SignalError({ message: cause instanceof Error ? cause.message : "Trigify create failed", cause }),
        });

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
          added = yield* runSync(binding.value, apiKey).pipe(Effect.catchTag("SignalError", () => Effect.succeed(0)));
        }
        return { bindingId, searchId, added };
      });

    const listByTable = (tableId: string) =>
      Effect.gen(function* () {
        const table = yield* grid.findTable(tableId);
        if (Option.isNone(table)) return [] as readonly SignalBinding[];
        yield* membership.requireMember(table.value.workspaceId);
        return yield* repo.listByTable(tableId);
      });

    const remove = (bindingId: string) =>
      Effect.gen(function* () {
        const binding = yield* repo.findById(bindingId);
        if (Option.isNone(binding)) return;
        yield* membership.requireMember(binding.value.workspaceId);
        yield* repo.remove(bindingId);
      });

    /** Membership-gated manual "pull now". */
    const sync = (bindingId: string) =>
      Effect.gen(function* () {
        const binding = yield* repo.findById(bindingId);
        if (Option.isNone(binding)) return yield* Effect.fail(new SignalError({ message: "Binding not found" }));
        yield* membership.requireMember(binding.value.workspaceId);
        const apiKey = yield* trigifyKey(binding.value.workspaceId);
        return yield* runSync(binding.value, apiKey);
      });

    /** Worker path (NO membership) — the cron's trust boundary is its worker secret. */
    const syncForWorker = (bindingId: string) =>
      Effect.gen(function* () {
        const binding = yield* repo.findById(bindingId);
        if (Option.isNone(binding)) return 0;
        const apiKey = yield* trigifyKey(binding.value.workspaceId);
        return yield* runSync(binding.value, apiKey);
      });

    /** Every enabled binding (worker scans for due ones). */
    const listAllEnabled = () => repo.listAllEnabled();

    return { create, listByTable, remove, sync, syncForWorker, listAllEnabled } as const;
  }),
}) {}
