/**
 * Notification-center model tests (TRI-3308). Cover the pure model offline (no
 * DOM, no React):
 *   - the builder yields the right items per app state (trial present/absent,
 *     auto-sync nudge eligible/not/dismissed, update present/absent),
 *   - unreadCount reflects active+unseen,
 *   - markAllSeen / dismissNotification transitions,
 *   - persistence parse/serialize, incl. the legacy auto-sync-nudge migration
 *     (so "stays dismissed across sessions" never regresses).
 */

import { describe, expect, it } from "vitest";
import {
  buildNotifications,
  unreadCount,
  markAllSeen,
  dismissNotification,
  parsePersistState,
  serializePersistState,
  EMPTY_PERSIST_STATE,
  NOTIFICATIONS_PERSIST_KEY,
  type NotificationInputs,
  type NotificationPersistState,
} from "./notifications";

const eligibleAutoSync = {
  cloudEnabled: true,
  inCloud: true,
  isAuthenticated: true,
  autoSyncOn: false,
} as const;

const inputs = (over: Partial<NotificationInputs> = {}): NotificationInputs => ({
  trialDaysLeft: null,
  autoSync: { ...eligibleAutoSync },
  updateVersion: null,
  updateError: null,
  persist: EMPTY_PERSIST_STATE,
  ...over,
});

describe("buildNotifications — per-state items", () => {
  it("yields nothing when no state is active (with the nudge gate off)", () => {
    const out = buildNotifications(
      inputs({ autoSync: { ...eligibleAutoSync, cloudEnabled: false } }),
    );
    expect(out).toEqual([]);
  });

  it("includes the trial item when a countdown is present", () => {
    const out = buildNotifications(
      inputs({ trialDaysLeft: 5, autoSync: { ...eligibleAutoSync, cloudEnabled: false } }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("trial");
    expect(out[0].body).toContain("ends in 5 days");
    expect(out[0].dismissible).toBe(false);
    expect(out[0].actions.map((a) => a.id)).toEqual(["trial.upgrade"]);
  });

  it("uses the singular + today copy and warning severity near the edge", () => {
    const one = buildNotifications(inputs({ trialDaysLeft: 1, autoSync: { ...eligibleAutoSync, cloudEnabled: false } }))[0];
    expect(one.body).toContain("ends in 1 day");
    expect(one.body).not.toContain("1 days");
    expect(one.severity).toBe("warning");

    const today = buildNotifications(inputs({ trialDaysLeft: 0, autoSync: { ...eligibleAutoSync, cloudEnabled: false } }))[0];
    expect(today.body).toContain("ends today");
    expect(today.severity).toBe("warning");

    const far = buildNotifications(inputs({ trialDaysLeft: 9, autoSync: { ...eligibleAutoSync, cloudEnabled: false } }))[0];
    expect(far.severity).toBe("info");
  });

  it("omits the trial item when no countdown", () => {
    const out = buildNotifications(inputs({ trialDaysLeft: null, autoSync: { ...eligibleAutoSync, cloudEnabled: false } }));
    expect(out.find((n) => n.kind === "trial")).toBeUndefined();
  });

  it("includes the auto-sync nudge only for eligible cloud users with auto-sync OFF", () => {
    expect(buildNotifications(inputs()).map((n) => n.kind)).toContain("autoSyncNudge");

    // auto-sync ON → no nudge
    expect(
      buildNotifications(inputs({ autoSync: { ...eligibleAutoSync, autoSyncOn: true } })).map((n) => n.kind),
    ).not.toContain("autoSyncNudge");

    // not signed in → no nudge
    expect(
      buildNotifications(inputs({ autoSync: { ...eligibleAutoSync, isAuthenticated: false } })).map((n) => n.kind),
    ).not.toContain("autoSyncNudge");

    // not in cloud → no nudge
    expect(
      buildNotifications(inputs({ autoSync: { ...eligibleAutoSync, inCloud: false } })).map((n) => n.kind),
    ).not.toContain("autoSyncNudge");
  });

  it("auto-sync nudge keeps the overwrite warning + both actions", () => {
    const nudge = buildNotifications(inputs()).find((n) => n.kind === "autoSyncNudge");
    expect(nudge).toBeDefined();
    expect(nudge?.body).toContain("local version always overwrites the cloud copy");
    expect(nudge?.dismissible).toBe(true);
    expect(nudge?.actions.map((a) => a.id)).toEqual(["autoSync.enable", "autoSync.dismiss"]);
  });

  it("hides the auto-sync nudge once dismissed", () => {
    const persist: NotificationPersistState = { dismissed: ["autoSyncNudge"], seen: ["autoSyncNudge"] };
    const out = buildNotifications(inputs({ persist }));
    expect(out.map((n) => n.kind)).not.toContain("autoSyncNudge");
  });

  it("includes the update item with version + error when an update is present", () => {
    const out = buildNotifications(inputs({ updateVersion: "0.4.0", updateError: "Install failed.", autoSync: { ...eligibleAutoSync, cloudEnabled: false } }));
    const update = out.find((n) => n.kind === "update");
    expect(update?.body).toBe("GTM Grid v0.4.0 is available. Install failed.");
    expect(update?.actions.map((a) => a.id)).toEqual(["update.install", "update.dismiss"]);
  });

  it("omits the update item when none / dismissed", () => {
    expect(buildNotifications(inputs({ updateVersion: null })).map((n) => n.kind)).not.toContain("update");
    const persist: NotificationPersistState = { dismissed: ["update"], seen: [] };
    expect(buildNotifications(inputs({ updateVersion: "0.4.0", persist })).map((n) => n.kind)).not.toContain("update");
  });

  it("orders newest-first: update, then auto-sync nudge, then trial", () => {
    const out = buildNotifications(inputs({ trialDaysLeft: 3, updateVersion: "0.4.0" }));
    expect(out.map((n) => n.kind)).toEqual(["update", "autoSyncNudge", "trial"]);
  });
});

describe("unreadCount — active + unseen", () => {
  it("counts every active item when none are seen", () => {
    const i = inputs({ trialDaysLeft: 3, updateVersion: "0.4.0" });
    const out = buildNotifications(i);
    expect(out).toHaveLength(3);
    expect(unreadCount(out, i.persist)).toBe(3);
  });

  it("excludes seen kinds from the badge", () => {
    const i = inputs({ trialDaysLeft: 3, updateVersion: "0.4.0", persist: { dismissed: [], seen: ["update", "trial"] } });
    const out = buildNotifications(i);
    expect(unreadCount(out, i.persist)).toBe(1); // only the nudge unseen
  });

  it("is zero when every active item is seen", () => {
    const i = inputs({ trialDaysLeft: 3, updateVersion: "0.4.0", persist: { dismissed: [], seen: ["update", "trial", "autoSyncNudge"] } });
    const out = buildNotifications(i);
    expect(unreadCount(out, i.persist)).toBe(0);
  });
});

describe("markAllSeen — opening the center clears the badge", () => {
  it("marks every active item seen so unreadCount becomes 0", () => {
    const i = inputs({ trialDaysLeft: 3, updateVersion: "0.4.0" });
    const out = buildNotifications(i);
    expect(unreadCount(out, i.persist)).toBe(3);
    const next = markAllSeen(out, i.persist);
    expect(unreadCount(out, next)).toBe(0);
    expect([...next.seen].sort()).toEqual(["autoSyncNudge", "trial", "update"]);
  });

  it("prunes seen entries that are no longer active", () => {
    // update went away; previously seen.
    const persist: NotificationPersistState = { dismissed: [], seen: ["update", "trial"] };
    const out = buildNotifications(inputs({ trialDaysLeft: 3, updateVersion: null, autoSync: { ...eligibleAutoSync, cloudEnabled: false } }));
    expect(out.map((n) => n.kind)).toEqual(["trial"]);
    const next = markAllSeen(out, persist);
    expect(next.seen).toEqual(["trial"]); // "update" pruned
  });

  it("does not mutate the input persist state", () => {
    const persist: NotificationPersistState = { dismissed: [], seen: [] };
    const out = buildNotifications(inputs({ trialDaysLeft: 3 }));
    markAllSeen(out, persist);
    expect(persist.seen).toEqual([]);
  });
});

describe("dismissNotification — removes + persists", () => {
  it("adds the kind to dismissed so the builder drops it", () => {
    const i = inputs();
    expect(buildNotifications(i).map((n) => n.kind)).toContain("autoSyncNudge");
    const next = dismissNotification("autoSyncNudge", i.persist);
    expect(next.dismissed).toContain("autoSyncNudge");
    expect(buildNotifications(inputs({ persist: next })).map((n) => n.kind)).not.toContain("autoSyncNudge");
  });

  it("is idempotent and does not mutate the input", () => {
    const persist: NotificationPersistState = { dismissed: ["update"], seen: [] };
    const a = dismissNotification("update", persist);
    expect(a.dismissed).toEqual(["update"]);
    expect(persist.dismissed).toEqual(["update"]);
  });
});

describe("persistence — parse / serialize / round-trip", () => {
  it("round-trips dismissed + seen through serialize/parse", () => {
    const state: NotificationPersistState = { dismissed: ["update"], seen: ["update", "trial"] };
    const raw = serializePersistState(state);
    const back = parsePersistState(raw, false);
    expect(back).toEqual(state);
  });

  it("treats missing / garbage as empty", () => {
    expect(parsePersistState(null, false)).toEqual(EMPTY_PERSIST_STATE);
    expect(parsePersistState("", false)).toEqual(EMPTY_PERSIST_STATE);
    expect(parsePersistState("not json", false)).toEqual(EMPTY_PERSIST_STATE);
    expect(parsePersistState("123", false)).toEqual(EMPTY_PERSIST_STATE);
  });

  it("drops unknown kinds and dedupes", () => {
    const raw = JSON.stringify({ dismissed: ["update", "bogus", "update"], seen: ["nope"] });
    expect(parsePersistState(raw, false)).toEqual({ dismissed: ["update"], seen: [] });
  });

  it("migrates the legacy auto-sync-nudge dismissal so it stays dismissed", () => {
    // Old session only had the legacy flag set; new JSON empty.
    const state = parsePersistState(null, true);
    expect(state.dismissed).toContain("autoSyncNudge");
    expect(state.seen).toContain("autoSyncNudge");
    // And the builder keeps the nudge hidden across sessions.
    expect(buildNotifications(inputs({ persist: state })).map((n) => n.kind)).not.toContain("autoSyncNudge");
  });

  it("does not duplicate autoSyncNudge when both legacy flag and JSON have it", () => {
    const raw = JSON.stringify({ dismissed: ["autoSyncNudge"], seen: ["autoSyncNudge"] });
    const state = parsePersistState(raw, true);
    expect(state.dismissed).toEqual(["autoSyncNudge"]);
    expect(state.seen).toEqual(["autoSyncNudge"]);
  });

  it("exposes a stable persist key", () => {
    expect(NOTIFICATIONS_PERSIST_KEY).toBe("gtmgrid:notifications");
  });
});
