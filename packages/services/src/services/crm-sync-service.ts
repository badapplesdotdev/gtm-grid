/**
 * `CrmSyncService` — the CRM→grid sync engine (TRI: crm-sync). Mirrors
 * {@link SignalService}'s member/worker split:
 *
 * - Member paths (tRPC): `listSources` / `describeSource` / `estimate` feed the
 *   wizard; `create` builds the synced columns + binding; `guardSyncNow`
 *   validates a manual sync before the router enqueues it; `listByTable` /
 *   `listRuns` feed the status strip + sync log; `remove` deletes a binding
 *   (grid rows stay).
 * - Worker path (Inngest): `syncPageForWorker` executes one provider page per
 *   durable invocation. ALL sync execution goes through the worker — manual
 *   "Sync now" only enqueues — so observability, retries, and concurrency
 *   limits live in exactly one place.
 *
 * The sync algorithm (`runSyncPage`):
 *   resolve live attributes (schema drift → drop column, keep going) → page
 *   records 500 at a time (server-side prefilter where expressible, worker
 *   filters ALWAYS re-checked) → flatten typed values to cell text (references
 *   resolved to names in per-page batches; actor names cached per run) → apply the binding's dedupe mode
 *   (update = hash-guarded upsert on record id or match key / skip / always
 *   create) under the plan's row cap → after a FULLY complete pull, mark
 *   vanished records' rows stale (never delete; user enrichment survives) →
 *   finalize a `crm_sync_runs` row whose `error` is already user-safe copy.
 */

import { createHash } from "node:crypto";
import { Effect, Option } from "effect";
import { MembershipService } from "@gtmgrid/cloud";
import { isSupportedAttrType, matchesAllFilters, type CrmFilter } from "../crm/crm-values.js";
import { crmErrorCopy } from "../crm/error-copy.js";
import { CrmSyncError, RowCapReached, type CrmError } from "../crm/errors.js";
import {
  CrmBindingRepo,
  CrmSyncedRowRepo,
  CrmSyncRunRepo,
  type CrmBinding,
  type CrmBindingColumn,
  type CrmSyncedRowUpsert,
} from "../repositories/crm-repo.js";
import { ColumnRepo } from "../repositories/column-repo.js";
import { WebhookRepo } from "../repositories/webhook-repo.js";
import { WorkspaceRepo } from "../repositories/workspace-repo.js";
import type { GridChangeEvent } from "../realtime/events.js";
import { CrmClientRegistry } from "./crm-client-registry.js";
import type { CrmAttrRef, CrmClientApi, CrmProvider, CrmRecord, CrmSession } from "./crm-client.js";
import { CrmConnectionService } from "./crm-connection-service.js";
import { EntitlementService } from "./entitlement-service.js";
import { RealtimePublisher } from "./realtime-publisher.js";

// ── Config + caps ─────────────────────────────────────────────────────────────

export type CrmDedupeMode = "update" | "skip" | "create";

export interface CrmBindingConfig {
  readonly filters: readonly CrmFilter[];
  readonly dedupeMode: CrmDedupeMode;
  /** Attribute slug rows upsert on in `update` mode (e.g. "email_addresses"). */
  readonly matchKeyAttr: string | null;
}

/** Plan-tiered per-table row caps (locked product decision). */
export const CRM_ROW_CAP_TEAM = 10_000;
export const CRM_ROW_CAP_SCALE = 50_000;

export const planRowCap = (planId: string | null): number =>
  planId === null || planId === "team" ? CRM_ROW_CAP_TEAM : CRM_ROW_CAP_SCALE;

/**
 * Hard bound on pages fetched per run: enough to fill the biggest cap plus
 * slack for worker-side filters discarding records, but never unbounded —
 * a low-match filter over a huge object must not page forever. Derived from
 * the provider's page size (500 Attio, 100 HubSpot) so smaller pages don't
 * truncate sooner.
 */
const maxPagesPerRun = (pageLimit: number): number => CRM_ROW_CAP_SCALE / pageLimit + 40;

/**
 * A `running` run whose heartbeat is older than this is treated as a crashed
 * leftover. Total run age is irrelevant because durable page chains may
 * legitimately run much longer.
 */
export const SYNC_STALE_RUN_MS = 30 * 60 * 1000;

/** Sync-log copy when the page budget ran out before the source did. */
const PAGE_BUDGET_COPY =
  "This source is very large, so we synced part of it this run. We'll continue at the next sync.";

export const parseBindingConfig = (config: Record<string, unknown>): CrmBindingConfig => {
  const filters = Array.isArray(config.filters)
    ? config.filters.flatMap((f): CrmFilter[] => {
        if (f === null || typeof f !== "object") return [];
        const r = f as Record<string, unknown>;
        return typeof r.attrSlug === "string" &&
          typeof r.attrType === "string" &&
          isSupportedAttrType(r.attrType) &&
          typeof r.op === "string" &&
          typeof r.value === "string"
          ? [{ attrSlug: r.attrSlug, attrType: r.attrType, op: r.op as CrmFilter["op"], value: r.value }]
          : [];
      })
    : [];
  const dedupeMode: CrmDedupeMode =
    config.dedupeMode === "skip" || config.dedupeMode === "create" ? config.dedupeMode : "update";
  return {
    filters,
    dedupeMode,
    matchKeyAttr:
      typeof config.matchKeyAttr === "string" && config.matchKeyAttr !== "" ? config.matchKeyAttr : null,
  };
};

/**
 * Hash of a record's SYNCED-column texts only. Filter/match-key attributes are
 * flattened for evaluation but never written to cells — including them made an
 * upstream change to a filter-only attribute rewrite every cell with identical
 * values (inflating rowsUpdated + spamming realtime).
 */
const hashValues = (texts: ReadonlyMap<string, string>, slugs: ReadonlyArray<string>): string => {
  const h = createHash("sha256");
  for (const slug of [...slugs].sort()) h.update(`${slug} ${texts.get(slug) ?? ""} `);
  return h.digest("hex");
};

/** Match keys compare case-insensitively (emails/domains) and trimmed. */
const normalizeMatchKey = (text: string): string | null => {
  const t = text.trim().toLowerCase();
  return t === "" ? null : t;
};

// ── Public result shapes ──────────────────────────────────────────────────────

export interface CrmSyncOutcome {
  readonly runId: string;
  readonly bindingId: string;
  readonly tableId: string;
  readonly workspaceId: string;
  readonly provider: string;
  readonly status: "ok" | "partial" | "warn" | "failed";
  readonly rowsCreated: number;
  readonly rowsUpdated: number;
  readonly rowsSkipped: number;
  readonly rowsStaled: number;
  readonly fieldsDropped: readonly string[];
  /** User-safe sync-log copy for non-ok outcomes (already translated). */
  readonly error: string | null;
  /** The failure tag for analytics (never shown to users). */
  readonly errorTag: string | null;
}

/**
 * Serializable checkpoint carried between Inngest steps. A checkpoint is
 * emitted only after one provider page and its database writes have completed.
 */
export interface CrmSyncPageState {
  readonly runId: string;
  readonly bindingId: string;
  readonly cursor: string;
  readonly pages: number;
  readonly rowsCreated: number;
  readonly rowsUpdated: number;
  readonly rowsSkipped: number;
  readonly remainingRowBudget: number;
  readonly plan: {
    readonly cap: number;
    readonly activeCols: readonly CrmBindingColumn[];
    readonly activeFilters: readonly CrmFilter[];
    readonly pullAttrs: readonly CrmAttrRef[];
    readonly fieldsDropped: readonly string[];
  };
  /** Cached actor display names; unlike reference names this set is run-bounded. */
  readonly members: readonly (readonly [string, string])[] | null;
}

export interface CrmSyncPageResult {
  /** Non-null only when the provider pull and run finalization are complete. */
  readonly outcome: CrmSyncOutcome | null;
  /** Non-null when another provider page must run in a fresh durable step. */
  readonly next: CrmSyncPageState | null;
  /** Rows inserted by this page only, so enrichment can fan out incrementally. */
  readonly newRowIds: readonly string[];
  readonly tableId: string;
  readonly workspaceId: string;
}

export interface CrmSourceSummary {
  readonly kind: "object" | "list";
  readonly id: string;
  readonly label: string;
  /** For lists: the object slug entries belong to. */
  readonly parentObject: string | null;
}

export interface CrmSourceField {
  readonly slug: string;
  readonly title: string;
  readonly type: string;
  readonly recommended: boolean;
  readonly sample: string;
}

export interface CrmSourceDescription {
  readonly fields: readonly CrmSourceField[];
  readonly suggestedMatchKey: string | null;
}

export interface CrmEstimate {
  readonly count: number;
  /** True when the probe page was full — the real count is at least `count`. */
  readonly isLowerBound: boolean;
}

export interface CreateCrmBindingArgs {
  readonly tableId: string;
  readonly provider: CrmProvider;
  readonly sourceKind: "object" | "list";
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly fields: ReadonlyArray<{ readonly attrSlug: string; readonly attrType: string; readonly title: string }>;
  readonly filters: readonly CrmFilter[];
  readonly dedupeMode: CrmDedupeMode;
  readonly matchKeyAttr: string | null;
}

/** A binding plus its newest run — what the status strip consumes. */
export interface CrmBindingWithRun extends CrmBinding {
  readonly lastRun: {
    readonly id: string;
    readonly status: string;
    readonly trigger: string;
    readonly rowsCreated: number;
    readonly rowsUpdated: number;
    readonly startedAt: number;
  } | null;
}

interface FlatRecord {
  readonly externalId: string;
  readonly texts: ReadonlyMap<string, string>;
}

/** Attribute slugs favored as recommended fields in the wizard. */
const RECOMMENDED_SLUGS = new Set([
  "name",
  "email_addresses",
  "domains",
  "company",
  "job_title",
  "title",
  "stage",
  "status",
  "owner",
  "value",
  "amount",
  "primary_location",
]);
const RECOMMENDED_TYPES = new Set(["email-address", "domain", "personal-name", "status"]);

export class CrmSyncService extends Effect.Service<CrmSyncService>()("CrmSyncService", {
  effect: Effect.gen(function* () {
    const bindings = yield* CrmBindingRepo;
    const syncedRows = yield* CrmSyncedRowRepo;
    const runs = yield* CrmSyncRunRepo;
    const grid = yield* WebhookRepo;
    const columns = yield* ColumnRepo;
    const registry = yield* CrmClientRegistry;
    const connections = yield* CrmConnectionService;
    const membership = yield* MembershipService;
    const entitlement = yield* EntitlementService;
    const workspaces = yield* WorkspaceRepo;
    const realtime = yield* RealtimePublisher;

    /** Best-effort broadcast — realtime must never fail a sync write. */
    const publish = (workspaceId: string, tableId: string, event: GridChangeEvent) =>
      realtime.publish({ workspaceId, tableId, event }).pipe(Effect.catchAll(() => Effect.void));

    const rowCapFor = (workspaceId: string) =>
      workspaces.findById(workspaceId).pipe(
        Effect.map((ws) =>
          planRowCap(Option.match(ws, { onNone: () => null, onSome: (w) => w.currentPlanId ?? null })),
        ),
        Effect.mapError((e) => new CrmSyncError({ message: "workspace lookup failed", cause: e })),
      );

    const requireBinding = (bindingId: string) =>
      Effect.gen(function* () {
        const found = yield* bindings
          .findById(bindingId)
          .pipe(Effect.mapError((e) => new CrmSyncError({ message: "binding lookup failed", cause: e })));
        if (Option.isNone(found)) return yield* Effect.fail(new CrmSyncError({ message: "Binding not found" }));
        return found.value;
      });

    const mapRepoError = <A, R>(effect: Effect.Effect<A, unknown, R>, message: string) =>
      effect.pipe(
        Effect.mapError((e) =>
          e !== null && typeof e === "object" && "_tag" in e &&
          (String((e as { _tag: string })._tag).startsWith("Crm") || (e as { _tag: string })._tag === "RowCapReached")
            ? (e as CrmError)
            : new CrmSyncError({ message, cause: e }),
        ),
      );

    // ── Flattening with batched reference/actor resolution ──────────────────

    interface ResolveCache {
      readonly refNames: Map<string, string>; // `${object} ${recordId}` → name
      members: ReadonlyMap<string, string> | null;
    }

    const newCache = (
      members: readonly (readonly [string, string])[] | null = null,
    ): ResolveCache => ({
      refNames: new Map(),
      members: members === null ? null : new Map(members),
    });

    /**
     * Resolve `records`' pre-flattened values to final cell text, batch-
     * resolving record references + actors through bounded caches (one query
     * per referenced object per page + one members fetch per run,
     * instead of per-cell lookups). Flattening itself happens inside the
     * provider client — the engine never sees raw CRM value shapes. Reference
     * names are batched per provider page; the bounded actor/member map is
     * carried in the durable checkpoint and fetched at most once per run.
     */
    const resolveRecords = (
      client: CrmClientApi,
      session: CrmSession,
      records: readonly CrmRecord[],
      cache: ResolveCache,
    ): Effect.Effect<readonly FlatRecord[], CrmError> =>
      Effect.gen(function* () {
        const wantRefs = new Map<string, Set<string>>();
        let wantMembers = false;
        for (const rec of records) {
          for (const v of Object.values(rec.values)) {
            if (v.kind === "ref" && !cache.refNames.has(`${v.targetObject} ${v.targetRecordId}`)) {
              const set = wantRefs.get(v.targetObject) ?? new Set<string>();
              set.add(v.targetRecordId);
              wantRefs.set(v.targetObject, set);
            }
            if (v.kind === "actor" && cache.members === null) wantMembers = true;
          }
        }
        for (const [object, ids] of wantRefs) {
          const idList = [...ids];
          const names = yield* client.resolveRecordNames(session, { object, ids: idList });
          for (const id of idList) cache.refNames.set(`${object} ${id}`, names.get(id) ?? "");
        }
        if (wantMembers) cache.members = yield* client.listMembers(session);

        return records.map((rec) => {
          const texts = new Map<string, string>();
          for (const [slug, v] of Object.entries(rec.values)) {
            texts.set(
              slug,
              v.kind === "text"
                ? v.text
                : v.kind === "ref"
                  ? (cache.refNames.get(`${v.targetObject} ${v.targetRecordId}`) ?? "")
                  : (cache.members?.get(v.actorId) ?? ""),
            );
          }
          return { externalId: rec.recordId, texts };
        });
      });

    /** One page of source records (object query, or list entries → records). */
    const pullPage = (
      client: CrmClientApi,
      session: CrmSession,
      binding: {
        readonly sourceKind: string;
        readonly sourceId: string;
        readonly sourceLabel: string;
      },
      serverFilter: unknown | undefined,
      attrs: readonly CrmAttrRef[],
      cursor: string | null,
    ): Effect.Effect<{ records: readonly CrmRecord[]; nextCursor: string | null }, CrmError> =>
      binding.sourceKind === "list"
        ? Effect.gen(function* () {
            const page = yield* client.queryListEntries(session, {
              listId: binding.sourceId,
              sourceLabel: binding.sourceLabel,
              limit: client.pageLimit,
              cursor,
            });
            const metaParent = yield* client.getListParent(session, {
              listId: binding.sourceId,
              sourceLabel: binding.sourceLabel,
            });
            const parent = metaParent !== "" ? metaParent : (page.items.find((e) => e.parentObject !== "")?.parentObject ?? "");
            const ids = page.items.map((e) => e.parentRecordId).filter((id) => id !== "");
            const records =
              parent === "" || ids.length === 0
                ? ([] as readonly CrmRecord[])
                : yield* client.queryRecordsByIds(session, {
                    object: parent,
                    sourceLabel: binding.sourceLabel,
                    attrs,
                    ids,
                  });
            // Count-level diagnostics (no record data): a list pull that lands
            // nothing must be explainable from host logs.
            yield* Effect.logWarning("crm list page").pipe(
              Effect.annotateLogs({
                listId: binding.sourceId,
                cursor: cursor ?? "start",
                entries: page.items.length,
                parent,
                parentIds: ids.length,
                records: records.length,
              }),
            );
            return { records, nextCursor: page.nextCursor };
          })
        : client
            .queryObjectRecords(session, {
              object: binding.sourceId,
              sourceLabel: binding.sourceLabel,
              attrs,
              ...(serverFilter !== undefined ? { filter: serverFilter } : {}),
              limit: client.pageLimit,
              cursor,
            })
            .pipe(Effect.map((page) => ({ records: page.items, nextCursor: page.nextCursor })));

    // ── The sync loop ─────────────────────────────────────────────────────────

    const runSyncPage = (
      binding: CrmBinding,
      session: CrmSession,
      trigger: "cron" | "manual" | "warmup",
      checkpoint: CrmSyncPageState | null,
    ): Effect.Effect<CrmSyncPageResult, CrmSyncError> =>
      Effect.gen(function* () {
        const client = registry.forProvider(binding.provider);
        const runId =
          checkpoint?.runId ??
          (yield* mapRepoError(
            runs.start({
              workspaceId: binding.workspaceId,
              bindingId: binding.id,
              tableId: binding.tableId,
              trigger,
              startedAt: Date.now(),
            }),
            "sync run start failed",
          ).pipe(Effect.mapError((e) => new CrmSyncError({ message: "sync run start failed", cause: e }))));

        const cfg = parseBindingConfig(binding.config);
        const counters = {
          created: checkpoint?.rowsCreated ?? 0,
          updated: checkpoint?.rowsUpdated ?? 0,
          skipped: checkpoint?.rowsSkipped ?? 0,
          staled: 0,
        };
        const newRowIds: string[] = [];
        let fieldsDropped: readonly string[] = checkpoint?.plan.fieldsDropped ?? [];
        let capped = false;
        let pageBudgetExhausted = false;
        let nextCursor: string | null = checkpoint?.cursor ?? null;
        let pagesCompleted = checkpoint?.pages ?? 0;
        let remainingRowBudget = checkpoint?.remainingRowBudget ?? 0;
        let members = checkpoint?.members ?? null;
        let runPlan = checkpoint?.plan ?? null;

        const work = Effect.gen(function* () {
          if (runPlan === null) {
            const cap = yield* rowCapFor(binding.workspaceId);
            // Resolve schema once per run, then carry the immutable plan in the
            // checkpoint instead of repeating provider metadata calls per page.
            const liveAttrs = yield* client.getAttributes(
              session,
              binding.sourceKind === "list" ? "lists" : "objects",
              binding.sourceId,
              binding.sourceLabel,
            );
            const liveSlugs = new Set(liveAttrs.map((a) => a.slug));
            if (binding.sourceKind === "list") {
              const parent = yield* client.getListParent(session, {
                listId: binding.sourceId,
                sourceLabel: binding.sourceLabel,
              });
              if (parent !== "") {
                const parentAttrs = yield* client.getAttributes(session, "objects", parent, binding.sourceLabel);
                for (const a of parentAttrs) liveSlugs.add(a.slug);
              }
            }
            const activeCols = binding.columns.filter((c) => liveSlugs.has(c.attrSlug));
            const activeFilters = cfg.filters.filter((f) => liveSlugs.has(f.attrSlug));
            const flattenCols: Array<{ attrSlug: string; attrType: string }> = [...activeCols];
            for (const f of activeFilters) {
              if (!flattenCols.some((c) => c.attrSlug === f.attrSlug)) {
                flattenCols.push({ attrSlug: f.attrSlug, attrType: f.attrType });
              }
            }
            if (cfg.matchKeyAttr !== null && !flattenCols.some((c) => c.attrSlug === cfg.matchKeyAttr)) {
              const live = liveAttrs.find((a) => a.slug === cfg.matchKeyAttr);
              if (live !== undefined) flattenCols.push({ attrSlug: live.slug, attrType: live.type });
            }
            fieldsDropped = binding.columns.filter((c) => !liveSlugs.has(c.attrSlug)).map((c) => c.title);
            runPlan = {
              cap,
              activeCols,
              activeFilters,
              pullAttrs: flattenCols.map((c) => ({ slug: c.attrSlug, type: c.attrType })),
              fieldsDropped,
            };
            const preexisting =
              cfg.dedupeMode === "create"
                ? (binding.rowsSynced ?? 0)
                : yield* mapRepoError(syncedRows.countByBinding(binding.id), "synced-row count failed");
            remainingRowBudget = Math.max(0, cap - preexisting);
          }

          const plan = runPlan;
          const activeCols = plan.activeCols;
          const activeSlugs = activeCols.map((c) => c.attrSlug);
          const activeFilters = plan.activeFilters;
          const serverFilter = client.compileServerFilter(
            activeFilters,
            binding.sourceKind === "list" ? "list" : "object",
          );
          const cache = newCache(members);
          const cursor: string | null = checkpoint?.cursor ?? null;
          const pages = checkpoint?.pages ?? 0;
          if (pages >= maxPagesPerRun(client.pageLimit)) {
            pageBudgetExhausted = true;
            return { pullComplete: false, plan };
          }

            const page: { records: readonly CrmRecord[]; nextCursor: string | null } = yield* pullPage(
              client,
              session,
              binding,
              serverFilter,
              plan.pullAttrs,
              cursor,
            );
            const records = page.records;

            yield* Effect.logWarning("crm page classify").pipe(
              Effect.annotateLogs({ bindingId: binding.id, cursor: cursor ?? "start", records: records.length }),
            );
            nextCursor = page.nextCursor;
            pagesCompleted = pages + 1;
            if (records.length > 0) {
              const flats = yield* resolveRecords(client, session, records, cache);
              const textOf = (fr: FlatRecord, slug: string) => fr.texts.get(slug) ?? "";
              const kept = flats.filter(
                (fr) => fr.externalId !== "" && matchesAllFilters(activeFilters, (slug) => textOf(fr, slug)),
              );

              // Identity lookups for the whole page at once.
              const keptIds = kept.map((fr) => fr.externalId);
              const existingList =
                cfg.dedupeMode === "create"
                  ? []
                  : yield* mapRepoError(syncedRows.findByExternalIds(binding.id, keptIds), "identity lookup failed");
              const byExternal = new Map(existingList.map((e) => [e.externalId, e]));

              const matchKeyOf = (fr: FlatRecord): string | null =>
                cfg.matchKeyAttr === null ? null : normalizeMatchKey(textOf(fr, cfg.matchKeyAttr));

              // Update mode: records new by id may still match an existing row by key.
              const byMatchKey = new Map<string, (typeof existingList)[number]>();
              if (cfg.dedupeMode === "update" && cfg.matchKeyAttr !== null) {
                const unknownKeys = kept
                  .filter((fr) => !byExternal.has(fr.externalId))
                  .map(matchKeyOf)
                  .filter((k): k is string => k !== null);
                const matches = yield* mapRepoError(
                  syncedRows.findByMatchKeys(binding.id, unknownKeys),
                  "match-key lookup failed",
                );
                for (const m of matches) if (m.matchKey !== null) byMatchKey.set(m.matchKey, m);
              }

              const toInsert: FlatRecord[] = [];
              const toUpdate: Array<{ fr: FlatRecord; rowId: string }> = [];
              const seenExternalIds: string[] = [];
              // Match keys already claimed by an insert EARLIER IN THIS PAGE:
              // two never-synced records sharing an email must not both insert
              // (the DB lookup only covers already-persisted rows, so without
              // this, dedupe silently depended on page boundaries).
              const pendingMatchKeys = new Set<string>();

              for (const fr of kept) {
                const key = matchKeyOf(fr);
                if (cfg.dedupeMode === "update" && key !== null && pendingMatchKeys.has(key)) {
                  counters.skipped += 1;
                  continue;
                }
                const existing =
                  byExternal.get(fr.externalId) ??
                  (cfg.dedupeMode === "update" ? byMatchKey.get(matchKeyOf(fr) ?? " ") : undefined);
                if (cfg.dedupeMode === "create") {
                  toInsert.push(fr);
                } else if (existing === undefined) {
                  if (cfg.dedupeMode === "update" && key !== null) pendingMatchKeys.add(key);
                  toInsert.push(fr);
                } else if (cfg.dedupeMode === "skip") {
                  counters.skipped += 1;
                  seenExternalIds.push(fr.externalId);
                } else if (existing.valuesHash === hashValues(fr.texts, activeSlugs)) {
                  // Unchanged — just mark seen (stale pass + skip accounting).
                  seenExternalIds.push(fr.externalId);
                } else {
                  toUpdate.push({ fr, rowId: existing.rowId });
                }
              }

              // Enforce the plan cap on NEW rows only (updates always allowed).
              let inserts = toInsert;
              if (inserts.length > remainingRowBudget) {
                inserts = inserts.slice(0, remainingRowBudget);
                capped = true;
              }
              remainingRowBudget -= inserts.length;

              const now = Date.now();
              if (inserts.length > 0) {
                const base = yield* mapRepoError(grid.maxRowPosition(binding.tableId), "row position failed");
                const cellsForIds = (ids: readonly string[]) =>
                  inserts.flatMap((fr, i) => {
                    const rowId = ids[i];
                    if (rowId === undefined) return [];
                    return activeCols.flatMap((col) => {
                      const value = fr.texts.get(col.attrSlug) ?? "";
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
                // ONE transaction: a row can never be read without its cells
                // (the two-step path let paged reads race the gap and render
                // whole pages of blank rows mid-sync).
                const rowIds = yield* mapRepoError(
                  grid.insertRowsWithCellsBulk(
                    inserts.map((_fr, i) => ({
                      workspaceId: binding.workspaceId,
                      tableId: binding.tableId,
                      position: base + i + 1,
                      createdAt: now,
                    })),
                    cellsForIds,
                  ),
                  "row+cell insert failed",
                );
                const cells = cellsForIds(rowIds);
                counters.created += rowIds.length;
                newRowIds.push(...rowIds);
                // Open grids see the pulled records land live, WITH their cell
                // values (the worker path can't publish these — only the page worker
                // knows the flattened values).
                yield* Effect.forEach(
                  rowIds,
                  (rowId) =>
                    publish(binding.workspaceId, binding.tableId, {
                      type: "row.insert",
                      row: { _id: rowId },
                      cells: cells
                        .filter((c) => c.rowId === rowId)
                        .map((c) => ({
                          rowId: c.rowId,
                          columnId: c.columnId,
                          value: c.cell.value,
                          status: c.cell.status,
                          error: c.cell.error,
                        })),
                    }),
                  // Bounded fan-out: sequential publishing was up to 500 serial
                  // HTTP POSTs per Attio page.
                  { concurrency: 8, discard: true },
                );

                if (cfg.dedupeMode !== "create") {
                  const entries: CrmSyncedRowUpsert[] = inserts.flatMap((fr, i) => {
                    const rowId = rowIds[i];
                    return rowId === undefined
                      ? []
                      : [
                          {
                            bindingId: binding.id,
                            rowId,
                            externalId: fr.externalId,
                            matchKey: matchKeyOf(fr),
                            valuesHash: hashValues(fr.texts, activeSlugs),
                            lastSeenRunId: runId,
                            createdAt: now,
                          },
                        ];
                  });
                  yield* mapRepoError(syncedRows.upsertMany(entries), "identity upsert failed");
                }
              }

              if (toUpdate.length > 0) {
                // Only records whose values actually changed reach here, so a
                // daily sync of a static CRM does zero cell writes.
                yield* Effect.forEach(
                  toUpdate.flatMap(({ fr, rowId }) =>
                    activeCols.map((col) => ({
                      rowId,
                      columnId: col.columnId,
                      value: fr.texts.get(col.attrSlug) ?? "",
                    })),
                  ),
                  (cell) =>
                    mapRepoError(
                      grid.upsertCell({
                        workspaceId: binding.workspaceId,
                        tableId: binding.tableId,
                        rowId: cell.rowId,
                        columnId: cell.columnId,
                        patch: { hasValue: true, value: cell.value, status: "done", error: null },
                        meter: false, // CRM sync is free (locked product decision)
                        updatedAt: now,
                      }),
                      "cell update failed",
                    ),
                  { concurrency: 8, discard: true },
                );
                yield* Effect.forEach(
                  toUpdate.flatMap(({ fr, rowId }) =>
                    activeCols.map((col) => ({
                      rowId,
                      columnId: col.columnId,
                      value: fr.texts.get(col.attrSlug) ?? "",
                    })),
                  ),
                  (cell) =>
                    publish(binding.workspaceId, binding.tableId, {
                      type: "cell.upsert",
                      cell: { rowId: cell.rowId, columnId: cell.columnId, value: cell.value, status: "done", error: null },
                    }),
                  { discard: true },
                );
                yield* mapRepoError(
                  syncedRows.upsertMany(
                    toUpdate.map(({ fr, rowId }) => ({
                      bindingId: binding.id,
                      rowId,
                      externalId: fr.externalId,
                      matchKey: matchKeyOf(fr),
                      valuesHash: hashValues(fr.texts, activeSlugs),
                      lastSeenRunId: runId,
                      createdAt: now,
                    })),
                  ),
                  "identity upsert failed",
                );
                counters.updated += toUpdate.length;
              }

              if (seenExternalIds.length > 0) {
                yield* mapRepoError(
                  syncedRows.touchSeen(binding.id, seenExternalIds, runId),
                  "seen touch failed",
                );
              }
            }
            members = cache.members === null ? null : [...cache.members.entries()];

            // Live progress for the strip ("Pulling records… N so far").
            // Best-effort: a progress hiccup must never fail the pull.
            yield* runs
              .progress(runId, {
                rowsCreated: counters.created,
                rowsUpdated: counters.updated,
                rowsSkipped: counters.skipped,
                progressedAt: Date.now(),
              })
              .pipe(Effect.catchAll(() => Effect.void));

          // Complete pull = the provider says the source is exhausted (never
          // a page-length heuristic) — the stale pass depends on this.
          const pullComplete = nextCursor === null;

          // 3. Stale pass — ONLY after a complete pull (a truncated pull would
          // false-stale everything it didn't reach), and never in create mode
          // (no record→row identity there).
          if (pullComplete && !capped && cfg.dedupeMode !== "create") {
            counters.staled = yield* mapRepoError(
              syncedRows.markStaleNotSeen(binding.id, runId),
              "stale marking failed",
            );
          }

          if (capped) return yield* Effect.fail(new RowCapReached({ cap: plan.cap }));
          return { pullComplete, plan };
        });

        // Outcome assembly: successes and typed failures both finalize the run
        // row + binding with USER-SAFE copy; only run-row bookkeeping failures
        // escape as CrmSyncError.
        const finalize = (
          status: CrmSyncOutcome["status"],
          error: string | null,
          errorTag: string | null,
          pause: "auth_revoked" | "source_gone" | null,
        ) =>
          Effect.gen(function* () {
            const finishedAt = Date.now();
            yield* mapRepoError(
              runs.finish(runId, {
                status,
                rowsCreated: counters.created,
                rowsUpdated: counters.updated,
                rowsSkipped: counters.skipped,
                rowsStaled: counters.staled,
                fieldsDropped: fieldsDropped.length > 0 ? fieldsDropped : null,
                error,
                finishedAt,
              }),
              "sync run finish failed",
            ).pipe(Effect.catchAll(() => Effect.void));
            const totalRows =
              parseBindingConfig(binding.config).dedupeMode === "create"
                ? (binding.rowsSynced ?? 0) + counters.created
                : yield* syncedRows.countByBinding(binding.id).pipe(Effect.orElseSucceed(() => 0));
            yield* bindings
              .patch(binding.id, {
                // Signals' "always-due while empty" pattern: a binding that has
                // never landed data keeps lastSyncedAt NULL so the warm-up/cron
                // retries it, then normal daily semantics take over.
                lastSyncedAt: totalRows > 0 ? finishedAt : null,
                lastError: error,
                rowsSynced: totalRows,
                ...(pause !== null ? { pausedReason: pause } : {}),
              })
              .pipe(Effect.catchAll(() => Effect.void));
            const outcome: CrmSyncOutcome = {
              runId,
              bindingId: binding.id,
              tableId: binding.tableId,
              workspaceId: binding.workspaceId,
              provider: binding.provider,
              status,
              rowsCreated: counters.created,
              rowsUpdated: counters.updated,
              rowsSkipped: counters.skipped,
              rowsStaled: counters.staled,
              fieldsDropped,
              error,
              errorTag,
            };
            return outcome;
          });

        const completed = (outcome: CrmSyncOutcome): CrmSyncPageResult => ({
          outcome,
          next: null,
          newRowIds,
          tableId: binding.tableId,
          workspaceId: binding.workspaceId,
        });

        return yield* work.pipe(
          Effect.flatMap((workResult) => {
            if (!workResult.pullComplete && !pageBudgetExhausted) {
              if (nextCursor === null) {
                return Effect.fail(new CrmSyncError({ message: "CRM sync continuation is missing its cursor" }));
              }
              return Effect.succeed<CrmSyncPageResult>({
                outcome: null,
                next: {
                  runId,
                  bindingId: binding.id,
                  cursor: nextCursor,
                  pages: pagesCompleted,
                  rowsCreated: counters.created,
                  rowsUpdated: counters.updated,
                  rowsSkipped: counters.skipped,
                  remainingRowBudget,
                  plan: workResult.plan,
                  members,
                },
                newRowIds,
                tableId: binding.tableId,
                workspaceId: binding.workspaceId,
              });
            }
            if (pageBudgetExhausted) {
              return finalize("partial", PAGE_BUDGET_COPY, null, null).pipe(Effect.map(completed));
            }
            if (fieldsDropped.length > 0) {
              return finalize(
                "partial",
                crmErrorCopy({
                  _tag: "CrmSchemaDriftError",
                  provider: registry.forProvider(binding.provider).displayName,
                  missingAttrs: fieldsDropped,
                } as CrmError).copy,
                "CrmSchemaDriftError",
                null,
              ).pipe(Effect.map(completed));
            }
            return finalize("ok", null, null, null).pipe(Effect.map(completed));
          }),
          Effect.catchAll((e: CrmError) => {
            const p = crmErrorCopy(e);
            return finalize(p.status, p.copy, e._tag, p.pause ?? null).pipe(Effect.map(completed));
          }),
        );
      });

    // ── Wizard metadata (member-gated) ────────────────────────────────────────

    const describeAttrs = (
      client: CrmClientApi,
      session: CrmSession,
      source: { kind: "object" | "list"; id: string; label: string },
    ) =>
      Effect.gen(function* () {
        // Attribute schema first (records flatten over it): for lists, the
        // parent object's attributes are what the grid will sync (entry-scoped
        // attrs are out of scope for v1).
        const target =
          source.kind === "object"
            ? { kind: "objects" as const, id: source.id }
            : yield* Effect.gen(function* () {
                // Parent from LIST METADATA — never from the first member (an
                // EMPTY list used to fall back to the list id and 400 the
                // provider's properties endpoint).
                const parent = yield* client.getListParent(session, {
                  listId: source.id,
                  sourceLabel: source.label,
                });
                return { kind: "objects" as const, id: parent !== "" ? parent : source.id };
              });
        const attrs = yield* client.getAttributes(session, target.kind, target.id, source.label);
        const supported = attrs.filter((a) => a.supported && a.slug !== "");
        const attrRefs: readonly CrmAttrRef[] = supported.map((a) => ({ slug: a.slug, type: a.type }));

        // Sample records: 3 from the source (for lists, via their entries).
        const sample =
          source.kind === "object"
            ? (yield* client.queryObjectRecords(session, {
                object: source.id,
                sourceLabel: source.label,
                attrs: attrRefs,
                limit: 3,
                cursor: null,
              })).items
            : yield* Effect.gen(function* () {
                const page = yield* client.queryListEntries(session, {
                  listId: source.id,
                  sourceLabel: source.label,
                  limit: 3,
                  cursor: null,
                });
                const parent = target.id;
                const ids = page.items.map((e) => e.parentRecordId).filter((id) => id !== "");
                return parent === "" || ids.length === 0
                  ? ([] as readonly CrmRecord[])
                  : yield* client.queryRecordsByIds(session, {
                      object: parent,
                      sourceLabel: source.label,
                      attrs: attrRefs,
                      ids,
                    });
              });

        const cache = newCache();
        const flats = yield* resolveRecords(client, session, sample, cache);

        const fields = supported.map((a): CrmSourceField => {
          const samples = flats
            .map((fr) => fr.texts.get(a.slug) ?? "")
            .filter((t) => t !== "")
            .slice(0, 3);
          return {
            slug: a.slug,
            title: a.title,
            type: a.type,
            recommended: RECOMMENDED_SLUGS.has(a.slug) || RECOMMENDED_TYPES.has(a.type),
            sample: samples.join("  ·  "),
          };
        });

        const suggestedMatchKey =
          supported.find((a) => a.type === "email-address")?.slug ??
          supported.find((a) => a.type === "domain")?.slug ??
          supported.find((a) => a.slug === "name")?.slug ??
          null;

        return { fields, suggestedMatchKey } satisfies CrmSourceDescription;
      });

    const pageResultForOutcome = (outcome: CrmSyncOutcome): CrmSyncPageResult => ({
      outcome,
      next: null,
      newRowIds: [],
      tableId: outcome.tableId,
      workspaceId: outcome.workspaceId,
    });

    /**
     * Run at most one provider page. Inngest persists the returned checkpoint
     * before invoking this again, keeping every serverless invocation bounded.
     */
    const syncPageForWorker = (
      bindingId: string,
      trigger: "cron" | "manual" | "warmup",
      checkpoint: CrmSyncPageState | null,
    ): Effect.Effect<CrmSyncPageResult, CrmError> =>
      Effect.gen(function* () {
        const binding = yield* requireBinding(bindingId);
        if (checkpoint !== null && checkpoint.bindingId !== binding.id) {
          return yield* Effect.fail(new CrmSyncError({ message: "CRM sync checkpoint does not match binding" }));
        }

        if (checkpoint !== null) {
          // Atomic lease renewal: if a stale-run reaper won the race, stop this
          // continuation before it can write another provider page.
          const alive = yield* mapRepoError(
            runs.progress(checkpoint.runId, {
              rowsCreated: checkpoint.rowsCreated,
              rowsUpdated: checkpoint.rowsUpdated,
              rowsSkipped: checkpoint.rowsSkipped,
              progressedAt: Date.now(),
            }),
            "sync run heartbeat failed",
          );
          if (!alive) {
            const found = yield* mapRepoError(runs.findById(checkpoint.runId), "sync run lookup failed");
            const stopped = Option.isSome(found) ? found.value : null;
            return pageResultForOutcome({
              runId: checkpoint.runId,
              bindingId: binding.id,
              tableId: binding.tableId,
              workspaceId: binding.workspaceId,
              provider: binding.provider,
              status: "failed",
              rowsCreated: checkpoint.rowsCreated,
              rowsUpdated: checkpoint.rowsUpdated,
              rowsSkipped: checkpoint.rowsSkipped,
              rowsStaled: 0,
              fieldsDropped: checkpoint.plan.fieldsDropped,
              error: stopped?.error ?? "This sync is no longer active.",
              errorTag: "SyncRunNotRunning",
            });
          }
          if (!binding.enabled || binding.pausedReason !== null) {
            const error =
              binding.lastError ??
              `This sync stopped because the binding was ${binding.pausedReason === null ? "disabled" : "paused"}.`;
            yield* mapRepoError(
              runs.finish(checkpoint.runId, {
                status: "failed",
                rowsCreated: checkpoint.rowsCreated,
                rowsUpdated: checkpoint.rowsUpdated,
                rowsSkipped: checkpoint.rowsSkipped,
                rowsStaled: 0,
                fieldsDropped:
                  checkpoint.plan.fieldsDropped.length > 0 ? checkpoint.plan.fieldsDropped : null,
                error,
                finishedAt: Date.now(),
              }),
              "paused sync run finish failed",
            );
            return pageResultForOutcome({
              runId: checkpoint.runId,
              bindingId: binding.id,
              tableId: binding.tableId,
              workspaceId: binding.workspaceId,
              provider: binding.provider,
              status: "failed",
              rowsCreated: checkpoint.rowsCreated,
              rowsUpdated: checkpoint.rowsUpdated,
              rowsSkipped: checkpoint.rowsSkipped,
              rowsStaled: 0,
              fieldsDropped: checkpoint.plan.fieldsDropped,
              error,
              errorTag: "SyncBindingInactive",
            });
          }
        } else {
          if (!binding.enabled || binding.pausedReason !== null) {
            return yield* Effect.fail(
              new CrmSyncError({ message: `Binding ${bindingId} is ${binding.pausedReason ?? "disabled"}` }),
            );
          }

          // Overlap and entitlement are start-of-run decisions. Continuations
          // hold the existing run lease and finish under the plan/cap captured
          // in their checkpoint, avoiding a half-applied run if billing changes
          // while a durable page chain is active.
          const newest = yield* mapRepoError(runs.listByBinding(binding.id, 1), "run lookup failed");
          const inFlight = newest[0];
          if (inFlight !== undefined && inFlight.status === "running") {
            const staleBefore = Date.now() - SYNC_STALE_RUN_MS;
            if (inFlight.lastProgressAt > staleBefore) {
              return pageResultForOutcome({
                runId: "",
                bindingId: binding.id,
                tableId: binding.tableId,
                workspaceId: binding.workspaceId,
                provider: binding.provider,
                status: "ok",
                rowsCreated: 0,
                rowsUpdated: 0,
                rowsSkipped: 0,
                rowsStaled: 0,
                fieldsDropped: [],
                error: null,
                errorTag: "SyncAlreadyRunning",
              });
            }

            const copy = "This sync stopped before it could finish. A new sync has started.";
            const reaped = yield* mapRepoError(
              runs.reapStale(inFlight.id, staleBefore, {
                status: "failed",
                rowsCreated: inFlight.rowsCreated,
                rowsUpdated: inFlight.rowsUpdated,
                rowsSkipped: inFlight.rowsSkipped,
                rowsStaled: inFlight.rowsStaled,
                fieldsDropped: inFlight.fieldsDropped,
                error: copy,
                finishedAt: Date.now(),
              }),
              "stale sync run reconciliation failed",
            );
            if (!reaped) {
              return pageResultForOutcome({
                runId: "",
                bindingId: binding.id,
                tableId: binding.tableId,
                workspaceId: binding.workspaceId,
                provider: binding.provider,
                status: "ok",
                rowsCreated: 0,
                rowsUpdated: 0,
                rowsSkipped: 0,
                rowsStaled: 0,
                  fieldsDropped: [],
                  error: null,
                  errorTag: "SyncAlreadyRunning",
                });
            }
          }

          const entitled = yield* entitlement.requireCloudAccess(binding.workspaceId).pipe(
            Effect.as(true),
            Effect.catchTag("PlanRequiredError", () => Effect.succeed(false)),
            Effect.mapError((e) => new CrmSyncError({ message: "entitlement check failed", cause: e })),
          );
          if (!entitled) {
            const copy = "Your plan doesn't include CRM sync right now. Upgrade to resume syncing.";
            const runId = yield* runs
              .start({
                workspaceId: binding.workspaceId,
                bindingId: binding.id,
                tableId: binding.tableId,
                trigger,
                startedAt: Date.now(),
              })
              .pipe(Effect.mapError((e) => new CrmSyncError({ message: "sync run start failed", cause: e })));
            yield* runs
              .finish(runId, {
                status: "failed",
                rowsCreated: 0,
                rowsUpdated: 0,
                rowsSkipped: 0,
                rowsStaled: 0,
                fieldsDropped: null,
                error: copy,
                finishedAt: Date.now(),
              })
              .pipe(Effect.catchAll(() => Effect.void));
            yield* bindings
              .patch(binding.id, { pausedReason: "plan_lapsed", lastError: copy })
              .pipe(Effect.catchAll(() => Effect.void));
            return pageResultForOutcome({
              runId,
              bindingId: binding.id,
              tableId: binding.tableId,
              workspaceId: binding.workspaceId,
              provider: binding.provider,
              status: "failed",
              rowsCreated: 0,
              rowsUpdated: 0,
              rowsSkipped: 0,
              rowsStaled: 0,
              fieldsDropped: [],
              error: copy,
              errorTag: "PlanRequired",
            });
          }
        }

        const session = yield* connections.workerSession(
          binding.workspaceId,
          registry.forProvider(binding.provider).provider,
        );
        return yield* runSyncPage(binding, session, trigger, checkpoint);
      }).pipe(
        Effect.catchTag("CrmConnectionMissing", () =>
          Effect.gen(function* () {
            const binding = yield* requireBinding(bindingId);
            const p = crmErrorCopy({
              _tag: "CrmConnectionMissing",
              provider: registry.forProvider(binding.provider).displayName,
            } as CrmError);
            const runId =
              checkpoint?.runId ??
              (yield* runs
                .start({
                  workspaceId: binding.workspaceId,
                  bindingId: binding.id,
                  tableId: binding.tableId,
                  trigger,
                  startedAt: Date.now(),
                })
                .pipe(Effect.mapError((e) => new CrmSyncError({ message: "sync run start failed", cause: e }))));
            yield* runs
              .finish(runId, {
                status: p.status,
                rowsCreated: checkpoint?.rowsCreated ?? 0,
                rowsUpdated: checkpoint?.rowsUpdated ?? 0,
                rowsSkipped: checkpoint?.rowsSkipped ?? 0,
                rowsStaled: 0,
                fieldsDropped:
                  checkpoint !== null && checkpoint.plan.fieldsDropped.length > 0
                    ? checkpoint.plan.fieldsDropped
                    : null,
                error: p.copy,
                finishedAt: Date.now(),
              })
              .pipe(Effect.catchAll(() => Effect.void));
            yield* bindings
              .patch(binding.id, { pausedReason: p.pause ?? "auth_revoked", lastError: p.copy })
              .pipe(Effect.catchAll(() => Effect.void));
            return pageResultForOutcome({
              runId,
              bindingId: binding.id,
              tableId: binding.tableId,
              workspaceId: binding.workspaceId,
              provider: binding.provider,
              status: p.status,
              rowsCreated: checkpoint?.rowsCreated ?? 0,
              rowsUpdated: checkpoint?.rowsUpdated ?? 0,
              rowsSkipped: checkpoint?.rowsSkipped ?? 0,
              rowsStaled: 0,
              fieldsDropped: checkpoint?.plan.fieldsDropped ?? [],
              error: p.copy,
              errorTag: "CrmConnectionMissing",
            });
          }),
        ),
      );

    return {
      // ── Member: wizard metadata ────────────────────────────────────────────
      listSources: (workspaceId: string, provider: CrmProvider = "attio") =>
        Effect.gen(function* () {
          yield* membership.requireMember(workspaceId);
          yield* entitlement.requireCloudAccess(workspaceId);
          const client = registry.forProvider(provider);
          const session = yield* connections.memberSession(workspaceId, client.provider);
          const [objects, lists] = yield* Effect.all([client.listObjects(session), client.listLists(session)]);
          const sources: CrmSourceSummary[] = [
            ...objects.map(
              (o): CrmSourceSummary => ({ kind: "object", id: o.slug, label: o.label, parentObject: null }),
            ),
            ...lists.map(
              (l): CrmSourceSummary => ({ kind: "list", id: l.id, label: l.name, parentObject: l.parentObject }),
            ),
          ];
          return sources;
        }),

      describeSource: (
        workspaceId: string,
        source: { readonly kind: "object" | "list"; readonly id: string; readonly label: string },
        provider: CrmProvider = "attio",
      ) =>
        Effect.gen(function* () {
          yield* membership.requireMember(workspaceId);
          yield* entitlement.requireCloudAccess(workspaceId);
          const client = registry.forProvider(provider);
          const session = yield* connections.memberSession(workspaceId, client.provider);
          return yield* describeAttrs(client, session, source);
        }),

      estimate: (
        workspaceId: string,
        args: {
          readonly kind: "object" | "list";
          readonly id: string;
          readonly label: string;
          readonly filters: readonly CrmFilter[];
        },
        provider: CrmProvider = "attio",
      ) =>
        Effect.gen(function* () {
          yield* membership.requireMember(workspaceId);
          yield* entitlement.requireCloudAccess(workspaceId);
          const client = registry.forProvider(provider);
          const session = yield* connections.memberSession(workspaceId, client.provider);
          const serverFilter = client.compileServerFilter(args.filters, args.kind);
          const filterAttrs: readonly CrmAttrRef[] = args.filters.map((f) => ({ slug: f.attrSlug, type: f.attrType }));
          const { records, nextCursor } = yield* pullPage(
            client,
            session,
            { sourceKind: args.kind, sourceId: args.id, sourceLabel: args.label },
            serverFilter,
            filterAttrs,
            null,
          );
          const cache = newCache();
          const flats = yield* resolveRecords(client, session, records, cache);
          const kept = flats.filter((fr) => matchesAllFilters(args.filters, (slug) => fr.texts.get(slug) ?? ""));
          return { count: kept.length, isLowerBound: nextCursor !== null } satisfies CrmEstimate;
        }),

      // ── Member: binding lifecycle ──────────────────────────────────────────
      create: (args: CreateCrmBindingArgs) =>
        Effect.gen(function* () {
          const table = yield* mapRepoError(grid.findTable(args.tableId), "table lookup failed");
          if (Option.isNone(table)) return yield* Effect.fail(new CrmSyncError({ message: "Table not found" }));
          const workspaceId = table.value.workspaceId;
          yield* membership.requireMember(workspaceId);
          yield* entitlement.requireCloudAccess(workspaceId);
          // Connection must exist before a binding can (wizard enforces too).
          yield* connections.memberSession(workspaceId, args.provider);

          const now = Date.now();
          const bindingId = yield* mapRepoError(
            bindings.insert({
              workspaceId,
              tableId: args.tableId,
              provider: args.provider,
              sourceKind: args.sourceKind,
              sourceId: args.sourceId,
              sourceLabel: args.sourceLabel,
              columns: [],
              config: {
                filters: args.filters,
                dedupeMode: args.dedupeMode,
                matchKeyAttr: args.matchKeyAttr,
              },
              // "Always create" is an IMPORT semantic — re-running it daily
              // would re-append the entire source every day until the row cap.
              // Those bindings sync on demand only; update/skip run daily.
              schedule: args.dedupeMode === "create" ? "manual" : "daily",
              enabled: true,
              createdAt: now,
            }),
            "binding insert failed",
          );

          // Create the synced columns (config-flagged) then bind the mapping.
          const basePosition = yield* mapRepoError(columns.nextPosition(args.tableId), "column position failed");
          const mapping: CrmBindingColumn[] = [];
          for (const [i, field] of args.fields.entries()) {
            const columnId = yield* mapRepoError(
              columns.insert({
                workspaceId,
                tableId: args.tableId,
                name: field.title,
                type: "text",
                kind: "manual",
                provider: null,
                method: null,
                code: null,
                params: null,
                condition: null,
                config: {
                  synced: true,
                  crmBindingId: bindingId,
                  attrSlug: field.attrSlug,
                  attrType: field.attrType,
                },
                position: basePosition + i,
                createdAt: now,
              }),
              "column insert failed",
            );
            mapping.push({ attrSlug: field.attrSlug, attrType: field.attrType, columnId, title: field.title });
          }
          yield* mapRepoError(bindings.patch(bindingId, { columns: mapping }), "binding mapping failed");
          return bindingId;
        }),

      /**
       * Add ONE more source field to an existing binding as a new synced
       * column. Backfill rides the next sync: the values-hash is scoped to the
       * synced columns, so every record's hash changes and the run rewrites
       * all cells — including the new column. (In "create" dedupe mode there
       * is no record→row identity, so only future imports carry the field.)
       * Idempotent: an already-mapped slug returns its existing column.
       */
      addField: (
        bindingId: string,
        field: { readonly attrSlug: string; readonly attrType: string; readonly title: string },
      ) =>
        Effect.gen(function* () {
          const binding = yield* requireBinding(bindingId);
          yield* membership.requireMember(binding.workspaceId);
          yield* entitlement.requireCloudAccess(binding.workspaceId);
          const existing = binding.columns.find((c) => c.attrSlug === field.attrSlug);
          if (existing !== undefined) return { columnId: existing.columnId, workspaceId: binding.workspaceId };
          const now = Date.now();
          const position = yield* mapRepoError(columns.nextPosition(binding.tableId), "column position failed");
          const columnId = yield* mapRepoError(
            columns.insert({
              workspaceId: binding.workspaceId,
              tableId: binding.tableId,
              name: field.title,
              type: "text",
              kind: "manual",
              provider: null,
              method: null,
              code: null,
              params: null,
              condition: null,
              config: {
                synced: true,
                crmBindingId: binding.id,
                attrSlug: field.attrSlug,
                attrType: field.attrType,
              },
              position,
              createdAt: now,
            }),
            "column insert failed",
          );
          yield* mapRepoError(
            bindings.patch(binding.id, {
              columns: [
                ...binding.columns,
                { attrSlug: field.attrSlug, attrType: field.attrType, columnId, title: field.title },
              ],
            }),
            "binding mapping failed",
          );
          return { columnId, workspaceId: binding.workspaceId };
        }),

      /** Validate a manual sync-now (member + entitlement) and return the binding. */
      guardSyncNow: (bindingId: string) =>
        Effect.gen(function* () {
          const binding = yield* requireBinding(bindingId);
          yield* membership.requireMember(binding.workspaceId);
          yield* entitlement.requireCloudAccess(binding.workspaceId);
          return binding;
        }),

      /**
       * Bindings on a table. The workspace is derived from the TABLE ROW (never
       * a client-supplied id — trusting one let any member of any workspace
       * read another workspace's binding config by table id). Unknown table →
       * empty, so probing ids leaks nothing.
       */
      listByTable: (tableId: string) =>
        Effect.gen(function* () {
          const table = yield* mapRepoError(grid.findTable(tableId), "table lookup failed");
          if (Option.isNone(table)) return [] as readonly CrmBindingWithRun[];
          yield* membership.requireMember(table.value.workspaceId);
          const list = yield* mapRepoError(bindings.listByTable(tableId), "binding list failed");
          // Newest run rides along so the strip can detect in-flight syncs
          // (any trigger) and show a live pulled-so-far count.
          return yield* Effect.forEach(
            list,
            (b) =>
              mapRepoError(runs.listByBinding(b.id, 1), "run lookup failed").pipe(
                Effect.map((rs): CrmBindingWithRun => {
                  const r = rs[0];
                  return {
                    ...b,
                    lastRun:
                      r === undefined
                        ? null
                        : {
                            id: r.id,
                            status: r.status,
                            trigger: r.trigger,
                            rowsCreated: r.rowsCreated,
                            rowsUpdated: r.rowsUpdated,
                            startedAt: r.startedAt,
                          },
                  };
                }),
              ),
            { concurrency: 4 },
          );
        }),

      listRuns: (bindingId: string, limit: number) =>
        Effect.gen(function* () {
          const binding = yield* requireBinding(bindingId);
          yield* membership.requireMember(binding.workspaceId);
          return yield* mapRepoError(runs.listByBinding(bindingId, limit), "run list failed");
        }),

      /**
       * Disconnect Attio for a workspace: pause every attio binding (they show
       * the Reconnect banner and the cron skips them) and delete the stored
       * OAuth connection. Rows/tables are untouched. Reconnecting via OAuth
       * clears the pauses (callback clearPause) and syncing resumes.
       */
      disconnect: (workspaceId: string, provider: CrmProvider = "attio") =>
        Effect.gen(function* () {
          yield* membership.requireMember(workspaceId);
          const name = registry.forProvider(provider).displayName;
          const all = yield* mapRepoError(bindings.listByWorkspace(workspaceId), "binding list failed");
          const paused = all.filter((b) => b.provider === provider);
          yield* Effect.forEach(
            paused,
            (b) =>
              mapRepoError(
                bindings.patch(b.id, {
                  pausedReason: "auth_revoked",
                  lastError: `${name} was disconnected. Reconnect ${name} to resume syncing.`,
                }),
                "binding pause failed",
              ),
            { discard: true },
          );
          const removed = yield* connections.removeConnection(workspaceId, provider);
          return { removed, bindingsPaused: paused.length };
        }),

      remove: (bindingId: string) =>
        Effect.gen(function* () {
          const binding = yield* requireBinding(bindingId);
          yield* membership.requireMember(binding.workspaceId);
          yield* mapRepoError(bindings.remove(bindingId), "binding delete failed");
        }),

      // ── Worker ─────────────────────────────────────────────────────────────
      /**
       * Execute one durable sync page without membership (the caller's worker
       * secret is the trust boundary). Production Inngest callers use this
       * method and carry its checkpoint into a fresh invocation.
       */
      syncPageForWorker,

      /**
       * Convenience full-run wrapper for local and test callers. Production
       * Inngest execution uses `syncPageForWorker` so each invocation is bounded.
       */
      syncForWorker: (bindingId: string, trigger: "cron" | "manual" | "warmup") =>
        Effect.gen(function* () {
          let checkpoint: CrmSyncPageState | null = null;
          while (true) {
            const page: CrmSyncPageResult = yield* syncPageForWorker(bindingId, trigger, checkpoint);
            if (page.outcome !== null) {
              return page.outcome;
            }
            if (page.next === null) {
              return yield* Effect.fail(new CrmSyncError({ message: "CRM sync page returned no checkpoint" }));
            }
            checkpoint = page.next;
          }
        }),

      listDuePage: (args: {
        readonly now: number;
        readonly limit: number;
        readonly cursor: { readonly createdAt: number; readonly id: string } | null;
      }) => mapRepoError(bindings.listDuePage(args), "due page failed"),
    } as const;
  }),
  dependencies: [],
}) {}
