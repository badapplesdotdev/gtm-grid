/**
 * Notification-center model (TRI-3308) — PURE, DOM-free.
 *
 * The app used to stack full-width banners at the top of the shell (trial-ends
 * and update-available). Stacked they looked bad and ate vertical space, so
 * they're consolidated behind a bell-icon notification center. This module is the
 * model: it derives the ACTIVE notification list from app state, computes the
 * unread badge, and owns the dismissed/seen persistence shape — all unit-testable
 * offline (no DOM, no React), so App.tsx only wires the action ids to handlers
 * and renders.
 *
 * Eligibility is unchanged from the banners it replaces: the trial item mirrors
 * the old `.trial-banner` gate, and the update item mirrors the old
 * `.update-banner`.
 */

/**
 * The notification kinds the center can surface. Also the stable item `id` (one
 * of each is live at a time), so dismissed/seen sets key on the kind:
 *   - `trial.started`    — welcome, just after the 7-day trial begins.
 *   - `trial`            — the countdown ("Trial ends in N days").
 *   - `cloudActionsLow`  — nearing the plan's cloud-actions limit.
 *   - `trial.expired`    — the trial lapsed and the cloud tier is locked.
 * App-update alerts are NOT here — they live in the dedicated download affordance
 * next to the bell (UpdateDialog), not the notification center.
 */
export type NotificationKind =
  | "trial"
  | "trial.started"
  | "trial.expired"
  | "cloudActionsLow";

/** All kinds in newest-first display order — most urgent first. */
export const NOTIFICATION_ORDER: readonly NotificationKind[] = [
  "trial.expired",
  "cloudActionsLow",
  "trial",
  "trial.started",
];

/**
 * Fraction of the cloud-actions limit at/above which the low-credits warning
 * fires (e.g. 0.8 = warn once 80% is used). Below this the warning stays silent.
 */
export const CLOUD_ACTIONS_LOW_THRESHOLD = 0.8;

/** Visual tone, mapped onto the app's existing accent/warn/danger tokens. */
export type NotificationSeverity = "info" | "success" | "warning";

/**
 * A single action a notification offers. `id` is a stable, DOM-free handle the
 * UI maps to a handler (so the model never references React). `variant` picks
 * the existing button style (primary = green accent, ghost = the Dismiss/Later
 * style).
 */
export interface NotificationAction {
  readonly id: NotificationActionId;
  readonly label: string;
  readonly variant: "primary" | "ghost";
}

/** Every action id the notification center can emit. */
export type NotificationActionId = "trial.upgrade";

/** A built notification item, newest-first in {@link buildNotifications}. */
export interface AppNotification {
  readonly id: NotificationKind;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  readonly severity: NotificationSeverity;
  /** Whether the item offers an explicit Dismiss (persists). The trial item is
   * NOT user-dismissible (it self-clears when the trial ends / a card is added),
   * matching the old banner which had no Dismiss. */
  readonly dismissible: boolean;
  readonly actions: readonly NotificationAction[];
}

/** The persisted dismissed/seen sets, keyed by notification kind. */
export interface NotificationPersistState {
  readonly dismissed: readonly NotificationKind[];
  readonly seen: readonly NotificationKind[];
}

/** Empty persisted state — nothing dismissed, nothing seen. */
export const EMPTY_PERSIST_STATE: NotificationPersistState = {
  dismissed: [],
  seen: [],
};

/** The app facts that drive which notifications are active. */
export interface NotificationInputs {
  /** Whole days left until the active workspace's trial ends, or null when not
   * trialing / cloud trial banner shouldn't show (mirrors `showTrialBanner`). */
  readonly trialDaysLeft: number | null;
  /** True for the first ~24h of a fresh trial — drives the welcome item (and
   * suppresses the redundant countdown while it shows). Defaults to false. */
  readonly trialStarted?: boolean;
  /** True when the cloud tier is locked because the trial has lapsed — drives the
   * dismissible "trial expired" companion to the full-screen locked panel.
   * Defaults to false. */
  readonly trialExpired?: boolean;
  /** The workspace's cloud-actions usage, or null when unmetered/unknown. The
   * low-credits warning fires when `used / limit >= CLOUD_ACTIONS_LOW_THRESHOLD`
   * and the limit is a positive number (a null limit = unlimited = no warning). */
  readonly cloudActions?: {
    readonly used: number;
    readonly limit: number | null;
  } | null;
  /** Persisted dismissed/seen kinds. */
  readonly persist: NotificationPersistState;
}

/** The trial item's copy, matching the old `.trial-banner` text exactly. */
function trialNotification(daysLeft: number): AppNotification {
  const body =
    daysLeft === 0
      ? "Your trial ends today — add a card to keep cloud sync, realtime & shared credentials."
      : `Your trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"} — add a card to keep your cloud features.`;
  return {
    id: "trial",
    kind: "trial",
    title: daysLeft === 0 ? "Your trial ends today" : `Trial ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
    body,
    // Urgent (<=2 days) reads as a warning; otherwise informational.
    severity: daysLeft <= 2 ? "warning" : "info",
    dismissible: false,
    actions: [{ id: "trial.upgrade", label: "Upgrade now", variant: "primary" }],
  };
}

/** Welcome item shown just after a trial begins. Dismissible (it self-clears once
 * the welcome window passes; dismissing hides it sooner). */
function trialStartedNotification(): AppNotification {
  return {
    id: "trial.started",
    kind: "trial.started",
    title: "Your free trial is active",
    body: "You're on a 7-day Team trial — cloud tables, realtime sync & shared credentials are unlocked. Add a card any time to keep them after the trial.",
    severity: "success",
    dismissible: true,
    actions: [{ id: "trial.upgrade", label: "See plans", variant: "ghost" }],
  };
}

/** Item shown once the trial has lapsed and the cloud tier is locked. The
 * companion to the full-screen locked panel; dismissible so it can be cleared. */
function trialExpiredNotification(): AppNotification {
  return {
    id: "trial.expired",
    kind: "trial.expired",
    title: "Your free trial has ended",
    body: "Cloud tables, realtime sync & shared credentials are locked. Your data is safe — upgrade to unlock them again.",
    severity: "warning",
    dismissible: true,
    actions: [{ id: "trial.upgrade", label: "Upgrade now", variant: "primary" }],
  };
}

/** Low cloud-actions warning. `pct` is the whole-percent of the limit used. */
function cloudActionsLowNotification(pct: number): AppNotification {
  return {
    id: "cloudActionsLow",
    kind: "cloudActionsLow",
    title: pct >= 100 ? "You're out of cloud actions" : "Cloud actions running low",
    body:
      pct >= 100
        ? "You've used all your cloud actions for this period. Upgrade for more headroom on enrichment, webhooks & runs."
        : `You've used ${pct}% of your cloud actions. Upgrade for more headroom before runs start failing.`,
    severity: "warning",
    dismissible: true,
    actions: [{ id: "trial.upgrade", label: "Upgrade now", variant: "primary" }],
  };
}

/**
 * Derive the active notification list (newest-first) from app state:
 *   - trial.expired: the trial lapsed and the cloud tier is locked.
 *   - cloudActionsLow: at/over {@link CLOUD_ACTIONS_LOW_THRESHOLD} of the limit.
 *   - trial: a trial countdown is present (NOT dismissible; suppressed while the
 *     welcome shows and when the trial has already expired).
 *   - trial.started: the first ~24h welcome.
 * Dismissed kinds are excluded so a dismissed item never reappears in-session or
 * across sessions (the caller backs `persist` with localStorage). App-update
 * alerts are intentionally absent — they surface via the bell-adjacent download
 * button + UpdateDialog instead.
 */
export function buildNotifications(input: NotificationInputs): readonly AppNotification[] {
  const dismissed = new Set(input.persist.dismissed);
  const out: AppNotification[] = [];

  if (input.trialExpired && !dismissed.has("trial.expired")) {
    out.push(trialExpiredNotification());
  }

  const ca = input.cloudActions ?? null;
  if (
    ca !== null &&
    typeof ca.limit === "number" &&
    ca.limit > 0 &&
    ca.used / ca.limit >= CLOUD_ACTIONS_LOW_THRESHOLD &&
    !dismissed.has("cloudActionsLow")
  ) {
    const pct = Math.min(100, Math.floor((ca.used / ca.limit) * 100));
    out.push(cloudActionsLowNotification(pct));
  }

  // The countdown is redundant while the welcome shows, and meaningless once the
  // trial has expired — suppress it in both cases.
  if (
    input.trialDaysLeft !== null &&
    !input.trialStarted &&
    !input.trialExpired &&
    !dismissed.has("trial")
  ) {
    out.push(trialNotification(input.trialDaysLeft));
  }

  if (input.trialStarted && !input.trialExpired && !dismissed.has("trial.started")) {
    out.push(trialStartedNotification());
  }

  // Stable newest-first ordering regardless of insertion order above.
  return out
    .slice()
    .sort(
      (a, b) =>
        NOTIFICATION_ORDER.indexOf(a.kind) - NOTIFICATION_ORDER.indexOf(b.kind),
    );
}

/**
 * The bell badge count: active notifications the user hasn't SEEN yet. Opening
 * the center marks every active item seen (see {@link markAllSeen}), which
 * clears the badge; dismissing removes the item entirely.
 */
export function unreadCount(
  notifications: readonly AppNotification[],
  persist: NotificationPersistState,
): number {
  const seen = new Set(persist.seen);
  return notifications.filter((n) => !seen.has(n.kind)).length;
}

/**
 * Mark every CURRENTLY-active notification seen (called when the center opens).
 * Seen kinds that are no longer active are pruned so the set never grows
 * unbounded and a kind that goes away then returns is unread again.
 */
export function markAllSeen(
  notifications: readonly AppNotification[],
  persist: NotificationPersistState,
): NotificationPersistState {
  const activeKinds = new Set(notifications.map((n) => n.kind));
  const nextSeen = new Set(persist.seen);
  for (const n of notifications) nextSeen.add(n.kind);
  // Drop seen entries that are no longer active.
  const pruned = [...nextSeen].filter((k) => activeKinds.has(k));
  return { dismissed: persist.dismissed, seen: pruned };
}

/**
 * Dismiss a notification: add it to the dismissed set so it never rebuilds. The
 * seen set keeps the kind too (a dismissed item is implicitly seen), so a
 * re-eligible kind won't flash the badge from a stale seen entry.
 */
export function dismissNotification(
  kind: NotificationKind,
  persist: NotificationPersistState,
): NotificationPersistState {
  const dismissed = new Set(persist.dismissed);
  dismissed.add(kind);
  return { dismissed: [...dismissed], seen: persist.seen };
}

// ── Persistence (localStorage) ───────────────────────────────────────────────
//
// The center persists a JSON dismissed/seen map under one key.

/** The notification-center persistence key (dismissed + seen, JSON). */
export const NOTIFICATIONS_PERSIST_KEY = "gtmgrid:notifications";

/** Whether a parsed value is a NotificationKind (drops unknown/garbage kinds). */
function isKind(v: unknown): v is NotificationKind {
  // "update" / "autoSyncNudge" are intentionally excluded — legacy persisted
  // dismissals of those are dropped on parse now that updates live outside the
  // center and auto-sync (the local paradigm) is gone.
  return (
    v === "trial" ||
    v === "trial.started" ||
    v === "trial.expired" ||
    v === "cloudActionsLow"
  );
}

/** Coerce an unknown JSON value into a deduped array of valid kinds. */
function toKindList(v: unknown): NotificationKind[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<NotificationKind>();
  for (const item of v) if (isKind(item)) out.add(item);
  return [...out];
}

/**
 * Parse persisted state from the stored JSON string. Garbage / missing values
 * yield {@link EMPTY_PERSIST_STATE}.
 */
export function parsePersistState(
  raw: string | null | undefined,
): NotificationPersistState {
  let dismissed: NotificationKind[] = [];
  let seen: NotificationKind[] = [];
  if (raw != null && raw !== "") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj: Record<string, unknown> = { ...parsed };
        dismissed = toKindList(obj.dismissed);
        seen = toKindList(obj.seen);
      }
    } catch {
      /* garbage → empty */
    }
  }
  return { dismissed, seen };
}

/** Serialize persisted state back to its canonical JSON string. */
export function serializePersistState(state: NotificationPersistState): string {
  return JSON.stringify({ dismissed: state.dismissed, seen: state.seen });
}
