/**
 * `CrmSyncService` — the CRM→grid sync engine (TRI: crm-sync). Mirrors
 * {@link SignalService}'s member/worker split:
 *
 * - Member paths (tRPC): `listSources` / `describeSource` / `estimate` feed the
 *   wizard; `create` builds the synced columns + binding; `guardSyncNow`
 *   validates a manual sync before the router enqueues it; `listByTable` /
 *   `listRuns` feed the status strip + sync log; `remove` deletes a binding
 *   (grid rows stay).
 * - Worker path (Inngest): `syncForWorker` executes the pull. ALL sync
 *   execution goes through the worker — manual "Sync now" only enqueues — so
 *   observability, retries, and concurrency limits live in exactly one place.
 *
 * The sync algorithm (`runSync`):
 *   resolve live attributes (schema drift → drop column, keep going) → page
 *   records 500 at a time (server-side prefilter where expressible, worker
 *   filters ALWAYS re-checked) → flatten typed values to cell text (references
 *   resolved to names in per-run batches) → apply the binding's dedupe mode
 *   (update = hash-guarded upsert on record id or match key / skip / always
 *   create) under the plan's row cap → after a FULLY complete pull, mark
 *   vanished records' rows stale (never delete; user enrichment survives) →
 *   finalize a `crm_sync_runs` row whose `error` is already user-safe copy.
 */

import { createHash } from "node:crypto";
import { Effect, Option } from "effect";
import { MembershipService } from "@gtmgrid/cloud";
import {
  flattenAttrValue,
  isSupportedAttrType,
  matchesAllFilters,
  toAttioFilterBody,
  type AttioAttrType,
  type CrmFilter,
  type FlatValue,
} from "../crm/attio-attributes.js";
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
import { AttioClient, ATTIO_PAGE_LIMIT, type AttioRecord, type AttioSession } from "./attio-client.js";
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
 * a low-match filter over a huge object must not page forever.
 */
const MAX_PAGES_PER_RUN = CRM_ROW_CAP_SCALE / ATTIO_PAGE_LIMIT + 40;

/**
 * A `running` run older than this is treated as a crashed leftover, not an
 * in-flight sync — the overlap guard ignores it so retries aren't blocked
 * forever by a worker that died mid-run.
 */
export const SYNC_STALE_RUN_MS = 10 * 60 * 1000;

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
  /** Rows inserted this run, for dependency-ordered enrichment. */
  readonly newRowIds: readonly string[];
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
  readonly provider: "attio";
  readonly sourceKind: "object" | "list";
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly fields: ReadonlyArray<{ readonly attrSlug: string; readonly attrType: string; readonly title: string }>;
  readonly filters: readonly CrmFilter[];
  readonly dedupeMode: CrmDedupeMode;
  readonly matchKeyAttr: string | null;
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
    const client = yield* AttioClient;
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
          e !== null && typeof e === "object" && "_tag" in e && String((e as { _tag: string })._tag).startsWith("Attio")
            ? (e as CrmError)
            : new CrmSyncError({ message, cause: e }),
        ),
      );

    // ── Flattening with per-run reference/actor resolution ───────────────────

    interface ResolveCache {
      readonly refNames: Map<string, string>; // `${object} ${recordId}` → name
      members: ReadonlyMap<string, string> | null;
    }

    const newCache = (): ResolveCache => ({ refNames: new Map(), members: null });

    /**
     * Flatten `records` across `cols` to text, batch-resolving record
     * references + actors through the per-run cache (one query per object per
     * page + one members fetch per run, instead of per-cell lookups).
     */
    const flattenRecords = (
      session: AttioSession,
      records: readonly AttioRecord[],
      cols: ReadonlyArray<{ readonly attrSlug: string; readonly attrType: string }>,
      cache: ResolveCache,
    ): Effect.Effect<readonly FlatRecord[], CrmError> =>
      Effect.gen(function* () {
        const flats = records.map((rec) => ({
          externalId: rec.recordId,
          flat: new Map<string, FlatValue>(
            cols.map((c) => [c.attrSlug, flattenAttrValue(c.attrType as AttioAttrType, rec.values[c.attrSlug])]),
          ),
        }));

        const wantRefs = new Map<string, Set<string>>();
        let wantMembers = false;
        for (const { flat } of flats) {
          for (const v of flat.values()) {
            if (v.kind === "ref" && !cache.refNames.has(`${v.targetObject} ${v.targetRecordId}`)) {
              const set = wantRefs.get(v.targetObject) ?? new Set<string>();
              set.add(v.targetRecordId);
              wantRefs.set(v.targetObject, set);
            }
            if (v.kind === "actor" && cache.members === null) wantMembers = true;
          }
        }
        for (const [object, ids] of wantRefs) {
          const idList = [...ids];
          for (let i = 0; i < idList.length; i += ATTIO_PAGE_LIMIT) {
            const chunk = idList.slice(i, i + ATTIO_PAGE_LIMIT);
            const names = yield* client.resolveRecordNames(session, { object, ids: chunk });
            for (const id of chunk) cache.refNames.set(`${object} ${id}`, names.get(id) ?? "");
          }
        }
        if (wantMembers) cache.members = yield* client.listMembers(session);

        return flats.map(({ externalId, flat }) => {
          const texts = new Map<string, string>();
          for (const [slug, v] of flat) {
            texts.set(
              slug,
              v.kind === "text"
                ? v.text
                : v.kind === "ref"
                  ? (cache.refNames.get(`${v.targetObject} ${v.targetRecordId}`) ?? "")
                  : (cache.members?.get(v.actorId) ?? ""),
            );
          }
          return { externalId, texts };
        });
      });

    /** One page of source records (object query, or list entries → records). */
    const pullPage = (
      session: AttioSession,
      binding: {
        readonly sourceKind: string;
        readonly sourceId: string;
        readonly sourceLabel: string;
      },
      serverFilter: Record<string, unknown> | undefined,
      offset: number,
    ): Effect.Effect<{ records: readonly AttioRecord[]; pageFull: boolean }, CrmError> =>
      binding.sourceKind === "list"
        ? Effect.gen(function* () {
            const entries = yield* client.queryListEntries(session, {
              listId: binding.sourceId,
              sourceLabel: binding.sourceLabel,
              limit: ATTIO_PAGE_LIMIT,
              offset,
            });
            const parent = entries.find((e) => e.parentObject !== "")?.parentObject ?? "";
            const ids = entries.map((e) => e.parentRecordId).filter((id) => id !== "");
            const records =
              parent === "" || ids.length === 0
                ? ([] as readonly AttioRecord[])
                : yield* client.queryRecordsByIds(session, {
                    object: parent,
                    sourceLabel: binding.sourceLabel,
                    ids,
                  });
            // Count-level diagnostics (no record data): a list pull that lands
            // nothing must be explainable from host logs.
            yield* Effect.logWarning("crm list page").pipe(
              Effect.annotateLogs({
                listId: binding.sourceId,
                offset,
                entries: entries.length,
                parent,
                parentIds: ids.length,
                records: records.length,
              }),
            );
            return { records, pageFull: entries.length === ATTIO_PAGE_LIMIT };
          })
        : client
            .queryObjectRecords(session, {
              object: binding.sourceId,
              sourceLabel: binding.sourceLabel,
              ...(serverFilter !== undefined ? { filter: serverFilter } : {}),
              limit: ATTIO_PAGE_LIMIT,
              offset,
            })
            .pipe(Effect.map((records) => ({ records, pageFull: records.length === ATTIO_PAGE_LIMIT })));

    // ── The sync loop ─────────────────────────────────────────────────────────

    const runSync = (
      binding: CrmBinding,
      session: AttioSession,
      trigger: "cron" | "manual" | "warmup",
    ): Effect.Effect<CrmSyncOutcome, CrmSyncError> =>
      Effect.gen(function* () {
        const startedAt = Date.now();
        const runId = yield* mapRepoError(
          runs.start({
            workspaceId: binding.workspaceId,
            bindingId: binding.id,
            tableId: binding.tableId,
            trigger,
            startedAt,
          }),
          "sync run start failed",
        ).pipe(Effect.mapError((e) => new CrmSyncError({ message: "sync run start failed", cause: e })));

        const cfg = parseBindingConfig(binding.config);
        const counters = { created: 0, updated: 0, skipped: 0, staled: 0 };
        const newRowIds: string[] = [];
        let fieldsDropped: readonly string[] = [];
        let capped = false;
        let pageBudgetExhausted = false;

        const work = Effect.gen(function* () {
          const cap = yield* rowCapFor(binding.workspaceId);

          // 1. Live attributes: drop mapped columns (and filters) that vanished.
          const liveAttrs = yield* client.getAttributes(
            session,
            binding.sourceKind === "list" ? "lists" : "objects",
            binding.sourceId,
            binding.sourceLabel,
          );
          const liveSlugs = new Set(liveAttrs.map((a) => a.slug));
          // For LIST sources the synced attributes live on the parent OBJECT,
          // not the list — resolve the parent's attributes too when needed.
          if (binding.sourceKind === "list") {
            const probe = yield* client.queryListEntries(session, {
              listId: binding.sourceId,
              sourceLabel: binding.sourceLabel,
              limit: 1,
              offset: 0,
            });
            const parent = probe.find((e) => e.parentObject !== "")?.parentObject;
            if (parent !== undefined) {
              const parentAttrs = yield* client.getAttributes(session, "objects", parent, binding.sourceLabel);
              for (const a of parentAttrs) liveSlugs.add(a.slug);
            }
          }
          const activeCols = binding.columns.filter((c) => liveSlugs.has(c.attrSlug));
          const activeSlugs = activeCols.map((c) => c.attrSlug);
          fieldsDropped = binding.columns.filter((c) => !liveSlugs.has(c.attrSlug)).map((c) => c.title);
          const activeFilters = cfg.filters.filter((f) => liveSlugs.has(f.attrSlug));

          // Attributes the loop must flatten: synced columns + filter + match key.
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

          // Cap budget: rows this binding has EVER created count against it.
          const preexisting =
            cfg.dedupeMode === "create"
              ? (binding.rowsSynced ?? 0)
              : yield* mapRepoError(syncedRows.countByBinding(binding.id), "synced-row count failed");
          let budget = Math.max(0, cap - preexisting);

          const serverFilter =
            binding.sourceKind === "object" ? toAttioFilterBody(activeFilters) : undefined;
          const cache = newCache();
          let offset = 0;
          let pages = 0;
          let pullComplete = false;

          while (true) {
            if (pages >= MAX_PAGES_PER_RUN) {
              pageBudgetExhausted = true;
              break;
            }
            const { records, pageFull } = yield* pullPage(session, binding, serverFilter, offset);
            pages += 1;
            offset += ATTIO_PAGE_LIMIT;

            yield* Effect.logWarning("crm page classify").pipe(
              Effect.annotateLogs({ bindingId: binding.id, offset: offset - ATTIO_PAGE_LIMIT, records: records.length }),
            );
            if (records.length > 0) {
              const flats = yield* flattenRecords(session, records, flattenCols, cache);
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
              if (inserts.length > budget) {
                inserts = inserts.slice(0, budget);
                capped = true;
              }
              budget -= inserts.length;

              const now = Date.now();
              if (inserts.length > 0) {
                const base = yield* mapRepoError(grid.maxRowPosition(binding.tableId), "row position failed");
                const rowIds = yield* mapRepoError(
                  grid.insertRowsBulk(
                    inserts.map((_fr, i) => ({
                      workspaceId: binding.workspaceId,
                      tableId: binding.tableId,
                      position: base + i + 1,
                      createdAt: now,
                    })),
                  ),
                  "row insert failed",
                );
                const cells = inserts.flatMap((fr, i) => {
                  const rowId = rowIds[i];
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
                yield* mapRepoError(grid.insertCellsBulk(cells), "cell insert failed");
                counters.created += rowIds.length;
                newRowIds.push(...rowIds);
                // Open grids see the pulled records land live, WITH their cell
                // values (the worker path can't publish these — only runSync
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
                  { discard: true },
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

            if (!pageFull) {
              pullComplete = true;
              break;
            }
          }

          // 3. Stale pass — ONLY after a complete pull (a truncated pull would
          // false-stale everything it didn't reach), and never in create mode
          // (no record→row identity there).
          if (pullComplete && !capped && cfg.dedupeMode !== "create") {
            counters.staled = yield* mapRepoError(
              syncedRows.markStaleNotSeen(binding.id, runId),
              "stale marking failed",
            );
          }

          if (capped) return yield* Effect.fail(new RowCapReached({ cap }));
          return pullComplete;
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
              newRowIds,
            };
            return outcome;
          });

        return yield* work.pipe(
          Effect.flatMap(() =>
            pageBudgetExhausted
              ? finalize("partial", PAGE_BUDGET_COPY, null, null)
              : fieldsDropped.length > 0
                ? finalize(
                    "partial",
                    crmErrorCopy({ _tag: "AttioSchemaDriftError", missingAttrs: fieldsDropped } as CrmError).copy,
                    "AttioSchemaDriftError",
                    null,
                  )
                : finalize("ok", null, null, null),
          ),
          Effect.catchAll((e: CrmError) => {
            const p = crmErrorCopy(e);
            return finalize(p.status, p.copy, e._tag, p.pause ?? null);
          }),
        );
      });

    // ── Wizard metadata (member-gated) ────────────────────────────────────────

    const describeAttrs = (
      session: AttioSession,
      source: { kind: "object" | "list"; id: string; label: string },
    ) =>
      Effect.gen(function* () {
        // Sample records: 3 from the source (for lists, via their entries).
        const sample =
          source.kind === "object"
            ? yield* client.queryObjectRecords(session, {
                object: source.id,
                sourceLabel: source.label,
                limit: 3,
                offset: 0,
              })
            : yield* Effect.gen(function* () {
                const entries = yield* client.queryListEntries(session, {
                  listId: source.id,
                  sourceLabel: source.label,
                  limit: 3,
                  offset: 0,
                });
                const parent = entries.find((e) => e.parentObject !== "")?.parentObject ?? "";
                const ids = entries.map((e) => e.parentRecordId).filter((id) => id !== "");
                return parent === "" || ids.length === 0
                  ? ([] as readonly AttioRecord[])
                  : yield* client.queryRecordsByIds(session, { object: parent, sourceLabel: source.label, ids });
              });

        // Attribute schema: for lists, the parent object's attributes are what
        // the grid will sync (entry-scoped attrs are out of scope for v1).
        const target =
          source.kind === "object"
            ? { kind: "objects" as const, id: source.id }
            : yield* Effect.gen(function* () {
                const entries = yield* client.queryListEntries(session, {
                  listId: source.id,
                  sourceLabel: source.label,
                  limit: 1,
                  offset: 0,
                });
                const parent = entries.find((e) => e.parentObject !== "")?.parentObject ?? source.id;
                return { kind: "objects" as const, id: parent };
              });
        const attrs = yield* client.getAttributes(session, target.kind, target.id, source.label);
        const supported = attrs.filter((a) => a.supported && a.slug !== "");

        const cache = newCache();
        const flats = yield* flattenRecords(
          session,
          sample,
          supported.map((a) => ({ attrSlug: a.slug, attrType: a.type })),
          cache,
        );

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

    return {
      // ── Member: wizard metadata ────────────────────────────────────────────
      listSources: (workspaceId: string) =>
        Effect.gen(function* () {
          yield* membership.requireMember(workspaceId);
          const session = yield* connections.memberSession(workspaceId);
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
      ) =>
        Effect.gen(function* () {
          yield* membership.requireMember(workspaceId);
          const session = yield* connections.memberSession(workspaceId);
          return yield* describeAttrs(session, source);
        }),

      estimate: (
        workspaceId: string,
        args: {
          readonly kind: "object" | "list";
          readonly id: string;
          readonly label: string;
          readonly filters: readonly CrmFilter[];
        },
      ) =>
        Effect.gen(function* () {
          yield* membership.requireMember(workspaceId);
          const session = yield* connections.memberSession(workspaceId);
          const serverFilter = args.kind === "object" ? toAttioFilterBody(args.filters) : undefined;
          const { records, pageFull } = yield* pullPage(
            session,
            { sourceKind: args.kind, sourceId: args.id, sourceLabel: args.label },
            serverFilter,
            0,
          );
          const cache = newCache();
          const filterCols = args.filters.map((f) => ({ attrSlug: f.attrSlug, attrType: f.attrType }));
          const flats = yield* flattenRecords(session, records, filterCols, cache);
          const kept = flats.filter((fr) => matchesAllFilters(args.filters, (slug) => fr.texts.get(slug) ?? ""));
          return { count: kept.length, isLowerBound: pageFull } satisfies CrmEstimate;
        }),

      // ── Member: binding lifecycle ──────────────────────────────────────────
      create: (args: CreateCrmBindingArgs) =>
        Effect.gen(function* () {
          const table = yield* mapRepoError(grid.findTable(args.tableId), "table lookup failed");
          if (Option.isNone(table)) return yield* Effect.fail(new CrmSyncError({ message: "Table not found" }));
          const workspaceId = table.value.workspaceId;
          yield* membership.requireMember(workspaceId);
          yield* entitlement.requireCloudAccess(workspaceId);
          if (args.provider !== "attio") {
            return yield* Effect.fail(new CrmSyncError({ message: `Unknown CRM provider ${String(args.provider)}` }));
          }
          // Connection must exist before a binding can (wizard enforces too).
          yield* connections.memberSession(workspaceId);

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
          if (Option.isNone(table)) return [] as readonly CrmBinding[];
          yield* membership.requireMember(table.value.workspaceId);
          return yield* mapRepoError(bindings.listByTable(tableId), "binding list failed");
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
      disconnect: (workspaceId: string) =>
        Effect.gen(function* () {
          yield* membership.requireMember(workspaceId);
          const all = yield* mapRepoError(bindings.listByWorkspace(workspaceId), "binding list failed");
          const attio = all.filter((b) => b.provider === "attio");
          yield* Effect.forEach(
            attio,
            (b) =>
              mapRepoError(
                bindings.patch(b.id, {
                  pausedReason: "auth_revoked",
                  lastError: "Attio was disconnected. Reconnect Attio to resume syncing.",
                }),
                "binding pause failed",
              ),
            { discard: true },
          );
          const removed = yield* connections.removeConnection(workspaceId);
          return { removed, bindingsPaused: attio.length };
        }),

      remove: (bindingId: string) =>
        Effect.gen(function* () {
          const binding = yield* requireBinding(bindingId);
          yield* membership.requireMember(binding.workspaceId);
          yield* mapRepoError(bindings.remove(bindingId), "binding delete failed");
        }),

      // ── Worker ─────────────────────────────────────────────────────────────
      /**
       * Execute a sync without membership (the caller's worker secret is the
       * trust boundary), entitlement-gated. NEVER throws for sync failures —
       * the outcome carries the status + user copy; only bookkeeping failures
       * (run row could not even start) fail the effect.
       */
      syncForWorker: (bindingId: string, trigger: "cron" | "manual" | "warmup") =>
        Effect.gen(function* () {
          const binding = yield* requireBinding(bindingId);
          if (!binding.enabled || binding.pausedReason !== null) {
            return yield* Effect.fail(
              new CrmSyncError({ message: `Binding ${bindingId} is ${binding.pausedReason ?? "disabled"}` }),
            );
          }
          // Overlap guard: the daily cron and a manual "Sync now" may target the
          // SAME binding concurrently (the per-workspace Inngest limit is 2).
          // Two interleaved pulls would both see records as "new" and duplicate
          // rows, so if a run is already in flight (and not a crashed leftover
          // older than the staleness window) this attempt no-ops. The caller
          // detects runId === "" and skips analytics/enrichment.
          const newest = yield* mapRepoError(runs.listByBinding(binding.id, 1), "run lookup failed");
          const inFlight = newest[0];
          if (
            inFlight !== undefined &&
            inFlight.status === "running" &&
            Date.now() - inFlight.startedAt < SYNC_STALE_RUN_MS
          ) {
            const outcome: CrmSyncOutcome = {
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
              newRowIds: [],
            };
            return outcome;
          }
          yield* entitlement
            .requireCloudAccess(binding.workspaceId)
            .pipe(Effect.mapError((e) => new CrmSyncError({ message: "workspace has no cloud access", cause: e })));
          const session = yield* connections
            .workerSession(binding.workspaceId)
            .pipe(
              Effect.catchTag("CrmConnectionMissing", (e) =>
                // A missing connection is a USER-facing outcome, not a crash:
                // run the finalize path through runSync's error handling by
                // failing inside it — here we short-circuit with a run row.
                Effect.fail(e),
              ),
            );
          return yield* runSync(binding, session, trigger);
        }).pipe(
          Effect.catchTag("CrmConnectionMissing", () =>
            Effect.gen(function* () {
              // Record the pause + a user-visible run entry even though the
              // sync never started.
              const binding = yield* requireBinding(bindingId);
              const p = crmErrorCopy({ _tag: "CrmConnectionMissing" } as CrmError);
              const startedAt = Date.now();
              const runId = yield* runs
                .start({
                  workspaceId: binding.workspaceId,
                  bindingId: binding.id,
                  tableId: binding.tableId,
                  trigger: "cron",
                  startedAt,
                })
                .pipe(Effect.mapError((e) => new CrmSyncError({ message: "sync run start failed", cause: e })));
              yield* runs
                .finish(runId, {
                  status: p.status,
                  rowsCreated: 0,
                  rowsUpdated: 0,
                  rowsSkipped: 0,
                  rowsStaled: 0,
                  fieldsDropped: null,
                  error: p.copy,
                  finishedAt: Date.now(),
                })
                .pipe(Effect.catchAll(() => Effect.void));
              yield* bindings
                .patch(binding.id, { pausedReason: p.pause ?? "auth_revoked", lastError: p.copy })
                .pipe(Effect.catchAll(() => Effect.void));
              const outcome: CrmSyncOutcome = {
                runId,
                bindingId: binding.id,
                tableId: binding.tableId,
                workspaceId: binding.workspaceId,
                provider: binding.provider,
                status: p.status,
                rowsCreated: 0,
                rowsUpdated: 0,
                rowsSkipped: 0,
                rowsStaled: 0,
                fieldsDropped: [],
                error: p.copy,
                errorTag: "CrmConnectionMissing",
                newRowIds: [],
              };
              return outcome;
            }),
          ),
        ),

      listDuePage: (args: {
        readonly now: number;
        readonly limit: number;
        readonly cursor: { readonly createdAt: number; readonly id: string } | null;
      }) => mapRepoError(bindings.listDuePage(args), "due page failed"),
    } as const;
  }),
  dependencies: [],
}) {}
