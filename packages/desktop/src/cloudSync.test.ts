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

describe("syncUiVisible", () => {
  it("visible only for cloud-enabled, signed-in users with a cloud project open", () => {
    expect(syncUiVisible({ cloudEnabled: true, inCloud: true, isAuthenticated: true })).toBe(true);
  });

  it("hidden in a pure-local build (cloud disabled)", () => {
    expect(syncUiVisible({ cloudEnabled: false, inCloud: true, isAuthenticated: true })).toBe(false);
  });

  it("hidden when no cloud project is open", () => {
    expect(syncUiVisible({ cloudEnabled: true, inCloud: false, isAuthenticated: true })).toBe(false);
  });

  it("hidden when signed out", () => {
    expect(syncUiVisible({ cloudEnabled: true, inCloud: true, isAuthenticated: false })).toBe(false);
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
  const base = { cloudEnabled: true, inCloud: true, isAuthenticated: true, autoSyncOn: false, dismissed: false };

  it("shows for an eligible cloud user with auto-sync OFF and not dismissed", () => {
    expect(autoSyncNudgeVisible(base)).toBe(true);
  });

  it("hidden once auto-sync is ON (nothing to nudge)", () => {
    expect(autoSyncNudgeVisible({ ...base, autoSyncOn: true })).toBe(false);
  });

  it("hidden once dismissed (stays dismissed across sessions)", () => {
    expect(autoSyncNudgeVisible({ ...base, dismissed: true })).toBe(false);
  });

  it("hidden for ineligible users (not cloud / not signed in / no project)", () => {
    expect(autoSyncNudgeVisible({ ...base, cloudEnabled: false })).toBe(false);
    expect(autoSyncNudgeVisible({ ...base, isAuthenticated: false })).toBe(false);
    expect(autoSyncNudgeVisible({ ...base, inCloud: false })).toBe(false);
  });
});

describe("shouldAutoPush (trigger gating)", () => {
  const eligible = { autoSyncOn: true, cloudEnabled: true, inCloud: true, isAuthenticated: true };

  it("ON + eligible cloud user → auto-push", () => {
    expect(shouldAutoPush(eligible)).toBe(true);
  });

  it("OFF → no auto traffic, regardless of eligibility", () => {
    expect(shouldAutoPush({ ...eligible, autoSyncOn: false })).toBe(false);
  });

  it("ON but ineligible (signed out / no project / local build) → no auto traffic", () => {
    expect(shouldAutoPush({ ...eligible, isAuthenticated: false })).toBe(false);
    expect(shouldAutoPush({ ...eligible, inCloud: false })).toBe(false);
    expect(shouldAutoPush({ ...eligible, cloudEnabled: false })).toBe(false);
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
