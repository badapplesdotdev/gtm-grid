import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, memo, lazy, Suspense, type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { api, TableSummary, FullTable, Column, Cell, ConnectorInfo, ExtensionInfo, AiProviderInfo, SkillInfo, type FolderSummary, type SignalSource, type CellProgressEvent } from "./api";
import { LogoMark } from "./Logo";
import { AppLoader } from "./AppLoader";
import CellDetails, { extractCode } from "./CellDetails";
import { DedupePopover } from "./DedupePopover";
import { BrandIcon } from "./BrandIcon";
import { ProjectSwitcher, CloudIcon } from "./ProjectSwitcher";
import { AccountBar, PlanBillingModal } from "./cloud/AccountBar";
import { PendingInvites } from "./cloud/PendingInvites";
import { cloudEnabled, queryClient, syncWorkspacePlan, apiClient, API_URL, getStoredAuthToken } from "./cloud/client";
import {
  SYNC_META,
  mapSyncStatus,
  syncUiVisible,
  decidePush,
  isOverwriteConfirmNeeded,
  overwriteConfirmMessage,
  pendingCount,
  planSyncAll,
  shouldAutoPush,
  parseAutoSyncFlag,
  AUTO_SYNC_DEBOUNCE_MS,
  AUTO_SYNC_ENABLE_WARNING,
  SYNC_LINKS_STORAGE_KEY,
  parseSyncLinks,
  serializeSyncLinks,
  upsertSyncLink,
  hydrateSyncLinksForProject,
  shouldCloseConflictPopover,
  mergeServerSyncLinks,
  resolveStaleCloudTableFallback,
  resolveTargetCloudProject,
  buildTableList,
  groupTableList,
  positionForMove,
  type MoveTarget,
  type SidebarFolder,
  type SyncStatus,
  type TableListRow,
} from "./cloudSync";
import { CloudPushHttpError } from "./api";
import { useMe, useActiveWorkspace, useAuthState } from "./cloud/auth";
import {
  useMyPendingInvitations,
  useAcceptInvitation,
} from "./cloud/useWorkspaceInvitations";
import {
  clearPendingInviteToken,
  usePendingInviteToken,
} from "./cloud/pendingInvite";
import { fireConfetti } from "./cloud/confetti";
import { useUpdateCheck } from "./useUpdateCheck";
import {
  buildNotifications,
  unreadCount as countUnread,
  markAllSeen,
  dismissNotification,
  parsePersistState,
  serializePersistState,
  NOTIFICATIONS_PERSIST_KEY,
  LEGACY_AUTO_SYNC_NUDGE_KEY,
  type NotificationPersistState,
  type NotificationActionId,
  type AppNotification,
} from "./notifications";
import { useWorkspaceCredentials } from "./cloud/useWorkspaceCredentials";
import {
  useCloudProjects,
  useCloudTables,
  useWorkspaceRealtime,
  useCloudFolders,
  useCloudProjectMutations,
  useCloudGridMutations,
  useCloudSyncRefresh,
  useCloudSession,
  type CloudProject,
  type CloudTableSummary,
} from "./cloud/useCloudGrid";
import { useAgentPresence } from "./cloud/agentPresence";
import { type SignalsCloud } from "./SignalsModal";
// Type-only import (erased at build) so the AgentPanel lazy chunk stays split.
import type { AgentCloudContext } from "./AgentPanel";
import type { ImportWriter } from "./csvImport";
import type { Id } from "./cloud/ids";
import { DataGrid } from "./DataGrid";
import { buildColumnMetaMap } from "./FnIcon";
import { resolveRowHeight } from "./gridVirtual";
import "./styles.css";

// ── Lazy-loaded panels (TRI-3287) ─────────────────────────────────────
// Heavy, non-initial UI is code-split out of the initial bundle so first
// paint (the core grid + shell) stays small. Each is rendered inside a
// <Suspense> with a lightweight fallback.
const AgentPanel = lazy(() => import("./AgentPanel"));
const OnboardingFlow = lazy(() =>
  import("./cloud/onboarding/OnboardingFlow").then((m) => ({ default: m.OnboardingFlow })),
);
const CloudGrid = lazy(() =>
  import("./cloud/CloudGrid").then((m) => ({ default: m.CloudGrid })),
);
const WorkspaceSettings = lazy(() =>
  import("./cloud/WorkspaceSettings").then((m) => ({ default: m.WorkspaceSettings })),
);
const ExtensionsBrowse = lazy(() =>
  import("./Panels").then((m) => ({ default: m.ExtensionsBrowse })),
);
const ExtensionPanel = lazy(() =>
  import("./Panels").then((m) => ({ default: m.ExtensionPanel })),
);
const AiProviderPanel = lazy(() =>
  import("./Panels").then((m) => ({ default: m.AiProviderPanel })),
);
const SkillsBrowse = lazy(() =>
  import("./Panels").then((m) => ({ default: m.SkillsBrowse })),
);
const SkillPanel = lazy(() =>
  import("./Panels").then((m) => ({ default: m.SkillPanel })),
);
const AddColumnPopover = lazy(() =>
  import("./AddColumn").then((m) => ({ default: m.AddColumnPopover })),
);
const FunctionsModal = lazy(() =>
  import("./AddColumn").then((m) => ({ default: m.FunctionsModal })),
);
const ColumnEditPanel = lazy(() => import("./ColumnEditPanel"));
const SignalsModal = lazy(() =>
  import("./SignalsModal").then((m) => ({ default: m.SignalsModal })),
);
const ImportCsvModal = lazy(() =>
  import("./ImportCsvModal").then((m) => ({ default: m.ImportCsvModal })),
);

/** Lightweight fallback shown while a lazy panel chunk loads. */
function PanelFallback() {
  return (
    <div className="panel-fallback" role="status" aria-live="polite">
      <span className="cell-spinner" style={{ width: 16, height: 16 }} />
    </div>
  );
}

// What the main area is showing.
type View =
  | { kind: "table" }
  | { kind: "extensions" }
  | { kind: "extension"; id: string }
  | { kind: "skills" }
  | { kind: "skill"; id: string }
  | { kind: "ai"; id: string };

// How many rows a sidebar section previews before the rest collapse behind a
// clickable "+ N more" row (Tools/Skills open their Browse-all gallery; Functions
// has no gallery, so it reveals the remaining providers inline).
const NAV_PREVIEW_LIMIT = 10;

// ─── Icons (inline SVG, no deps) ─────────────────────────

export const Icon = {
  Table: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <path d="M3 9h18M3 15h18M9 3v18"/>
    </svg>
  ),
  Plus: ({ size = 14 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  ),
  Play: ({ size = 12 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3"/>
    </svg>
  ),
  ChevronRight: () => (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  ),
  X: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  ),
  Zap: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>
  ),
  Grid: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
      <rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
    </svg>
  ),
  Puzzle: () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/>
      <line x1="7" y1="7" x2="7.01" y2="7"/>
    </svg>
  ),
  Trash: () => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
      <path d="M10 11v6M14 11v6M9 6V4h6v2"/>
    </svg>
  ),
  Folder: ({ size = 14 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
    </svg>
  ),
  FolderOpen: ({ size = 14 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>
    </svg>
  ),
  FolderPlus: ({ size = 14 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 10v6"/><path d="M9 13h6"/>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
    </svg>
  ),
  Star: ({ filled = false }: { filled?: boolean }) => (
    <svg width="11" height="11" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
  ),
  More: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>
    </svg>
  ),
  Bell: ({ size = 16 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    </svg>
  ),
  Download: ({ size = 14 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  ),
  // ── Table-sync icons (TRI-3297) — Feather/Lucide stroke-2, currentColor.
  //    Path data copied verbatim from the design handoff app/icons.jsx.
  Cloud: ({ size = 14 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>
    </svg>
  ),
  CloudUp: ({ size = 14 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 16.2A4.5 4.5 0 0 0 17.5 8h-1.8A7 7 0 1 0 4 14.9"/><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/>
    </svg>
  ),
  CloudOff: ({ size = 14 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22.61 16.95A5 5 0 0 0 18 10h-1.26a8 8 0 0 0-7.05-6M5 5a8 8 0 0 0 4 15h9a5 5 0 0 0 1.7-.3"/><line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  ),
  Refresh: ({ size = 14 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
    </svg>
  ),
  Check: ({ size = 14 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
  ),
  CheckCircle: ({ size = 14 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
    </svg>
  ),
  Alert: ({ size = 14 }: { size?: number }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  ),
};

// ─── Helpers ─────────────────────────────────────────────

function isObjectOrArray(val: unknown): boolean {
  return val !== null && typeof val === "object";
}

/** The `receivedAt` of a webhook raw-payload cell (`{receivedAt, payload}`),
 *  or `null` when the value is any other shape. */
export function webhookCellReceivedAt(val: unknown): number | null {
  if (val === null || typeof val !== "object" || Array.isArray(val)) return null;
  const o = val as { receivedAt?: unknown; payload?: unknown };
  return typeof o.receivedAt === "number" && "payload" in o ? o.receivedAt : null;
}

/** "Received <date>" label — e.g. "Jun 12, 2026, 10:26 AM". */
function formatReceivedAt(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Column width: a modest default, hard min/max so cells stay readable & clipped.
const DEFAULT_COL_W = 200;
const MIN_COL_W = 80;
const MAX_COL_W = 460;
const GUTTER_W = 48; // row-number column
const ADD_COL_W = 44; // trailing "+" column

// Max function columns run concurrently by "Run all". Independent columns fan
// out up to this bound; dependent columns still serialize behind their inputs.
const RUN_ALL_CONCURRENCY = 4;

// Persisted id of the last cloud project the user had open, so a relaunch
// reopens it (default-to-cloud for signed-in users).
const LAST_CLOUD_PROJECT_KEY = "gtmgrid:lastCloudProject";

// A function column is "free" to run when it computes locally and dispatches no
// billable connector call: a formula column (`provider === "formula"`) or a
// mapped/code column with no connector provider. Free columns always cascade —
// running them spends no credits — even with Auto-run off; a real enrichment
// (a connector provider) cascades only when Auto-run is on. (A hand-written code
// column that itself calls `sdk.<connector>` is treated as free here — an
// uncommon edge the heuristic doesn't catch; the promote/map-to-column columns
// are pure value extraction.)
export function isFreeColumn(col: Pick<Column, "kind" | "provider">): boolean {
  return col.kind === "function" && (col.provider == null || col.provider === "formula");
}

// True if any of a function column's params reference {{columnName}}.
function columnDependsOn(col: Column, columnName: string): boolean {
  const re = new RegExp(`\\{\\{\\s*${columnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}`);
  // References live in the input params (incl. a formula column's params.expression)
  // OR in the column's run condition — both should make it a dependent for auto-run.
  if (typeof col.condition === "string" && re.test(col.condition)) return true;
  return Object.values(col.params ?? {}).some((v) => typeof v === "string" && re.test(v));
}

// Build the intra-set dependency graph for a run-all: for each function column,
// the set of OTHER function-column ids it depends on (references via {{Name}}).
// Only columns within `cols` are considered — a reference to a manual column or
// to a column outside this set imposes no ordering constraint here.
export function buildColumnDeps(cols: Column[]): Map<string, Set<string>> {
  const deps = new Map<string, Set<string>>();
  for (const col of cols) {
    const set = new Set<string>();
    for (const other of cols) {
      if (other.id === col.id) continue;
      if (columnDependsOn(col, other.name)) set.add(other.id);
    }
    deps.set(col.id, set);
  }
  return deps;
}

/**
 * Run a set of function columns honouring their dependency graph with bounded
 * concurrency. Independent columns run in parallel (up to `concurrency`); a
 * column only starts once every column it depends on has finished. Cyclic or
 * unresolvable dependencies are released once no further progress is possible,
 * so every column is always attempted exactly once. `run` failures are swallowed
 * per-column (matching the prior per-column try/catch) so one bad column never
 * blocks the rest. `onColumnSettled` fires after each column completes (used for
 * progress reporting).
 */
export async function runColumnsWithDeps(
  cols: Column[],
  deps: Map<string, Set<string>>,
  concurrency: number,
  run: (col: Column) => Promise<void>,
  onColumnSettled?: () => void,
): Promise<void> {
  const byId = new Map(cols.map((c) => [c.id, c]));
  const done = new Set<string>();
  const inFlight = new Set<string>();
  const pending = new Set(cols.map((c) => c.id));
  const limit = Math.max(1, concurrency);

  const depsSatisfied = (id: string): boolean => {
    const d = deps.get(id);
    if (!d) return true;
    for (const dep of d) if (byId.has(dep) && !done.has(dep)) return false;
    return true;
  };

  return new Promise<void>((resolve) => {
    const pump = () => {
      if (pending.size === 0 && inFlight.size === 0) {
        resolve();
        return;
      }
      // Eligible = pending columns whose in-set deps are all done.
      let eligible = [...pending].filter(depsSatisfied);
      // Deadlock guard: nothing eligible and nothing running (e.g. a cycle) —
      // release the rest so they still get attempted exactly once.
      if (eligible.length === 0 && inFlight.size === 0 && pending.size > 0) {
        eligible = [...pending];
      }
      for (const id of eligible) {
        if (inFlight.size >= limit) break;
        const col = byId.get(id);
        if (!col) { pending.delete(id); continue; }
        pending.delete(id);
        inFlight.add(id);
        void Promise.resolve()
          .then(() => run(col))
          .catch(() => { /* per-column failure must not abort the run */ })
          .finally(() => {
            inFlight.delete(id);
            done.add(id);
            onColumnSettled?.();
            pump();
          });
      }
    };
    pump();
  });
}

// ─── Cell renderer ───────────────────────────────────────

const ExpandIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
  </svg>
);

type CellContentProps = {
  cell: Cell | undefined;
  col: Column;
  onEdit: (value: string) => void;
  onOpenDetails?: () => void;
  onExpand?: (anchor: { left: number; top: number; width: number }) => void;
  onRunCell?: () => void;
  running?: boolean;
  /** The column has unmet required inputs / broken {{Refs}} — empty cells
   *  render "waiting for inputs" instead of a dash. */
  waiting?: boolean;
  /** Notifies the grid when this cell enters/leaves edit mode (presence). */
  onEditingChange?: (editing: boolean) => void;
};

function CellContentInner({ cell, col, onEdit, onOpenDetails, onExpand, onRunCell, running, waiting, onEditingChange }: CellContentProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => {
    if (col.kind === "function") return;
    const current = cell?.value != null ? String(cell.value) : "";
    setDraft(current);
    setEditing(true);
    onEditingChange?.(true);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const commit = () => {
    setEditing(false);
    onEditingChange?.(false);
    onEdit(draft);
  };

  // Per-cell run button (function cells only) — runs just this row × column.
  const runBtn = col.kind === "function" && onRunCell ? (
    <button
      className="cell-run"
      title="Run this cell"
      onClick={e => { e.stopPropagation(); onRunCell(); }}
    >
      <Icon.Play size={9} />
    </button>
  ) : null;

  // Expand button → opens the full-content editor (for long text / transcripts).
  const expandBtn = onExpand ? (
    <button
      className="cell-expand"
      title="Expand"
      onClick={e => {
        e.stopPropagation();
        const r = (e.currentTarget.closest("td") as HTMLElement | null)?.getBoundingClientRect();
        onExpand({ left: r?.left ?? 80, top: r?.top ?? 80, width: r?.width ?? 280 });
      }}
    >
      <ExpandIcon />
    </button>
  ) : null;

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="cell-input"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setEditing(false);
            onEditingChange?.(false);
          }
        }}
        autoFocus
      />
    );
  }

  if (running || cell?.status === "running") {
    return (
      <div className="cell-wrap">
        <span className="cell-running">
          <span className="cell-spinner"/>
          running
        </span>
      </div>
    );
  }

  if (!cell || cell.status === "empty" || cell.status === "pending") {
    // A row gated off by the column's run condition carries a note on an empty
    // cell — render the Clay-style neutral "Skipped" pill (full note on hover).
    if (cell?.status === "empty" && cell.error) {
      return (
        <div className="cell-wrap" title={cell.error}>
          {runBtn}
          <span className="cell-skipped">⊘ Skipped</span>
        </div>
      );
    }
    // Queued: the run has claimed this cell but hasn't reached it yet.
    if (cell?.status === "pending") {
      return <div className="cell-wrap">{runBtn}<span className="cell-queued">queued</span></div>;
    }
    if (col.kind === "function") {
      // Column-level "waiting for inputs": a required mapping is unset or
      // points at a deleted column — running now would fail, so say why.
      if (waiting) {
        return (
          <div className="cell-wrap" title="A required input is unmapped or references a missing column — edit the column to fix its mapping">
            {runBtn}
            <span className="cell-waiting">waiting for inputs</span>
          </div>
        );
      }
      return <div className="cell-wrap">{runBtn}<span className="cell-empty">—</span></div>;
    }
    return <div className="cell-wrap cell-editable" onClick={startEdit}><span className="cell-empty">empty</span></div>;
  }

  if (cell.status === "error") {
    const code = cell.error?.match(/\b(\d{3})\b/)?.[1];
    return (
      <div className="cell-wrap" title={cell.error ?? "error"}>
        {runBtn}
        <span className="cell-status err" onClick={onOpenDetails}>
          {code ? `Status Code: ${code}` : "Error"}
        </span>
      </div>
    );
  }

  // Webhook raw-payload cell ({receivedAt, payload}) — render the Clay-style
  // "Received <date>" pill; click opens the details panel to map fields out.
  const webhookReceivedAt = webhookCellReceivedAt(cell.value);
  if (webhookReceivedAt !== null) {
    return (
      <div className="cell-wrap">
        <span
          className="cell-status ok"
          title="Click to view the received payload"
          onClick={onOpenDetails}
        >
          ⚡ Received {formatReceivedAt(webhookReceivedAt)}
        </span>
      </div>
    );
  }

  // done / has value — objects collapse to a status pill (click to open fields).
  // A connector can return an error AS a value (e.g. `{ error: "timeout" }`) without
  // throwing, so the cell is `done` yet really failed — surface that as an error pill
  // rather than a misleading green success. Show a real status code when the object
  // carries one; otherwise don't fabricate "200".
  if (isObjectOrArray(cell.value)) {
    const obj = !Array.isArray(cell.value) && cell.value && typeof cell.value === "object"
      ? (cell.value as Record<string, unknown>)
      : null;
    const errMsg = obj && typeof obj.error === "string" && obj.error.trim() ? obj.error.trim() : null;
    if (errMsg) {
      return (
        <div className="cell-wrap" title={errMsg}>
          {runBtn}
          <span className="cell-status err" onClick={onOpenDetails}>
            {errMsg.length > 28 ? `${errMsg.slice(0, 28)}…` : errMsg}
          </span>
        </div>
      );
    }
    const code = obj && (typeof obj.status === "number" ? obj.status
      : typeof obj.statusCode === "number" ? obj.statusCode : null);
    return (
      <div className="cell-wrap">
        {runBtn}
        <span className="cell-status ok" title="Click to view fields" onClick={onOpenDetails}>
          {code != null ? `Status Code: ${code}` : "View data"}
        </span>
      </div>
    );
  }

  const strVal = cell.value != null ? String(cell.value) : "";
  return (
    <div className="cell-wrap" onClick={col.kind === "manual" ? startEdit : undefined}
         style={col.kind === "manual" ? { cursor: "text" } : {}}>
      <span className="cell-value">{strVal}</span>
      <div className="cell-actions">{expandBtn}{runBtn}</div>
    </div>
  );
}

/**
 * Memoized cell renderer. A grid has thousands of cells; without this, any App
 * state change (e.g. a single cell edit, an unrelated panel toggle) re-renders
 * EVERY mounted cell. The comparator skips re-render unless this cell's own
 * data changed: its value/status/error, its `running` flag, or its `col`
 * identity. Callback props (`onEdit`, `onRunCell`, …) are intentionally NOT
 * compared — call sites create fresh closures per render, so comparing them
 * would defeat memoization. They are safe to ignore because each closure only
 * captures the cell's stable `row.id`/`col.id`, so a stale closure still writes
 * the correct cell. `running` and `onRunCell`-presence are the only render-
 * affecting inputs derived from those props, and both are compared.
 */
function cellPropsEqual(prev: CellContentProps, next: CellContentProps): boolean {
  return (
    prev.col === next.col &&
    prev.running === next.running &&
    prev.waiting === next.waiting &&
    prev.cell?.value === next.cell?.value &&
    prev.cell?.status === next.cell?.status &&
    prev.cell?.error === next.cell?.error &&
    // Run/expand/details affordances are gated on whether the handler exists.
    !prev.onRunCell === !next.onRunCell &&
    !prev.onExpand === !next.onExpand &&
    !prev.onOpenDetails === !next.onOpenDetails
  );
}

export const CellContent = memo(CellContentInner, cellPropsEqual);

// ─── Expanded cell editor ─────────────────────────────────
// A popover for viewing / editing long cell content (transcripts, summaries…)
// without ballooning the grid. Fixed width, with a maximize toggle.

export function ExpandedEditor({
  columnName,
  value,
  editable,
  anchor,
  onSave,
  onClose,
}: {
  columnName: string;
  value: string;
  editable: boolean;
  anchor: { left: number; top: number; width: number };
  onSave: (v: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [big, setBig] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setTimeout(() => taRef.current?.focus(), 0); }, []);

  const words = draft.trim() ? draft.trim().split(/\s+/).length : 0;
  const chars = draft.length;

  const W = big ? 720 : Math.max(440, Math.min(anchor.width, 560));
  const style: CSSProperties = big
    ? { position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: W }
    : {
        position: "fixed",
        width: W,
        left: Math.max(12, Math.min(anchor.left, window.innerWidth - W - 12)),
        top: Math.max(12, Math.min(anchor.top, window.innerHeight - 360)),
      };

  const save = () => { if (editable) onSave(draft); onClose(); };

  return (
    <div className="popover-scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="xcell" style={style} onMouseDown={e => e.stopPropagation()}>
        <div className="xcell-head">
          <div className="xcell-head-text">
            <div className="xcell-title">{columnName}</div>
            <div className="xcell-sub">Expanded editor</div>
          </div>
          <button className="xcell-max" title={big ? "Shrink" : "Maximize"} onClick={() => setBig(b => !b)}>
            <ExpandIcon />
          </button>
        </div>
        <textarea
          ref={taRef}
          className={`xcell-area${big ? " big" : ""}`}
          value={draft}
          readOnly={!editable}
          spellCheck={false}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); save(); }
            if (e.key === "Escape") onClose();
          }}
        />
        <div className="xcell-foot">
          <span>{editable ? "Cmd/Ctrl+Enter to save" : "Read only"}</span>
          <span>{words} word{words !== 1 ? "s" : ""}, {chars} chars</span>
        </div>
      </div>
    </div>
  );
}

// ─── New Table Modal ──────────────────────────────────────

function NewTableModal({ onClose, onCreated, folderId = null }: { onClose: () => void; onCreated: (id: string) => void; folderId?: string | null }) {
  const [name, setName] = useState("Untitled table");
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const t = await api.createTable(name.trim(), folderId);
      onCreated(t.id);
      onClose();
    } catch {
      setSaving(false);
    }
  };

  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">New table</span>
          <button className="modal-close" onClick={onClose}><Icon.X /></button>
        </div>
        <div className="modal-body">
          <div className="form-row">
            <label className="form-label">Table name</label>
            <input className="form-input" value={name} onChange={e => setName(e.target.value)} autoFocus
              onKeyDown={e => e.key === "Enter" && handleCreate()} />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleCreate} disabled={saving || !name.trim()}>
            {saving ? "Creating…" : "Create table"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── New Table Chooser ────────────────────────────────────

/**
 * The "New table" chooser — three option tiles (Blank / CSV upload / Webhook)
 * replacing the old straight-to-blank entry points. Reuses the centered
 * `.overlay > .modal` surface and the `.acx-*` tile pattern. Webhook is
 * CLOUD-ONLY: in local mode the tile is disabled with a "requires a cloud
 * workspace" hint (the design's paid/cloud gate).
 */
function NewTableChooser({
  inCloud,
  onClose,
  onBlank,
  onCsv,
  onWebhook,
  onSignals,
}: {
  inCloud: boolean;
  onClose: () => void;
  onBlank: () => void;
  onCsv: () => void;
  onWebhook: () => void;
  onSignals: () => void;
}) {
  const Caret = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
  );
  const UploadIcon = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
  );
  const WebhookIcon = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17a4 4 0 0 1 3.6-3.98" /><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06" /><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8" /></svg>
  );
  const LockIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
  );

  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 440 }}>
        <div className="modal-header">
          <span className="modal-title">New table</span>
          <button className="modal-close" onClick={onClose}><Icon.X /></button>
        </div>
        <div className="modal-body">
          <div className="acx-group" style={{ margin: 0 }}>
            <button className="acx-item" onClick={() => { onBlank(); onClose(); }}>
              <span className="acx-item-icon acx-icon-accent"><Icon.Table /></span>
              <span className="acx-item-text">
                <span className="acx-item-title">Start empty</span>
                <span className="acx-item-sub">A blank grid you fill in yourself.</span>
              </span>
              <span className="acx-item-caret">{Caret}</span>
            </button>
            <button className="acx-item" onClick={() => { onCsv(); onClose(); }}>
              <span className="acx-item-icon">{UploadIcon}</span>
              <span className="acx-item-text">
                <span className="acx-item-title">Import a CSV</span>
                <span className="acx-item-sub">Drop a file; map columns; populate rows.</span>
              </span>
              <span className="acx-item-caret">{Caret}</span>
            </button>
            <button className="acx-item" onClick={() => { onSignals(); onClose(); }}>
              <span className="acx-item-icon"><BrandIcon logo="https://www.google.com/s2/favicons?domain=trigify.io&sz=128" name="Trigify" size={18} /></span>
              <span className="acx-item-text">
                <span className="acx-item-title">From Social Signals</span>
                <span className="acx-item-sub">Powered by Trigify — pulls social posts into rows (API key required).</span>
              </span>
              <span className="acx-item-caret">{Caret}</span>
            </button>
            {inCloud ? (
              <button className="acx-item" onClick={() => { onWebhook(); onClose(); }}>
                <span className="acx-item-icon">{WebhookIcon}</span>
                <span className="acx-item-text">
                  <span className="acx-item-title">Driven by a webhook</span>
                  <span className="acx-item-sub">POST JSON to populate rows automatically.</span>
                </span>
                <span className="acx-item-caret">{Caret}</span>
              </button>
            ) : (
              <button className="acx-item acx-disabled" disabled title="Requires a cloud workspace">
                <span className="acx-item-icon">{WebhookIcon}</span>
                <span className="acx-item-text">
                  <span className="acx-item-title">Driven by a webhook</span>
                  <span className="acx-item-sub">Requires a cloud workspace.</span>
                </span>
                <span className="acx-item-caret" style={{ color: "var(--text-3)" }}>{LockIcon}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sync popover (TRI-3297) ──────────────────────────────
// The per-table sync dialog, anchored to the right of the clicked sidebar row.
// Head = table name + status pill; a workspace row; and a state-varying body
// (synced / ahead|local / syncing / conflict-as-overwrite-confirm / offline).
// Recreated from the design's `SyncPopover` (app/SyncPanel.jsx + app/sync.css),
// mapped onto the live app's tokens.

const SyncDot = ({ status }: { status: SyncStatus }) => (
  <span className={`sync-dot is-${status}`} aria-label={SYNC_META[status].label} />
);

function SyncPopover({
  tableName,
  rowCount,
  status,
  workspaceName,
  memberCount,
  anchorTop,
  sidebarWidth,
  cloudRowCount,
  error,
  onPush,
  onConfirmOverwrite,
  onRepush,
  onClose,
}: {
  tableName: string;
  rowCount: number;
  status: SyncStatus;
  workspaceName: string;
  memberCount: number;
  anchorTop: number;
  sidebarWidth: number;
  cloudRowCount: number | null;
  error: string | null;
  onPush: () => void;
  onConfirmOverwrite: () => void;
  // TRI-3306: v1 sync is one-way (local→cloud), so the synced state offers a
  // re-push, not a "check for updates" (there is nothing to pull).
  onRepush: () => void;
  onClose: () => void;
}) {
  const meta = SYNC_META[status];
  // TRI-3314-2: clamp `top` against the ACTUAL rendered height, not a fixed 330px
  // guess. A tall branch (conflict / synced + error) used to exceed the guess and
  // clip the action button. We measure the popover after layout and re-clamp so it
  // can never overflow the bottom edge (and flips above the anchor when needed).
  const popRef = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(() => Math.max(8, Math.min(anchorTop, window.innerHeight - 330)));
  useLayoutEffect(() => {
    const el = popRef.current;
    const measured = el ? el.getBoundingClientRect().height : 330;
    setTop(Math.max(8, Math.min(anchorTop, window.innerHeight - measured - 8)));
  }, [anchorTop, status, error]);
  return (
    <>
      <div className="popover-scrim" onMouseDown={onClose} />
      <div
        ref={popRef}
        className="sync-pop"
        style={{ top, left: sidebarWidth + 8 }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Sync ${tableName}`}
      >
        <div className="sync-pop-head">
          <span className="sync-pop-table">
            <span className="sync-pop-table-ic"><Icon.Table /></span>
            {tableName}
          </span>
          <span className={`sync-pill is-${meta.tone}`}>
            <SyncDot status={status} />
            {meta.label}
          </span>
        </div>

        <div className="sync-pop-ws">
          <span className="sync-pop-ws-text">
            <span className="sync-pop-ws-name">{workspaceName}</span>
            <span className="sync-pop-ws-sub">{memberCount} member{memberCount === 1 ? "" : "s"} · realtime</span>
          </span>
        </div>

        {status === "syncing" ? (
          <div className="sync-prog">
            <div className="sync-prog-top">
              <span className="cell-spinner" />
              <span>Uploading rows…</span>
            </div>
            <div className="sync-prog-bar"><span style={{ width: "60%" }} /></div>
            <div className="sync-prog-note">execution stays local — only table data is uploaded</div>
          </div>
        ) : status === "synced" ? (
          <div className="sync-body">
            <div className="sync-row"><span className="sync-row-k">Rows in cloud</span><span className="sync-row-v mono">{(cloudRowCount ?? rowCount).toLocaleString()}</span></div>
            <button className="btn btn-outline sync-act" onClick={onRepush}>
              <Icon.CloudUp size={13} /> Re-push to cloud
            </button>
            {error && <div className="account-menu-error" role="alert">{error}</div>}
          </div>
        ) : status === "conflict" ? (
          <div className="sync-body">
            <div className="sync-conflict-note">
              <Icon.Alert size={13} />
              <span>Re-syncing <strong>{tableName}</strong> overwrites the cloud copy ({rowCount.toLocaleString()} row{rowCount === 1 ? "" : "s"}) with your local version.</span>
            </div>
            <div className="sync-choices">
              <button className="sync-choice" onClick={onConfirmOverwrite}>
                <span className="sync-choice-t">Keep my version</span>
                <span className="sync-choice-s">overwrite the cloud copy</span>
              </button>
              <button className="sync-choice" onClick={onClose}>
                <span className="sync-choice-t">Cancel</span>
                <span className="sync-choice-s">leave the cloud copy as-is</span>
              </button>
            </div>
            {error && <div className="account-menu-error" role="alert">{error}</div>}
          </div>
        ) : status === "offline" ? (
          <div className="sync-body">
            <div className="sync-offline-note">
              <Icon.CloudOff size={14} />
              <span>Engine offline. Changes are saved locally and will push when you reconnect.</span>
            </div>
          </div>
        ) : (
          /* ahead OR local */
          <div className="sync-body">
            <div className="sync-diff">
              <div className="sync-diff-line new"><span className="sync-diff-ic">↑</span>{rowCount.toLocaleString()} row{rowCount === 1 ? "" : "s"} · not in cloud yet</div>
            </div>
            <button className="btn btn-primary sync-act" onClick={onPush}>
              <Icon.CloudUp size={14} /> Push table to cloud
            </button>
            <div className="sync-prog-note">teammates get your changes in realtime</div>
            {error && <div className="account-menu-error" role="alert">{error}</div>}
          </div>
        )}
      </div>
    </>
  );
}

// ─── Notification center (TRI-3308) ───────────────────────
// The bell popover. Reuses the account-menu shell (same surface / border /
// radius / shadow tokens + green accent) so it matches the app's existing
// popovers. Lists the active notifications newest-first; empty state when none.
function NotificationCenter({
  notifications,
  onAction,
  onDismiss,
  onClose,
  anchorRef,
}: {
  notifications: readonly AppNotification[];
  onAction: (id: NotificationActionId) => void;
  onDismiss: (kind: AppNotification["kind"]) => void;
  onClose: () => void;
  anchorRef: { readonly current: HTMLButtonElement | null };
}) {
  // Close on Escape for keyboard accessibility.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Position as a viewport-FIXED popover anchored just under the bell and clamped
  // on-screen — as an absolute child of the sidebar header it gets clipped by the
  // sidebar's overflow, so we measure the bell rect and place it fixed instead.
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 8, left: 8 });
  useLayoutEffect(() => {
    const a = anchorRef.current?.getBoundingClientRect();
    if (!a) return;
    const w = popRef.current?.offsetWidth ?? 320;
    const left = Math.max(8, Math.min(a.right - w, window.innerWidth - w - 8));
    setPos({ top: a.bottom + 6, left });
  }, [anchorRef, notifications.length]);
  return (
    <>
      <div className="popover-scrim" onMouseDown={onClose} />
      <div
        ref={popRef}
        className="account-menu notif-pop"
        style={{ top: pos.top, left: pos.left }}
        role="dialog"
        aria-label="Notifications"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="account-menu-head">
          <div className="account-menu-head-text">
            <strong>Notifications</strong>
            <span>{notifications.length === 0 ? "Nothing needs your attention" : `${notifications.length} update${notifications.length === 1 ? "" : "s"}`}</span>
          </div>
        </div>
        <div className="notif-list">
          {notifications.length === 0 ? (
            <div className="notif-empty">
              <Icon.CheckCircle size={20} />
              <span>You&apos;re all caught up</span>
            </div>
          ) : (
            notifications.map((n) => (
              <div key={n.id} className={`notif-item is-${n.severity}`}>
                <div className="notif-item-body">
                  <span className="notif-item-title">{n.title}</span>
                  <span className="notif-item-text">{n.body}</span>
                </div>
                <div className="notif-item-actions">
                  {n.actions.map((a) => (
                    <button
                      key={a.id}
                      className={a.variant === "primary" ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm"}
                      onClick={() => onAction(a.id)}
                    >
                      {a.label}
                    </button>
                  ))}
                  {/* Fallback Dismiss for a dismissible item whose actions don't
                      already include one (none today, but keeps the contract). */}
                  {n.dismissible && !n.actions.some((a) => a.id.endsWith(".dismiss")) && (
                    <button className="btn btn-ghost btn-sm" onClick={() => onDismiss(n.kind)}>Dismiss</button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

// ─── Main App ─────────────────────────────────────────────

export default function App() {
  // Health
  const [healthStatus, setHealthStatus] = useState<"loading" | "connected" | "offline">("loading");
  const [projectName, setProjectName] = useState("gtmgrid");

  // Tables
  const [tables, setTables] = useState<TableSummary[]>([]);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [tableData, setTableData] = useState<FullTable | null>(null);
  const [tableLoading, setTableLoading] = useState(false);
  const [renamingTableId, setRenamingTableId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDeleteTable, setConfirmDeleteTable] = useState<TableSummary | null>(null);
  const [confirmDeleteCloudTable, setConfirmDeleteCloudTable] = useState<{ _id: Id<"tables">; name: string } | null>(null);

  // Sidebar folders (local project; cloud folders come from useCloudFolders).
  const [localFolders, setLocalFolders] = useState<FolderSummary[]>([]);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [folderDraft, setFolderDraft] = useState("");
  // The header "+" add menu (New table / New folder).
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  // Folder a "New table here" should file the created table under (null = root).
  const [newTableFolderId, setNewTableFolderId] = useState<string | null>(null);
  // Folder expand/collapse — per-device UI state, persisted across sessions.
  // Default CLOSED (an absent key = collapsed) so a teammate's new folder
  // arrives tidy.
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>(() => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem("gtmgrid:openFolders") ?? "{}");
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, boolean>)
        : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try { localStorage.setItem("gtmgrid:openFolders", JSON.stringify(openFolders)); } catch { /* ignore */ }
  }, [openFolders]);
  // Drag-and-drop: the table row being dragged + the current drop target.
  const [dragTableId, setDragTableId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<
    | { kind: "table"; id: string; pos: "before" | "after" }
    | { kind: "folder"; id: string }
    | { kind: "root" }
    | null
  >(null);

  // Connectors / extensions / AI providers
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [aiProviders, setAiProviders] = useState<AiProviderInfo[]>([]);
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({});
  const [fnSectionOpen, setFnSectionOpen] = useState(false); // Functions section: collapsed by default
  const [fnShowAll, setFnShowAll] = useState(false); // Functions: reveal providers past the preview limit inline (no gallery to open)
  const [aiSectionOpen, setAiSectionOpen] = useState(true);
  const [extSectionOpen, setExtSectionOpen] = useState(true);
  const [skillsSectionOpen, setSkillsSectionOpen] = useState(false); // Skills section: collapsed by default

  // Which detail (table grid / extension / AI provider) the main area shows.
  const [view, setView] = useState<View>({ kind: "table" });

  // Modals
  const [showAddCol, setShowAddCol] = useState(false);
  const [addColAnchor, setAddColAnchor] = useState<{ left: number; top: number } | null>(null);
  const [showFunctions, setShowFunctions] = useState(false);
  const [editCol, setEditCol] = useState<Column | null>(null);
  const [showNewTable, setShowNewTable] = useState(false);
  // The "New table" chooser (Blank / CSV / Webhook) replaces the old
  // straight-to-blank entry points.
  const [showNewTableChooser, setShowNewTableChooser] = useState(false);
  const [showSignals, setShowSignals] = useState(false);
  const [warmingTableId, setWarmingTableId] = useState<string | null>(null);
  const warmTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Bumped to ask the CloudGrid to auto-open the webhook setup form (the chooser's
  // Webhook flow). A monotonic token so each request re-triggers cleanly.
  const [openWebhookToken, setOpenWebhookToken] = useState(0);
  const [showProjects, setShowProjects] = useState(false);
  const [showWorkspaceSettings, setShowWorkspaceSettings] = useState(false);
  const [currentProjectPath, setCurrentProjectPath] = useState<string | null>(null);
  // Resizable sidebar — width persisted to localStorage, clamped to a sane range.
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem("gtmgrid:sidebarW"));
    return v >= 200 && v <= 480 ? v : 240;
  });
  const startSidebarResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    document.body.style.cursor = "col-resize";
    const onMove = (ev: MouseEvent) =>
      setSidebarWidth(Math.min(480, Math.max(200, startW + ev.clientX - startX)));
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      setSidebarWidth((w) => {
        try { localStorage.setItem("gtmgrid:sidebarW", String(w)); } catch { /* ignore */ }
        return w;
      });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // ── Cloud project mode (multiplayer via Convex) ──────────────
  // A cloud project is selected from the switcher; while one is active the main
  // area renders the live CloudGrid instead of the local sidecar grid. Local
  // state above is left intact so switching back is instant and unchanged.
  const me = useMe();
  const { isAuthenticated, isLoading: authLoading } = useAuthState();
  // A captured invite (deep link `gtmgrid://invite/<token>` or `?invite=` URL).
  // When present + signed out it FORCES the auth flow even in local mode, so an
  // invitee is always guided to sign up / sign in and then auto-enrolled.
  const pendingInviteToken = usePendingInviteToken();
  // In-app auto-update (Tauri only): a newer SIGNED release surfaces a top banner
  // that downloads + installs it and relaunches, all in-app.
  const update = useUpdateCheck();
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const runUpdate = useCallback(async () => {
    if (!update || updating) return;
    setUpdating(true);
    setUpdateError(null);
    try {
      await update.install(); // downloads, installs, then relaunches the app
    } catch {
      setUpdateError("Update failed — please try again.");
      setUpdating(false);
    }
  }, [update, updating]);
  // Local-first: when cloud is configured but the user hasn't signed in, the
  // onboarding offers "Continue locally" — which sets this persisted flag so the
  // app boots straight into local mode (no cloud features) on future launches.
  // Signing in (via the AccountBar) unlocks cloud at any time.
  const [localMode, setLocalMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem("gtmgrid:localMode") === "1";
    } catch {
      return false;
    }
  });
  // Boot-loader timing (see the boot gate before the main return). A signed-in
  // cloud user lands in a cloud project; we hold the full-screen branded loader
  // until that resolves so the app never flashes local-then-cloud on open.
  //   - `bootMinElapsed`: a MINIMUM display window so that when cloud state loads
  //     instantly (warm cache / fast network) the loader still shows briefly
  //     instead of flickering — the boot reads as an intentional branded splash.
  //   - `bootTimedOut`: a safety ceiling so a degenerate account (e.g. no
  //     workspace) reveals the app instead of spinning forever; never fires on a
  //     normal boot.
  const BOOT_MIN_MS = 900;
  const BOOT_MAX_MS = 8000;
  const [bootMinElapsed, setBootMinElapsed] = useState(false);
  const [bootTimedOut, setBootTimedOut] = useState(false);
  useEffect(() => {
    const min = setTimeout(() => setBootMinElapsed(true), BOOT_MIN_MS);
    const max = setTimeout(() => setBootTimedOut(true), BOOT_MAX_MS);
    return () => {
      clearTimeout(min);
      clearTimeout(max);
    };
  }, []);
  const continueLocally = useCallback(() => {
    try {
      localStorage.setItem("gtmgrid:localMode", "1");
    } catch {
      /* no storage — local mode just won't persist across launches */
    }
    setLocalMode(true);
  }, []);
  // Pull fresh cloud state (user, workspaces, plan, seats) after a flow that
  // changes it — finishing onboarding or accepting an invite — so the badge,
  // plan, and cloud tables are immediately in sync. Invalidates every cached
  // query and reconciles the plan from Autumn for the given workspace.
  const refreshAppState = useCallback((workspaceId: string | null) => {
    void queryClient.invalidateQueries();
    if (workspaceId !== null) void syncWorkspacePlan(workspaceId);
  }, []);
  const { activeWorkspace, setActiveWorkspaceId } = useActiveWorkspace(me ?? null);
  // Shown after joining a workspace via an invite: a confetti burst + a
  // confirmation dialog. Centralised so every accept path (the banner + the
  // new-signup auto-enrol) celebrates + refreshes state identically.
  const [celebrateInvite, setCelebrateInvite] = useState<{
    workspaceName: string | null;
  } | null>(null);
  const onInviteAccepted = useCallback(
    (workspaceId: Id<"workspaces">, workspaceName: string | null) => {
      clearPendingInviteToken();
      setActiveWorkspaceId(workspaceId);
      refreshAppState(workspaceId);
      fireConfetti();
      setCelebrateInvite({ workspaceName });
    },
    [setActiveWorkspaceId, refreshAppState],
  );

  // ── Cloud onboarding flow (C28) ──────────────────────────────
  // The full-screen split-layout onboarding wizard. Opened from the AccountBar
  // "Sign in" (auth entry) OR auto-started at the Create-workspace step when a
  // signed-in user has no workspace yet (first-run). Fully dismissible back to
  // the local app, so the local-first path is never blocked.
  const [onboarding, setOnboarding] = useState<
    { initialScreen: "signin" | "workspace"; hasSession: boolean } | null
  >(null);
  // Auto-start at "Create workspace" once: signed in, cloud on, zero workspaces,
  // and not already showing the flow. A ref guards against re-opening it after
  // the user dismisses it.
  const autoStartedRef = useRef(false);
  // Invitations waiting for the signed-in user (email-matched), + the accept
  // mutation. Drive the "new signup with a pending invite → auto-enrol" path.
  const myInvites = useMyPendingInvitations();
  const acceptInvite = useAcceptInvitation();
  const autoAcceptedRef = useRef(false);
  useEffect(() => {
    if (!cloudEnabled || !isAuthenticated || me == null) return;
    if (me.workspaces.length > 0) return;
    // A signed-in user with ZERO workspaces is a fresh signup. If they were
    // invited to a workspace (an email-matched pending invite), auto-enrol them
    // there instead of prompting them to create their own workspace. Wait for the
    // invites query to resolve (undefined = loading) before deciding, so we never
    // flash the create-workspace wizard at an invitee.
    if (myInvites === undefined) return;
    if (myInvites.length > 0) {
      if (autoAcceptedRef.current) return;
      autoAcceptedRef.current = true;
      void (async () => {
        const invite = myInvites[0];
        const res = await acceptInvite(invite.token).catch(() => null);
        if (res?.status === "accepted") {
          onInviteAccepted(
            res.workspaceId as Id<"workspaces">,
            invite.workspaceName,
          );
          return;
        }
        // Couldn't auto-enrol (seat limit / invalid / error): fall back to the
        // create-workspace prompt so the user is never stranded, and let the
        // PendingInvites banner surface the reason.
        autoAcceptedRef.current = false;
        if (!autoStartedRef.current && onboarding === null) {
          autoStartedRef.current = true;
          setOnboarding({ initialScreen: "workspace", hasSession: true });
        }
      })();
      return;
    }
    // No pending invite → prompt the user to create their first workspace.
    if (autoStartedRef.current || onboarding !== null) return;
    autoStartedRef.current = true;
    setOnboarding({ initialScreen: "workspace", hasSession: true });
  }, [isAuthenticated, me, onboarding, myInvites, acceptInvite, setActiveWorkspaceId]);
  // Keep the active workspace's plan reconciled with Autumn: on workspace switch
  // and whenever the window regains focus (returning from the Autumn checkout, or
  // after a manual upgrade in the Autumn dashboard), so the plan badge reflects
  // reality without an app restart. Throttled so focus thrash can't spam Autumn.
  const activeWorkspaceForPlan = activeWorkspace?._id ?? null;
  useEffect(() => {
    if (!cloudEnabled || !isAuthenticated || activeWorkspaceForPlan == null) {
      return;
    }
    void syncWorkspacePlan(activeWorkspaceForPlan);
    let last = Date.now();
    const onFocus = () => {
      if (Date.now() - last < 30_000) return;
      last = Date.now();
      void syncWorkspacePlan(activeWorkspaceForPlan);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [activeWorkspaceForPlan, isAuthenticated]);
  // The signed-in cloud session (apps/web URL + bearer); also threaded into the
  // credential source so "Use my local key" can forward the key to the cloud.
  const cloudSession = useCloudSession();
  // Shared (workspace-scoped) credential source for the connector / AI panels.
  // `undefined` when signed out / local-only, so those panels behave as before.
  const workspaceCreds = useWorkspaceCredentials(
    activeWorkspace?._id ?? null,
    isAuthenticated,
    cloudSession,
  );
  const cloudProjects = useCloudProjects(activeWorkspace?._id ?? null);
  // Live sidebar: refresh the table/project lists when any teammate creates,
  // syncs, or deletes a table in this workspace.
  useWorkspaceRealtime(activeWorkspace?._id ?? null);
  const [cloudProject, setCloudProject] = useState<CloudProject | null>(null);
  const [cloudTableId, setCloudTableId] = useState<Id<"tables"> | null>(null);
  // The LOCAL table the open cloud view corresponds to, when known (set on a
  // sync push / swap repoint). Drives the open-cloud-table 404 self-heal
  // (TRI-3312): if the open cloud id is a stale deleted id, we recover to this
  // local table's CURRENT linked cloud id. `null` for a cloud table opened with
  // no known local link (nothing to recover to → leave the existing behaviour).
  const [cloudTableLocalId, setCloudTableLocalId] = useState<string | null>(null);
  const cloudTables = useCloudTables(cloudProject?._id ?? null);
  const cloudFolders = useCloudFolders(cloudProject?._id ?? null);
  const {
    createProject: createCloudProject,
    createTable: createCloudTable,
    deleteTable: deleteCloudTable,
    createFolder: createCloudFolder,
    renameFolder: renameCloudFolder,
    deleteFolder: deleteCloudFolder,
    moveTable: moveCloudTable,
  } = useCloudProjectMutations();
  const { addColumn: cloudAddColumn, addRowsWithCells: cloudAddRowsWithCells } =
    useCloudGridMutations();
  // Post-push cache invalidations (TRI-3309 A/E): refetch the cloud-tables list
  // and re-seed the open cloud table's grid after a push / re-sync swap.
  const { invalidateCloudTables, invalidateCloudTable } = useCloudSyncRefresh();
  // CSV import: which mode's modal is open (null = closed). Local writes via the
  // sidecar; cloud writes via Convex (metered). Writers are built below.
  const [importMode, setImportMode] = useState<null | "local" | "cloud">(null);

  // Local import writer — sidecar HTTP (unmetered). Stable across renders.
  const localImportWriter = useMemo<ImportWriter>(
    () => ({
      createTable: async (name) => (await api.createTable(name)).id,
      addColumn: async (tableId, col) =>
        (await api.addColumn(tableId, { name: col.name, type: col.type })).id,
      addRowsChunk: async (tableId, rows) => {
        await api.addRowsBulk(tableId, rows);
      },
    }),
    [],
  );
  // Cloud import writer — Convex mutations (metered; quota-guarded). Null until a
  // cloud project is open. Branded Convex ids are strings at runtime.
  const cloudImportWriter = useMemo<ImportWriter | null>(() => {
    if (!cloudProject) return null;
    return {
      createTable: (name) => createCloudTable(cloudProject._id, name),
      addColumn: (tableId, col) =>
        cloudAddColumn(tableId as Id<"tables">, { name: col.name, type: col.type }),
      addRowsChunk: async (tableId, rows) => {
        await cloudAddRowsWithCells(tableId as Id<"tables">, rows);
      },
    };
  }, [cloudProject, createCloudTable, cloudAddColumn, cloudAddRowsWithCells]);
  // Cloud "From Social Signals" adapter — loads sources via tRPC + creates the
  // cloud table/columns/binding (the recurring poll runs in the Inngest worker).
  const signalsCloud = useMemo<SignalsCloud | undefined>(() => {
    if (!cloudProject || !apiClient) return undefined;
    const client = apiClient;
    const project = cloudProject;
    return {
      loadSources: async () => {
        const src = await client.signals.sources.query();
        const trigifyConnected = workspaceCreds?.connectedExtensionIds.has("trigify") ?? false;
        return { trigifyConnected, sources: src.map((s) => ({ ...s, description: null })) as unknown as SignalSource[] };
      },
      create: async (args) => {
        const tableId = await createCloudTable(project._id, args.name);
        const columns: { key: string; columnId: string }[] = [];
        for (const col of args.columns) {
          const columnId = await cloudAddColumn(tableId as Id<"tables">, { name: col.name, type: "text" });
          columns.push({ key: col.key, columnId: String(columnId) });
        }
        const r = await client.signals.createSignalBinding.mutate({
          tableId: String(tableId),
          sourceId: args.sourceId,
          name: args.name,
          config: args.config,
          schedule: "daily",
          columns,
        });
        return { tableId: String(tableId), added: (r as { added?: number })?.added ?? 0 };
      },
    };
  }, [cloudProject, workspaceCreds, createCloudTable, cloudAddColumn]);
  // Cloud create (project/table) UX: a busy flag to disable the trigger while the
  // mutation is in flight, and a surfaced error so a failed create never hangs
  // silently. Both are cleared on the next attempt / success.
  const [cloudCreating, setCloudCreating] = useState(false);
  const [cloudCreateError, setCloudCreateError] = useState<string | null>(null);
  // Whether the app is currently viewing a cloud project (vs. local).
  const inCloud = cloudProject !== null;
  // CLOUD context for the agent (TRI-3296): the signed-in session + the active
  // cloud workspace/project/table, so the agent's MCP table tools operate on
  // Supabase. Null unless ALL are present (a cloud project + table is open and
  // we have a session), in which case the agent keeps its local-SQLite path.
  // (`cloudSession` is declared above, alongside the credential source.)
  const agentCloud = useMemo<AgentCloudContext | null>(() => {
    if (!cloudSession || !activeWorkspace || !cloudProject || !cloudTableId) {
      return null;
    }
    return {
      apiUrl: cloudSession.apiUrl,
      token: cloudSession.token,
      workspaceId: activeWorkspace._id,
      projectId: cloudProject._id,
      tableId: cloudTableId,
    };
  }, [cloudSession, activeWorkspace, cloudProject, cloudTableId]);
  // Stable `activeTable` for the agent panel (TRI-3306). Previously passed as an
  // inline object literal, giving it a new identity on every App re-render
  // (react-query cloud polling, etc.); the panel keyed an abort-on-change effect
  // off it and so aborted the live agent turn on every unrelated re-render. The
  // panel now depends on scalar keys, but we still memoize here for hygiene so
  // the prop identity only changes when the table name or column set actually
  // does.
  const activeTableColumnNames = tableData?.columns.map((c) => c.name).join("\n") ?? null;
  const activeTable = useMemo(
    () => (tableData ? { name: tableData.name, columns: tableData.columns.map((c) => c.name) } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the table name + serialized column names, not the FullTable identity
    [tableData?.name, activeTableColumnNames],
  );
  // Agent presence (Co-Pilot cursor): the agent's gtmgrid tool calls — streamed
  // through the panel's SSE — light up the cell/column it's working on for
  // EVERYONE in the cloud table's room. Cloud-only; no-ops in local mode.
  const onAgentEvent = useAgentPresence(agentCloud);
  // Cloud-access lock: the active workspace's trial lapsed / it's on Free (no
  // plan id). Cloud tables/projects are shown but LOCKED — opening or editing
  // them prompts an upgrade; local tables are unaffected. The server enforces the
  // same gate (EntitlementService) so this is a UX layer over a real lock.
  const cloudLocked =
    cloudEnabled && activeWorkspace != null && activeWorkspace.plan.id === null;
  const [showUpgrade, setShowUpgrade] = useState(false);
  // Trial countdown: whole days left until the active workspace's trial ends
  // (null when not trialing). Drives the in-app "trial ends in N days" banner so
  // users add a card BEFORE the hard lock.
  const trialEndsAt = activeWorkspace?.plan.trialEndsAt ?? null;
  const trialDaysLeft =
    trialEndsAt != null
      ? Math.max(0, Math.ceil((trialEndsAt - Date.now()) / 86_400_000))
      : null;
  const showTrialBanner = cloudEnabled && !cloudLocked && trialDaysLeft != null;

  // Reset the open cloud project when the active workspace changes: a project
  // belongs to exactly one workspace, so keeping it open across a switch would
  // leak another workspace's project into the new one's view. The first render
  // (no prior workspace) is a no-op so it does not disturb local mode.
  const activeWorkspaceId = activeWorkspace?._id ?? null;
  const prevWorkspaceIdRef = useRef<Id<"workspaces"> | null>(activeWorkspaceId);
  useEffect(() => {
    if (prevWorkspaceIdRef.current === activeWorkspaceId) return;
    prevWorkspaceIdRef.current = activeWorkspaceId;
    setCloudProject(null);
    setCloudTableId(null);
  }, [activeWorkspaceId]);

  // Navigating to any table or view (selecting/creating a table, switching to AI
  // or extensions) exits the inline CSV import view. Opening "Import CSV" only
  // sets importMode (it changes neither cloudTableId nor view), so this effect
  // does NOT fire on open — it only clears the importer when the user moves away.
  useEffect(() => {
    setImportMode(null);
  }, [cloudTableId, view]);

  // ── Default-to-cloud for signed-in users ─────────────────────────────────
  // Persist the last-selected cloud project id so a relaunch reopens it, and on
  // first load (when a workspace + its projects are ready and nothing is open
  // yet) auto-select that project — or the most recent / first — so a signed-in
  // user lands in CLOUD mode, not local. Guarded by a ref so it runs ONCE per
  // workspace and never fights the workspace-change reset or an explicit user
  // action. Signed-out users have no cloud projects, so they stay local.
  const autoCloudWorkspaceRef = useRef<Id<"workspaces"> | null>(null);
  useEffect(() => {
    if (!activeWorkspaceId) return;
    // Persist the selection so the next launch can rehydrate it.
    if (cloudProject) {
      try { localStorage.setItem(LAST_CLOUD_PROJECT_KEY, cloudProject._id); } catch { /* ignore */ }
    }
    // One-shot auto-select per workspace: only when nothing is open yet and the
    // projects have loaded. An empty list (or a still-loading `undefined`) is a
    // no-op, so a user with no cloud projects simply stays in local mode.
    if (autoCloudWorkspaceRef.current === activeWorkspaceId) return;
    if (cloudProject !== null) return;
    if (!cloudProjects) return; // still loading
    if (cloudProjects.length === 0) {
      // A cloud workspace must NEVER fall back to the local engine — that would
      // silently save tables to disk instead of the cloud. If the workspace has
      // no projects yet, auto-create a default cloud project so the app enters
      // cloud mode (`inCloud`) and the local table section stays hidden. Skip when
      // cloud is locked (the lapsed-trial panel owns that state).
      if (cloudLocked || !activeWorkspace) return;
      autoCloudWorkspaceRef.current = activeWorkspaceId;
      void (async () => {
        try {
          const id = await createCloudProject(activeWorkspace._id, "Default");
          setCloudProject({
            _id: id,
            workspaceId: activeWorkspace._id,
            name: "Default",
            createdAt: Date.now(),
          });
          setCloudTableId(null);
          setView({ kind: "table" });
        } catch {
          autoCloudWorkspaceRef.current = null; // allow a retry on next change
        }
      })();
      return;
    }
    autoCloudWorkspaceRef.current = activeWorkspaceId;
    let persisted: string | null = null;
    try { persisted = localStorage.getItem(LAST_CLOUD_PROJECT_KEY); } catch { /* ignore */ }
    const byId = persisted ? cloudProjects.find((p) => p._id === persisted) : undefined;
    // Most recent by createdAt (fall back to the first) when no persisted match.
    const mostRecent = [...cloudProjects].sort((a, b) => b.createdAt - a.createdAt)[0];
    const target = byId ?? mostRecent ?? cloudProjects[0];
    if (target) {
      setCloudProject(target);
      setCloudTableId(null);
      setView({ kind: "table" });
    }
  }, [activeWorkspaceId, cloudProjects, cloudProject, cloudLocked, activeWorkspace, createCloudProject]);

  // Appearance: only the dark-mode toggle is user-controllable. Density and
  // accent are fixed (compact + green) by product decision.
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try { return (localStorage.getItem("gtmgrid:theme") as "light" | "dark") || "light"; } catch { return "light"; }
  });
  // Per-density row height the virtualizer estimates with (the scroll container
  // + column windowing now live inside the shared DataGrid).
  const [rowHeight, setRowHeight] = useState(resolveRowHeight);
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    root.setAttribute("data-density", "compact");
    root.setAttribute("data-accent", "green");
    setRowHeight(resolveRowHeight());
    try { localStorage.setItem("gtmgrid:theme", theme); } catch { /* ignore */ }
  }, [theme]);

  // Open the add-column popover anchored just below the clicked "+" button.
  const openAddCol = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setAddColAnchor({ left: r.left, top: r.bottom });
    setShowAddCol(true);
  };

  // Run state
  const [runProgress, setRunProgress] = useState<{ current: number; total: number } | null>(null);
  const [runningColId, setRunningColId] = useState<string | null>(null);
  const [runningCells, setRunningCells] = useState<Set<string>>(new Set()); // `${rowId}:${colId}`
  // Auto-run: recompute dependent function columns when an input cell changes.
  const [autoRun, setAutoRun] = useState<boolean>(() => {
    try { return localStorage.getItem("gtmgrid:autoRun") !== "off"; } catch { return true; }
  });
  // Mirror into a ref so the per-cell `onEdit` closure always reads the CURRENT
  // value. Cells are memoized (cellPropsEqual ignores onEdit), so they keep a stale
  // closure across a toggle — without this the toggle wouldn't take effect until the
  // cell re-rendered for another reason, so "Auto-run off" was being ignored.
  const autoRunRef = useRef(autoRun);
  autoRunRef.current = autoRun;
  const toggleAutoRun = useCallback(() => {
    setAutoRun((v) => {
      const next = !v;
      try { localStorage.setItem("gtmgrid:autoRun", next ? "on" : "off"); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Cell details drawer + column widths (resize)
  const [detail, setDetail] = useState<{ columnName: string; value: unknown } | null>(null);
  const [expandCell, setExpandCell] = useState<
    { rowId: string; colId: string; columnName: string; value: string; editable: boolean; anchor: { left: number; top: number; width: number } } | null
  >(null);
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem("gtmgrid:colWidths") || "{}");
    } catch {
      return {};
    }
  });
  const setColWidth = useCallback((colId: string, w: number) => {
    setColWidths((prev) => {
      const next = { ...prev, [colId]: Math.max(MIN_COL_W, Math.min(MAX_COL_W, Math.round(w))) };
      try {
        localStorage.setItem("gtmgrid:colWidths", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  // Effective rendered width for a column (clamped — old saved widths can be huge).
  const colW = useCallback(
    (id: string) => Math.max(MIN_COL_W, Math.min(MAX_COL_W, colWidths[id] ?? DEFAULT_COL_W)),
    [colWidths],
  );


  // Right-click context menu
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    items: { label: string; danger?: boolean; onClick: () => void }[];
  } | null>(null);

  // ── Boot ───────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    // The sidecar has a cold-start delay when the app launches, so poll until
    // it's reachable instead of giving up on the first failed check.
    const boot = async () => {
      try {
        // `health` is the liveness contract — gate connected/offline on it ALONE.
        const h = await api.health();
        if (cancelled) return;
        setHealthStatus("connected");
        setProjectName(h.project ?? "gtmgrid");
        // Load feature data resiliently: a single missing/failed route (e.g. a
        // version-skewed sidecar lacking a newer endpoint) must degrade that one
        // feature, never blank the whole app with "server not reachable".
        const [t, fl, f, e, ai, sk] = await Promise.all([
          api.tables().catch(() => []),
          api.folders().catch(() => []),
          api.functions().catch(() => []),
          api.extensions().catch(() => []),
          api.aiProviders().catch(() => []),
          api.skills().catch(() => []),
        ]);
        if (cancelled) return;
        setTables(t);
        setLocalFolders(fl);
        setConnectors(f);
        setExtensions(e);
        setAiProviders(ai);
        setSkills(sk);
        setSelectedTableId((cur) => cur ?? (t.length > 0 ? t[0].id : null));
      } catch {
        if (cancelled) return;
        setHealthStatus("offline");
        timer = setTimeout(boot, 1500); // retry — server is probably still booting
      }
    };
    boot();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  // ── Load selected table ────────────────────

  const loadTable = useCallback(async (id: string) => {
    setTableLoading(true);
    try {
      const data = await api.table(id);
      setTableData(data);
    } catch {
      setTableData(null);
    } finally {
      setTableLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedTableId) loadTable(selectedTableId);
    else setTableData(null);
  }, [selectedTableId, loadTable]);

  // Patch a single cell in place from a streamed run progress event. Keeps the
  // rest of the grid untouched so a local run updates only the cells that
  // actually changed (no full setTableData replacement / loadTable refetch).
  // Ignores events for a table other than the one currently loaded.
  const patchCell = useCallback((tableId: string, e: CellProgressEvent) => {
    setTableData((cur) => {
      if (!cur || cur.id !== tableId) return cur;
      let touched = false;
      const rows = cur.rows.map((row) => {
        if (row.id !== e.rowId) return row;
        touched = true;
        return { ...row, cells: { ...row.cells, [e.columnId]: e.cell } };
      });
      return touched ? { ...cur, rows } : cur;
    });
  }, []);

  // A freshly-created social-signal table populates asynchronously (Trigify
  // scrapes results over ~10-60s). Poll until rows land, showing a skeleton.
  const startWarming = useCallback((tableId: string) => {
    setWarmingTableId(tableId);
    if (warmTimerRef.current) clearInterval(warmTimerRef.current);
    let ticks = 0;
    warmTimerRef.current = setInterval(async () => {
      ticks++;
      try {
        const data = await api.table(tableId);
        if (data.rows.length > 0) {
          setTableData((cur) => (cur && cur.id === tableId ? data : cur));
          setWarmingTableId(null);
          if (warmTimerRef.current) clearInterval(warmTimerRef.current);
          return;
        }
      } catch { /* keep polling */ }
      if (ticks >= 40) {
        setWarmingTableId(null);
        if (warmTimerRef.current) clearInterval(warmTimerRef.current);
      }
    }, 8000);
  }, []);

  // Live refresh when the in-app agent mutates the grid (Phase D).
  const refreshAll = useCallback(async () => {
    const t = await api.tables().catch(() => null);
    if (!t) return;
    setTables(t);
    setSelectedTableId((cur) => {
      if (cur && t.some((x) => x.id === cur)) {
        loadTable(cur);
        return cur;
      }
      return t.length ? t[t.length - 1].id : null;
    });
  }, [loadTable]);

  // ── Table management (rename / delete / favorite) ──

  const reloadTables = useCallback(async () => {
    const t = await api.tables().catch(() => null);
    if (t) setTables(t);
  }, []);

  const reloadFolders = useCallback(async () => {
    const f = await api.folders().catch(() => null);
    if (f) setLocalFolders(f);
  }, []);

  // ── Cloud project selection ──────────────
  // Open a cloud project: leave the local sidecar untouched, switch the main
  // area to the live CloudGrid, and default to its first table once they load.
  const onCloudProjectSelected = useCallback((project: CloudProject) => {
    setShowProjects(false);
    setCloudProject(project);
    setCloudTableId(null);
    setView({ kind: "table" });
  }, []);

  // Create a cloud project in the active workspace, then open it. Surfaces any
  // failure (and always clears the busy flag) so the UI never hangs silently.
  const onCreateCloudProject = useCallback(
    async (name: string) => {
      if (!activeWorkspace || cloudCreating) return;
      setCloudCreating(true);
      setCloudCreateError(null);
      try {
        const id = await createCloudProject(activeWorkspace._id, name);
        setShowProjects(false);
        setCloudProject({
          _id: id,
          workspaceId: activeWorkspace._id,
          name,
          createdAt: Date.now(),
        });
        setCloudTableId(null);
        setView({ kind: "table" });
      } catch (e) {
        const message =
          e instanceof Error ? e.message : "Could not create project.";
        setCloudCreateError(message);
        // Re-throw so the project switcher (which owns the create form) can keep
        // it open and show the failure instead of closing as if it succeeded.
        throw e instanceof Error ? e : new Error(message);
      } finally {
        setCloudCreating(false);
      }
    },
    [activeWorkspace, createCloudProject, cloudCreating],
  );

  // Create a cloud table in the open project, then select it. Single helper for
  // the (previously duplicated) "New table" affordances in the cloud sidebar.
  // Surfaces any failure and always clears the busy flag so the UI never hangs.
  const onCreateCloudTable = useCallback(async (folderId: string | null = null) => {
    if (!cloudProject || cloudCreating) return;
    setCloudCreating(true);
    setCloudCreateError(null);
    try {
      const id = await createCloudTable(cloudProject._id, "Untitled", folderId);
      if (folderId !== null) setOpenFolders((o) => (o[folderId] ? o : { ...o, [folderId]: true }));
      setCloudTableId(id);
      setView({ kind: "table" });
    } catch (e) {
      setCloudCreateError(
        e instanceof Error ? e.message : "Could not create table.",
      );
    } finally {
      setCloudCreating(false);
    }
  }, [cloudProject, createCloudTable, cloudCreating]);

  // Chooser → Webhook (cloud-only): create + select a cloud table, then ask the
  // CloudGrid to auto-open the webhook setup form for it. The mapping starts
  // empty; the user maps payload paths → columns they add via the normal UI.
  const onChooseWebhook = useCallback(async () => {
    if (!cloudProject || cloudCreating) return;
    setCloudCreating(true);
    setCloudCreateError(null);
    try {
      const id = await createCloudTable(cloudProject._id, "Webhook table");
      setCloudTableId(id);
      setView({ kind: "table" });
      setOpenWebhookToken((n) => n + 1);
    } catch (e) {
      setCloudCreateError(
        e instanceof Error ? e.message : "Could not create table.",
      );
    } finally {
      setCloudCreating(false);
    }
  }, [cloudProject, createCloudTable, cloudCreating]);

  // Switch the app to LOCAL mode (used by the account menu's Environment
  // switcher): drop the open cloud project so the sidecar grid is shown.
  const switchToLocal = useCallback(() => {
    setCloudProject(null);
    setCloudTableId(null);
    setView({ kind: "table" });
  }, []);

  // ── Table sync (TRI-3297) ────────────────────────────────────────────────
  // Per local-table sync facts, tracked CLIENT-SIDE: a table is `linked` once a
  // push succeeds; a push that returns its row count marks it synced. The link
  // state is also confirmed by the server — a 409 re-routes through the
  // destructive-overwrite confirm. `pushingTableId` is the in-flight row (busy
  // dot); `syncErrors` surfaces a failed push inline (no toast system).
  // `rowCount` is the LAST-PUSHED cloud row count, known only for links
  // established this session; a link HYDRATED from the localStorage mirror
  // (TRI-3309 bug B) carries no count (the popover then falls back to the live
  // local count). `undefined` rowCount = linked-but-count-unknown.
  const [syncLinks, setSyncLinks] = useState<Record<string, { cloudTableId: string; rowCount?: number }>>({});
  // Set of table ids with a push in flight (TRI-3307): a bulk "Sync all" pushes
  // many tables concurrently, so each pushing row must show its own busy dot — a
  // single id would only mark one row. Single-push adds/removes its one id here.
  const [pushingTableIds, setPushingTableIds] = useState<ReadonlySet<string>>(new Set());
  const [syncErrors, setSyncErrors] = useState<Record<string, string>>({});
  // The open sync popover: the table id + the clicked row's viewport top, so the
  // popover anchors to the right of the row (design's `.sync-pop`).
  const [syncPopover, setSyncPopover] = useState<{ tableId: string; anchorTop: number } | null>(null);
  const [dedupeOpen, setDedupeOpen] = useState(false);
  // A pending destructive-overwrite confirm: a linked table whose re-push would
  // overwrite cloud data. Holds the table + cloud row count for the warning copy.
  const [overwriteConfirm, setOverwriteConfirm] = useState<{ tableId: string; name: string; rowCount: number } | null>(null);
  // A pending BULK destructive-overwrite confirm for "Sync all" (TRI-3307): holds
  // the linked table ids to re-push and the unlinked ids to create on accept. ONE
  // confirm covers ALL linked tables so none are silently skipped; on cancel none
  // of the linked tables push (the unlinked creates are non-destructive).
  const [bulkOverwriteConfirm, setBulkOverwriteConfirm] = useState<{ toOverwrite: string[]; toCreate: string[] } | null>(null);

  // Hydrate the in-memory sync links from the SIDECAR meta — the source of truth
  // (TRI-3311) — whenever the open cloud project changes. The localStorage mirror
  // (TRI-3309 bug B) is kept ONLY as an offline/fast-path cache: we seed from it
  // synchronously so the Synced/ahead status paints immediately, then overlay the
  // server's authoritative `{ [localTableId]: cloudTableId }` map with the SERVER
  // WINNING on every conflict (mergeServerSyncLinks), so a stale mirror can never
  // drift the displayed status. The mirror is namespaced per cloud project; the
  // server route returns the CURRENT project's links (the sidecar follows the
  // active project), so we only overlay when this remains the active project.
  useEffect(() => {
    const projectKey = cloudProject?._id ?? null;
    if (projectKey === null) {
      setSyncLinks({});
      return;
    }
    // 1) Fast-path: seed from the local mirror for this project (sync, offline).
    let stored: Record<string, string> = {};
    try {
      stored = parseSyncLinks(localStorage.getItem(SYNC_LINKS_STORAGE_KEY));
    } catch {
      stored = {};
    }
    const mirror = hydrateSyncLinksForProject(stored, projectKey);
    setSyncLinks(
      Object.fromEntries(
        Object.entries(mirror).map(([localId, cloudTableId]) => [
          localId,
          { cloudTableId },
        ]),
      ),
    );
    // 2) Source of truth: overlay the sidecar's persisted links (server wins).
    let cancelled = false;
    api
      .cloudTableLinks()
      .then((server) => {
        if (cancelled) return;
        const merged = mergeServerSyncLinks(server, mirror);
        setSyncLinks((cur) =>
          Object.fromEntries(
            Object.entries(merged).map(([localId, cloudTableId]) => [
              localId,
              // Preserve any rowCount already known from a this-session push.
              cur[localId]?.cloudTableId === cloudTableId
                ? cur[localId]!
                : { cloudTableId },
            ]),
          ),
        );
      })
      .catch(() => {
        /* offline / sidecar unreachable → keep the mirror-seeded links */
      });
    return () => {
      cancelled = true;
    };
  }, [cloudProject?._id]);

  // ── Auto-sync setting (TRI-3298) ─────────────────────────────────────────
  // The global `auto_sync_offline_tables` flag (default OFF), loaded from the
  // sidecar. When ON, local tables auto-link + push on create / debounced edit.
  // `autoSyncEnable` holds a pending enable-time destructive-overwrite confirm:
  // turning it ON requires confirming local tables will REPEATEDLY overwrite
  // their cloud copies. Toggling OFF is immediate (no confirm).
  const [autoSyncOn, setAutoSyncOn] = useState(false);
  const [autoSyncEnableConfirm, setAutoSyncEnableConfirm] = useState(false);
  // Notification-center persistence (TRI-3308): dismissed/seen kinds, persisted
  // across sessions. On first run we MIGRATE the legacy auto-sync-nudge flag
  // (LEGACY_AUTO_SYNC_NUDGE_KEY) so a previously-dismissed nudge stays dismissed
  // (no regression of TRI-3298's "stays dismissed across sessions").
  const [notifPersist, setNotifPersist] = useState<NotificationPersistState>(() => {
    try {
      const legacy = localStorage.getItem(LEGACY_AUTO_SYNC_NUDGE_KEY) === "1";
      return parsePersistState(localStorage.getItem(NOTIFICATIONS_PERSIST_KEY), legacy);
    } catch {
      return parsePersistState(null, false);
    }
  });
  // Whether the bell's notification center popover is open.
  const [notifOpen, setNotifOpen] = useState(false);
  const bellRef = useRef<HTMLButtonElement | null>(null);

  // Load the persisted flag once the sidecar is reachable. Defaults OFF on any
  // failure (parseAutoSyncFlag treats a missing value as OFF).
  useEffect(() => {
    let cancelled = false;
    api.getAutoSync()
      .then((r) => { if (!cancelled) setAutoSyncOn(parseAutoSyncFlag(r.enabled ? "true" : "false")); })
      .catch(() => { /* default OFF */ });
    return () => { cancelled = true; };
  }, []);

  // The sync UI (dots + popover + sync-all) is visible only for cloud-enabled,
  // signed-in users with a cloud project open. Hidden in pure-local builds.
  const showSyncUi = syncUiVisible({ cloudEnabled, inCloud, isAuthenticated });

  // Build the active notification list (TRI-3308) from app state. Eligibility is
  // unchanged from the banners these replace: the trial item mirrors
  // `showTrialBanner`, the auto-sync nudge reuses `autoSyncNudgeVisible` (inside
  // buildNotifications), and the update item mirrors the old `.update-banner`.
  const notifications = useMemo(
    () =>
      buildNotifications({
        trialDaysLeft: showTrialBanner ? trialDaysLeft : null,
        autoSync: { cloudEnabled, inCloud, isAuthenticated, autoSyncOn },
        updateVersion: update && !updateDismissed ? update.version : null,
        updateError,
        persist: notifPersist,
      }),
    [showTrialBanner, trialDaysLeft, cloudEnabled, inCloud, isAuthenticated, autoSyncOn, update, updateDismissed, updateError, notifPersist],
  );
  // Bell badge = active notifications not yet seen.
  const unreadNotifs = countUnread(notifications, notifPersist);

  // Persist the notification dismissed/seen state to localStorage.
  const persistNotifState = useCallback((next: NotificationPersistState) => {
    setNotifPersist(next);
    try { localStorage.setItem(NOTIFICATIONS_PERSIST_KEY, serializePersistState(next)); } catch { /* ignore */ }
  }, []);

  // Opening the center marks every active item seen (clears the badge).
  const openNotifications = useCallback(() => {
    setNotifOpen(true);
    persistNotifState(markAllSeen(notifications, notifPersist));
  }, [notifications, notifPersist, persistNotifState]);

  // Dismiss a notification — removes it + persists (stays dismissed next session).
  const dismissNotif = useCallback((kind: AppNotification["kind"]) => {
    persistNotifState(dismissNotification(kind, notifPersist));
  }, [notifPersist, persistNotifState]);

  // Map a notification action id to its behaviour. Each preserves the original
  // banner's action — notably `autoSync.enable` still routes through the
  // TRI-3298 enable-time overwrite confirm (setAutoSyncEnableConfirm) rather than
  // enabling directly.
  const runNotificationAction = useCallback((id: NotificationActionId) => {
    switch (id) {
      case "trial.upgrade":
        setShowUpgrade(true);
        setNotifOpen(false);
        break;
      case "autoSync.enable":
        setAutoSyncEnableConfirm(true);
        setNotifOpen(false);
        break;
      case "autoSync.dismiss":
        dismissNotif("autoSyncNudge");
        break;
      case "update.install":
        void runUpdate();
        break;
      case "update.dismiss":
        setUpdateDismissed(true);
        dismissNotif("update");
        break;
    }
  }, [dismissNotif, runUpdate]);

  // Persist the flag to the sidecar. Toggling OFF is immediate; toggling ON must
  // go through `requestAutoSyncToggle` (which shows the enable-time confirm).
  const persistAutoSync = useCallback(async (next: boolean) => {
    setAutoSyncOn(next);
    try { await api.setAutoSync(next); } catch { setAutoSyncOn(!next); }
  }, []);

  // Toggle entry point. OFF→ON opens the destructive-overwrite confirm and only
  // enables on accept. ON→OFF disables immediately.
  const requestAutoSyncToggle = useCallback(() => {
    if (autoSyncOn) { void persistAutoSync(false); return; }
    setAutoSyncEnableConfirm(true);
  }, [autoSyncOn, persistAutoSync]);

  // Derive a table's design SYNC_META status from its client-tracked facts.
  const syncStatusFor = useCallback(
    (tableId: string): SyncStatus =>
      mapSyncStatus({
        linked: syncLinks[tableId] !== undefined,
        // v1 cannot diff local edits against the last push without a backend
        // GET, so a linked table is treated as `synced` until the user pushes
        // again; an unlinked table is `local`. (No fabricated change counts.)
        hasLocalChanges: false,
        pushing: pushingTableIds.has(tableId),
        offline: healthStatus === "offline",
        needsOverwriteConfirm: overwriteConfirm?.tableId === tableId,
      }),
    [syncLinks, pushingTableIds, healthStatus, overwriteConfirm],
  );

  // Run a single table push. `confirmOverwrite` is supplied by the confirm flow.
  // A 409 (LinkConflictError) means the server demands explicit confirmation:
  // surface the destructive-overwrite confirm instead of a generic error.
  const runPush = useCallback(
    async (tableId: string, confirmOverwrite: boolean) => {
      const apiUrl = API_URL;
      const token = getStoredAuthToken();
      if (!apiUrl || !token) {
        setSyncErrors((m) => ({ ...m, [tableId]: "Sign in to a cloud workspace to sync." }));
        return;
      }
      // TRI-3313-B: a push from the LOCAL env must NOT require an open cloud
      // project. Resolve a TARGET project (open → last-used → most-recent → first)
      // WITHOUT opening it; the server reads the local table from the sidecar and
      // only needs a valid target projectId. If the workspace has NO project to
      // target, prompt the user to pick/create one (open the ProjectSwitcher)
      // rather than erroring with "not found".
      let lastUsed: string | null = null;
      try { lastUsed = localStorage.getItem(LAST_CLOUD_PROJECT_KEY); } catch { /* ignore */ }
      const target = resolveTargetCloudProject(cloudProject, lastUsed, cloudProjects ?? null);
      const projectId = target?._id ?? null;
      if (!projectId) {
        setShowProjects(true);
        return;
      }
      setPushingTableIds((s) => { const next = new Set(s); next.add(tableId); return next; });
      setSyncErrors((m) => { const next = { ...m }; delete next[tableId]; return next; });
      try {
        const result = await api.pushTable({ apiUrl, token, projectId, localTableId: tableId, confirmOverwrite });
        // The cloud id this local table previously pointed at (if any), so we can
        // detect a re-sync SWAP (TRI-3309 bug E): a re-push builds a NEW cloud
        // table and deletes the old one, so the open grid would otherwise point
        // at a now-deleted id.
        const prevCloudTableId = syncLinks[tableId]?.cloudTableId ?? null;
        setSyncLinks((m) => ({ ...m, [tableId]: { cloudTableId: result.cloudTableId, rowCount: result.rowCount } }));
        // Persist the link to the localStorage MIRROR (TRI-3309 bug B) so the
        // Synced status survives a reload (sidecar meta stays authoritative for
        // overwrite detection — this only drives the UI status).
        try {
          const stored = parseSyncLinks(localStorage.getItem(SYNC_LINKS_STORAGE_KEY));
          localStorage.setItem(
            SYNC_LINKS_STORAGE_KEY,
            serializeSyncLinks(upsertSyncLink(stored, projectId, tableId, result.cloudTableId)),
          );
        } catch { /* mirror is best-effort; a write failure only loses hydration */ }
        setOverwriteConfirm((c) => (c?.tableId === tableId ? null : c));
        // TRI-3309 bug A: the push mutated the cloud project outside the tRPC
        // mutation hooks, so refetch the "TABLES (CLOUD)" list (it stays "No
        // tables yet" until reload otherwise).
        void invalidateCloudTables();
        // TRI-3309 bug E: a re-sync swap repointed the link to a NEW cloud id and
        // deleted the old one. If the open cloud table was the deleted old id,
        // re-point it to the new id; either way invalidate the new table's grid
        // so it re-seeds against the surviving table.
        if (prevCloudTableId !== null && prevCloudTableId !== result.cloudTableId) {
          setCloudTableId((cur) => {
            if (cur !== prevCloudTableId) return cur;
            // The open view followed this local table — remember the association
            // so a later stale-id 404 can self-heal to its current link (TRI-3312).
            setCloudTableLocalId(tableId);
            return result.cloudTableId as Id<"tables">;
          });
        }
        void invalidateCloudTable(result.cloudTableId);
      } catch (e) {
        if (e instanceof CloudPushHttpError && isOverwriteConfirmNeeded(e)) {
          // Server says this table is linked and a re-push overwrites it. Route
          // into the destructive-overwrite confirm (naming the table + rows).
          // TRI-3310 bug D: show EXACTLY ONE confirmation. `syncStatusFor` maps a
          // pending overwriteConfirm to the `conflict` state, so an OPEN sync
          // popover for this same table would ALSO render the conflict confirm
          // body — two overlapping confirms. Close that popover so only the modal
          // shows (never both).
          const t = tables.find((x) => x.id === tableId);
          setSyncPopover((p) =>
            p !== null && shouldCloseConflictPopover({ modalTableId: tableId, openPopoverTableId: p.tableId })
              ? null
              : p,
          );
          setOverwriteConfirm({ tableId, name: t?.name ?? "table", rowCount: t?.rows ?? 0 });
        } else {
          setSyncErrors((m) => ({ ...m, [tableId]: e instanceof Error ? e.message : "Push failed." }));
        }
      } finally {
        setPushingTableIds((s) => { const next = new Set(s); next.delete(tableId); return next; });
      }
    },
    [cloudProject, cloudProjects, tables, syncLinks, invalidateCloudTables, invalidateCloudTable],
  );

  // Push entry point from the popover / sync-all. Decides create-vs-overwrite:
  // an unlinked table pushes straight through; a linked table prompts the
  // destructive-overwrite confirm first (it only pushes after the user accepts).
  const onPushTable = useCallback(
    (tableId: string) => {
      const linked = syncLinks[tableId] !== undefined;
      const decision = decidePush({ linked, userConfirmed: false });
      if (decision.needsConfirm) {
        const t = tables.find((x) => x.id === tableId);
        // TRI-3310 bug D: opening the overwrite-confirm modal flips this table's
        // sync status to `conflict`, which would ALSO render the conflict-confirm
        // body inside an open sync popover for the same table (two overlapping
        // confirms). Close that popover so only the modal shows — never both.
        setSyncPopover((p) =>
          p !== null && shouldCloseConflictPopover({ modalTableId: tableId, openPopoverTableId: p.tableId })
            ? null
            : p,
        );
        setOverwriteConfirm({ tableId, name: t?.name ?? "table", rowCount: t?.rows ?? 0 });
        return;
      }
      void runPush(tableId, decision.confirmOverwrite);
    },
    [syncLinks, tables, runPush],
  );

  // User accepted the destructive overwrite — re-push with confirmOverwrite.
  const onConfirmOverwrite = useCallback(() => {
    const target = overwriteConfirm;
    if (!target) return;
    void runPush(target.tableId, true);
  }, [overwriteConfirm, runPush]);

  // ── Auto-push trigger (TRI-3298) ─────────────────────────────────────────
  // When auto-sync is ON, local tables auto-link + push on create and (debounced)
  // on edit. Auto-pushes always send `confirmOverwrite: true` because the user
  // gave one-time consent at enable-time — per-edit prompts would defeat the
  // automation. Re-pushes REUSE the stored TRI-3295 link, so no duplicate cloud
  // tables are created. The gate is recomputed at fire time (via a ref) so a
  // setting flip / sign-out cancels pending pushes — when OFF, zero auto traffic.
  const autoPushGateRef = useRef({ autoSyncOn, cloudEnabled, inCloud, isAuthenticated });
  autoPushGateRef.current = { autoSyncOn, cloudEnabled, inCloud, isAuthenticated };
  const autoPushTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Fire an auto-push immediately if the gate is satisfied at THIS moment.
  const autoPushNow = useCallback((tableId: string) => {
    if (!shouldAutoPush(autoPushGateRef.current)) return;
    void runPush(tableId, true);
  }, [runPush]);

  // Schedule a debounced auto-push for an edited table (coalesces rapid edits).
  const scheduleAutoPush = useCallback((tableId: string) => {
    if (!shouldAutoPush(autoPushGateRef.current)) return;
    const timers = autoPushTimers.current;
    if (timers[tableId]) clearTimeout(timers[tableId]);
    timers[tableId] = setTimeout(() => {
      delete timers[tableId];
      autoPushNow(tableId);
    }, AUTO_SYNC_DEBOUNCE_MS);
  }, [autoPushNow]);

  // Drop any pending debounced pushes when auto-sync turns OFF (or eligibility is
  // lost) so no straggler push fires after the user opts out — zero auto traffic.
  useEffect(() => {
    if (shouldAutoPush({ autoSyncOn, cloudEnabled, inCloud, isAuthenticated })) return;
    const timers = autoPushTimers.current;
    for (const id of Object.keys(timers)) { clearTimeout(timers[id]); delete timers[id]; }
  }, [autoSyncOn, cloudEnabled, inCloud, isAuthenticated]);

  // Push every table that has un-pushed work (the sync-all header control).
  // TRI-3307: split pending tables into unlinked (create) vs linked (overwrite)
  // via the pure planner. Unlinked tables create straight through (non-
  // destructive). If ANY linked tables are pending, gate ALL of them behind ONE
  // bulk destructive-overwrite confirm — so no linked table is silently skipped
  // (the old per-table loop clobbered the single `overwriteConfirm`, surfacing
  // only the LAST linked table). On cancel, NONE of the linked tables push.
  const onSyncAll = useCallback(() => {
    const plan = planSyncAll(
      tables.map((t) => ({ id: t.id, linked: syncLinks[t.id] !== undefined, status: syncStatusFor(t.id) })),
    );
    for (const id of plan.toCreate) void runPush(id, false);
    if (plan.toOverwrite.length > 0) {
      setBulkOverwriteConfirm({ toOverwrite: [...plan.toOverwrite], toCreate: [...plan.toCreate] });
    }
  }, [tables, syncLinks, syncStatusFor, runPush]);

  // User accepted the bulk "Sync all" overwrite — re-push EVERY linked table with
  // confirmOverwrite (the unlinked creates already fired in onSyncAll). None of
  // the linked tables are omitted.
  const onConfirmBulkOverwrite = useCallback(() => {
    const target = bulkOverwriteConfirm;
    setBulkOverwriteConfirm(null);
    if (!target) return;
    for (const id of target.toOverwrite) void runPush(id, true);
  }, [bulkOverwriteConfirm, runPush]);

  // How many local tables have un-pushed work (drives `.sync-all-btn.has-pending`).
  const syncPending = useMemo(
    () => (showSyncUi ? pendingCount(tables.map((t) => syncStatusFor(t.id))) : 0),
    [showSyncUi, tables, syncStatusFor],
  );

  // ── Unified Tables list (TRI-3313-C) ──────────────────────────────────────
  // ONE merged, de-duplicated list of local + cloud tables (a local table linked
  // via `syncLinks` is rendered ONCE as a synced local row; its cloud copy is
  // folded in). Drives a SINGLE active-table selection so only one row highlights.
  // CLEAR local/cloud separation (TRI-3313 follow-up): the Tables list shows ONE
  // environment's tables, never both. In CLOUD mode it is purely the cloud
  // tables; in LOCAL mode it is purely the local tables (still synced-tagged so
  // the sync dot / cloud icon renders). Because exactly one environment's rows
  // exist, exactly one row can be active — no more dual highlight from two
  // independent lists. Cloud rows are built directly (no dedup against local
  // links) so EVERY cloud table is visible in cloud mode, including ones a local
  // table is linked to.
  const tableList = useMemo(
    () =>
      inCloud
        ? (cloudTables ?? []).map<TableListRow>((t) => ({
            kind: "cloud" as const,
            id: t._id,
            name: t.name,
            synced: true,
            favorite: false,
            rows: 0,
            folderId: t.folderId,
            position: t.position,
          }))
        : buildTableList({
            localTables: tables.map((t) => ({
              id: t.id,
              name: t.name,
              favorite: t.favorite,
              rows: t.rows,
              folderId: t.folderId,
              position: t.position,
            })),
            cloudTables: [],
            syncLinks,
          }),
    [inCloud, tables, cloudTables, syncLinks],
  );
  // The sidebar's folders for the ACTIVE environment (cloud project's folders in
  // cloud mode; the local project's folders otherwise), in position order.
  const sidebarFolders = useMemo<SidebarFolder[]>(
    () =>
      inCloud
        ? (cloudFolders ?? []).map((f) => ({ id: f._id, name: f.name, position: f.position }))
        : localFolders.map((f) => ({ id: f.id, name: f.name, position: f.position })),
    [inCloud, cloudFolders, localFolders],
  );
  // Folder sections + root rows the sidebar renders.
  const groupedTables = useMemo(
    () => groupTableList(tableList, sidebarFolders),
    [tableList, sidebarFolders],
  );
  // Lookups by id so the unified rows can recover their original summaries (the
  // local TableSummary for context-menu / rename / delete; the branded cloud id
  // for selection) without re-casting strings.
  const localById = useMemo(() => {
    const m = new Map<string, TableSummary>();
    for (const t of tables) m.set(t.id, t);
    return m;
  }, [tables]);
  const cloudById = useMemo(() => {
    const m = new Map<string, CloudTableSummary>();
    for (const t of cloudTables ?? []) m.set(String(t._id), t);
    return m;
  }, [cloudTables]);
  // The ONE active row id, unifying the old independent cloud (`cloudTableId`) vs
  // local (`selectedTableId`) selection: when a cloud project is open and a cloud
  // table is selected, the cloud id wins; otherwise the local selection wins.
  const activeRowId = inCloud && cloudTableId !== null ? String(cloudTableId) : selectedTableId;
  // Select any row from the unified list: a LOCAL row drops the open cloud project
  // (so the local sidecar grid renders) and selects the local table; a CLOUD row
  // keeps the cloud project open and points the live grid at that cloud table.
  // Either way exactly ONE row ends up active.
  const onSelectTableRow = useCallback(
    (row: TableListRow) => {
      if (row.kind === "cloud") {
        const ct = cloudById.get(row.id);
        if (ct) setCloudTableId(ct._id);
        setView({ kind: "table" });
        return;
      }
      // Local row: leave cloud mode so the local grid shows this table.
      if (inCloud) {
        setCloudProject(null);
        setCloudTableId(null);
      }
      setSelectedTableId(row.id);
      setView({ kind: "table" });
    },
    [inCloud, cloudById],
  );

  // One unified sidebar table row (root or inside a folder). Not memoized — it
  // closes over the drag/drop + rename state and renders a handful of rows.
  const renderTableRow = (row: TableListRow, inFolder: boolean) => {
    const local = row.kind === "local" ? localById.get(row.id) : undefined;
    const cloudRowLocked = row.kind === "cloud" && cloudLocked;
    if (local && renamingTableId === local.id) {
      return (
        <div key={`local:${row.id}`} className={`sidebar-item${inFolder ? " in-folder" : ""}`} style={{ paddingTop: 2, paddingBottom: 2 }}>
          <span className="sidebar-item-icon"><Icon.Table /></span>
          <input
            className="sidebar-rename-input"
            value={renameDraft}
            autoFocus
            onChange={e => setRenameDraft(e.target.value)}
            onBlur={() => commitRename(local.id, renameDraft)}
            onKeyDown={e => {
              if (e.key === "Enter") commitRename(local.id, renameDraft);
              if (e.key === "Escape") setRenamingTableId(null);
            }}
          />
        </div>
      );
    }
    const dropCls =
      dropTarget?.kind === "table" && dropTarget.id === row.id ? ` drop-${dropTarget.pos}` : "";
    return (
      <div
        key={`${row.kind}:${row.id}`}
        className={`sidebar-item${inFolder ? " in-folder" : ""}${row.id === activeRowId && view.kind === "table" && !cloudRowLocked ? " active" : ""}${dragTableId === row.id ? " dragging" : ""}${dropCls}`}
        style={cloudRowLocked ? { opacity: 0.6 } : undefined}
        title={cloudRowLocked ? "Upgrade to unlock cloud tables" : undefined}
        draggable={!cloudRowLocked}
        onDragStart={e => onRowDragStart(e, row)}
        onDragEnd={clearDrag}
        onDragOver={e => onRowDragOver(e, row)}
        onDrop={e => onRowDrop(e, row)}
        onClick={() => (cloudRowLocked ? setShowUpgrade(true) : onSelectTableRow(row))}
        onContextMenu={local ? (e => openCtx(e, tableMenuItems(local))) : undefined}
      >
        <span className="sidebar-item-icon">
          {cloudRowLocked ? "🔒" : <Icon.Table />}
        </span>
        <span className="sidebar-item-name">{row.name}</span>
        {row.favorite && <span className="sidebar-item-star"><Icon.Star filled /></span>}
        {local && (
          <>
            <button
              className="sidebar-item-del"
              title="Delete table"
              onClick={e => { e.stopPropagation(); setConfirmDeleteTable(local); }}
            >
              <Icon.Trash />
            </button>
            <button
              className="sidebar-item-more"
              title="Table options"
              onClick={e => { e.stopPropagation(); openCtx(e, tableMenuItems(local)); }}
            >
              <Icon.More />
            </button>
          </>
        )}
        {row.kind === "cloud" && !cloudRowLocked && cloudById.get(row.id) && (
          <button
            className="sidebar-item-del"
            title="Delete table"
            onClick={e => {
              e.stopPropagation();
              const ct = cloudById.get(row.id);
              if (ct) setConfirmDeleteCloudTable({ _id: ct._id, name: ct.name });
            }}
          >
            <Icon.Trash />
          </button>
        )}
        {/* Trailing indicator: a cloud icon on cloud/synced rows; the
            sync dot (cloud users) or row count on unsynced local rows. */}
        {row.synced ? (
          <span className="sidebar-item-cloud" title="Synced to cloud">{CloudIcon}</span>
        ) : showSyncUi && local ? (
          <button
            className={`row-sync is-${syncStatusFor(local.id)}`}
            title={SYNC_META[syncStatusFor(local.id)].label}
            onClick={e => {
              e.stopPropagation();
              const host = e.currentTarget.closest(".sidebar-item");
              const top = host instanceof HTMLElement ? host.getBoundingClientRect().top : 80;
              setSyncPopover({ tableId: local.id, anchorTop: top });
              // TRI-3310 bug C: the popover diff + the overwrite-confirm
              // copy read the row count from the cached TableSummary,
              // which goes stale after edits. Refresh the summary at
              // popover-open so the count reflects the table's real
              // current rows (the push itself always sends the live rows).
              void reloadTables();
            }}
          >
            <SyncDot status={syncStatusFor(local.id)} />
          </button>
        ) : (
          <span className="sidebar-item-count">{row.rows}</span>
        )}
      </div>
    );
  };

  // Default the active cloud table to the first one once the list loads.
  useEffect(() => {
    if (!inCloud) return;
    if (cloudTables && cloudTables.length > 0 && cloudTableId === null) {
      setCloudTableId(cloudTables[0]._id);
    }
  }, [inCloud, cloudTables, cloudTableId]);

  // Open-cloud-table 404 self-heal (TRI-3312). When the open cloud table's load
  // returns 404 / not-found (CloudGrid reports it via `onMissing`), the open id
  // is a STALE deleted id (a swap before this session's link state, or a
  // teammate re-synced). Rather than leave the dead-id error, fall back to the
  // open view's local table's CURRENT linked cloud id (from the now
  // server-hydrated `syncLinks`) and open that. `resolveStaleCloudTableFallback`
  // returns `null` when there is nothing to recover to (no link, or the link
  // still points at the same dead id), so we never loop on the same dead id.
  const onCloudTableMissing = useCallback(() => {
    const fallback = resolveStaleCloudTableFallback({
      openCloudTableId: cloudTableId,
      localTableId: cloudTableLocalId,
      links: syncLinks,
    });
    if (fallback !== null) setCloudTableId(fallback as Id<"tables">);
  }, [cloudTableId, cloudTableLocalId, syncLinks]);

  // Switch to a different LOCAL project: also exit cloud mode so the sidecar
  // grid is shown. Tables change; global creds/extensions stay.
  const onProjectSwitched = useCallback(async (name: string) => {
    setShowProjects(false);
    setCloudProject(null);
    setCloudTableId(null);
    setCloudTableLocalId(null);
    setProjectName(name);
    setView({ kind: "table" });
    const [t, fl, e, ai] = await Promise.all([
      api.tables().catch(() => [] as TableSummary[]),
      api.folders().catch(() => [] as FolderSummary[]),
      api.extensions().catch(() => null),
      api.aiProviders().catch(() => null),
    ]);
    setTables(t);
    setLocalFolders(fl);
    setSelectedTableId(t.length ? t[0].id : null);
    if (e) setExtensions(e);
    if (ai) setAiProviders(ai);
  }, []);

  // Refresh the current local project path; the AccountBar owns its open state.
  const openAccountMenu = useCallback(async () => {
    const ps = await api.projects().catch(() => []);
    setCurrentProjectPath(ps.find((p) => p.current)?.path ?? null);
  }, []);

  const toggleFavorite = async (id: string, favorite: boolean) => {
    await api.favoriteTable(id, favorite).catch(() => {});
    await reloadTables();
  };

  const commitRename = async (id: string, name: string) => {
    setRenamingTableId(null);
    const trimmed = name.trim();
    if (!trimmed) return;
    await api.renameTable(id, trimmed).catch(() => {});
    await reloadTables();
  };

  // window.confirm() is a no-op in Tauri's webview, so we use an in-app modal.
  const deleteTable = async (id: string) => {
    await api.deleteTable(id).catch(() => {});
    const t = await api.tables().catch(() => []);
    setTables(t);
    if (selectedTableId === id) {
      const next = t[0]?.id ?? null;
      setSelectedTableId(next);
      setView({ kind: "table" });
    }
  };

  const tableMenuItems = (t: TableSummary) => [
    {
      label: t.favorite ? "Unpin from Favorites" : "Pin to Favorites",
      onClick: () => toggleFavorite(t.id, !t.favorite),
    },
    { label: "Rename", onClick: () => { setRenameDraft(t.name); setRenamingTableId(t.id); } },
    { label: "Delete", danger: true, onClick: () => setConfirmDeleteTable(t) },
  ];

  // ── Sidebar folders (create / rename / delete / move) ─────────────────────
  // One set of handlers serving BOTH environments: cloud mode goes through the
  // tRPC folder mutations (shared with teammates), local mode through the
  // sidecar's /api/folders routes (per-project SQLite).

  const uniqueFolderName = (base: string): string => {
    const names = new Set(sidebarFolders.map((f) => f.name.toLowerCase()));
    if (!names.has(base.toLowerCase())) return base;
    let n = 2;
    while (names.has(`${base} ${n}`.toLowerCase())) n++;
    return `${base} ${n}`;
  };

  const onCreateFolder = async () => {
    const name = uniqueFolderName("New folder");
    try {
      let id: string;
      if (inCloud) {
        if (!cloudProject) return;
        id = await createCloudFolder(cloudProject._id, name);
      } else {
        id = (await api.createFolder(name)).id;
        await reloadFolders();
      }
      // Open the new folder and drop straight into rename (matching the design).
      setOpenFolders((o) => ({ ...o, [id]: true }));
      setFolderDraft(name);
      setRenamingFolderId(id);
    } catch { /* surfaced by the list simply not changing */ }
  };

  const commitFolderRename = async (id: string, name: string) => {
    setRenamingFolderId(null);
    const trimmed = name.trim();
    if (!trimmed) return;
    if (inCloud) {
      if (!cloudProject) return;
      await renameCloudFolder(cloudProject._id, id, trimmed).catch(() => {});
    } else {
      await api.renameFolder(id, trimmed).catch(() => {});
      await reloadFolders();
    }
  };

  // Deleting a folder UNFILES its tables back to the root (both backends), so
  // no confirm modal is needed — nothing destructive happens to table data.
  const onDeleteFolder = async (id: string) => {
    if (inCloud) {
      if (!cloudProject) return;
      await deleteCloudFolder(cloudProject._id, id).catch(() => {});
    } else {
      await api.deleteFolder(id).catch(() => {});
      await Promise.all([reloadFolders(), reloadTables()]);
    }
    setOpenFolders((o) => {
      if (!(id in o)) return o;
      const next = { ...o };
      delete next[id];
      return next;
    });
  };

  const toggleFolder = (id: string) =>
    setOpenFolders((o) => ({ ...o, [id]: !o[id] }));
  const openFolder = (id: string) =>
    setOpenFolders((o) => (o[id] ? o : { ...o, [id]: true }));

  // Move a dragged table row into a folder / to the root / next to another row.
  // The fractional position is computed CLIENT-side from the visible list (pure
  // helper) so both backends get one simple "set folderId + position" write.
  const onMoveTableRow = async (row: TableListRow, target: MoveTarget) => {
    const position = positionForMove(tableList, row.id, target);
    if (row.kind === "cloud") {
      if (!cloudProject) return;
      await moveCloudTable(cloudProject._id, row.id as Id<"tables">, target.folderId, position).catch(() => {});
    } else {
      await api.moveTable(row.id, target.folderId, position).catch(() => {});
      await reloadTables();
    }
    if (target.folderId !== null) openFolder(target.folderId);
  };

  const startFolderRename = (f: SidebarFolder) => {
    setFolderDraft(f.name);
    setRenamingFolderId(f.id);
  };

  const newTableInFolder = (folderId: string) => {
    setNewTableFolderId(folderId);
    setShowNewTableChooser(true);
  };

  const folderMenuItems = (f: SidebarFolder) => [
    { label: "Rename", onClick: () => startFolderRename(f) },
    { label: "New table here", onClick: () => newTableInFolder(f.id) },
    { label: "Delete folder", danger: true, onClick: () => { void onDeleteFolder(f.id); } },
  ];

  // ── Sidebar drag & drop (tables ↔ folders) ─────────────────────────────────

  const clearDrag = () => { setDragTableId(null); setDropTarget(null); };
  const dragPosOf = (e: ReactDragEvent): "before" | "after" => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY - r.top < r.height / 2 ? "before" : "after";
  };
  const onRowDragStart = (e: ReactDragEvent, row: TableListRow) => {
    setDragTableId(row.id);
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", row.id); } catch { /* webview quirk */ }
  };
  const onRowDragOver = (e: ReactDragEvent, row: TableListRow) => {
    if (!dragTableId || dragTableId === row.id) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget({ kind: "table", id: row.id, pos: dragPosOf(e) });
  };
  const onRowDrop = (e: ReactDragEvent, row: TableListRow) => {
    const dragged = tableList.find((r) => r.id === dragTableId);
    if (!dragged || dragged.id === row.id) { clearDrag(); return; }
    e.preventDefault();
    e.stopPropagation();
    const target: MoveTarget =
      dragPosOf(e) === "after"
        ? { folderId: row.folderId, afterId: row.id }
        : { folderId: row.folderId, beforeId: row.id };
    void onMoveTableRow(dragged, target);
    clearDrag();
  };
  const onFolderDragEnter = (f: SidebarFolder) => {
    // Auto-expand a collapsed folder while hovering a drag over it.
    if (dragTableId) openFolder(f.id);
  };
  const onFolderDragOver = (e: ReactDragEvent, f: SidebarFolder) => {
    if (!dragTableId) return;
    e.preventDefault();
    setDropTarget({ kind: "folder", id: f.id });
  };
  const onFolderDrop = (e: ReactDragEvent, f: SidebarFolder) => {
    const dragged = tableList.find((r) => r.id === dragTableId);
    if (!dragged) { clearDrag(); return; }
    e.preventDefault();
    e.stopPropagation();
    void onMoveTableRow(dragged, { folderId: f.id });
    clearDrag();
  };
  const onRootDragOver = (e: ReactDragEvent) => {
    if (!dragTableId) return;
    e.preventDefault();
    setDropTarget({ kind: "root" });
  };
  const onRootDrop = (e: ReactDragEvent) => {
    const dragged = tableList.find((r) => r.id === dragTableId);
    if (!dragged) { clearDrag(); return; }
    e.preventDefault();
    void onMoveTableRow(dragged, { folderId: null });
    clearDrag();
  };

  // ── Run all function cols ──────────────────

  const runAll = async () => {
    if (!tableData) return;
    const tableId = tableData.id;
    const fnCols = tableData.columns.filter(c => c.kind === "function");
    if (!fnCols.length) return;
    // Run independent columns concurrently (bounded), serializing only columns
    // with true {{dependencies}} (topological order). Each column streams its
    // per-cell progress and patches cells as they land — no full-grid refetch.
    const deps = buildColumnDeps(fnCols);
    let completed = 0;
    setRunProgress({ current: 0, total: fnCols.length });
    await runColumnsWithDeps(
      fnCols,
      deps,
      RUN_ALL_CONCURRENCY,
      async (col) => { await api.runColumnStream(col.id, (e) => patchCell(tableId, e)); },
      () => { completed += 1; setRunProgress({ current: completed, total: fnCols.length }); },
    );
    setRunProgress(null);
  };

  // ── Run only the selected rows ─────────────
  // Same dependency-aware orchestration as `runAll`, but each column streams
  // against just the chosen row IDs — so the user can process a custom batch at
  // a time instead of the whole table. Non-force: already-`done` cells in those
  // rows are skipped (and not re-billed), matching Run-all semantics.
  const runRows = async (rowIds: string[]) => {
    if (!tableData || rowIds.length === 0) return;
    const tableId = tableData.id;
    const fnCols = tableData.columns.filter(c => c.kind === "function");
    if (!fnCols.length) return;
    const deps = buildColumnDeps(fnCols);
    let completed = 0;
    setRunProgress({ current: 0, total: fnCols.length });
    await runColumnsWithDeps(
      fnCols,
      deps,
      RUN_ALL_CONCURRENCY,
      async (col) => { await api.runColumnStream(col.id, (e) => patchCell(tableId, e), { rowIds }); },
      () => { completed += 1; setRunProgress({ current: completed, total: fnCols.length }); },
    );
    setRunProgress(null);
  };

  // ── Auto-run cascade ───────────────────────
  //
  // A single-column or single-cell run doesn't walk the dependency graph the way
  // Run-all does, so columns that map from the one we just ran would otherwise sit
  // empty until the user hit play on each. These helpers auto-populate them.
  //
  // Free/mapped columns always cascade (no credit cost), even with Auto-run off;
  // a billed enrichment cascades only when Auto-run is on. See `isFreeColumn`.
  const cascadeEligible = (c: Column): boolean =>
    c.kind === "function" && (autoRunRef.current || isFreeColumn(c));

  // After the columns named by `sourceColIds` have run, run the eligible function
  // columns that reference them, transitively (a dependent we run becomes a source
  // for its own dependents). `opts` mirrors the triggering run: a single-cell edit
  // cascades force-scoped to that row; a full-column run fills empty dependent cells
  // without forcing, so already-`done` cells are never re-billed (TRI-3283 L2).
  const cascadeDependents = async (
    tableId: string,
    sourceColIds: string[],
    opts: { force?: boolean; rowIds?: string[] } = {},
  ) => {
    const ran = new Set<string>(sourceColIds);
    let snapshot = await api.table(tableId);
    let frontier = snapshot.columns.filter((c) => sourceColIds.includes(c.id)).map((c) => c.name);
    while (frontier.length) {
      const deps = snapshot.columns.filter(
        (c) => !ran.has(c.id) && cascadeEligible(c) && frontier.some((n) => columnDependsOn(c, n)),
      );
      if (!deps.length) break;
      for (const dc of deps) {
        ran.add(dc.id);
        await api.runColumnStream(dc.id, (e) => patchCell(tableId, e), opts).catch(() => {});
      }
      frontier = deps.map((c) => c.name);
      snapshot = await api.table(tableId);
    }
  };

  // ── Run single column ──────────────────────

  const runColumn = async (colId: string, opts?: { force?: boolean; rowIds?: string[] }) => {
    const tableId = selectedTableId;
    if (!tableId) return;
    setRunningColId(colId);
    // Patch cells in place as the sidecar streams per-cell progress (SSE),
    // instead of refetching+replacing the whole grid after the run.
    try {
      await api.runColumnStream(colId, (e) => patchCell(tableId, e), opts);
      // Cascade keeps the triggering run's ROW scope but never its force —
      // dependents fill empty cells only, so done cells are never re-billed.
      await cascadeDependents(tableId, [colId], opts?.rowIds ? { rowIds: opts.rowIds } : {});
    } catch { /* ignore */ }
    setRunningColId(null);
  };

  // ── Run a single cell (this row × this function column) ──
  const runCell = async (rowId: string, colId: string) => {
    const tableId = selectedTableId;
    if (!tableId) return;
    const key = `${rowId}:${colId}`;
    setRunningCells(s => new Set(s).add(key));
    try {
      // Force is scoped to the ONE explicitly-targeted cell via `rowIds:[rowId]`,
      // so re-running this cell never re-runs (or re-bills) any other row's
      // already-`done` cell in the column (TRI-3283 L2).
      await api.runColumnStream(colId, (e) => patchCell(tableId, e), { force: true, rowIds: [rowId] });
      await cascadeDependents(tableId, [colId], { force: true, rowIds: [rowId] });
    } catch { /* ignore */ }
    setRunningCells(s => { const n = new Set(s); n.delete(key); return n; });
  };

  // ── Column added (from Add-column / Functions) ──
  // A newly added mapped/formula column whose inputs already have values should
  // populate immediately — it's free. A new billed enrichment auto-runs only when
  // Auto-run is on; otherwise it waits for the user to hit play. Manual columns
  // (and any non-eligible column) just refresh the grid.
  const onColumnAdded = async (tableId: string, newColId?: string) => {
    await loadTable(tableId);
    if (!newColId) return;
    const col = (await api.table(tableId).catch(() => null))?.columns.find((c) => c.id === newColId);
    if (!col || !cascadeEligible(col)) return;
    setRunningColId(newColId);
    try {
      await api.runColumnStream(newColId, (e) => patchCell(tableId, e));
      await cascadeDependents(tableId, [newColId]);
    } catch { /* ignore */ }
    setRunningColId(null);
  };

  // ── Add row ────────────────────────────────

  const addRow = async () => {
    if (!tableData) return;
    await api.addRow(tableData.id);
    await loadTable(tableData.id);
    scheduleAutoPush(tableData.id);
  };

  // ── Promote a JSON field to a column (from the Cell details drawer) ──

  const uniqueColName = (base: string): string => {
    const existing = new Set((tableData?.columns ?? []).map((c) => c.name.toLowerCase()));
    if (!existing.has(base.toLowerCase())) return base;
    let n = 2;
    while (existing.has(`${base} ${n}`.toLowerCase())) n++;
    return `${base} ${n}`;
  };

  const promoteCreate = async (path: string[], label: string) => {
    if (!detail || !selectedTableId) return;
    const res = await api.addColumn(selectedTableId, {
      name: uniqueColName(label),
      code: extractCode(path),
      params: { src: `{{${detail.columnName}}}` },
      type: "text",
    });
    await api.runColumn(res.id).catch(() => {});
    await loadTable(selectedTableId);
  };

  const promoteMap = async (path: string[], targetId: string) => {
    if (!detail || !selectedTableId) return;
    await api.updateColumn(targetId, {
      kind: "function",
      provider: null,
      method: null,
      code: extractCode(path),
      params: { src: `{{${detail.columnName}}}` },
    });
    await api.runColumn(targetId).catch(() => {});
    await loadTable(selectedTableId);
  };

  // ── Rename / duplicate a column (header context menu) ──

  const renameColumn = async (colId: string, name: string) => {
    await api.updateColumn(colId, { name }).catch(() => {});
    reloadCurrent();
    if (selectedTableId) scheduleAutoPush(selectedTableId);
  };

  const duplicateColumn = async (col: Column) => {
    if (!selectedTableId) return;
    const body: Parameters<typeof api.addColumn>[1] = {
      name: uniqueColName(`${col.name} copy`),
      type: col.type,
      params: col.params,
      condition: col.condition ?? null,
    };
    // The server synthesizes fn === "code" for custom-code columns — those
    // round-trip via `code`, everything else via the real `provider.method`.
    if (col.fn === "code") body.code = col.code ?? undefined;
    else if (col.fn) body.fn = col.fn;
    await api.addColumn(selectedTableId, body).catch(() => {});
    reloadCurrent();
  };

  // ── Column resize (drag the header edge) ──

  const startResize = (colId: string, startX: number, startW: number) => {
    const onMove = (e: MouseEvent) => setColWidth(colId, startW + (e.clientX - startX));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // ── Delete row / cell / column ─────────────

  const reloadCurrent = () => {
    if (selectedTableId) loadTable(selectedTableId);
  };
  const deleteRow = async (rowId: string) => {
    await api.deleteRow(rowId).catch(() => {});
    reloadCurrent();
  };
  const clearCell = async (rowId: string, columnId: string) => {
    await api.clearCell(rowId, columnId).catch(() => {});
    reloadCurrent();
  };
  const deleteColumn = async (columnId: string) => {
    await api.deleteColumn(columnId).catch(() => {});
    reloadCurrent();
  };
  const openCtx = (e: React.MouseEvent, items: { label: string; danger?: boolean; onClick: () => void }[]) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, items });
  };

  // ── Set cell ───────────────────────────────

  const setCell = async (rowId: string, colId: string, value: string) => {
    await api.setCell(rowId, colId, value);
    if (!selectedTableId) return;
    setTableData(await api.table(selectedTableId));

    // Auto-run: re-run the columns that map from the edited one, for this row only
    // (`rowIds:[rowId]`, so other rows' already-`done` dependents aren't re-billed —
    // TRI-3283 L2). Free/mapped dependents always cascade; billed enrichments only
    // when Auto-run is on (handled by `cascadeEligible`).
    await cascadeDependents(selectedTableId, [colId], { force: true, rowIds: [rowId] });
    setTableData(await api.table(selectedTableId));

    // Auto-sync (TRI-3298): a debounced push after the edit settles.
    scheduleAutoPush(selectedTableId);
  };

  // ── Sidebar: connector groups ──────────────

  const toggleProvider = (p: string) =>
    setExpandedProviders(prev => ({ ...prev, [p]: !prev[p] }));

  // Refresh connection state after a key is added in a detail panel.
  const refreshConnections = useCallback(async () => {
    const [e, ai] = await Promise.all([
      api.extensions().catch(() => null),
      api.aiProviders().catch(() => null),
    ]);
    if (e) setExtensions(e);
    if (ai) setAiProviders(ai);
  }, []);

  // ─────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────

  const fnColCount = tableData?.columns.filter(c => c.kind === "function").length ?? 0;

  // "provider.method" → presentation metadata (logo, labels, credits) for the
  // grid headers; rebuilt only when the connector catalog changes.
  const fnColumnMeta = useMemo(() => buildColumnMetaMap(connectors), [connectors]);

  // ── Cloud sign-in welcome (dismissable to local) ─────────────
  // When cloud is configured, first launch shows the sign-in/onboarding screen —
  // but it is NOT a hard gate: "Continue locally" (onClose → continueLocally)
  // drops into local mode with NO cloud features, free + offline. Cloud access
  // (workspaces, sync, realtime) requires signing in. Once the user has chosen
  // local (or signed in), this never blocks again.
  // A pending invite OVERRIDES local mode: an invitee who previously chose
  // "continue locally" must still be guided through sign-in to accept + join.
  const mustAuth =
    cloudEnabled &&
    !isAuthenticated &&
    (!localMode || pendingInviteToken !== null);
  if (mustAuth && authLoading) {
    return <AppLoader inShell label="Signing you in…" />;
  }
  if (mustAuth) {
    return (
      <Suspense fallback={<AppLoader inShell label="Signing you in…" />}>
        <OnboardingFlow
          forced
          initialScreen={pendingInviteToken !== null ? "signup" : "signin"}
          hasSession={false}
          onClose={() => {
            // Opting out clears the invite so the gate doesn't re-fire in a loop.
            if (pendingInviteToken !== null) clearPendingInviteToken();
            continueLocally();
          }}
          onDone={() => {}}
        />
      </Suspense>
    );
  }

  // Boot loader: a signed-in cloud user is always routed into a cloud project (the
  // effect above auto-opens the last/most-recent one, or creates a Default). Until
  // that resolves, `cloudProject` is null and the app would otherwise render in
  // LOCAL mode and then visibly flip to cloud. Hold the full-screen branded loader
  // until the cloud environment is settled (a project is open).
  //
  // We deliberately do NOT gate on `localMode`: a signed-in user auto-enters cloud
  // on every boot regardless of a stale localMode flag, so they'd otherwise still
  // see the flash. Skipped only when the trial is locked (its own panel owns the
  // screen). The loader holds until BOTH the project is open AND the minimum window
  // has elapsed (so an instant load still reads as an intentional branded splash),
  // bounded by the safety ceiling so it can never stick.
  const cloudUser = cloudEnabled && !cloudLocked && isAuthenticated;
  const bootingCloud =
    cloudUser && !bootTimedOut && (cloudProject === null || !bootMinElapsed);
  if (bootingCloud) {
    return <AppLoader inShell label="Loading your workspace…" />;
  }

  return (
    <div className="app-shell" style={{ ["--sidebar-w"]: `${sidebarWidth}px` } as CSSProperties}>
      {/* Workspace-invite accept banner (email-matched + ?invite= URL token).
          Self-gates: renders nothing when signed out / no pending invites. The
          trial / auto-sync nudge / update alerts that used to stack here now live
          in the bell notification center (TRI-3308) in the sidebar header. */}
      <PendingInvites onAccepted={onInviteAccepted} />
      <div className="app">
      {/* ── Sidebar ─────────────────────── */}
      <aside className="sidebar">
        {/* Header — brand + project/workspace dropdown + plan badge (replaces the
            old separate top bar). Same height as the main toolbar so the top
            divider line is continuous across panes. */}
        <div className="sidebar-header">
          <LogoMark size={22} />
          <button className="sidebar-proj" onClick={() => setShowProjects(true)} title="Switch project / workspace">
            <span className="brand-name">GTM Grid</span>
            <span className="sidebar-project">
              {inCloud ? cloudProject!.name : projectName}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
            </span>
          </button>
          <span className="sidebar-head-spacer" />
          <div className="notif-anchor">
            <button
              ref={bellRef}
              className={`sidebar-members notif-bell${unreadNotifs > 0 ? " has-unread" : ""}`}
              onClick={openNotifications}
              aria-label={unreadNotifs > 0 ? `Notifications, ${unreadNotifs} unread` : "Notifications"}
              aria-haspopup="dialog"
              aria-expanded={notifOpen}
              title="Notifications"
            >
              <Icon.Bell size={15} />
              {unreadNotifs > 0 && (
                <span className="notif-badge" aria-hidden="true">{unreadNotifs > 9 ? "9+" : unreadNotifs}</span>
              )}
            </button>
            {notifOpen && (
              <NotificationCenter
                notifications={notifications}
                onAction={runNotificationAction}
                onDismiss={dismissNotif}
                onClose={() => setNotifOpen(false)}
                anchorRef={bellRef}
              />
            )}
          </div>
          {activeWorkspace && (
            <button className="sidebar-members" onClick={() => setShowWorkspaceSettings(true)} title="Workspace members & seats">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            </button>
          )}
        </div>

        <div className="sidebar-scroll">
          {/* Tables section — CLEAR local/cloud separation. The list shows ONE
              environment's tables: in CLOUD mode the cloud tables, in LOCAL mode
              the local tables. Because only one environment's rows exist at a
              time, only one row can ever be active (no dual highlight). The sync
              affordances (sync-all button, per-row sync dots, auto-sync toggle)
              appear ONLY in local mode while signed into cloud (`showSyncUi`). */}
          <div className="sidebar-section">
            <div className="sidebar-section-label">
              <span className="sidebar-label-text">Tables{cloudLocked && inCloud ? " 🔒" : ""}</span>
              <span className="sidebar-label-actions">
                {showSyncUi && (
                  <button
                    className={`sync-all-btn${syncPending ? " has-pending" : ""}`}
                    title={syncPending ? `Sync ${syncPending} table${syncPending > 1 ? "s" : ""}` : "All tables synced"}
                    disabled={pushingTableIds.size > 0}
                    onClick={onSyncAll}
                  >
                    {pushingTableIds.size > 0 ? <span className="cell-spinner" /> : <Icon.CloudUp size={13} />}
                    {syncPending ? <span className="sync-all-count">{syncPending}</span> : null}
                  </button>
                )}
                <span className="add-menu-wrap">
                  <button onClick={() => setAddMenuOpen(o => !o)} title="Add table or folder" disabled={inCloud && cloudLocked}>
                    <Icon.Plus />
                  </button>
                  {addMenuOpen && (
                    <>
                      <div className="menu-scrim" onClick={() => setAddMenuOpen(false)} />
                      <div className="add-menu">
                        <button onClick={() => { setAddMenuOpen(false); setNewTableFolderId(null); setShowNewTableChooser(true); }}>
                          <span className="add-menu-ic"><Icon.Table /></span> New table
                        </button>
                        <button onClick={() => { setAddMenuOpen(false); void onCreateFolder(); }}>
                          <span className="add-menu-ic"><Icon.FolderPlus /></span> New folder
                        </button>
                      </div>
                    </>
                  )}
                </span>
              </span>
            </div>
            {/* Auto-sync setting (TRI-3298): default OFF. Turning it ON requires
                confirming the destructive overwrite warning; OFF is immediate. */}
            {showSyncUi && (
              <label className="auto-sync-toggle">
                <span className="auto-sync-toggle__label">Auto-sync to cloud</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoSyncOn}
                  className={`switch${autoSyncOn ? " is-on" : ""}`}
                  title={autoSyncOn ? "Auto-sync is on — local tables overwrite the cloud copy on every change" : "Turn on auto-sync (will overwrite cloud copies)"}
                  onClick={requestAutoSyncToggle}
                >
                  <span className="switch__knob" />
                </button>
              </label>
            )}
            {cloudTables === undefined && inCloud ? (
              <div className="skeleton-row">
                <div className="shimmer skeleton-bar" style={{ width: "65%", height: 13 }} />
              </div>
            ) : tableList.length === 0 && sidebarFolders.length === 0 ? (
              <div style={{ padding: "4px 16px", fontSize: 12, color: "var(--text-3)" }}>No tables yet</div>
            ) : (
              <>
                {groupedTables.folders.map(({ folder, rows: folderRows }) => {
                  const isOpen = !!openFolders[folder.id];
                  const into = dropTarget?.kind === "folder" && dropTarget.id === folder.id;
                  return (
                    <div key={`folder:${folder.id}`} className="sidebar-folder">
                      {renamingFolderId === folder.id ? (
                        <div className="folder-head">
                          <span className="connector-group-toggle open"><Icon.ChevronRight /></span>
                          <span className="folder-ic"><Icon.FolderOpen /></span>
                          <input
                            className="sidebar-rename-input"
                            value={folderDraft}
                            autoFocus
                            onChange={e => setFolderDraft(e.target.value)}
                            onBlur={() => commitFolderRename(folder.id, folderDraft)}
                            onKeyDown={e => {
                              if (e.key === "Enter") commitFolderRename(folder.id, folderDraft);
                              if (e.key === "Escape") setRenamingFolderId(null);
                            }}
                          />
                        </div>
                      ) : (
                        <div
                          className={`folder-head${into ? " drop-into" : ""}`}
                          onClick={() => toggleFolder(folder.id)}
                          onContextMenu={e => openCtx(e, folderMenuItems(folder))}
                          onDragEnter={() => onFolderDragEnter(folder)}
                          onDragOver={e => onFolderDragOver(e, folder)}
                          onDrop={e => onFolderDrop(e, folder)}
                        >
                          <span className={`connector-group-toggle${isOpen ? " open" : ""}`}><Icon.ChevronRight /></span>
                          <span className="folder-ic">{isOpen ? <Icon.FolderOpen /> : <Icon.Folder />}</span>
                          <span
                            className="folder-name"
                            onDoubleClick={e => { e.stopPropagation(); startFolderRename(folder); }}
                          >
                            {folder.name}
                          </span>
                          <button
                            className="sidebar-item-more"
                            title="Folder options"
                            onClick={e => { e.stopPropagation(); openCtx(e, folderMenuItems(folder)); }}
                          >
                            <Icon.More />
                          </button>
                          <span className="sidebar-item-count">{folderRows.length}</span>
                        </div>
                      )}
                      {isOpen && (
                        <div className="folder-body">
                          {folderRows.length === 0 ? (
                            <div
                              className={`folder-empty${into ? " drop-into" : ""}`}
                              onDragOver={e => onFolderDragOver(e, folder)}
                              onDrop={e => onFolderDrop(e, folder)}
                            >
                              Drop tables here
                            </div>
                          ) : (
                            folderRows.map((row) => renderTableRow(row, true))
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                <div
                  className={`root-drop${dropTarget?.kind === "root" ? " drop-into" : ""}`}
                  onDragOver={onRootDragOver}
                  onDrop={onRootDrop}
                >
                  {groupedTables.root.map((row) => renderTableRow(row, false))}
                </div>
              </>
            )}
            {inCloud && cloudLocked ? (
              <button
                className="btn btn--primary"
                style={{ margin: "8px 12px", width: "calc(100% - 24px)", justifyContent: "center" }}
                onClick={() => setShowUpgrade(true)}
              >
                Upgrade to unlock cloud
              </button>
            ) : (
              <>
                <div
                  className="sidebar-item"
                  style={{ marginTop: 2, opacity: cloudCreating ? 0.6 : 1 }}
                  onClick={() => { setNewTableFolderId(null); setShowNewTableChooser(true); }}
                >
                  <span className="sidebar-item-icon" style={{ color: "var(--accent)" }}><Icon.Plus /></span>
                  <span className="sidebar-item-name" style={{ color: "var(--accent)" }}>
                    {cloudCreating ? "Creating…" : "New table"}
                  </span>
                </div>
                <div className="sidebar-item" onClick={() => setImportMode(inCloud ? "cloud" : "local")}>
                  <span className="sidebar-item-icon"><Icon.Table /></span>
                  <span className="sidebar-item-name">Import CSV…</span>
                </div>
              </>
            )}
            {cloudCreateError && (
              <div className="account-menu-error" role="alert" style={{ margin: "4px 16px" }}>
                {cloudCreateError}
              </div>
            )}
          </div>

          {/* AI Providers section — collapsible */}
          <div className="sidebar-section">
            <div className="sidebar-section-label clickable" onClick={() => setAiSectionOpen(o => !o)}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className={`connector-group-toggle${aiSectionOpen ? " open" : ""}`}>
                  <Icon.ChevronRight />
                </span>
                AI Providers
              </span>
            </div>
            {aiSectionOpen && (aiProviders.length === 0 ? (
              <div className="skeleton-row">
                <div className="shimmer skeleton-bar" style={{ width: "65%", height: 13 }} />
              </div>
            ) : aiProviders.map(p => (
              <div
                key={p.id}
                className={`ext-item clickable${view.kind === "ai" && view.id === p.id ? " active" : ""}`}
                onClick={() => setView({ kind: "ai", id: p.id })}
              >
                <BrandIcon logo={p.logo} name={p.name} size={16} />
                <span className="ext-item-name">{p.name}</span>
                {p.connected && <span className="ext-badge connected">connected</span>}
              </div>
            )))}
          </div>

          {/* Tools section — collapsible, with Browse all in the header */}
          <div className="sidebar-section">
            <div className="sidebar-section-label clickable" onClick={() => setExtSectionOpen(o => !o)}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className={`connector-group-toggle${extSectionOpen ? " open" : ""}`}>
                  <Icon.ChevronRight />
                </span>
                Tools
              </span>
              <button
                className={`section-link${view.kind === "extensions" ? " active" : ""}`}
                onClick={e => { e.stopPropagation(); setView({ kind: "extensions" }); }}
              >
                Browse all
              </button>
            </div>
            {extSectionOpen && (extensions.length === 0 ? (
              <div className="skeleton-row">
                <div className="shimmer skeleton-bar" style={{ width: "70%", height: 13 }} />
              </div>
            ) : <>
              {extensions.slice(0, NAV_PREVIEW_LIMIT).map(e => (
                <div
                  key={e.id}
                  className={`ext-item clickable${view.kind === "extension" && view.id === e.id ? " active" : ""}`}
                  onClick={() => setView({ kind: "extension", id: e.id })}
                >
                  <BrandIcon logo={e.logo} name={e.name} size={16} />
                  <span className="ext-item-name">{e.name}</span>
                  <span className={`ext-badge ${e.connected ? "connected" : "no-key"}`}>
                    {e.connected ? "connected" : "no key"}
                  </span>
                </div>
              ))}
              {extensions.length > NAV_PREVIEW_LIMIT && (
                <div
                  className="ext-item clickable ext-item-more"
                  onClick={() => setView({ kind: "extensions" })}
                  title="Browse all tools"
                >
                  +{extensions.length - NAV_PREVIEW_LIMIT} more
                </div>
              )}
            </>)}
          </div>

          {/* Functions section — collapsed by default */}
          <div className="sidebar-section">
            <div
              className="sidebar-section-label clickable"
              onClick={() => setFnSectionOpen(o => !o)}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className={`connector-group-toggle${fnSectionOpen ? " open" : ""}`}>
                  <Icon.ChevronRight />
                </span>
                Functions
              </span>
              <span className="connector-method-count">{connectors.reduce((n, c) => n + c.methods.length, 0)}</span>
            </div>
            {fnSectionOpen && (connectors.length === 0 ? (
              <div className="skeleton-row">
                <div className="shimmer skeleton-bar" style={{ width: "60%", height: 13 }} />
              </div>
            ) : <>
              {(fnShowAll ? connectors : connectors.slice(0, NAV_PREVIEW_LIMIT)).map(c => (
                <div key={c.provider} className="connector-group">
                  <div className="connector-group-header" onClick={() => toggleProvider(c.provider)}>
                    <span className={`connector-group-toggle${expandedProviders[c.provider] ? " open" : ""}`}>
                      <Icon.ChevronRight />
                    </span>
                    <span className="connector-group-name">{c.name}</span>
                    <span className="connector-method-count">{c.methods.length}</span>
                  </div>
                  {expandedProviders[c.provider] && (
                    <div className="connector-methods">
                      {c.methods.map(m => (
                        <div key={m.method} className="connector-method-item" title={m.description}>
                          {m.label}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {!fnShowAll && connectors.length > NAV_PREVIEW_LIMIT && (
                <div
                  className="ext-item clickable ext-item-more"
                  onClick={() => setFnShowAll(true)}
                  title="Show all providers"
                >
                  +{connectors.length - NAV_PREVIEW_LIMIT} more
                </div>
              )}
            </>)}
          </div>

          {/* Skills section — per-tool agent playbooks + custom skills */}
          <div className="sidebar-section">
            <div className="sidebar-section-label clickable" onClick={() => setSkillsSectionOpen(o => !o)}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className={`connector-group-toggle${skillsSectionOpen ? " open" : ""}`}>
                  <Icon.ChevronRight />
                </span>
                Skills
              </span>
              <button
                className={`section-link${view.kind === "skills" ? " active" : ""}`}
                onClick={e => { e.stopPropagation(); setView({ kind: "skills" }); }}
              >
                Browse all
              </button>
            </div>
            {skillsSectionOpen && (skills.length === 0 ? (
              <div className="skeleton-row">
                <div className="shimmer skeleton-bar" style={{ width: "70%", height: 13 }} />
              </div>
            ) : <>
              {skills.slice(0, NAV_PREVIEW_LIMIT).map(s => (
                <div
                  key={s.id}
                  className={`ext-item clickable${view.kind === "skill" && view.id === s.id ? " active" : ""}`}
                  onClick={() => setView({ kind: "skill", id: s.id })}
                >
                  <BrandIcon logo={s.logo} name={s.name} size={16} />
                  <span className="ext-item-name">{s.name}</span>
                  {s.source === "tool" && s.connected && <span className="ext-badge connected">on</span>}
                  {s.source === "custom" && <span className="ext-badge no-key">custom</span>}
                </div>
              ))}
              {skills.length > NAV_PREVIEW_LIMIT && (
                <div
                  className="ext-item clickable ext-item-more"
                  onClick={() => setView({ kind: "skills" })}
                  title="Browse all skills"
                >
                  +{skills.length - NAV_PREVIEW_LIMIT} more
                </div>
              )}
            </>)}
          </div>
        </div>

        {/* Footer: account / project menu (cloud auth + workspace switcher +
            appearance/dark-mode toggle). */}
        <AccountBar
          projectName={projectName}
          healthStatus={healthStatus}
          currentProjectPath={currentProjectPath}
          inCloud={inCloud}
          cloudProjectName={cloudProject?.name ?? null}
          onSwitchToLocal={switchToLocal}
          cloudProjects={activeWorkspace ? cloudProjects : undefined}
          onOpenCloudProject={onCloudProjectSelected}
          onSwitchProject={() => setShowProjects(true)}
          onOpenMenu={openAccountMenu}
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          onStartOnboarding={
            cloudEnabled
              ? () =>
                  setOnboarding({
                    initialScreen: isAuthenticated ? "workspace" : "signin",
                    hasSession: isAuthenticated,
                  })
              : undefined
          }
        />
        {/* Drag handle on the right edge — resize the sidebar width. */}
        <div className="sidebar-resize" onMouseDown={startSidebarResize} title="Drag to resize sidebar" />
      </aside>

      {/* ── Main area ───────────────────── */}
      <div className="main">

        {healthStatus === "offline" && (
          <div className="offline-banner">
            <Icon.Zap />
            Server not reachable — start it with{" "}
            <code>pnpm --filter @gtmgrid/server dev</code>
          </div>
        )}

        {/* CSV import — rendered INLINE in this center pane (filling the area
            between the two sidebars), replacing the grid/empty-state while open.
            Closing returns to the grid. Local writes via the sidecar; cloud via
            Convex. */}
        {importMode === "local" && (
          <Suspense fallback={<PanelFallback />}>
            <ImportCsvModal
              inline
              writer={localImportWriter}
              onClose={() => setImportMode(null)}
              onImported={() => { api.tables().then(setTables); }}
              onOpenTable={id => {
                api.tables().then(t => {
                  setTables(t);
                  setSelectedTableId(id);
                  setView({ kind: "table" });
                });
                setImportMode(null);
              }}
            />
          </Suspense>
        )}
        {importMode === "cloud" && cloudImportWriter && (
          <Suspense fallback={<PanelFallback />}>
            <ImportCsvModal
              inline
              writer={cloudImportWriter}
              onClose={() => setImportMode(null)}
              onOpenTable={id => {
                setCloudTableId(id as Id<"tables">);
                setImportMode(null);
              }}
            />
          </Suspense>
        )}

        {/* Cloud project: the LIVE multiplayer grid (Convex). Replaces the local
            sidecar grid entirely while a cloud project is open. Hidden while a
            CSV import is open in this pane. */}
        {!importMode && inCloud && !cloudLocked && view.kind === "table" && (
          <Suspense fallback={<PanelFallback />}>
            <CloudGrid
              tableId={cloudTableId}
              connectors={connectors}
              onOpenAiSettings={() => setView({ kind: "ai", id: aiProviders[0]?.id ?? "anthropic" })}
              openWebhookToken={openWebhookToken}
              onMissing={onCloudTableMissing}
            />
          </Suspense>
        )}

        {/* Cloud locked: the trial lapsed / Free plan. Cloud data stays safe but
            inaccessible until the user upgrades; local tables are unaffected. */}
        {!importMode && inCloud && cloudLocked && view.kind === "table" && (
          <div className="cloud-locked">
            <div className="cloud-locked__card">
              <div className="cloud-locked__icon">🔒</div>
              <h2>Cloud is locked</h2>
              <p>
                Your free trial has ended. Your cloud tables, realtime sync and
                shared credentials are safe — upgrade to unlock them again.
                Everything local keeps working, free.
              </p>
              <button className="btn btn--primary" onClick={() => setShowUpgrade(true)}>
                Upgrade to unlock cloud
              </button>
            </div>
          </div>
        )}

        {/* Extensions gallery + detail panels. These render in BOTH local and
            cloud workspaces — in cloud they own the shared "Workspace" credential
            scope, so they must take precedence over the CloudGrid (which only
            renders for the "table" view). */}
        {!importMode && view.kind === "extensions" && (
          <Suspense fallback={<PanelFallback />}>
            <ExtensionsBrowse
              extensions={extensions}
              onOpen={(id) => setView({ kind: "extension", id })}
            />
          </Suspense>
        )}
        {!importMode && view.kind === "extension" && (
          <Suspense fallback={<PanelFallback />}>
            <ExtensionPanel
              id={view.id}
              onConnected={refreshConnections}
              onBack={() => setView({ kind: "extensions" })}
              workspaceCreds={workspaceCreds}
            />
          </Suspense>
        )}
        {!importMode && view.kind === "ai" && (() => {
          const p = aiProviders.find(x => x.id === view.id);
          return p ? (
            <Suspense fallback={<PanelFallback />}>
              <AiProviderPanel provider={p} onConnected={refreshConnections} workspaceCreds={workspaceCreds} />
            </Suspense>
          ) : null;
        })()}

        {/* Skills gallery + detail panels. Like the extension/AI panels, these
            render in BOTH local and cloud workspaces (the Skills sidebar is shown
            in both) and take precedence over CloudGrid, which is gated to the
            "table" view — otherwise selecting a skill in a cloud workspace would
            hide the grid and render nothing (a blank dead-end). */}
        {!importMode && view.kind === "skills" && (
          <Suspense fallback={<PanelFallback />}>
            <SkillsBrowse
              skills={skills}
              onOpen={(id) => setView({ kind: "skill", id })}
              onChanged={() => api.skills().then(setSkills).catch(() => {})}
            />
          </Suspense>
        )}
        {!importMode && view.kind === "skill" && (
          <Suspense fallback={<PanelFallback />}>
            <SkillPanel
              id={view.id}
              onBack={() => setView({ kind: "skills" })}
              onChanged={() => api.skills().then(setSkills).catch(() => {})}
            />
          </Suspense>
        )}

        {!importMode && !inCloud && view.kind === "table" && (
          !selectedTableId ? (
            <div className="empty-state">
              <div className="empty-icon"><Icon.Grid /></div>
              <div className="empty-title">No table selected</div>
              <p className="empty-sub">Create your first table to start building your GTM data grid.</p>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-primary" onClick={() => { setNewTableFolderId(null); setShowNewTableChooser(true); }}>
                  <Icon.Plus /> Create table
                </button>
                <button className="btn btn-outline" onClick={() => setImportMode("local")}>
                  <Icon.Table /> Import CSV
                </button>
              </div>
            </div>
          ) : tableLoading ? (
            <div className="empty-state">
              <div className="cell-spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />
            </div>
          ) : tableData ? (
            <DataGrid
              controller={{
                table: tableData,
                rowHeight,
                columnWidth: colW,
                minColWidth: MIN_COL_W,
                maxColWidth: MAX_COL_W,
                runProgress,
                runningColId,
                runningCells,
                fnColCount,
                canRun: !runProgress,
                runDisabledReason: runProgress ? "Running…" : undefined,
                canAddRow: !runProgress,
                autoRun: { value: autoRun, onToggle: toggleAutoRun },
                toolbarLeftExtras: (
                  <button
                    className="autorun-toggle"
                    onClick={() => setDedupeOpen(true)}
                    title="Deduplicate rows on a column"
                  >
                    <span className="autorun-label">Dedupe</span>
                    {tableData.dedupe && <span className="dedupe-on-dot" title="Auto-dedupe is on" />}
                  </button>
                ),
                columnMeta: (col) => (col.fn ? fnColumnMeta.get(col.fn) ?? null : null),
                addRow,
                runAll,
                runRows,
                runColumn,
                runCell,
                setCell,
                deleteRow,
                deleteColumn,
                clearCell,
                // One right rail at a time: the edit panel and the cell-details
                // drawer overlap, so opening one closes the other.
                editColumn: (col) => { setDetail(null); setEditCol(col); },
                renameColumn,
                duplicateColumn,
                openAddColumn: (anchor) => { setAddColAnchor(anchor); setShowAddCol(true); },
                resizeColumn: startResize,
                openCellDetails: (col, cell) => {
                  setEditCol(null);
                  setDetail({
                    columnName: col.name,
                    value: cell?.value ?? (cell?.error ? { error: cell.error } : null),
                  });
                },
                expandCell: (a) => setExpandCell(a),
              }}
              bodyOverride={
                tableData.rows.length === 0 && warmingTableId === tableData.id ? (
                  <div className="empty-state">
                    <div className="cell-spinner" style={{ width: 22, height: 22, borderWidth: 2, marginBottom: 14 }} />
                    <div className="empty-title">Pulling results from Trigify…</div>
                    <p className="empty-sub">Trigify is scraping your signal — first results can take a few minutes. They'll appear here automatically, and keep updating on your schedule.</p>
                  </div>
                ) : undefined
              }
            />
          ) : null
        )}
      </div>

      {/* ── Agent panel (Claude Code / Codex) ─ */}
      <Suspense fallback={null}>
        <AgentPanel
          onGridChange={refreshAll}
          activeTable={activeTable}
          cloud={agentCloud}
          onAgentEvent={onAgentEvent}
        />
      </Suspense>

      {/* ── Cell details drawer ─ */}
      {detail && (
        <CellDetails
          source={detail}
          columns={(tableData?.columns ?? []).map((c) => ({ id: c.id, name: c.name }))}
          onClose={() => setDetail(null)}
          onCreate={promoteCreate}
          onMapTo={promoteMap}
        />
      )}

      {/* ── Expanded cell editor ─ */}
      {expandCell && (
        <ExpandedEditor
          columnName={expandCell.columnName}
          value={expandCell.value}
          editable={expandCell.editable}
          anchor={expandCell.anchor}
          onSave={(v) => setCell(expandCell.rowId, expandCell.colId, v)}
          onClose={() => setExpandCell(null)}
        />
      )}

      {/* ── Right-click context menu ─ */}
      {ctxMenu && (
        <>
          <div className="ctx-backdrop" onClick={() => setCtxMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }} />
          <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            {ctxMenu.items.map((it, i) => (
              <button
                key={i}
                className={`ctx-item ${it.danger ? "danger" : ""}`}
                onClick={() => {
                  setCtxMenu(null);
                  it.onClick();
                }}
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}

      {/* ── Cloud onboarding (full-screen, C28) ─────────────── */}
      {onboarding && (
        <Suspense fallback={<AppLoader inShell label="Loading…" />}>
          <OnboardingFlow
            initialScreen={onboarding.initialScreen}
            hasSession={onboarding.hasSession}
            onClose={() => setOnboarding(null)}
            onDone={(workspaceId) => {
              if (workspaceId !== null) setActiveWorkspaceId(workspaceId);
              setOnboarding(null);
              refreshAppState(workspaceId);
            }}
          />
        </Suspense>
      )}

      {/* ── Modals ──────────────────────── */}
      {showWorkspaceSettings && activeWorkspace && (
        <Suspense fallback={<PanelFallback />}>
          <WorkspaceSettings
            workspaceId={activeWorkspace._id}
            workspaceName={activeWorkspace.name}
            onClose={() => setShowWorkspaceSettings(false)}
          />
        </Suspense>
      )}

      {/* Invite-accepted celebration: confetti fires on accept; this confirms it. */}
      {celebrateInvite && (
        <div
          className="overlay"
          onMouseDown={(e) =>
            e.target === e.currentTarget && setCelebrateInvite(null)
          }
        >
          <div className="modal celebrate" style={{ width: 380 }}>
            <div className="celebrate__emoji">🎉</div>
            <h2 className="celebrate__title">
              You&apos;re in{celebrateInvite.workspaceName ? "!" : "!"}
            </h2>
            <p className="celebrate__body">
              You&apos;ve joined{" "}
              <strong>{celebrateInvite.workspaceName ?? "the workspace"}</strong>
              . Your teammates&apos; cloud tables are ready.
            </p>
            <button
              className="btn btn--primary"
              onClick={() => setCelebrateInvite(null)}
            >
              Let&apos;s go
            </button>
          </div>
        </div>
      )}

      {/* Upgrade prompt for the cloud-locked / trial-expired state. Reuses the
          account bar's plan + checkout modal (opens the Autumn hosted checkout). */}
      {showUpgrade && activeWorkspace && (
        <PlanBillingModal
          workspace={activeWorkspace}
          isAuthenticated={isAuthenticated}
          onClose={() => setShowUpgrade(false)}
        />
      )}

      {showAddCol && tableData && (
        <Suspense fallback={<PanelFallback />}>
          <AddColumnPopover
            tableId={tableData.id}
            anchor={addColAnchor}
            onClose={() => setShowAddCol(false)}
            onAdded={() => loadTable(tableData.id)}
            onUseFunction={() => { setShowAddCol(false); setShowFunctions(true); }}
          />
        </Suspense>
      )}

      {showFunctions && tableData && (
        <Suspense fallback={<PanelFallback />}>
          <FunctionsModal
            tableId={tableData.id}
            connectors={connectors}
            columns={tableData.columns.map((c) => c.name)}
            onClose={() => setShowFunctions(false)}
            onAdded={(newColId) => onColumnAdded(tableData.id, newColId)}
            onOpenAiSettings={() => {
              setShowFunctions(false);
              const target = aiProviders[0]?.id ?? "anthropic";
              setView({ kind: "ai", id: target });
            }}
          />
        </Suspense>
      )}

      {editCol && tableData && (
        <Suspense fallback={<PanelFallback />}>
          <ColumnEditPanel
            column={editCol}
            columns={tableData.columns.map((c) => ({ id: c.id, name: c.name, type: c.type }))}
            connectors={connectors}
            tableId={tableData.id}
            rows={tableData.rows}
            onClose={() => setEditCol(null)}
            onSaved={(run) => {
              void loadTable(tableData.id);
              if (run) void runColumn(editCol.id, run);
            }}
            onOpenExtension={(id) => setView({ kind: "extension", id })}
          />
        </Suspense>
      )}

      {showNewTableChooser && (
        <NewTableChooser
          inCloud={inCloud}
          onClose={() => setShowNewTableChooser(false)}
          onBlank={() => {
            if (inCloud) void onCreateCloudTable(newTableFolderId);
            else setShowNewTable(true);
          }}
          onCsv={() => setImportMode(inCloud ? "cloud" : "local")}
          onWebhook={() => { void onChooseWebhook(); }}
          onSignals={() => setShowSignals(true)}
        />
      )}

      {showSignals && (
        <Suspense fallback={<PanelFallback />}>
          <SignalsModal
            cloud={inCloud ? signalsCloud : undefined}
            onClose={() => setShowSignals(false)}
            onConnectTrigify={() => { setShowSignals(false); setView({ kind: "extension", id: "trigify" }); }}
            onCreated={(tableId, added) => {
              setShowSignals(false);
              if (inCloud) {
                setCloudTableId(tableId as Id<"tables">);
                setView({ kind: "table" });
              } else {
                api.tables().then((t) => {
                  setTables(t);
                  setSelectedTableId(tableId);
                  setView({ kind: "table" });
                }).catch(() => {});
                if (!added) startWarming(tableId);
              }
            }}
          />
        </Suspense>
      )}

      {showNewTable && (
        <NewTableModal
          folderId={newTableFolderId}
          onClose={() => { setShowNewTable(false); setNewTableFolderId(null); }}
          onCreated={id => {
            if (newTableFolderId !== null) {
              const fid = newTableFolderId;
              setOpenFolders((o) => (o[fid] ? o : { ...o, [fid]: true }));
            }
            api.tables().then(t => {
              setTables(t);
              setSelectedTableId(id);
            });
            // Auto-sync (TRI-3298): a new local table auto-links + pushes
            // immediately when the setting is ON (first push creates the cloud
            // table; the link is reused on later auto-pushes — no duplicates).
            autoPushNow(id);
          }}
        />
      )}

      {confirmDeleteTable && (
        <div className="overlay" onMouseDown={e => e.target === e.currentTarget && setConfirmDeleteTable(null)}>
          <div className="modal" style={{ width: 380 }}>
            <div className="modal-header">
              <span className="modal-title">Delete table</span>
              <button className="modal-close" onClick={() => setConfirmDeleteTable(null)}><Icon.X /></button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>
                Delete <strong style={{ color: "var(--text)" }}>{confirmDeleteTable.name}</strong>? This permanently
                removes the table and all of its columns and rows. This can't be undone.
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setConfirmDeleteTable(null)}>Cancel</button>
              <button
                className="btn btn-danger"
                onClick={() => { const t = confirmDeleteTable; setConfirmDeleteTable(null); deleteTable(t.id); }}
              >
                Delete table
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteCloudTable && (
        <div className="overlay" onMouseDown={e => e.target === e.currentTarget && setConfirmDeleteCloudTable(null)}>
          <div className="modal">
            <div className="modal-header">
              <span className="modal-title">Delete table</span>
              <button className="modal-close" onClick={() => setConfirmDeleteCloudTable(null)}><Icon.X /></button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>
                Delete <strong style={{ color: "var(--text)" }}>{confirmDeleteCloudTable.name}</strong>? This permanently
                removes the cloud table and all of its columns and rows. This can't be undone.
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setConfirmDeleteCloudTable(null)}>Cancel</button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  const t = confirmDeleteCloudTable;
                  setConfirmDeleteCloudTable(null);
                  if (cloudTableId === t._id) setCloudTableId(null);
                  void deleteCloudTable(t._id).catch(() => {});
                }}
              >
                Delete table
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Per-table sync popover (TRI-3297). */}
      {/* TRI-3310 bug D: NEVER render the popover while the overwrite-confirm
          modal is open for the SAME table — the popover would show the
          conflict-confirm body alongside the modal (two overlapping confirms).
          The call sites also close the popover when the modal opens; this render
          guard makes the "exactly one confirmation" invariant structural. */}
      {showSyncUi && syncPopover && overwriteConfirm?.tableId !== syncPopover.tableId && (() => {
        const t = tables.find((x) => x.id === syncPopover.tableId);
        if (!t) return null;
        const status = syncStatusFor(t.id);
        return (
          <SyncPopover
            tableName={t.name}
            rowCount={t.rows}
            status={status}
            workspaceName={activeWorkspace?.name ?? "Workspace"}
            memberCount={activeWorkspace?.seatUsage.used ?? 1}
            anchorTop={syncPopover.anchorTop}
            sidebarWidth={sidebarWidth}
            cloudRowCount={syncLinks[t.id]?.rowCount ?? null}
            error={syncErrors[t.id] ?? null}
            onPush={() => onPushTable(t.id)}
            // Conflict state already names the destructive overwrite and asks
            // "Keep my version / Cancel", so push DIRECTLY here (TRI-3306) —
            // routing through onPushTable would pop a second identical overwrite
            // modal (double-confirm) for the one action the user just accepted.
            onConfirmOverwrite={() => { setSyncPopover(null); void runPush(t.id, true); }}
            onRepush={() => onPushTable(t.id)}
            onClose={() => setSyncPopover(null)}
          />
        );
      })()}

      {dedupeOpen && tableData && (
        <DedupePopover
          columns={tableData.columns.map((c) => ({ id: c.id, name: c.name }))}
          current={tableData.dedupe ?? null}
          setDedupe={(body) => api.setDedupe(tableData.id, body)}
          dedupeTable={() => api.dedupeTable(tableData.id)}
          onClose={() => setDedupeOpen(false)}
          onChanged={() => loadTable(tableData.id)}
        />
      )}

      {/* Destructive-overwrite confirm (TRI-3297): a re-push of a LINKED table
          overwrites cloud data, so name the table + row count before sending
          confirmOverwrite. A first push (unlinked → create) never reaches here. */}
      {overwriteConfirm && (
        <div className="overlay" onMouseDown={e => e.target === e.currentTarget && setOverwriteConfirm(null)}>
          <div className="modal" style={{ width: 400 }}>
            <div className="modal-header">
              <span className="modal-title">Overwrite cloud copy?</span>
              <button className="modal-close" onClick={() => setOverwriteConfirm(null)}><Icon.X /></button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>
                {overwriteConfirmMessage(overwriteConfirm.name, overwriteConfirm.rowCount)}
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setOverwriteConfirm(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={() => { onConfirmOverwrite(); setOverwriteConfirm(null); }}>
                Keep my version — overwrite the cloud copy
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk destructive-overwrite confirm (TRI-3307): "Sync all" with linked
          tables pending shows ONE confirm naming the COUNT, then re-pushes ALL of
          them on accept. On cancel none of the linked tables push. */}
      {bulkOverwriteConfirm && (
        <div className="overlay" onMouseDown={e => e.target === e.currentTarget && setBulkOverwriteConfirm(null)}>
          <div className="modal" style={{ width: 400 }}>
            <div className="modal-header">
              <span className="modal-title">Re-push linked tables?</span>
              <button className="modal-close" onClick={() => setBulkOverwriteConfirm(null)}><Icon.X /></button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>
                Re-push {bulkOverwriteConfirm.toOverwrite.length} linked table{bulkOverwriteConfirm.toOverwrite.length === 1 ? "" : "s"}? This overwrites their cloud copies with your local versions.
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setBulkOverwriteConfirm(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={onConfirmBulkOverwrite}>
                Keep my versions — overwrite the cloud copies
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Auto-sync enable-time confirm (TRI-3298): turning the setting ON
          requires confirming the repeated-overwrite behaviour. Only enables on
          accept; cancelling leaves it OFF. */}
      {autoSyncEnableConfirm && (
        <div className="overlay" onMouseDown={e => e.target === e.currentTarget && setAutoSyncEnableConfirm(false)}>
          <div className="modal" style={{ width: 420 }}>
            <div className="modal-header">
              <span className="modal-title">Turn on auto-sync?</span>
              <button className="modal-close" onClick={() => setAutoSyncEnableConfirm(false)}><Icon.X /></button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.5 }}>
                {AUTO_SYNC_ENABLE_WARNING}
              </p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setAutoSyncEnableConfirm(false)}>Cancel</button>
              <button
                className="btn btn-danger"
                onClick={() => { setAutoSyncEnableConfirm(false); void persistAutoSync(true); }}
              >
                Turn on — overwrite cloud copies automatically
              </button>
            </div>
          </div>
        </div>
      )}

      {showProjects && (
        <ProjectSwitcher
          current={projectName}
          onClose={() => setShowProjects(false)}
          onSwitched={onProjectSwitched}
          cloud={
            activeWorkspace
              ? {
                  projects: cloudProjects,
                  activeId: cloudProject?._id ?? null,
                  onSelect: onCloudProjectSelected,
                  onCreate: onCreateCloudProject,
                }
              : undefined
          }
        />
      )}
      </div>
    </div>
  );
}
