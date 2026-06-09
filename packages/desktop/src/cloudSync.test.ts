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
