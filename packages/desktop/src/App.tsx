import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, memo, lazy, Suspense, type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { api, Column, Cell, ConnectorInfo, ExtensionInfo, AiProviderInfo, SkillInfo, type SignalSource } from "./api";
import { onActivateKey } from "./lib/utils";
import { LogoMark } from "./Logo";
import { AppLoader } from "./AppLoader";
import { CommandPalette, type PaletteAction } from "./CommandPalette";
import { resolveEditTrigger } from "./useGridKeyboardNav";
import { Dialog, DialogContent } from "./components/ui/dialog";
import { BrandIcon } from "./BrandIcon";
import { ProjectSwitcher, CloudIcon } from "./ProjectSwitcher";
import { AccountBar, PlanBillingModal } from "./cloud/AccountBar";
import { PendingInvites } from "./cloud/PendingInvites";
import { cloudEnabled, queryClient, syncWorkspacePlan, apiClient } from "./cloud/client";
import {
  dedupeTableRowsByName,
  groupTableList,
  positionForMove,
  type MoveTarget,
  type SidebarFolder,
  type TableListRow,
} from "./tableTree";
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
import { changelogNotes } from "./changelog";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import {
  buildNotifications,
  unreadCount as countUnread,
  markAllSeen,
  dismissNotification,
  parsePersistState,
  serializePersistState,
  NOTIFICATIONS_PERSIST_KEY,
  type NotificationPersistState,
  type NotificationActionId,
  type AppNotification,
} from "./notifications";
import { useWorkspaceCredentials } from "./cloud/useWorkspaceCredentials";
import {
  useCloudProjects,
  useCloudTables,
  useCloudTablePaged,
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
import type { TableCard } from "./Panels";
import type { ImportWriter } from "./csvImport";
// NOTE: DataGrid / buildColumnMetaMap / resolveRowHeight were only used by the
// removed local-sidecar grid render path; the cloud grid (CloudGrid) is
// self-contained. They are intentionally no longer imported here.
import type { Id } from "./cloud/ids";
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
const TablesBrowse = lazy(() =>
  import("./Panels").then((m) => ({ default: m.TablesBrowse })),
);
const SkillPanel = lazy(() =>
  import("./Panels").then((m) => ({ default: m.SkillPanel })),
);
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
  | { kind: "tables" }
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
  /** Keyboard nav: whether this is the grid's active (roving-tabindex) cell. */
  isActive?: boolean;
  /** Keyboard nav: bumped by the grid to request this (active) cell start
   *  editing. `editSeed` carries the first typed character (type-to-edit). */
  editSignal?: number;
  editSeed?: string;
};

function CellContentInner({ cell, col, onEdit, onOpenDetails, onExpand, onRunCell, running, waiting, onEditingChange, isActive, editSignal, editSeed }: CellContentProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = (seed?: string) => {
    if (col.kind === "function") return;
    if (seed !== undefined) {
      // Type-to-edit: replace with the typed character, cursor at the end.
      setDraft(seed);
      setTimeout(() => {
        const el = inputRef.current;
        if (el) el.setSelectionRange(el.value.length, el.value.length);
      }, 0);
    } else {
      const current = cell?.value != null ? String(cell.value) : "";
      setDraft(current);
      setTimeout(() => inputRef.current?.select(), 0);
    }
    setEditing(true);
    onEditingChange?.(true);
  };

  // Enter edit when the grid bumps editSignal — but ONLY for a real request made
  // while this cell is already active (see resolveEditTrigger for the why).
  const lastEditSignal = useRef(editSignal ?? 0);
  const wasActive = useRef(false);
  useEffect(() => {
    const { edit, baseline } = resolveEditTrigger({
      isActive: !!isActive,
      wasActive: wasActive.current,
      signal: editSignal ?? 0,
      baseline: lastEditSignal.current,
    });
    lastEditSignal.current = baseline;
    wasActive.current = !!isActive;
    if (edit) startEdit(editSeed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, editSignal]);

  const commit = () => {
    setEditing(false);
    onEditingChange?.(false);
    onEdit(draft);
  };

  // End editing and return focus to the owning cell so arrow-key nav resumes.
  const refocusCell = () => {
    const td = inputRef.current?.closest("td");
    requestAnimationFrame(() => (td as HTMLElement | null)?.focus());
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
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
            refocusCell();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
            onEditingChange?.(false);
            refocusCell();
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
    // cell — render the note itself ("Run condition not met") as a neutral pill.
    if (cell?.status === "empty" && cell.error) {
      return (
        <div className="cell-wrap" title={cell.error}>
          {runBtn}
          <span className="cell-skipped">⊘ {cell.error}</span>
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
    return <div className="cell-wrap cell-editable" onClick={() => startEdit()}><span className="cell-empty">empty</span></div>;
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
    <div className="cell-wrap" onClick={col.kind === "manual" ? () => startEdit() : undefined}
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
    // Edit requests from keyboard nav target only the active cell (others always
    // get editSignal=0), so comparing it keeps non-active cells from re-rendering.
    prev.isActive === next.isActive &&
    prev.editSignal === next.editSignal &&
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
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="xcell" style={style} overlayClassName="bare-scrim" srTitle="Edit cell">
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
      </DialogContent>
    </Dialog>
  );
}

// ─── New Table Chooser ────────────────────────────────────

/**
 * The "New table" chooser — option tiles (Blank / CSV upload / Social Signals /
 * Webhook). Reuses the centered `.overlay > .modal` surface and the `.acx-*`
 * tile pattern. Every option creates a cloud table.
 */
function NewTableChooser({
  onClose,
  onBlank,
  onCsv,
  onWebhook,
  onSignals,
}: {
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

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="modal" style={{ width: 440 }} srTitle="New table">
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
            <button className="acx-item" onClick={() => { onWebhook(); onClose(); }}>
              <span className="acx-item-icon">{WebhookIcon}</span>
              <span className="acx-item-text">
                <span className="acx-item-title">Driven by a webhook</span>
                <span className="acx-item-sub">POST JSON to populate rows automatically.</span>
              </span>
              <span className="acx-item-caret">{Caret}</span>
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        ref={popRef}
        className="account-menu notif-pop"
        style={{ top: pos.top, left: pos.left }}
        overlayClassName="bare-scrim"
        srTitle="Notifications"
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
      </DialogContent>
    </Dialog>
  );
}

// ─── Update + changelog dialogs ───────────────────────────

/** The "update available" dialog: version + release notes + download/relaunch.
 *  Opened automatically on first sight of an update and re-openable from the
 *  download button next to the bell. */
function UpdateDialog({
  version,
  notes,
  updating,
  error,
  onDownload,
  onLater,
}: {
  version: string;
  notes: string | null;
  updating: boolean;
  error: string | null;
  onDownload: () => void;
  onLater: () => void;
}) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onLater(); }}>
      <DialogContent className="modal update-modal" style={{ width: 460 }} srTitle="Update available">
        <div className="modal-header">
          <span className="modal-title">Update available</span>
          <button className="modal-close" onClick={onLater} aria-label="Close"><Icon.X /></button>
        </div>
        <div className="modal-body">
          <p className="update-lead">
            GTM Grid <strong>v{version}</strong> is ready to install.
          </p>
          {notes && <div className="update-notes">{notes}</div>}
          {error && <div className="conn-err">{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onLater} disabled={updating}>Later</button>
          <button className="btn btn-primary" onClick={onDownload} disabled={updating}>
            {updating ? "Downloading…" : (<><Icon.Download size={13} /> Download &amp; restart</>)}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** "What's new" dialog shown once on the first launch of a freshly-installed
 *  version, listing that version's changelog notes. */
function ChangelogDialog({
  version,
  items,
  onClose,
}: {
  version: string;
  items: readonly string[];
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="modal changelog-modal" style={{ width: 460 }} srTitle={`What's new in version ${version}`}>
        <div className="modal-header">
          <span className="modal-title">What&apos;s new in v{version}</span>
          <button className="modal-close" onClick={onClose} aria-label="Close"><Icon.X /></button>
        </div>
        <div className="modal-body">
          <ul className="changelog-list">
            {items.map((it, i) => (
              <li key={i}>{it}</li>
            ))}
          </ul>
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" onClick={onClose}>Got it</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main App ─────────────────────────────────────────────

export default function App() {
  // Health (the execution sidecar liveness).
  const [healthStatus, setHealthStatus] = useState<"loading" | "connected" | "offline">("loading");

  // Tables (cloud-backed). Inline-rename draft state for the sidebar rows.
  const [renamingTableId, setRenamingTableId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmDeleteCloudTable, setConfirmDeleteCloudTable] = useState<{ _id: Id<"tables">; name: string } | null>(null);

  // Sidebar folders (cloud folders come from useCloudFolders).
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
  // The "New table" chooser (Blank / CSV / Webhook) replaces the old
  // straight-to-blank entry points.
  const [showNewTableChooser, setShowNewTableChooser] = useState(false);
  const [showSignals, setShowSignals] = useState(false);
  // Bumped to ask the CloudGrid to auto-open the webhook setup form (the chooser's
  // Webhook flow). A monotonic token so each request re-triggers cleanly.
  const [openWebhookToken, setOpenWebhookToken] = useState(0);
  const [showProjects, setShowProjects] = useState(false);
  const [showWorkspaceSettings, setShowWorkspaceSettings] = useState(false);
  // Cmd/Ctrl+K command palette (quick table nav + actions).
  const [paletteOpen, setPaletteOpen] = useState(false);
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

  // Resizable agent panel — same pattern as the sidebar but anchored to the RIGHT
  // edge, so the panel grows as you drag its left-edge handle leftward. Persisted
  // and clamped; `--agent-w` keeps the plan drawer (anchored right: var(--agent-w))
  // aligned. `resizing-agent` on <body> kills the collapse width-transition mid-drag.
  const [agentWidth, setAgentWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem("gtmgrid:agentW"));
    return v >= 320 && v <= 720 ? v : 384;
  });
  const startAgentResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = agentWidth;
    document.body.style.cursor = "col-resize";
    document.body.classList.add("resizing-agent");
    const onMove = (ev: MouseEvent) =>
      setAgentWidth(Math.min(720, Math.max(320, startW + startX - ev.clientX)));
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.classList.remove("resizing-agent");
      setAgentWidth((w) => {
        try { localStorage.setItem("gtmgrid:agentW", String(w)); } catch { /* ignore */ }
        return w;
      });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // ── Cloud project (multiplayer via Convex) ──────────────
  // The app is cloud-only: a signed-in user always has a cloud project open and
  // the main area renders the live CloudGrid.
  const me = useMe();
  const { isAuthenticated, isLoading: authLoading } = useAuthState();
  // A captured invite (deep link `gtmgrid://invite/<token>` or `?invite=` URL).
  // When present + signed out it routes the auth gate to sign-up so an invitee is
  // always guided to sign up / sign in and then auto-enrolled.
  const pendingInviteToken = usePendingInviteToken();
  // In-app auto-update (Tauri only): a newer SIGNED release surfaces a download
  // affordance next to the bell + an UpdateDialog that downloads/installs/relaunches.
  const update = useUpdateCheck();
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
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
  // On first sight of an available update, pop the dialog automatically — unless
  // the user already chose "Later" for THIS version (then it waits behind the
  // bell-adjacent download button).
  useEffect(() => {
    if (!update) return;
    let skipped: string | null = null;
    try { skipped = localStorage.getItem("gtmgrid:updateSkipped"); } catch { /* ignore */ }
    if (skipped !== update.version) setUpdateDialogOpen(true);
  }, [update]);
  // "Later": close + remember the skip for this version so it doesn't re-pop on
  // launch (the download button still holds it).
  const skipUpdate = useCallback(() => {
    setUpdateDialogOpen(false);
    if (update) { try { localStorage.setItem("gtmgrid:updateSkipped", update.version); } catch { /* ignore */ } }
  }, [update]);

  // "What's new" on the FIRST launch of a newly-installed version: compare the
  // running version against the last one we recorded. Show the changelog once,
  // then record the current version so it won't show again until the next update.
  const [changelogOpen, setChangelogOpen] = useState(false);
  const changelogItems = useMemo(() => changelogNotes(__APP_VERSION__), []);
  useEffect(() => {
    let last: string | null = null;
    try { last = localStorage.getItem("gtmgrid:lastVersion"); } catch { /* ignore */ }
    if (last !== null && last !== __APP_VERSION__ && changelogItems.length > 0) {
      setChangelogOpen(true);
    }
    try { localStorage.setItem("gtmgrid:lastVersion", __APP_VERSION__); } catch { /* ignore */ }
  }, [changelogItems]);
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
  const cloudTables = useCloudTables(cloudProject?._id ?? null);
  const cloudFolders = useCloudFolders(cloudProject?._id ?? null);
  const {
    createProject: createCloudProject,
    createTable: createCloudTable,
    deleteTable: deleteCloudTable,
    renameTable: renameCloudTable,
    setTableFavorite: setCloudTableFavorite,
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
  // CSV import: whether the cloud import modal is open (null = closed). Cloud
  // writes go via the metered Convex mutations (writer built below).
  const [importMode, setImportMode] = useState<null | "cloud">(null);

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
  // CLOUD context for the agent (TRI-3296): the signed-in session + the active
  // cloud workspace/project/table, so the agent's MCP table tools operate on
  // Supabase. Null unless ALL are present (a cloud project + table is open and
  // we have a session).
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
  // Active CLOUD table's live view. Shares CloudGrid's paged query key, so this
  // dedups with CloudGrid's own useCloudTablePaged (no extra fetch) and is a
  // safe no-op when passed `null`. Gives the agent's "Active table" hint the
  // cloud table the user is actually viewing (TRI-3296 follow-up): the visible
  // grid is driven by `cloudTableId`.
  const cloudActiveTable = useCloudTablePaged(cloudTableId).data;
  // Stable `activeTable` for the agent panel (TRI-3306). Previously passed as an
  // inline object literal, giving it a new identity on every App re-render
  // (react-query cloud polling, etc.); the panel keyed an abort-on-change effect
  // off it and so aborted the live agent turn on every unrelated re-render. The
  // panel now depends on scalar keys, but we still memoize here for hygiene so
  // the prop identity only changes when the table name or column set actually
  // does. We source it from the cloud table so the hint follows `cloudTableId`.
  const activeTableSource = cloudActiveTable ?? null;
  const activeTableColumnNames = activeTableSource?.columns.map((c) => c.name).join("\n") ?? null;
  const activeTable = useMemo(
    () =>
      activeTableSource
        ? { name: activeTableSource.name, columns: activeTableSource.columns.map((c) => c.name) }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the table name + serialized column names, not the FullTable identity
    [activeTableSource?.name, activeTableColumnNames],
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

  // ── Default cloud project for signed-in users ────────────────────────────
  // Persist the last-selected cloud project id so a relaunch reopens it, and on
  // first load (when a workspace + its projects are ready and nothing is open
  // yet) auto-select that project — or the most recent / first — so a signed-in
  // user always lands in a cloud project. Guarded by a ref so it runs ONCE per
  // workspace and never fights the workspace-change reset or an explicit user
  // action.
  const autoCloudWorkspaceRef = useRef<Id<"workspaces"> | null>(null);
  useEffect(() => {
    if (!activeWorkspaceId) return;
    // Persist the selection so the next launch can rehydrate it.
    if (cloudProject) {
      try { localStorage.setItem(LAST_CLOUD_PROJECT_KEY, cloudProject._id); } catch { /* ignore */ }
    }
    // One-shot auto-select per workspace: only when nothing is open yet and the
    // projects have loaded. A still-loading `undefined` is a no-op.
    if (autoCloudWorkspaceRef.current === activeWorkspaceId) return;
    if (cloudProject !== null) return;
    if (!cloudProjects) return; // still loading
    if (cloudProjects.length === 0) {
      // The app is cloud-only: if the workspace has no projects yet, auto-create
      // a default cloud project so a brand-new user always lands in a project.
      if (!activeWorkspace) return;
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
  }, [activeWorkspaceId, cloudProjects, cloudProject, activeWorkspace, createCloudProject]);

  // Appearance: only the dark-mode toggle is user-controllable. Density and
  // accent are fixed (compact + green) by product decision.
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try { return (localStorage.getItem("gtmgrid:theme") as "light" | "dark") || "light"; } catch { return "light"; }
  });
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    root.setAttribute("data-density", "compact");
    root.setAttribute("data-accent", "green");
    try { localStorage.setItem("gtmgrid:theme", theme); } catch { /* ignore */ }
  }, [theme]);

  // Open the add-column popover anchored just below the clicked "+" button.
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
        await api.health();
        if (cancelled) return;
        setHealthStatus("connected");
        // Load engine metadata resiliently: a single missing/failed route (e.g. a
        // version-skewed sidecar lacking a newer endpoint) must degrade that one
        // feature, never blank the whole app with "server not reachable". (Tables
        // live in the cloud now, so only engine metadata is fetched here.)
        const [f, e, ai, sk] = await Promise.all([
          api.functions().catch(() => []),
          api.extensions().catch(() => []),
          api.aiProviders().catch(() => []),
          api.skills().catch(() => []),
        ]);
        if (cancelled) return;
        setConnectors(f);
        setExtensions(e);
        setAiProviders(ai);
        setSkills(sk);
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

  // ── Cloud project selection ──────────────
  // Open a cloud project and default to its first table once the tables load.
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

  // Notification-center persistence (TRI-3308): dismissed/seen kinds, persisted
  // across sessions.
  const [notifPersist, setNotifPersist] = useState<NotificationPersistState>(() => {
    try {
      return parsePersistState(localStorage.getItem(NOTIFICATIONS_PERSIST_KEY));
    } catch {
      return parsePersistState(null);
    }
  });
  // Whether the bell's notification center popover is open.
  const [notifOpen, setNotifOpen] = useState(false);
  const bellRef = useRef<HTMLButtonElement | null>(null);

  // Build the active notification list (TRI-3308) from app state. The trial item
  // mirrors `showTrialBanner`.
  const notifications = useMemo(
    () =>
      buildNotifications({
        trialDaysLeft: showTrialBanner ? trialDaysLeft : null,
        persist: notifPersist,
      }),
    [showTrialBanner, trialDaysLeft, notifPersist],
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

  // Map a notification action id to its behaviour.
  const runNotificationAction = useCallback((id: NotificationActionId) => {
    switch (id) {
      case "trial.upgrade":
        setShowUpgrade(true);
        setNotifOpen(false);
        break;
    }
  }, []);

  // ── Tables list (cloud-only) ──────────────────────────────────────────────
  // The sidebar Tables list is purely the open cloud project's tables (cloud is
  // the only data path). De-duplicated by name; favourites pinned to the top.
  const tableList = useMemo(
    () =>
      dedupeTableRowsByName(
        [...(cloudTables ?? [])]
          // Favourites-first (stable: position order holds within a group).
          .sort((a, b) => Number(b.favorite) - Number(a.favorite))
          .map<TableListRow>((t) => ({
            kind: "cloud" as const,
            id: t._id,
            name: t.name,
            synced: true,
            favorite: t.favorite,
            rows: t.rows ?? 0,
            folderId: t.folderId,
            position: t.position,
          })),
      ),
    [cloudTables],
  );
  // The sidebar's folders for the open cloud project, in position order.
  const sidebarFolders = useMemo<SidebarFolder[]>(
    () => (cloudFolders ?? []).map((f) => ({ id: f._id, name: f.name, position: f.position })),
    [cloudFolders],
  );
  // Folder sections + root rows the sidebar renders.
  const groupedTables = useMemo(
    () => groupTableList(tableList, sidebarFolders),
    [tableList, sidebarFolders],
  );
  // Lookup by id so the rows can recover their cloud summary for selection.
  const cloudById = useMemo(() => {
    const m = new Map<string, CloudTableSummary>();
    for (const t of cloudTables ?? []) m.set(String(t._id), t);
    return m;
  }, [cloudTables]);
  // The active row id is the open cloud table's id (every row is cloud-backed).
  const activeRowId = cloudTableId !== null ? String(cloudTableId) : null;
  // Select a row from the list: point the live grid at that cloud table.
  const onSelectTableRow = useCallback(
    (row: TableListRow) => {
      const ct = cloudById.get(row.id);
      if (ct) setCloudTableId(ct._id);
      setView({ kind: "table" });
    },
    [cloudById],
  );

  // Cmd/Ctrl+K toggles the command palette. Registered once; safe to fire even
  // while typing in an input (it's a deliberate global shortcut, like browsers').
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Recency-sorted table cards for the Tables page, sorted by cloud createdAt.
  const tableCards = useMemo<TableCard[]>(() => {
    const ranked = tableList.map((row) => {
      const cloud = cloudById.get(row.id);
      const recency = Number(cloud?.createdAt ?? 0);
      const card: TableCard = {
        key: `${row.kind}:${row.id}`,
        kind: row.kind,
        id: row.id,
        name: row.name,
        rows: cloud?.rows ?? (row.rows > 0 ? row.rows : null),
        columns: null,
        favorite: row.favorite,
        synced: row.synced,
        active: String(row.id) === String(activeRowId),
        recency,
      };
      return { recency, card };
    });
    ranked.sort((a, b) => b.recency - a.recency);
    return ranked.map((r) => r.card);
  }, [tableList, cloudById, activeRowId]);

  // Tables-page actions (cloud-only). Plain functions — they close over the
  // latest state at click time. Rename/favourite go through the cloud mutations.
  const onOpenCard = (c: TableCard) => {
    const ct = cloudById.get(c.id);
    if (ct) setCloudTableId(ct._id);
    setView({ kind: "table" });
  };
  const onDeleteCard = (c: TableCard) => {
    const ct = cloudById.get(c.id);
    if (ct) setConfirmDeleteCloudTable({ _id: ct._id, name: ct.name });
  };
  const onFavoriteCard = (c: TableCard) => { void toggleCloudFavorite(c.id, !c.favorite); };
  const onRenameCard = (c: TableCard, name: string) => { void commitCloudRename(c.id, name); };
  // Bulk delete from the Tables hub — the page confirms once before calling this,
  // so it deletes each directly (no per-item modal).
  const onBulkDeleteCards = async (cs: TableCard[]) => {
    for (const c of cs) {
      const ct = cloudById.get(c.id);
      if (ct) await deleteCloudTable(ct._id).catch(() => {});
    }
  };

  // One unified sidebar table row (root or inside a folder). Not memoized — it
  // closes over the drag/drop + rename state and renders a handful of rows.
  const renderTableRow = (row: TableListRow, inFolder: boolean) => {
    const cloudRowLocked = cloudLocked;
    // Inline rename goes through the cloud tRPC mutation (a locked row can't be
    // renamed).
    const commitRowRename = (name: string) => commitCloudRename(row.id, name);
    if (renamingTableId === row.id && !cloudRowLocked) {
      return (
        <div key={`${row.kind}:${row.id}`} className={`sidebar-item${inFolder ? " in-folder" : ""}`} style={{ paddingTop: 2, paddingBottom: 2 }}>
          <span className="sidebar-item-icon"><Icon.Table /></span>
          <input
            className="sidebar-rename-input"
            value={renameDraft}
            autoFocus
            onChange={e => setRenameDraft(e.target.value)}
            onBlur={() => commitRowRename(renameDraft)}
            onKeyDown={e => {
              if (e.key === "Enter") commitRowRename(renameDraft);
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
        onKeyDown={onActivateKey(() => (cloudRowLocked ? setShowUpgrade(true) : onSelectTableRow(row)))}
        role="button"
        tabIndex={0}
        onContextMenu={
          !cloudRowLocked && cloudById.get(row.id)
            ? (e => openCtx(e, cloudTableMenuItems(row)))
            : undefined
        }
      >
        <span className="sidebar-item-icon">
          {cloudRowLocked ? "🔒" : <Icon.Table />}
        </span>
        <span className="sidebar-item-name">{row.name}</span>
        {row.favorite && <span className="sidebar-item-star"><Icon.Star filled /></span>}
        {row.rows > 0 && <span className="sidebar-item-count">{row.rows.toLocaleString()}</span>}
        {!cloudRowLocked && cloudById.get(row.id) && (
          <>
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
            <button
              className="sidebar-item-more"
              title="Table options"
              onClick={e => { e.stopPropagation(); openCtx(e, cloudTableMenuItems(row)); }}
            >
              <Icon.More />
            </button>
          </>
        )}
        {/* Trailing indicator: a cloud icon on cloud-backed rows; otherwise
            the row count. Every table is cloud-backed in the cloud-only app. */}
        {row.synced ? (
          <span className="sidebar-item-cloud" title="Synced to cloud">{CloudIcon}</span>
        ) : (
          <span className="sidebar-item-count">{row.rows}</span>
        )}
      </div>
    );
  };

  // Default the active cloud table to the first one once the list loads.
  useEffect(() => {
    if (cloudTables && cloudTables.length > 0 && cloudTableId === null) {
      setCloudTableId(cloudTables[0]._id);
    }
  }, [cloudTables, cloudTableId]);

  // Open-cloud-table 404 self-heal (TRI-3312). When the open cloud table's load
  // returns 404 / not-found (CloudGrid reports it via `onMissing`), the open id
  // is a STALE deleted id (deleted out-of-band / by a teammate). Fall back to
  // another available cloud table so the view never sticks on the dead id.
  const onCloudTableMissing = useCallback(() => {
    // The open cloud table no longer exists (deleted out-of-band / by a
    // teammate). Fall back to the first available cloud table, or clear the
    // selection if the project is now empty.
    setCloudTableId((cur) => {
      const next = cloudTables?.find((t) => t._id !== cur);
      return next ? next._id : null;
    });
  }, [cloudTables]);


  // ── Cloud table actions (context menu + cards) ─────────────────────────────
  // Rename + favourite go through the tRPC mutations and both broadcast to every
  // teammate: rename relabels live, and a favourite is workspace-shared (any
  // member's pin shows for all).
  const commitCloudRename = async (id: string, name: string) => {
    setRenamingTableId(null);
    const trimmed = name.trim();
    if (!trimmed) return;
    await renameCloudTable(id as Id<"tables">, trimmed).catch(() => {});
  };
  const toggleCloudFavorite = async (id: string, favorite: boolean) => {
    await setCloudTableFavorite(id as Id<"tables">, favorite).catch(() => {});
  };
  const cloudTableMenuItems = (row: TableListRow) => [
    {
      label: row.favorite ? "Unpin from Favorites" : "Pin to Favorites",
      onClick: () => void toggleCloudFavorite(row.id, !row.favorite),
    },
    { label: "Rename", onClick: () => { setRenameDraft(row.name); setRenamingTableId(row.id); } },
    {
      label: "Delete",
      danger: true,
      onClick: () => {
        const ct = cloudById.get(row.id);
        if (ct) setConfirmDeleteCloudTable({ _id: ct._id, name: ct.name });
      },
    },
  ];

  // ── Sidebar folders (create / rename / delete / move) ─────────────────────
  // Folder ops go through the tRPC folder mutations (shared with teammates).

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
      if (!cloudProject) return;
      const id = await createCloudFolder(cloudProject._id, name);
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
    if (!cloudProject) return;
    await renameCloudFolder(cloudProject._id, id, trimmed).catch(() => {});
  };

  // Deleting a folder UNFILES its tables back to the root, so no confirm modal
  // is needed — nothing destructive happens to table data.
  const onDeleteFolder = async (id: string) => {
    if (cloudProject) {
      await deleteCloudFolder(cloudProject._id, id).catch(() => {});
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
  // helper) so the backend gets one simple "set folderId + position" write.
  const onMoveTableRow = async (row: TableListRow, target: MoveTarget) => {
    const position = positionForMove(tableList, row.id, target);
    if (!cloudProject) return;
    await moveCloudTable(cloudProject._id, row.id as Id<"tables">, target.folderId, position).catch(() => {});
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

  // The shared sidebar/grid context menu (cloud table + folder menus).
  const openCtx = (e: React.MouseEvent, items: { label: string; danger?: boolean; onClick: () => void }[]) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, items });
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

  // ── Mandatory cloud sign-in gate ─────────────
  // The app is cloud-only: a signed-out user is held at the onboarding screen
  // with NO opt-out (a hard mandatory-login gate).
  const mustAuth = !isAuthenticated;
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
            // No opt-out for signed-out users; just clear any captured invite so
            // the gate doesn't re-fire in a loop.
            if (pendingInviteToken !== null) clearPendingInviteToken();
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
  // Skipped only when the trial is locked (its own panel owns the screen). The
  // loader holds until BOTH the project is open AND the minimum window has
  // elapsed (so an instant load still reads as an intentional branded splash),
  // bounded by the safety ceiling so it can never stick.
  const cloudUser = !cloudLocked && isAuthenticated;
  const bootingCloud =
    cloudUser && !bootTimedOut && (cloudProject === null || !bootMinElapsed);
  if (bootingCloud) {
    return <AppLoader inShell label="Loading your workspace…" />;
  }

  return (
    <div className="app-shell" style={{ ["--sidebar-w"]: `${sidebarWidth}px`, ["--agent-w"]: `${agentWidth}px` } as CSSProperties}>
      {/* Workspace-invite accept banner (email-matched + ?invite= URL token).
          Self-gates: renders nothing when signed out / no pending invites. The
          trial / auto-sync nudge / update alerts that used to stack here now live
          in the bell notification center (TRI-3308) in the sidebar header. */}
      <PendingInvites onAccepted={onInviteAccepted} />
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to content
      </a>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        tables={tableList.map((r) => ({ id: String(r.id), name: r.name, kind: r.kind }))}
        onSelectTable={(id, kind) => {
          const row = tableList.find((r) => String(r.id) === id && r.kind === kind);
          if (row) onSelectTableRow(row);
        }}
        actions={[
          { id: "new-table", label: "New table", keywords: "create add", run: () => { setNewTableFolderId(null); setShowNewTableChooser(true); } },
          { id: "import-csv", label: "Import CSV", keywords: "upload file", run: () => setImportMode("cloud") },
          { id: "browse-tables", label: "Browse all tables", keywords: "search manage", run: () => setView({ kind: "tables" }) },
          { id: "switch-project", label: "Switch project / workspace", keywords: "change", run: () => setShowProjects(true) },
          ...(activeWorkspace ? [{ id: "workspace-settings", label: "Workspace settings", keywords: "members seats billing", run: () => setShowWorkspaceSettings(true) } as PaletteAction] : []),
        ]}
      />
      {update && updateDialogOpen && (
        <UpdateDialog
          version={update.version}
          notes={update.notes}
          updating={updating}
          error={updateError}
          onDownload={() => void runUpdate()}
          onLater={skipUpdate}
        />
      )}
      {changelogOpen && (
        <ChangelogDialog
          version={__APP_VERSION__}
          items={changelogItems}
          onClose={() => setChangelogOpen(false)}
        />
      )}
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
              {cloudProject?.name ?? "GTM Grid"}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
            </span>
          </button>
          <span className="sidebar-head-spacer" />
          {update && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="sidebar-members update-dl-btn"
                  onClick={() => setUpdateDialogOpen(true)}
                  aria-label={`Download GTM Grid v${update.version}`}
                >
                  <Icon.Download size={15} />
                  <span className="update-dl-dot" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Download GTM Grid v{update.version}</TooltipContent>
            </Tooltip>
          )}
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
          {/* Tables section — the open cloud project's tables (cloud is the only
              data path), so exactly one row can be active. */}
          <div className="sidebar-section">
            <div className="sidebar-section-label">
              <span className="sidebar-label-text">Tables{cloudLocked ? " 🔒" : ""}</span>
              <span className="sidebar-label-actions">
                <button
                  className={`section-link${view.kind === "tables" ? " active" : ""}`}
                  title="Search and manage all tables"
                  onClick={(e) => { e.stopPropagation(); setView({ kind: "tables" }); }}
                >
                  Browse all
                </button>
                <span className="add-menu-wrap">
                  <button onClick={() => setAddMenuOpen(o => !o)} title="Add table or folder" disabled={cloudLocked}>
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
            {cloudTables === undefined ? (
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
                          onKeyDown={onActivateKey(() => toggleFolder(folder.id))}
                          role="button"
                          tabIndex={0}
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
            {cloudLocked ? (
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
                  onKeyDown={onActivateKey(() => { setNewTableFolderId(null); setShowNewTableChooser(true); })}
                  role="button"
                  tabIndex={0}
                >
                  <span className="sidebar-item-icon" style={{ color: "var(--accent)" }}><Icon.Plus /></span>
                  <span className="sidebar-item-name" style={{ color: "var(--accent)" }}>
                    {cloudCreating ? "Creating…" : "New table"}
                  </span>
                </div>
                <div className="sidebar-item" onClick={() => setImportMode("cloud")} onKeyDown={onActivateKey(() => setImportMode("cloud"))} role="button" tabIndex={0}>
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
            <div className="sidebar-section-label clickable" onClick={() => setAiSectionOpen(o => !o)} onKeyDown={onActivateKey(() => setAiSectionOpen(o => !o))} role="button" tabIndex={0}>
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
                onKeyDown={onActivateKey(() => setView({ kind: "ai", id: p.id }))}
                role="button"
                tabIndex={0}
              >
                <BrandIcon logo={p.logo} name={p.name} size={16} />
                <span className="ext-item-name">{p.name}</span>
                {p.connected && <span className="ext-badge connected">connected</span>}
              </div>
            )))}
          </div>

          {/* Tools section — collapsible, with Browse all in the header */}
          <div className="sidebar-section">
            <div className="sidebar-section-label clickable" onClick={() => setExtSectionOpen(o => !o)} onKeyDown={onActivateKey(() => setExtSectionOpen(o => !o))} role="button" tabIndex={0}>
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
                  onKeyDown={onActivateKey(() => setView({ kind: "extension", id: e.id }))}
                  role="button"
                  tabIndex={0}
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
                  onKeyDown={onActivateKey(() => setView({ kind: "extensions" }))}
                  role="button"
                  tabIndex={0}
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
              onKeyDown={onActivateKey(() => setFnSectionOpen(o => !o))}
              role="button"
              tabIndex={0}
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
                  <div className="connector-group-header" onClick={() => toggleProvider(c.provider)} onKeyDown={onActivateKey(() => toggleProvider(c.provider))} role="button" tabIndex={0}>
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
                  onKeyDown={onActivateKey(() => setFnShowAll(true))}
                  role="button"
                  tabIndex={0}
                  title="Show all providers"
                >
                  +{connectors.length - NAV_PREVIEW_LIMIT} more
                </div>
              )}
            </>)}
          </div>

          {/* Skills section — per-tool agent playbooks + custom skills */}
          <div className="sidebar-section">
            <div className="sidebar-section-label clickable" onClick={() => setSkillsSectionOpen(o => !o)} onKeyDown={onActivateKey(() => setSkillsSectionOpen(o => !o))} role="button" tabIndex={0}>
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
                  onKeyDown={onActivateKey(() => setView({ kind: "skill", id: s.id }))}
                  role="button"
                  tabIndex={0}
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
                  onKeyDown={onActivateKey(() => setView({ kind: "skills" }))}
                  role="button"
                  tabIndex={0}
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
          projectName={cloudProject?.name ?? ""}
          healthStatus={healthStatus}
          cloudProjectName={cloudProject?.name ?? null}
          onSwitchProject={() => setShowProjects(true)}
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
      <div className="main" id="main-content" tabIndex={-1}>

        {healthStatus === "offline" && (
          <div className="offline-banner">
            <Icon.Zap />
            Server not reachable — start it with{" "}
            <code>pnpm --filter @gtmgrid/server dev</code>
          </div>
        )}

        {/* CSV import — rendered INLINE in this center pane (filling the area
            between the two sidebars), replacing the grid/empty-state while open.
            Closing returns to the grid. Writes via the metered Convex mutations. */}
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

        {/* Cloud project: the LIVE multiplayer grid (Convex) — the only data
            grid. Hidden while a CSV import is open in this pane. */}
        {!importMode && !cloudLocked && view.kind === "table" && (
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
            inaccessible until the user upgrades. */}
        {!importMode && cloudLocked && view.kind === "table" && (
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
        {!importMode && view.kind === "tables" && (
          <Suspense fallback={<PanelFallback />}>
            <TablesBrowse
              cards={tableCards}
              workspaceName={cloudProject?.name ?? undefined}
              onOpen={onOpenCard}
              onDelete={onDeleteCard}
              onFavorite={onFavoriteCard}
              onRename={onRenameCard}
              onNew={() => { setNewTableFolderId(null); setShowNewTableChooser(true); }}
              onBulkDelete={onBulkDeleteCards}
            />
          </Suspense>
        )}
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

      </div>

      {/* ── Agent panel (Claude Code / Codex) ─ */}
      <Suspense fallback={null}>
        <AgentPanel
          onGridChange={() => {
            // The agent mutates the cloud grid — refetch the cloud table list and
            // the open table so the UI reflects the agent's writes.
            void invalidateCloudTables();
            if (cloudTableId !== null) void invalidateCloudTable(cloudTableId);
          }}
          activeTable={activeTable}
          cloud={agentCloud}
          onAgentEvent={onAgentEvent}
          onResizeStart={startAgentResize}
        />
      </Suspense>

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
        <Dialog open onOpenChange={(o) => { if (!o) setCelebrateInvite(null); }}>
          <DialogContent className="modal celebrate" style={{ width: 380 }} srTitle="Invite accepted">
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
          </DialogContent>
        </Dialog>
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

      {showNewTableChooser && (
        <NewTableChooser
          onClose={() => setShowNewTableChooser(false)}
          onBlank={() => { void onCreateCloudTable(newTableFolderId); }}
          onCsv={() => setImportMode("cloud")}
          onWebhook={() => { void onChooseWebhook(); }}
          onSignals={() => setShowSignals(true)}
        />
      )}

      {showSignals && signalsCloud && (
        <Suspense fallback={<PanelFallback />}>
          <SignalsModal
            cloud={signalsCloud}
            onClose={() => setShowSignals(false)}
            onConnectTrigify={() => { setShowSignals(false); setView({ kind: "extension", id: "trigify" }); }}
            onCreated={(tableId) => {
              setShowSignals(false);
              setCloudTableId(tableId as Id<"tables">);
              setView({ kind: "table" });
            }}
          />
        </Suspense>
      )}

      {confirmDeleteCloudTable && (
        <Dialog open onOpenChange={(o) => { if (!o) setConfirmDeleteCloudTable(null); }}>
          <DialogContent className="modal" srTitle="Delete table">
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
          </DialogContent>
        </Dialog>
      )}

      {showProjects && activeWorkspace && (
        <ProjectSwitcher
          onClose={() => setShowProjects(false)}
          cloud={{
            projects: cloudProjects,
            activeId: cloudProject?._id ?? null,
            onSelect: onCloudProjectSelected,
            onCreate: onCreateCloudProject,
          }}
        />
      )}
      </div>
    </div>
  );
}
