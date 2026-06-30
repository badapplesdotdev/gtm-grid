/**
 * Notification-center model tests (TRI-3308). Cover the pure model offline (no
 * DOM, no React):
 *   - the builder yields the right items per app state (trial present/absent),
 *   - unreadCount reflects active+unseen,
 *   - markAllSeen / dismissNotification transitions,
 *   - persistence parse/serialize.
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

const inputs = (over: Partial<NotificationInputs> = {}): NotificationInputs => ({
  trialDaysLeft: null,
  persist: EMPTY_PERSIST_STATE,
  ...over,
});

describe("buildNotifications — per-state items", () => {
  it("yields nothing when no state is active", () => {
    expect(buildNotifications(inputs())).toEqual([]);
  });

  it("includes the trial item when a countdown is present", () => {
    const out = buildNotifications(inputs({ trialDaysLeft: 5 }));
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("trial");
    expect(out[0].body).toContain("ends in 5 days");
    expect(out[0].dismissible).toBe(false);
    expect(out[0].actions.map((a) => a.id)).toEqual(["trial.upgrade"]);
  });

  it("uses the singular + today copy and warning severity near the edge", () => {
    const one = buildNotifications(inputs({ trialDaysLeft: 1 }))[0];
    expect(one.body).toContain("ends in 1 day");
    expect(one.body).not.toContain("1 days");
    expect(one.severity).toBe("warning");

    const today = buildNotifications(inputs({ trialDaysLeft: 0 }))[0];
    expect(today.body).toContain("ends today");
    expect(today.severity).toBe("warning");

    const far = buildNotifications(inputs({ trialDaysLeft: 9 }))[0];
    expect(far.severity).toBe("info");
  });

  it("omits the trial item when no countdown", () => {
    const out = buildNotifications(inputs({ trialDaysLeft: null }));
    expect(out.find((n) => n.kind === "trial")).toBeUndefined();
  });

  it("hides the trial item once the kind is dismissed via persist", () => {
    // The trial item itself is not user-dismissible, but a persisted dismissal
    // (defensive) still suppresses it.
    const persist: NotificationPersistState = { dismissed: ["trial"], seen: [] };
    const out = buildNotifications(inputs({ trialDaysLeft: 3, persist }));
    expect(out.map((n) => n.kind)).not.toContain("trial");
  });

  it("never includes an update item (updates live outside the notification center)", () => {
    const out = buildNotifications(inputs({ trialDaysLeft: 3 }));
    expect(out.map((n) => n.kind)).not.toContain("update");
  });

  it("shows the welcome item and suppresses the countdown during the welcome window", () => {
    const out = buildNotifications(inputs({ trialDaysLeft: 7, trialStarted: true }));
    expect(out.map((n) => n.kind)).toContain("trial.started");
    expect(out.map((n) => n.kind)).not.toContain("trial");
    const started = out.find((n) => n.kind === "trial.started")!;
    expect(started.severity).toBe("success");
    expect(started.dismissible).toBe(true);
  });

  it("shows the expired item and suppresses countdown/welcome once expired", () => {
    const out = buildNotifications(
      inputs({ trialDaysLeft: 0, trialStarted: true, trialExpired: true }),
    );
    expect(out.map((n) => n.kind)).toEqual(["trial.expired"]);
    const expired = out[0];
    expect(expired.dismissible).toBe(true);
    expect(expired.actions.map((a) => a.id)).toEqual(["trial.upgrade"]);
  });

  it("fires the low cloud-actions warning at/over the threshold only", () => {
    expect(
      buildNotifications(inputs({ cloudActions: { used: 79, limit: 100 } })).map(
        (n) => n.kind,
      ),
    ).not.toContain("cloudActionsLow");

    const low = buildNotifications(inputs({ cloudActions: { used: 80, limit: 100 } }));
    const item = low.find((n) => n.kind === "cloudActionsLow")!;
    expect(item.body).toContain("80%");
    expect(item.severity).toBe("warning");

    const out = buildNotifications(inputs({ cloudActions: { used: 100, limit: 100 } }))
      .find((n) => n.kind === "cloudActionsLow")!;
    expect(out.title).toContain("out of cloud actions");
  });

  it("treats an unlimited (null) limit as no warning", () => {
    const out = buildNotifications(
      inputs({ cloudActions: { used: 9999, limit: null } }),
    );
    expect(out.map((n) => n.kind)).not.toContain("cloudActionsLow");
  });

  it("orders the most urgent kind first", () => {
    const out = buildNotifications(
      inputs({ trialExpired: true, cloudActions: { used: 90, limit: 100 } }),
    );
    expect(out[0].kind).toBe("trial.expired");
  });
});

describe("unreadCount — active + unseen", () => {
  it("counts every active item when none are seen", () => {
    const i = inputs({ trialDaysLeft: 3 });
    const out = buildNotifications(i);
    expect(out).toHaveLength(1);
    expect(unreadCount(out, i.persist)).toBe(1);
  });

  it("excludes seen kinds from the badge", () => {
    const i = inputs({ trialDaysLeft: 3, persist: { dismissed: [], seen: ["trial"] } });
    const out = buildNotifications(i);
    expect(unreadCount(out, i.persist)).toBe(0);
  });
});

describe("markAllSeen — opening the center clears the badge", () => {
  it("marks every active item seen so unreadCount becomes 0", () => {
    const i = inputs({ trialDaysLeft: 3 });
    const out = buildNotifications(i);
    expect(unreadCount(out, i.persist)).toBe(1);
    const next = markAllSeen(out, i.persist);
    expect(unreadCount(out, next)).toBe(0);
    expect(next.seen).toEqual(["trial"]);
  });

  it("prunes seen entries that are no longer active", () => {
    const persist: NotificationPersistState = { dismissed: [], seen: ["trial"] };
    const out = buildNotifications(inputs({ trialDaysLeft: null }));
    expect(out).toEqual([]);
    const next = markAllSeen(out, persist);
    expect(next.seen).toEqual([]); // "trial" pruned (no longer active)
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
    const i = inputs({ trialDaysLeft: 3 });
    expect(buildNotifications(i).map((n) => n.kind)).toContain("trial");
    const next = dismissNotification("trial", i.persist);
    expect(next.dismissed).toContain("trial");
    expect(
      buildNotifications(inputs({ trialDaysLeft: 3, persist: next })).map((n) => n.kind),
    ).not.toContain("trial");
  });

  it("is idempotent and does not mutate the input", () => {
    const persist: NotificationPersistState = { dismissed: ["trial"], seen: [] };
    const a = dismissNotification("trial", persist);
    expect(a.dismissed).toEqual(["trial"]);
    expect(persist.dismissed).toEqual(["trial"]);
  });
});

describe("persistence — parse / serialize / round-trip", () => {
  it("round-trips dismissed + seen through serialize/parse", () => {
    const state: NotificationPersistState = { dismissed: ["trial"], seen: ["trial"] };
    const raw = serializePersistState(state);
    expect(parsePersistState(raw)).toEqual(state);
  });

  it("treats missing / garbage as empty", () => {
    expect(parsePersistState(null)).toEqual(EMPTY_PERSIST_STATE);
    expect(parsePersistState("")).toEqual(EMPTY_PERSIST_STATE);
    expect(parsePersistState("not json")).toEqual(EMPTY_PERSIST_STATE);
    expect(parsePersistState("123")).toEqual(EMPTY_PERSIST_STATE);
  });

  it("drops unknown kinds and dedupes", () => {
    const raw = JSON.stringify({ dismissed: ["trial", "bogus", "trial", "update", "autoSyncNudge"], seen: ["nope"] });
    expect(parsePersistState(raw)).toEqual({ dismissed: ["trial"], seen: [] });
  });

  it("exposes a stable persist key", () => {
    expect(NOTIFICATIONS_PERSIST_KEY).toBe("gtmgrid:notifications");
  });
});
