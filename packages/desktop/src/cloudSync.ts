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
 * for ANY cloud-enabled, signed-in user (TRI-3313-A): the user does NOT need a
 * cloud project open. A signed-in user working in their LOCAL environment can
 * push local tables to a (resolved/created) cloud project, so the sync dots /
 * sync-all / push controls must be available there too. Hidden in pure-local
 * builds (`cloudEnabled` false) and when signed out — the plain row count stays.
 *
 * `inCloud` is accepted but intentionally ignored so existing callers keep their
 * signature; the visibility no longer depends on a cloud project being open.
 */
export function syncUiVisible(gate: {
  readonly cloudEnabled: boolean;
  readonly inCloud?: boolean;
  readonly isAuthenticated: boolean;
}): boolean {
  // Sync (pushing the LOCAL environment's tables up to cloud) is only meaningful
  // in LOCAL mode while signed into cloud. When a cloud project is open
  // (`inCloud`) you are already editing cloud tables directly, so the sync
  // affordances (sync-all, per-row sync dots, auto-sync toggle, nudge) are
  // hidden. `inCloud` defaults to false so callers that don't pass it (pure
  // local-mode checks) keep the old "cloud-enabled + signed in" behavior.
  return gate.cloudEnabled && gate.isAuthenticated && !gate.inCloud;
}

// ── Target cloud project resolution (TRI-3313-B) ───────────────────────────
//
// A push from the LOCAL environment must NOT require a cloud project to be open.
// The old runPush used `cloudProject?._id ?? null` and bailed ("not found") when
// local. Instead we resolve a TARGET cloud project WITHOUT opening one, mirroring
// the default-to-cloud auto-select logic (App.tsx): prefer the currently-open
// project, else the last-used (persisted) project, else the most-recent by
// `createdAt`, else the first. When the workspace has no projects at all, the
// caller must prompt the user to pick/create one (open the ProjectSwitcher)
// rather than erroring.

/** The minimal cloud-project shape this resolver needs (id + creation time). */
export interface TargetProjectCandidate {
  readonly _id: string;
  readonly createdAt: number;
}

/**
 * Resolve the cloud project a local-env push should target, WITHOUT opening one.
 * Priority: the currently-open project → the last-used (persisted) project → the
 * most-recent by `createdAt` → the first. Returns `null` when there is no project
 * to target (empty/loading list), so the caller can prompt to pick/create one.
 *
 * Pure + testable: the target decision is verifiable offline with no React.
 */
export function resolveTargetCloudProject<T extends TargetProjectCandidate>(
  open: T | null,
  lastUsedId: string | null,
  projects: readonly T[] | null | undefined,
): T | null {
  if (open) return open;
  if (!projects || projects.length === 0) return null;
  if (lastUsedId !== null && lastUsedId !== "") {
    const byId = projects.find((p) => p._id === lastUsedId);
    if (byId) return byId;
  }
  // Most recent by createdAt, falling back to the first.
  const mostRecent = [...projects].sort((a, b) => b.createdAt - a.createdAt)[0];
  return mostRecent ?? projects[0] ?? null;
}

// ── Unified table list view-model (TRI-3313-C) ─────────────────────────────
//
// The sidebar previously rendered TWO independent "Tables" sections — a cloud
// list (useCloudTables) and a local list (api.tables()) — each with its OWN
// selection, so two rows could be highlighted at once. We now build ONE merged,
// de-duplicated view-model: a local table that has a `syncLinks[id]` entry is
// "cloud-backed" (synced) and is rendered ONCE as a synced local row (its linked
// cloud table is folded in via that link, never listed twice). Cloud tables that
// are NOT the link target of any local table render as plain cloud rows.

/** One row of the unified Tables list. */
export interface TableListRow {
  /** Where the row's data lives / how the main grid should render it. */
  readonly kind: "local" | "cloud";
  /** The id used to select + render the row (local table id or cloud table id). */
  readonly id: string;
  /** The display name. */
  readonly name: string;
  /** Whether this row is cloud-backed (a cloud row, or a linked local row). */
  readonly synced: boolean;
  /** Favorite flag (local rows only; cloud rows are never favorited). */
  readonly favorite: boolean;
  /** Local row count (for the trailing count on unsynced local rows). */
  readonly rows: number;
  /** Sidebar folder the table is filed under (null = root). */
  readonly folderId: string | null;
  /** Sort position within the sidebar (fractional after drag-reorders). */
  readonly position: number;
}

/** A local table summary as seen by the list builder (subset of TableSummary). */
export interface LocalTableInput {
  readonly id: string;
  readonly name: string;
  readonly favorite: boolean;
  readonly rows: number;
  readonly folderId?: string | null;
  readonly position?: number;
}

/** A cloud table summary as seen by the list builder (subset of CloudTableSummary). */
export interface CloudTableInput {
  readonly _id: string;
  readonly name: string;
}

/**
 * Build the ONE merged, de-duplicated Tables list (TRI-3313-C). Local tables come
 * first (favorites sorted to the top, matching the old local list), each tagged
 * `synced` when a `syncLinks[id]` entry exists. Cloud tables are appended ONLY
 * when they are not already the link target of a local table (so a synced local
 * table and its cloud copy never both appear). Pure + testable: merge / dedup /
 * synced-tagging are verifiable offline with no React.
 */
export function buildTableList(args: {
  readonly localTables: readonly LocalTableInput[];
  readonly cloudTables: readonly CloudTableInput[];
  readonly syncLinks: Record<string, { cloudTableId: string }>;
}): TableListRow[] {
  const { localTables, cloudTables, syncLinks } = args;
  // Cloud ids that a local table already links to — folded into the local row.
  const linkedCloudIds = new Set<string>();
  for (const id of Object.keys(syncLinks)) {
    const cloudId = syncLinks[id]?.cloudTableId;
    if (cloudId) linkedCloudIds.add(cloudId);
  }
  const localRows: TableListRow[] = [...localTables]
    .sort((a, b) => Number(b.favorite) - Number(a.favorite))
    .map((t) => ({
      kind: "local" as const,
      id: t.id,
      name: t.name,
      synced: syncLinks[t.id] !== undefined,
      favorite: t.favorite,
      rows: t.rows,
      folderId: t.folderId ?? null,
      position: t.position ?? 0,
    }));
  const cloudRows: TableListRow[] = cloudTables
    .filter((t) => !linkedCloudIds.has(t._id))
    .map((t) => ({
      kind: "cloud" as const,
      id: t._id,
      name: t.name,
      synced: true,
      favorite: false,
      rows: 0,
      folderId: null,
      position: 0,
    }));
  return [...localRows, ...cloudRows];
}

// ── Sidebar folder grouping ─────────────────────────────────────────────────
//
// Folders partition the unified Tables list: every folder renders (even empty
// ones — they're valid drop targets), followed by the root rows. Pure +
// testable: the partitioning, orphan handling (a row pointing at a deleted /
// unknown folder falls back to the root), and group ordering are verifiable
// offline with no React.

/** A sidebar folder as the grouper sees it (local FolderSummary or cloud). */
export interface SidebarFolder {
  readonly id: string;
  readonly name: string;
  readonly position: number;
}

/** The grouped sidebar view-model: folder sections first, then root rows. */
export interface GroupedTableList {
  readonly folders: ReadonlyArray<{
    readonly folder: SidebarFolder;
    readonly rows: TableListRow[];
  }>;
  readonly root: TableListRow[];
}

/**
 * Partition the unified Tables list by folder. Folder sections come in folder
 * `position` order; each section's rows (and the root rows) PRESERVE the input
 * list's order, so {@link buildTableList}'s favorites-first / position ordering
 * holds within every group. A row whose `folderId` matches no known folder
 * (deleted out-of-band / not yet synced) falls back to the root rather than
 * vanishing.
 */
export function groupTableList(
  rows: readonly TableListRow[],
  folders: readonly SidebarFolder[],
): GroupedTableList {
  const ordered = [...folders].sort((a, b) => a.position - b.position);
  const byFolder = new Map<string, TableListRow[]>(
    ordered.map((f) => [f.id, []]),
  );
  const root: TableListRow[] = [];
  for (const row of rows) {
    const bucket = row.folderId !== null ? byFolder.get(row.folderId) : undefined;
    if (bucket) bucket.push(row);
    else root.push(row);
  }
  return {
    folders: ordered.map((folder) => ({
      folder,
      rows: byFolder.get(folder.id) ?? [],
    })),
    root,
  };
}

/**
 * The drop target of a sidebar drag, as the UI reports it:
 *   - onto a folder head / its empty body → `{ folderId }` (file at the tail)
 *   - between two rows → `{ folderId, beforeId | afterId }` (reorder)
 *   - onto the root zone → `{ folderId: null }`
 */
export interface MoveTarget {
  readonly folderId: string | null;
  readonly beforeId?: string;
  readonly afterId?: string;
}

/**
 * Compute the fractional `position` a moved table should take for a
 * {@link MoveTarget}, from the CURRENT unified list. Dropping before/after an
 * anchor row takes the midpoint between the anchor and its same-group
 * neighbour (so only the moved row's position changes); dropping onto a folder
 * or the root files at the group's tail (`max position + 1`). Returns
 * `undefined` when no position change is needed (empty group — keep the
 * current position; membership alone changes).
 */
export function positionForMove(
  rows: readonly TableListRow[],
  movedId: string,
  target: MoveTarget,
): number | undefined {
  // The target group's rows in display order, excluding the row being moved.
  const group = rows.filter(
    (r) => r.folderId === target.folderId && r.id !== movedId,
  );
  if (group.length === 0) return undefined;
  const anchorId = target.beforeId ?? target.afterId;
  const i = anchorId !== undefined ? group.findIndex((r) => r.id === anchorId) : -1;
  if (i < 0) {
    // No (valid) anchor — file at the tail of the group.
    return Math.max(...group.map((r) => r.position)) + 1;
  }
  const anchor = group[i] as TableListRow;
  if (target.beforeId !== undefined) {
    const prev = group[i - 1];
    return prev === undefined ? anchor.position - 1 : (prev.position + anchor.position) / 2;
  }
  const next = group[i + 1];
  return next === undefined ? anchor.position + 1 : (anchor.position + next.position) / 2;
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

// ── localStorage sync-link mirror (TRI-3309 bug B) ─────────────────────────
//
// The authoritative local↔cloud link lives in the sidecar meta and is now
// exposed at `GET /api/cloud/tables/links` (TRI-3311) — that is the source of
// truth the desktop hydrates from on load / project change (mergeServerSyncLinks
// below). This localStorage MIRROR is kept ONLY as an optional offline/fast-path
// cache: on each successful push we record `${projectKey}:${localTableId}` →
// cloudTableId, and on mount we seed the in-memory `syncLinks` from it
// synchronously so the status paints before the sidecar answers. The server then
// overlays and WINS on every conflict, so a stale mirror can no longer drift the
// displayed status (the sidecar meta also stays the source of truth for overwrite
// detection — the server still returns 409 if a push would clobber a cloud copy).

/** The localStorage key holding the serialized sync-link mirror. */
export const SYNC_LINKS_STORAGE_KEY = "gtmgrid:syncLinks";

/** Compose the flat mirror key for a (project, local table) pair. */
export function syncLinkKey(projectKey: string, localTableId: string): string {
  return `${projectKey}:${localTableId}`;
}

/**
 * Parse the serialized mirror into a flat `{ "projectKey:localTableId":
 * cloudTableId }` map. Defensive: a missing / malformed / non-string-valued
 * entry is dropped rather than throwing, so a corrupt localStorage value can
 * never crash hydration (worst case = empty map → tables render "Local only"
 * until the next push, same as having no mirror).
 */
export function parseSyncLinks(
  raw: string | null | undefined,
): Record<string, string> {
  if (raw === null || raw === undefined || raw === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string" && value !== "") out[key] = value;
  }
  return out;
}

/** Serialize the flat mirror back to its persisted JSON string. */
export function serializeSyncLinks(links: Record<string, string>): string {
  return JSON.stringify(links);
}

/**
 * Return a NEW mirror with the (project, local table) → cloud table link
 * recorded. Pure (does not mutate the input) so it is trivially testable and
 * safe to feed a React state updater.
 */
export function upsertSyncLink(
  links: Record<string, string>,
  projectKey: string,
  localTableId: string,
  cloudTableId: string,
): Record<string, string> {
  return { ...links, [syncLinkKey(projectKey, localTableId)]: cloudTableId };
}

/**
 * Project the flat persisted mirror onto the in-memory `syncLinks` shape for ONE
 * cloud project: `{ [localTableId]: cloudTableId }`. Only entries prefixed with
 * `${projectKey}:` are included (so switching projects shows the right links),
 * and the in-memory record carries no row count (the cloud row count is unknown
 * until the next push — the popover falls back to the local count meanwhile).
 */
export function hydrateSyncLinksForProject(
  links: Record<string, string>,
  projectKey: string,
): Record<string, string> {
  const prefix = `${projectKey}:`;
  const out: Record<string, string> = {};
  for (const [key, cloudTableId] of Object.entries(links)) {
    if (key.startsWith(prefix)) {
      out[key.slice(prefix.length)] = cloudTableId;
    }
  }
  return out;
}

// ── Single-confirm decision on a 409 (TRI-3310 bug D) ──────────────────────
//
// When a push hits server 409 (LinkConflictError) the client opens the
// `overwriteConfirm` modal. But `syncStatusFor` also maps a pending
// `overwriteConfirm` to the `conflict` design state, so if the sync popover is
// open for that same table its body ALSO renders the conflict confirm — two
// overlapping confirmation UIs. EXACTLY ONE confirmation must show. We prefer the
// modal and suppress the popover: this helper decides whether an open popover
// must be closed when the 409 modal opens for the same table.

/**
 * Decide, on a 409 re-route, whether the currently-open sync popover must be
 * closed so it does not double up with the overwrite-confirm modal. Returns true
 * ONLY when the open popover targets the SAME table the modal is opening for — a
 * popover for a different table is unrelated and stays open. Pure + testable so
 * the "never both" invariant is verifiable offline.
 */
export function shouldCloseConflictPopover(args: {
  /** The table the 409 modal is opening for. */
  readonly modalTableId: string;
  /** The table the sync popover is currently open for, if any. */
  readonly openPopoverTableId: string | null;
}): boolean {
  return (
    args.openPopoverTableId !== null &&
    args.openPopoverTableId === args.modalTableId
  );
}

// ── Server-backed sync-link hydration (TRI-3311) ───────────────────────────
//
// The authoritative local↔cloud links live in the sidecar's SQLite meta and are
// now exposed at `GET /api/cloud/tables/links` (api.cloudTableLinks()). On load /
// project change the desktop hydrates `syncLinks` from THAT (source of truth),
// keeping the localStorage mirror only as an optional offline/fast-path cache.
// Because the mirror could drift (links created/cleared on another machine, or a
// cloud table deleted out-of-band), the SERVER MUST WIN on conflict so the
// displayed status can't go stale.

/**
 * Merge the server's authoritative `{ [localTableId]: cloudTableId }` link map
 * with the localStorage mirror, with the SERVER WINNING on every conflict. The
 * mirror only fills gaps (a link the server doesn't yet report, e.g. hydrating
 * offline before the sidecar answers); any local table the server reports is
 * taken verbatim from the server, and a mirror entry that disagrees with the
 * server is DROPPED in favour of the server value — so a stale mirror can never
 * override the source of truth. Pure (mutates neither input) and testable.
 */
export function mergeServerSyncLinks(
  server: Record<string, string>,
  mirror: Record<string, string>,
): Record<string, string> {
  // Start from the mirror (fast-path / offline cache), then overlay the server
  // so every server-reported link overwrites any disagreeing mirror entry.
  return { ...mirror, ...server };
}

// ── Open-cloud-table 404 self-heal (TRI-3312) ──────────────────────────────
//
// A re-sync swap creates a NEW cloud table and deletes the old one, repointing
// the local table's link. If the currently-open cloud table id is a STALE id
// deleted before this session's link state (swaps across versions, or a teammate
// re-synced), the open grid's `getTable` returns 404 ("no longer exists"). Rather
// than leave the dead-id error, self-heal: fall back to the local table's CURRENT
// linked cloud id (from the now-server-hydrated `syncLinks`) and open that.

/**
 * Whether a cloud `getTable` result indicates the open table no longer exists.
 * The cloud grid hook surfaces a missing table as `null` (vs `undefined` while
 * loading), mirroring a 404 / not-found from `grid.getTable`. Pure so the 404
 * detection is unit-testable without React or the network.
 */
export function isCloudTableMissing(
  data: unknown | null | undefined,
): data is null {
  return data === null;
}

/**
 * Decide the cloud table id to fall back to when the currently-open cloud table
 * 404s (TRI-3312). Given the stale open cloud id, the LOCAL table the open view
 * corresponds to, and the current (server-hydrated) links map
 * (`{ [localTableId]: { cloudTableId } }`), return that local table's CURRENT
 * linked cloud id — but ONLY when it is a DIFFERENT, non-empty id (a real swap to
 * recover to). Returns `null` when there is nothing to recover to (no link, or
 * the link still points at the same — already-dead — id), so the caller leaves
 * the existing behaviour rather than looping on the same dead id.
 *
 * Pure + testable: the recovery decision is verifiable offline with no React.
 */
export function resolveStaleCloudTableFallback(args: {
  /** The open cloud table id whose load just 404'd. */
  readonly openCloudTableId: string | null;
  /** The local table the open cloud view corresponds to (its link key), if known. */
  readonly localTableId: string | null;
  /** The current links map, keyed by local table id. */
  readonly links: Record<string, { cloudTableId: string }>;
}): string | null {
  if (args.openCloudTableId === null || args.localTableId === null) return null;
  const linked = args.links[args.localTableId]?.cloudTableId;
  if (linked === undefined || linked === "") return null;
  // Only recover when the current link points somewhere ELSE than the dead id.
  return linked === args.openCloudTableId ? null : linked;
}
