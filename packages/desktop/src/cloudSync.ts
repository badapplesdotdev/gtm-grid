/**
 * Table-sync UI logic (TRI-3297) — PURE helpers, no DOM / React.
 *
 * The sidebar sync feature (status dots + popover + sync-all) is driven by these
 * helpers so the design-state mapping, the create-vs-overwrite / 409-confirm
 * decision, and the visibility gating are unit-testable offline (no DOM, no live
 * sidecar). App.tsx composes them; the network call lives in api.ts.
 *
 * v1 is ONE-WAY push (local is the source of truth). The `conflict` state is
 * reused PURELY as the destructive-overwrite confirm affordance — there is no
 * cloud→local merge. See /Users/.../design-handoff SPEC-FOR-LANES.md.
 */

/** The six design states a synced table row can be in (from SYNC_META). */
export type SyncStatus =
  | "synced"
  | "ahead"
  | "local"
  | "syncing"
  | "conflict"
  | "offline";

/** Status → human label/tone, recreated from the design's `SYNC_META`. */
export const SYNC_META: Record<SyncStatus, { label: string; tone: SyncStatus }> = {
  synced: { label: "Synced", tone: "synced" },
  ahead: { label: "Changes to push", tone: "ahead" },
  local: { label: "Local only", tone: "local" },
  syncing: { label: "Syncing…", tone: "syncing" },
  conflict: { label: "Conflict", tone: "conflict" },
  offline: { label: "Offline", tone: "offline" },
};

/**
 * Our feature's per-table sync facts, mapped onto a design state. v1 has no true
 * bidirectional conflict, so `conflict` is surfaced only as the overwrite-confirm
 * affordance (driven by `needsOverwriteConfirm`), never by a real merge.
 */
export interface TableSyncFacts {
  /** A successful push has linked this local table to a cloud table. */
  readonly linked: boolean;
  /** Local edits exist that haven't been pushed since the last successful push. */
  readonly hasLocalChanges: boolean;
  /** A push for this table is currently in flight. */
  readonly pushing: boolean;
  /** The local engine / sidecar is unreachable. */
  readonly offline: boolean;
  /**
   * A push was attempted on a linked table without confirmation and the server
   * demanded explicit overwrite confirmation (HTTP 409). Reuses the design's
   * `conflict` state as the confirm affordance.
   */
  readonly needsOverwriteConfirm: boolean;
}

/**
 * Map our link/sync facts onto a design SYNC_META status. Order encodes priority:
 *   offline > syncing > needs-confirm(conflict) > not-linked(local) >
 *   linked+changes(ahead) > linked+clean(synced).
 */
export function mapSyncStatus(facts: TableSyncFacts): SyncStatus {
  if (facts.offline) return "offline";
  if (facts.pushing) return "syncing";
  if (facts.needsOverwriteConfirm) return "conflict";
  if (!facts.linked) return "local";
  if (facts.hasLocalChanges) return "ahead";
  return "synced";
}

/**
 * Whether the sync dot / popover / sync-all controls are visible at all. Shown
 * ONLY for cloud-enabled, signed-in users with a cloud project open. Hidden in
 * pure-local builds (`cloudEnabled` false) — the plain row count stays.
 */
export function syncUiVisible(gate: {
  readonly cloudEnabled: boolean;
  readonly inCloud: boolean;
  readonly isAuthenticated: boolean;
}): boolean {
  return gate.cloudEnabled && gate.inCloud && gate.isAuthenticated;
}

/** The decision for a push attempt before any network call. */
export interface PushDecision {
  /**
   * The destructive-overwrite confirm (naming the table + row count) MUST be
   * shown before this push proceeds. True only for a re-push of a table we
   * already know is linked — overwriting cloud data. A first push (unlinked) is
   * non-destructive and needs no warning.
   */
  readonly needsConfirm: boolean;
  /** The `confirmOverwrite` flag to send to the push route. */
  readonly confirmOverwrite: boolean;
}

/**
 * Decide how to push a table given what the client knows about its link state
 * and whether the user has already confirmed an overwrite.
 *
 *   - Unlinked table → create (non-destructive): no confirm, `confirmOverwrite`
 *     false.
 *   - Linked table, not yet confirmed → MUST confirm first; do not send
 *     `confirmOverwrite` until the user accepts.
 *   - Linked table, user confirmed → send `confirmOverwrite: true`.
 *
 * The server is the source of truth: even when the client thinks a table is
 * unlinked, a 409 reply re-routes through {@link isOverwriteConfirmNeeded} so the
 * confirm still happens (see App.tsx).
 */
export function decidePush(args: {
  readonly linked: boolean;
  readonly userConfirmed: boolean;
}): PushDecision {
  if (!args.linked) return { needsConfirm: false, confirmOverwrite: false };
  if (args.userConfirmed) return { needsConfirm: false, confirmOverwrite: true };
  return { needsConfirm: true, confirmOverwrite: false };
}

/**
 * Whether a failed push response means the server is demanding an explicit
 * overwrite confirmation. TRI-3295's route returns 409 (LinkConflictError) unless
 * `confirmOverwrite=true`, so a 409 with that code is the confirm trigger.
 */
export function isOverwriteConfirmNeeded(err: {
  readonly status?: number;
  readonly code?: string | null;
}): boolean {
  return err.status === 409 || err.code === "LinkConflictError";
}

/**
 * Compose the destructive-overwrite confirm copy, naming the table + row count.
 * Mirrors the design's conflict language ("Keep my version — overwrite the cloud
 * copy") so the popover and the confirm read consistently.
 */
export function overwriteConfirmMessage(tableName: string, rowCount: number): string {
  const rows = `${rowCount.toLocaleString()} row${rowCount === 1 ? "" : "s"}`;
  return `Push “${tableName}” (${rows})? This overwrites the cloud copy with your local version.`;
}

/** Count tables with un-pushed work — drives the sync-all `.has-pending` badge. */
export function pendingCount(statuses: readonly SyncStatus[]): number {
  return statuses.filter(
    (s) => s === "ahead" || s === "local" || s === "conflict",
  ).length;
}

/** One table's facts as seen by the sync-all planner: its id, link state, and
 * current design status (so the planner can exclude already synced/in-flight). */
export interface SyncAllTable {
  readonly id: string;
  /** A successful push has linked this local table to a cloud table. */
  readonly linked: boolean;
  /** The table's mapped design status (synced/ahead/local/syncing/…). */
  readonly status: SyncStatus;
}

/**
 * The sync-all plan: which pending tables to CREATE (unlinked → non-destructive
 * first push) vs OVERWRITE (linked → re-push that clobbers the cloud copy and so
 * must be gated behind ONE bulk destructive-overwrite confirm).
 */
export interface SyncAllPlan {
  /** Unlinked pending tables — pushed straight through as create (no warning). */
  readonly toCreate: readonly string[];
  /** Linked pending tables — every one re-pushed with `confirmOverwrite:true`
   * after the single bulk confirm. NONE are ever silently dropped (TRI-3307). */
  readonly toOverwrite: readonly string[];
}

/**
 * Plan a "Sync all": split every table with un-pushed work into unlinked
 * (`toCreate`) vs linked (`toOverwrite`). This is the fix for TRI-3307 — the old
 * loop called the single-table push per table, and each linked table clobbered
 * the one `overwriteConfirm` useState, so all-but-one linked table was silently
 * skipped. By returning the FULL linked set up front, the caller can show ONE
 * bulk confirm and then push EVERY linked table (none omitted).
 *
 * Already-`synced` and in-flight `syncing` tables are excluded (no work / busy);
 * a table whose status is `offline` is also excluded (can't push). Pending =
 * `local` (→ create), `ahead` / `conflict` (→ overwrite). Link state, not status
 * alone, decides the bucket so a `conflict`-flagged linked table still overwrites.
 */
export function planSyncAll(tables: readonly SyncAllTable[]): SyncAllPlan {
  const toCreate: string[] = [];
  const toOverwrite: string[] = [];
  for (const t of tables) {
    if (t.status === "synced" || t.status === "syncing" || t.status === "offline") {
      continue;
    }
    if (t.linked) toOverwrite.push(t.id);
    else toCreate.push(t.id);
  }
  return { toCreate, toOverwrite };
}

// ── Auto-sync setting (TRI-3298) ───────────────────────────────────────────
//
// `auto_sync_offline_tables` is a GLOBAL meta flag (default OFF). When ON, the
// app auto-links + pushes ALL local tables on create and on debounced edit,
// reusing TRI-3295's push route. The settings toggle gates enabling behind an
// explicit destructive-overwrite confirm (turning it ON means local tables will
// AUTOMATICALLY and REPEATEDLY overwrite their cloud copies). These PURE helpers
// keep persistence parsing, eligibility, the trigger gate, and the debounce
// window unit-testable offline (no DOM, no live sidecar).

/** Debounce window (ms) for auto-pushing a table after a local edit. */
export const AUTO_SYNC_DEBOUNCE_MS = 1500;

/**
 * Parse the persisted `auto_sync_offline_tables` meta value into a boolean.
 * The flag DEFAULTS OFF: only the canonical string `"true"` enables it, so a
 * missing/empty/unset/garbage value is always OFF. This is the single source of
 * truth for the default so the server, the sidecar endpoint, and the client all
 * agree (a non-"true" value can never silently turn auto-sync on).
 */
export function parseAutoSyncFlag(raw: string | null | undefined): boolean {
  return raw === "true";
}

/** Serialize the auto-sync flag back to its canonical persisted string. */
export function serializeAutoSyncFlag(on: boolean): string {
  return on ? "true" : "false";
}

/**
 * Whether the auto-sync NUDGE may be shown. It nudges ONLY eligible cloud users
 * — cloud-enabled + signed in + a cloud project open (same gate as the sync UI)
 * — and ONLY when auto-sync is still OFF (nothing to nudge once it's on) and the
 * user hasn't dismissed it. Dismissal persists across sessions (the caller backs
 * `dismissed` with localStorage), so once dismissed it stays dismissed.
 */
export function autoSyncNudgeVisible(gate: {
  readonly cloudEnabled: boolean;
  readonly inCloud: boolean;
  readonly isAuthenticated: boolean;
  readonly autoSyncOn: boolean;
  readonly dismissed: boolean;
}): boolean {
  if (gate.autoSyncOn || gate.dismissed) return false;
  return syncUiVisible({
    cloudEnabled: gate.cloudEnabled,
    inCloud: gate.inCloud,
    isAuthenticated: gate.isAuthenticated,
  });
}

/**
 * The trigger gate: whether a local-table create/edit should auto-push. Returns
 * true ONLY when the setting is ON and the user is an eligible cloud target
 * (signed in with a cloud project open) — so with the setting OFF, or signed
 * out, or no cloud project, ZERO automatic push traffic is produced. App.tsx
 * checks this before scheduling any auto-push.
 */
export function shouldAutoPush(gate: {
  readonly autoSyncOn: boolean;
  readonly cloudEnabled: boolean;
  readonly inCloud: boolean;
  readonly isAuthenticated: boolean;
}): boolean {
  if (!gate.autoSyncOn) return false;
  return syncUiVisible({
    cloudEnabled: gate.cloudEnabled,
    inCloud: gate.inCloud,
    isAuthenticated: gate.isAuthenticated,
  });
}

/**
 * The enable-time destructive-overwrite warning shown before turning auto-sync
 * ON. Makes the repeated-overwrite behaviour explicit so consent happens once at
 * enable-time (per-edit prompts would defeat the automation). Toggling OFF is
 * immediate and needs no warning.
 */
export const AUTO_SYNC_ENABLE_WARNING =
  "Turn on auto-sync? Your local tables will AUTOMATICALLY and REPEATEDLY overwrite their cloud copies whenever you create or edit them. The local version always wins — cloud edits to these tables will be lost.";
