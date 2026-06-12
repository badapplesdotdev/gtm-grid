/**
 * Table-sync UI logic tests (TRI-3297). Cover the three pieces of business logic
 * the design AC names, extracted as pure helpers so they run offline (no DOM, no
 * live sidecar):
 *   - the design-state mapping (link/sync facts → SYNC_META status),
 *   - the create-vs-overwrite + 409-confirm decision logic,
 *   - the visibility gating.
 */

import { describe, expect, it } from "vitest";
import {
  SYNC_META,
  mapSyncStatus,
  syncUiVisible,
  decidePush,
  isOverwriteConfirmNeeded,
  overwriteConfirmMessage,
  pendingCount,
  planSyncAll,
  parseAutoSyncFlag,
  serializeAutoSyncFlag,
  autoSyncNudgeVisible,
  shouldAutoPush,
  AUTO_SYNC_DEBOUNCE_MS,
  AUTO_SYNC_ENABLE_WARNING,
  SYNC_LINKS_STORAGE_KEY,
  syncLinkKey,
  parseSyncLinks,
  serializeSyncLinks,
  upsertSyncLink,
  hydrateSyncLinksForProject,
  shouldCloseConflictPopover,
  mergeServerSyncLinks,
  isCloudTableMissing,
  resolveStaleCloudTableFallback,
  resolveTargetCloudProject,
  buildTableList,
  groupTableList,
  positionForMove,
  type TableListRow,
  type TableSyncFacts,
} from "./cloudSync";

const facts = (over: Partial<TableSyncFacts> = {}): TableSyncFacts => ({
  linked: false,
  hasLocalChanges: false,
  pushing: false,
  offline: false,
  needsOverwriteConfirm: false,
  ...over,
});

describe("mapSyncStatus", () => {
  it("not linked → local", () => {
    expect(mapSyncStatus(facts())).toBe("local");
  });

  it("linked + clean → synced", () => {
    expect(mapSyncStatus(facts({ linked: true }))).toBe("synced");
  });

  it("linked + local changes → ahead", () => {
    expect(mapSyncStatus(facts({ linked: true, hasLocalChanges: true }))).toBe("ahead");
  });

  it("push in flight → syncing (overrides linked/changes)", () => {
    expect(mapSyncStatus(facts({ linked: true, hasLocalChanges: true, pushing: true }))).toBe("syncing");
  });

  it("needs overwrite confirm → conflict", () => {
    expect(mapSyncStatus(facts({ linked: true, needsOverwriteConfirm: true }))).toBe("conflict");
  });

  it("offline wins over everything", () => {
    expect(
      mapSyncStatus(facts({ linked: true, hasLocalChanges: true, pushing: true, needsOverwriteConfirm: true, offline: true })),
    ).toBe("offline");
  });

  it("syncing takes priority over a pending confirm", () => {
    expect(mapSyncStatus(facts({ pushing: true, needsOverwriteConfirm: true }))).toBe("syncing");
  });

  it("every mapped status has SYNC_META metadata", () => {
    for (const f of [facts(), facts({ linked: true }), facts({ linked: true, hasLocalChanges: true }), facts({ pushing: true }), facts({ needsOverwriteConfirm: true, linked: true }), facts({ offline: true })]) {
      expect(SYNC_META[mapSyncStatus(f)]).toBeDefined();
    }
  });
});

describe("syncUiVisible (local-mode only — clear local/cloud separation)", () => {
  it("HIDDEN when a cloud project is open (cloud mode shows cloud tables directly, no sync)", () => {
    expect(syncUiVisible({ cloudEnabled: true, inCloud: true, isAuthenticated: true })).toBe(false);
  });

  it("hidden in a pure-local build (cloud disabled)", () => {
    expect(syncUiVisible({ cloudEnabled: false, inCloud: false, isAuthenticated: true })).toBe(false);
  });

  it("visible in the LOCAL env when signed in (no cloud project open)", () => {
    expect(syncUiVisible({ cloudEnabled: true, inCloud: false, isAuthenticated: true })).toBe(true);
  });

  it("visible when inCloud is omitted entirely (treated as local mode)", () => {
    expect(syncUiVisible({ cloudEnabled: true, isAuthenticated: true })).toBe(true);
  });

  it("hidden when signed out", () => {
    expect(syncUiVisible({ cloudEnabled: true, inCloud: false, isAuthenticated: false })).toBe(false);
  });
});

describe("decidePush", () => {
  it("unlinked table → create, no confirm, confirmOverwrite false", () => {
    expect(decidePush({ linked: false, userConfirmed: false })).toEqual({ needsConfirm: false, confirmOverwrite: false });
  });

  it("linked table, not yet confirmed → MUST confirm, do not send confirmOverwrite", () => {
    expect(decidePush({ linked: true, userConfirmed: false })).toEqual({ needsConfirm: true, confirmOverwrite: false });
  });

  it("linked table, user confirmed → send confirmOverwrite true", () => {
    expect(decidePush({ linked: true, userConfirmed: true })).toEqual({ needsConfirm: false, confirmOverwrite: true });
  });

  it("unlinked never asks for confirm even if userConfirmed is somehow true", () => {
    expect(decidePush({ linked: false, userConfirmed: true })).toEqual({ needsConfirm: false, confirmOverwrite: false });
  });
});

describe("isOverwriteConfirmNeeded", () => {
  it("treats a 409 as needing confirmation", () => {
    expect(isOverwriteConfirmNeeded({ status: 409, code: null })).toBe(true);
  });

  it("treats a LinkConflictError code as needing confirmation", () => {
    expect(isOverwriteConfirmNeeded({ status: 500, code: "LinkConflictError" })).toBe(true);
  });

  it("a generic 500 / 402 does not trigger the confirm", () => {
    expect(isOverwriteConfirmNeeded({ status: 500, code: "FatalPushError" })).toBe(false);
    expect(isOverwriteConfirmNeeded({ status: 402, code: "CloudActionsLimitError" })).toBe(false);
  });
});

describe("overwriteConfirmMessage", () => {
  it("names the table and the row count", () => {
    const msg = overwriteConfirmMessage("Leads", 1234);
    expect(msg).toContain("Leads");
    expect(msg).toContain("1,234 rows");
    expect(msg.toLowerCase()).toContain("overwrites the cloud copy");
  });

  it("singularises one row", () => {
    expect(overwriteConfirmMessage("T", 1)).toContain("1 row)");
  });
});

describe("pendingCount", () => {
  it("counts ahead / local / conflict as pending; not synced / syncing / offline", () => {
    expect(pendingCount(["synced", "ahead", "local", "syncing", "conflict", "offline"])).toBe(3);
  });

  it("is zero when everything is synced", () => {
    expect(pendingCount(["synced", "synced"])).toBe(0);
  });
});

// ── Sync-all planner (TRI-3307) ────────────────────────────────────────────
//
// The bug: the old "Sync all" loop called the single-table push per table, and
// each LINKED table clobbered the one `overwriteConfirm` state, so all-but-one
// linked+ahead table was silently dropped. planSyncAll returns the FULL linked
// set up front so the caller can confirm once and push EVERY linked table.
describe("planSyncAll", () => {
  it("splits unlinked (create) vs linked (overwrite)", () => {
    const plan = planSyncAll([
      { id: "a", linked: false, status: "local" },
      { id: "b", linked: true, status: "ahead" },
      { id: "c", linked: false, status: "local" },
      { id: "d", linked: true, status: "ahead" },
    ]);
    expect(plan.toCreate).toEqual(["a", "c"]);
    expect(plan.toOverwrite).toEqual(["b", "d"]);
  });

  it("excludes synced and in-flight syncing tables", () => {
    const plan = planSyncAll([
      { id: "a", linked: true, status: "synced" },
      { id: "b", linked: true, status: "syncing" },
      { id: "c", linked: false, status: "syncing" },
      { id: "d", linked: true, status: "ahead" },
    ]);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toOverwrite).toEqual(["d"]);
  });

  it("excludes offline tables (cannot push)", () => {
    const plan = planSyncAll([
      { id: "a", linked: false, status: "offline" },
      { id: "b", linked: true, status: "offline" },
      { id: "c", linked: false, status: "local" },
    ]);
    expect(plan.toCreate).toEqual(["c"]);
    expect(plan.toOverwrite).toEqual([]);
  });

  it("buckets a conflict-flagged linked table as overwrite", () => {
    const plan = planSyncAll([{ id: "a", linked: true, status: "conflict" }]);
    expect(plan.toOverwrite).toEqual(["a"]);
    expect(plan.toCreate).toEqual([]);
  });

  it("returns the FULL linked set — NO linked table is omitted (TRI-3307)", () => {
    const linked = ["b", "d", "e", "g"];
    const tables = [
      { id: "a", linked: false, status: "local" as const },
      { id: "b", linked: true, status: "ahead" as const },
      { id: "c", linked: true, status: "synced" as const },
      { id: "d", linked: true, status: "ahead" as const },
      { id: "e", linked: true, status: "conflict" as const },
      { id: "f", linked: false, status: "syncing" as const },
      { id: "g", linked: true, status: "ahead" as const },
    ];
    const plan = planSyncAll(tables);
    expect(plan.toOverwrite).toEqual(linked);
    // Every linked+pending table is accounted for — none silently skipped.
    expect(plan.toOverwrite).toHaveLength(linked.length);
  });

  it("pendingCount matches toCreate + toOverwrite for the same tables", () => {
    const tables = [
      { id: "a", linked: false, status: "local" as const },
      { id: "b", linked: true, status: "ahead" as const },
      { id: "c", linked: true, status: "conflict" as const },
      { id: "d", linked: true, status: "synced" as const },
      { id: "e", linked: false, status: "syncing" as const },
    ];
    const plan = planSyncAll(tables);
    // pendingCount excludes synced/syncing/offline — same exclusions the planner
    // applies — so the two views of "pending" agree.
    expect(plan.toCreate.length + plan.toOverwrite.length).toBe(
      pendingCount(tables.map((t) => t.status)),
    );
  });

  it("is empty when everything is synced", () => {
    const plan = planSyncAll([
      { id: "a", linked: true, status: "synced" },
      { id: "b", linked: true, status: "synced" },
    ]);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toOverwrite).toEqual([]);
  });
});

// ── Auto-sync setting (TRI-3298) ───────────────────────────────────────────

describe("parseAutoSyncFlag (default OFF)", () => {
  it("defaults OFF for unset / missing values", () => {
    expect(parseAutoSyncFlag(undefined)).toBe(false);
    expect(parseAutoSyncFlag(null)).toBe(false);
    expect(parseAutoSyncFlag("")).toBe(false);
  });

  it("only the canonical 'true' string enables it", () => {
    expect(parseAutoSyncFlag("true")).toBe(true);
    expect(parseAutoSyncFlag("false")).toBe(false);
  });

  it("a non-canonical / garbage value can never silently turn it on", () => {
    expect(parseAutoSyncFlag("1")).toBe(false);
    expect(parseAutoSyncFlag("TRUE")).toBe(false);
    expect(parseAutoSyncFlag("yes")).toBe(false);
  });

  it("round-trips through serialize", () => {
    expect(parseAutoSyncFlag(serializeAutoSyncFlag(true))).toBe(true);
    expect(parseAutoSyncFlag(serializeAutoSyncFlag(false))).toBe(false);
  });
});

describe("autoSyncNudgeVisible", () => {
  // Auto-sync is a LOCAL-mode activity, so the nudge lives in local mode too.
  const base = { cloudEnabled: true, inCloud: false, isAuthenticated: true, autoSyncOn: false, dismissed: false };

  it("shows for an eligible local-mode user with auto-sync OFF and not dismissed", () => {
    expect(autoSyncNudgeVisible(base)).toBe(true);
  });

  it("hidden once auto-sync is ON (nothing to nudge)", () => {
    expect(autoSyncNudgeVisible({ ...base, autoSyncOn: true })).toBe(false);
  });

  it("hidden once dismissed (stays dismissed across sessions)", () => {
    expect(autoSyncNudgeVisible({ ...base, dismissed: true })).toBe(false);
  });

  it("hidden for ineligible users (not cloud / not signed in)", () => {
    expect(autoSyncNudgeVisible({ ...base, cloudEnabled: false })).toBe(false);
    expect(autoSyncNudgeVisible({ ...base, isAuthenticated: false })).toBe(false);
  });

  it("HIDDEN in cloud mode (cloud tables are edited directly, nothing to nudge)", () => {
    expect(autoSyncNudgeVisible({ ...base, inCloud: true })).toBe(false);
  });
});

describe("shouldAutoPush (trigger gating)", () => {
  // Auto-push sends LOCAL edits up to cloud, so it only fires in local mode.
  const eligible = { autoSyncOn: true, cloudEnabled: true, inCloud: false, isAuthenticated: true };

  it("ON + eligible local-mode user → auto-push", () => {
    expect(shouldAutoPush(eligible)).toBe(true);
  });

  it("OFF → no auto traffic, regardless of eligibility", () => {
    expect(shouldAutoPush({ ...eligible, autoSyncOn: false })).toBe(false);
  });

  it("ON but ineligible (signed out / local build) → no auto traffic", () => {
    expect(shouldAutoPush({ ...eligible, isAuthenticated: false })).toBe(false);
    expect(shouldAutoPush({ ...eligible, cloudEnabled: false })).toBe(false);
  });

  it("HIDDEN in cloud mode (editing cloud tables directly — no push needed)", () => {
    expect(shouldAutoPush({ ...eligible, inCloud: true })).toBe(false);
  });
});

describe("auto-sync constants", () => {
  it("has a positive debounce window", () => {
    expect(AUTO_SYNC_DEBOUNCE_MS).toBeGreaterThan(0);
  });

  it("the enable warning makes the repeated overwrite explicit", () => {
    expect(AUTO_SYNC_ENABLE_WARNING.toLowerCase()).toContain("overwrite");
    expect(AUTO_SYNC_ENABLE_WARNING.toLowerCase()).toContain("automatically");
  });
});

// ── localStorage sync-link mirror (TRI-3309 bug B) ─────────────────────────
//
// The mirror restores Synced/ahead status after a reload (otherwise a synced
// table reads "Local only" — bug B). These tests pin the parse/serialize +
// per-project hydrate so a corrupt or cross-project value can never crash
// hydration or leak another project's links.
describe("syncLinkKey", () => {
  it("namespaces a local table id under its project", () => {
    expect(syncLinkKey("proj1", "tblA")).toBe("proj1:tblA");
  });
});

describe("parseSyncLinks (TRI-3309 bug B)", () => {
  it("returns an empty map for missing / empty values", () => {
    expect(parseSyncLinks(null)).toEqual({});
    expect(parseSyncLinks(undefined)).toEqual({});
    expect(parseSyncLinks("")).toEqual({});
  });

  it("returns an empty map for malformed JSON (never throws)", () => {
    expect(parseSyncLinks("{not json")).toEqual({});
    expect(parseSyncLinks("[1,2,3]")).toEqual({});
    expect(parseSyncLinks("42")).toEqual({});
    expect(parseSyncLinks("null")).toEqual({});
  });

  it("keeps only string-valued entries (drops malformed values)", () => {
    expect(
      parseSyncLinks(JSON.stringify({ "p:a": "cloudA", "p:b": 5, "p:c": "", "p:d": null })),
    ).toEqual({ "p:a": "cloudA" });
  });

  it("round-trips through serialize", () => {
    const links = { "p:a": "cloudA", "p:b": "cloudB" };
    expect(parseSyncLinks(serializeSyncLinks(links))).toEqual(links);
  });
});

describe("upsertSyncLink (TRI-3309 bug B)", () => {
  it("records a (project, local table) → cloud table link without mutating the input", () => {
    const before = { "p:a": "cloudA" };
    const after = upsertSyncLink(before, "p", "b", "cloudB");
    expect(after).toEqual({ "p:a": "cloudA", "p:b": "cloudB" });
    expect(before).toEqual({ "p:a": "cloudA" }); // pure — input untouched
  });

  it("overwrites an existing link (a re-sync swap repoints to a new cloud id)", () => {
    const after = upsertSyncLink({ "p:a": "oldCloud" }, "p", "a", "newCloud");
    expect(after).toEqual({ "p:a": "newCloud" });
  });
});

describe("hydrateSyncLinksForProject (TRI-3309 bug B)", () => {
  const mirror = {
    "proj1:tblA": "cloudA",
    "proj1:tblB": "cloudB",
    "proj2:tblC": "cloudC",
  };

  it("projects only the open project's links onto { localId: cloudId }", () => {
    expect(hydrateSyncLinksForProject(mirror, "proj1")).toEqual({
      tblA: "cloudA",
      tblB: "cloudB",
    });
  });

  it("does not leak another project's links", () => {
    const hydrated = hydrateSyncLinksForProject(mirror, "proj2");
    expect(hydrated).toEqual({ tblC: "cloudC" });
    expect(hydrated).not.toHaveProperty("tblA");
  });

  it("is empty for a project with no persisted links", () => {
    expect(hydrateSyncLinksForProject(mirror, "proj-unknown")).toEqual({});
  });

  it("round-trips a pushed link back to a hydrated link (status survives reload)", () => {
    // Simulate: push tblA in proj1 → write mirror → reload → hydrate.
    const written = upsertSyncLink({}, "proj1", "tblA", "cloudA");
    const reloaded = parseSyncLinks(serializeSyncLinks(written));
    expect(hydrateSyncLinksForProject(reloaded, "proj1")).toEqual({ tblA: "cloudA" });
  });

  it("exposes a stable storage key", () => {
    expect(SYNC_LINKS_STORAGE_KEY).toBe("gtmgrid:syncLinks");
  });
});

// ── Single-confirm decision on a 409 (TRI-3310 bug D) ──────────────────────
//
// On a 409 the overwrite-confirm MODAL opens; an open sync popover for the SAME
// table would also render the conflict-confirm body → two overlapping confirms.
// The helper decides whether the popover must close so EXACTLY ONE confirm shows.
describe("shouldCloseConflictPopover (TRI-3310 bug D)", () => {
  it("closes the popover when it targets the same table the modal opens for", () => {
    expect(
      shouldCloseConflictPopover({ modalTableId: "t1", openPopoverTableId: "t1" }),
    ).toBe(true);
  });

  it("leaves a popover for a DIFFERENT table open (unrelated)", () => {
    expect(
      shouldCloseConflictPopover({ modalTableId: "t1", openPopoverTableId: "t2" }),
    ).toBe(false);
  });

  it("is a no-op when no popover is open", () => {
    expect(
      shouldCloseConflictPopover({ modalTableId: "t1", openPopoverTableId: null }),
    ).toBe(false);
  });
});

// ── Server-backed sync-link hydration merge (TRI-3311) ─────────────────────
//
// On load the desktop seeds `syncLinks` from the localStorage MIRROR, then
// overlays the sidecar's authoritative map — the SERVER must WIN on conflict so
// a stale mirror can never drift the displayed status.
describe("mergeServerSyncLinks (TRI-3311 — server wins)", () => {
  it("server value wins over a STALE mirror entry for the same local table", () => {
    // The mirror points local-a at a stale cloud id; the server is authoritative.
    const mirror = { "local-a": "cloud-stale" };
    const server = { "local-a": "cloud-current" };
    expect(mergeServerSyncLinks(server, mirror)).toEqual({ "local-a": "cloud-current" });
  });

  it("keeps a mirror-only link the server has not (yet) reported (fast-path gap-fill)", () => {
    const mirror = { "local-a": "cloud-a", "local-b": "cloud-b" };
    const server = { "local-a": "cloud-a" };
    // local-b survives (offline gap-fill); local-a stays the agreed value.
    expect(mergeServerSyncLinks(server, mirror)).toEqual({
      "local-a": "cloud-a",
      "local-b": "cloud-b",
    });
  });

  it("adds a server link the mirror is missing", () => {
    expect(mergeServerSyncLinks({ "local-c": "cloud-c" }, {})).toEqual({
      "local-c": "cloud-c",
    });
  });

  it("an empty server map leaves the offline mirror intact", () => {
    const mirror = { "local-a": "cloud-a" };
    expect(mergeServerSyncLinks({}, mirror)).toEqual({ "local-a": "cloud-a" });
  });

  it("does not mutate its inputs", () => {
    const mirror = { "local-a": "cloud-stale" };
    const server = { "local-a": "cloud-current" };
    mergeServerSyncLinks(server, mirror);
    expect(mirror).toEqual({ "local-a": "cloud-stale" });
    expect(server).toEqual({ "local-a": "cloud-current" });
  });
});

// ── Open-cloud-table 404 self-heal (TRI-3312) ──────────────────────────────
describe("isCloudTableMissing (TRI-3312 — 404 detection)", () => {
  it("treats null (404 / not-found) as missing", () => {
    expect(isCloudTableMissing(null)).toBe(true);
  });

  it("treats undefined (still loading) as NOT missing", () => {
    expect(isCloudTableMissing(undefined)).toBe(false);
  });

  it("treats a loaded table as NOT missing", () => {
    expect(isCloudTableMissing({ id: "t", name: "T", columns: [], rows: [] })).toBe(false);
  });
});

describe("resolveStaleCloudTableFallback (TRI-3312 — recover to linked id)", () => {
  const links = { "local-a": { cloudTableId: "cloud-current" } };

  it("recovers to the local table's CURRENT linked cloud id when the open id is stale", () => {
    expect(
      resolveStaleCloudTableFallback({
        openCloudTableId: "cloud-deleted",
        localTableId: "local-a",
        links,
      }),
    ).toBe("cloud-current");
  });

  it("returns null when the link still points at the same (dead) id — no loop", () => {
    expect(
      resolveStaleCloudTableFallback({
        openCloudTableId: "cloud-current",
        localTableId: "local-a",
        links,
      }),
    ).toBeNull();
  });

  it("returns null when the local table has no link to recover to", () => {
    expect(
      resolveStaleCloudTableFallback({
        openCloudTableId: "cloud-deleted",
        localTableId: "local-unlinked",
        links,
      }),
    ).toBeNull();
  });

  it("returns null when the open view's local table is unknown", () => {
    expect(
      resolveStaleCloudTableFallback({
        openCloudTableId: "cloud-deleted",
        localTableId: null,
        links,
      }),
    ).toBeNull();
  });

  it("returns null when there is no open cloud table", () => {
    expect(
      resolveStaleCloudTableFallback({
        openCloudTableId: null,
        localTableId: "local-a",
        links,
      }),
    ).toBeNull();
  });
});

describe("resolveTargetCloudProject (TRI-3313-B — push target without opening)", () => {
  const p = (id: string, createdAt: number) => ({ _id: id, createdAt });

  it("prefers the currently-open project", () => {
    const open = p("open", 1);
    expect(resolveTargetCloudProject(open, "last", [p("a", 5), p("b", 9)])?._id).toBe("open");
  });

  it("falls back to the last-used (persisted) project when none open", () => {
    const list = [p("a", 5), p("last", 1), p("b", 9)];
    expect(resolveTargetCloudProject(null, "last", list)?._id).toBe("last");
  });

  it("falls back to the most-recent by createdAt when no last-used match", () => {
    const list = [p("a", 5), p("b", 9), p("c", 2)];
    expect(resolveTargetCloudProject(null, "missing", list)?._id).toBe("b");
  });

  it("falls back to the most-recent when last-used is null/empty", () => {
    const list = [p("a", 5), p("b", 9)];
    expect(resolveTargetCloudProject(null, null, list)?._id).toBe("b");
    expect(resolveTargetCloudProject(null, "", list)?._id).toBe("b");
  });

  it("returns null when there is no project to target (caller must prompt)", () => {
    expect(resolveTargetCloudProject(null, "last", [])).toBeNull();
    expect(resolveTargetCloudProject(null, "last", undefined)).toBeNull();
    expect(resolveTargetCloudProject(null, "last", null)).toBeNull();
  });
});

describe("buildTableList (TRI-3313-C — merge / dedup / synced-tagging)", () => {
  const local = (id: string, name: string, favorite = false, rows = 0) => ({ id, name, favorite, rows });
  const cloud = (id: string, name: string) => ({ _id: id, name });

  it("renders an unlinked local table as a non-synced local row", () => {
    const rows = buildTableList({ localTables: [local("l1", "Leads", false, 12)], cloudTables: [], syncLinks: {} });
    expect(rows).toEqual([
      { kind: "local", id: "l1", name: "Leads", synced: false, favorite: false, rows: 12, folderId: null, position: 0 },
    ]);
  });

  it("tags a linked local table as synced", () => {
    const rows = buildTableList({
      localTables: [local("l1", "Leads")],
      cloudTables: [],
      syncLinks: { l1: { cloudTableId: "c1" } },
    });
    expect(rows[0]).toMatchObject({ kind: "local", id: "l1", synced: true });
  });

  it("de-dups: a linked local table's cloud copy is NOT listed twice", () => {
    const rows = buildTableList({
      localTables: [local("l1", "Leads")],
      cloudTables: [cloud("c1", "Leads"), cloud("c2", "Accounts")],
      syncLinks: { l1: { cloudTableId: "c1" } },
    });
    // c1 is folded into the synced local row; only c2 surfaces as a cloud row.
    expect(rows.map((r) => `${r.kind}:${r.id}`)).toEqual(["local:l1", "cloud:c2"]);
    expect(rows.find((r) => r.id === "c2")).toMatchObject({ kind: "cloud", synced: true });
  });

  it("sorts favorited local tables to the top, then appends cloud rows", () => {
    const rows = buildTableList({
      localTables: [local("l1", "A", false), local("l2", "B", true)],
      cloudTables: [cloud("c9", "Cloudy")],
      syncLinks: {},
    });
    expect(rows.map((r) => r.id)).toEqual(["l2", "l1", "c9"]);
  });

  it("lists an unlinked cloud table as a plain synced cloud row", () => {
    const rows = buildTableList({ localTables: [], cloudTables: [cloud("c1", "Signals")], syncLinks: {} });
    expect(rows).toEqual([
      { kind: "cloud", id: "c1", name: "Signals", synced: true, favorite: false, rows: 0, folderId: null, position: 0 },
    ]);
  });

  it("carries a local table's folderId and position onto its row", () => {
    const rows = buildTableList({
      localTables: [{ ...local("l1", "Leads"), folderId: "f1", position: 3.5 }],
      cloudTables: [],
      syncLinks: {},
    });
    expect(rows[0]).toMatchObject({ folderId: "f1", position: 3.5 });
  });
});

describe("groupTableList (sidebar folder partitioning)", () => {
  const row = (id: string, folderId: string | null = null, position = 0): TableListRow => ({
    kind: "local", id, name: id, synced: false, favorite: false, rows: 0, folderId, position,
  });
  const folder = (id: string, position = 0) => ({ id, name: id, position });

  it("partitions rows into folder sections and the root, preserving order", () => {
    const grouped = groupTableList(
      [row("a", "f1"), row("b"), row("c", "f1"), row("d", "f2")],
      [folder("f1", 0), folder("f2", 1)],
    );
    expect(grouped.folders.map((s) => s.folder.id)).toEqual(["f1", "f2"]);
    expect(grouped.folders[0]?.rows.map((r) => r.id)).toEqual(["a", "c"]);
    expect(grouped.folders[1]?.rows.map((r) => r.id)).toEqual(["d"]);
    expect(grouped.root.map((r) => r.id)).toEqual(["b"]);
  });

  it("orders folder sections by folder position", () => {
    const grouped = groupTableList([], [folder("f2", 5), folder("f1", 1)]);
    expect(grouped.folders.map((s) => s.folder.id)).toEqual(["f1", "f2"]);
  });

  it("keeps an empty folder as a section (a valid drop target)", () => {
    const grouped = groupTableList([row("a")], [folder("f1")]);
    expect(grouped.folders).toHaveLength(1);
    expect(grouped.folders[0]?.rows).toEqual([]);
  });

  it("falls a row pointing at an unknown folder back to the root", () => {
    const grouped = groupTableList([row("a", "ghost")], [folder("f1")]);
    expect(grouped.root.map((r) => r.id)).toEqual(["a"]);
    expect(grouped.folders[0]?.rows).toEqual([]);
  });
});

describe("positionForMove (fractional drag-reorder positions)", () => {
  const row = (id: string, position: number, folderId: string | null = null): TableListRow => ({
    kind: "local", id, name: id, synced: false, favorite: false, rows: 0, folderId, position,
  });

  it("returns undefined for an empty target group (membership-only move)", () => {
    expect(positionForMove([row("a", 0)], "a", { folderId: "f1" })).toBeUndefined();
  });

  it("files at the tail of a folder when dropped on its head", () => {
    const rows = [row("a", 1, "f1"), row("b", 4, "f1"), row("m", 0)];
    expect(positionForMove(rows, "m", { folderId: "f1" })).toBe(5);
  });

  it("takes the midpoint when dropped between two rows", () => {
    const rows = [row("a", 1), row("b", 3), row("m", 9)];
    expect(positionForMove(rows, "m", { folderId: null, beforeId: "b" })).toBe(2);
    expect(positionForMove(rows, "m", { folderId: null, afterId: "a" })).toBe(2);
  });

  it("steps past the edge when dropped before the first / after the last row", () => {
    const rows = [row("a", 1), row("b", 3), row("m", 9)];
    expect(positionForMove(rows, "m", { folderId: null, beforeId: "a" })).toBe(0);
    expect(positionForMove(rows, "m", { folderId: null, afterId: "b" })).toBe(4);
  });

  it("ignores the moved row itself when finding neighbours", () => {
    const rows = [row("a", 1), row("m", 2), row("b", 3)];
    // Moving m after a: its old position is excluded, so the midpoint is with b.
    expect(positionForMove(rows, "m", { folderId: null, afterId: "a" })).toBe(2);
  });
});
