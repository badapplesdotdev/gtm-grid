import { useState, useEffect, useCallback, useMemo, useRef, memo, lazy, Suspense, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { api, TableSummary, FullTable, Column, Cell, ConnectorInfo, ExtensionInfo, AiProviderInfo, SkillInfo, type SignalSource, type CellProgressEvent } from "./api";
import { LogoMark } from "./Logo";
import { AppLoader } from "./AppLoader";
import CellDetails, { extractCode } from "./CellDetails";
import { BrandIcon } from "./BrandIcon";
import { ProjectSwitcher } from "./ProjectSwitcher";
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
  autoSyncNudgeVisible,
  shouldAutoPush,
  parseAutoSyncFlag,
  AUTO_SYNC_DEBOUNCE_MS,
  AUTO_SYNC_ENABLE_WARNING,
  type SyncStatus,
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
import { useWorkspaceCredentials } from "./cloud/useWorkspaceCredentials";
import {
  useCloudProjects,
  useCloudTables,
  useCloudProjectMutations,
  useCloudGridMutations,
  useCloudSession,
  type CloudProject,
} from "./cloud/useCloudGrid";
import { type SignalsCloud } from "./SignalsModal";
// Type-only import (erased at build) so the AgentPanel lazy chunk stays split.
import type { AgentCloudContext } from "./AgentPanel";
import type { ImportWriter } from "./csvImport";
import type { Id } from "./cloud/ids";
import { VirtualGridBody } from "./VirtualGridBody";
import { resolveRowHeight } from "./gridVirtual";
import { useColumnWindow } from "./useColumnWindow";
import { GridColSpacer } from "./GridColSpacer";
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
// Persisted dismissal of the auto-sync nudge (TRI-3298) — stays dismissed across
// sessions once the user closes the nudge.
const AUTO_SYNC_NUDGE_DISMISSED_KEY = "gtmgrid:autoSyncNudgeDismissed";

// True if any of a function column's params reference {{columnName}}.
function columnDependsOn(col: Column, columnName: string): boolean {
  const re = new RegExp(`\\{\\{\\s*${columnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}`);
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
};

function CellContentInner({ cell, col, onEdit, onOpenDetails, onExpand, onRunCell, running }: CellContentProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => {
    if (col.kind === "function") return;
    const current = cell?.value != null ? String(cell.value) : "";
    setDraft(current);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const commit = () => {
    setEditing(false);
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
          if (e.key === "Escape") setEditing(false);
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
    if (col.kind === "function") {
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

  // done / has value — objects collapse to a status pill (click to open fields)
  if (isObjectOrArray(cell.value)) {
    return (
      <div className="cell-wrap">
        {runBtn}
        <span className="cell-status ok" title="Click to view fields" onClick={onOpenDetails}>
          Status Code: 200
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

function ExpandedEditor({
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

function NewTableModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("Untitled table");
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const t = await api.createTable(name.trim());
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
  const top = Math.min(anchorTop, window.innerHeight - 330);
  return (
    <>
      <div className="popover-scrim" onMouseDown={onClose} />
      <div
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
  // Shared (workspace-scoped) credential source for the connector / AI panels.
  // `undefined` when signed out / local-only, so those panels behave as before.
  const workspaceCreds = useWorkspaceCredentials(
    activeWorkspace?._id ?? null,
    isAuthenticated,
  );
  const cloudProjects = useCloudProjects(activeWorkspace?._id ?? null);
  const [cloudProject, setCloudProject] = useState<CloudProject | null>(null);
  const [cloudTableId, setCloudTableId] = useState<Id<"tables"> | null>(null);
  const cloudTables = useCloudTables(cloudProject?._id ?? null);
  const { createProject: createCloudProject, createTable: createCloudTable, deleteTable: deleteCloudTable } =
    useCloudProjectMutations();
  const { addColumn: cloudAddColumn, addRowsWithCells: cloudAddRowsWithCells } =
    useCloudGridMutations();
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
  const cloudSession = useCloudSession();
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
  // Row-virtualization plumbing (TRI-3267): the scroll container ref the
  // virtualizer reads, and the resolved per-density row height it estimates with.
  const gridScrollRef = useRef<HTMLDivElement>(null);
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

  // Column virtualization (TRI-3286): window the DATA columns horizontally so a
  // table with hundreds of columns mounts only the visible columns × visible
  // rows. The gutter is NOT part of this window — it is the always-present
  // sticky gutter <th>/<td> rendered once below, so it is reserved exactly once
  // and `spacers.left` is the first visible data column's offset (gutter
  // excluded). The hook runs unconditionally (count 0 when no table) to keep
  // hook order stable.
  const gridColumns = tableData?.columns ?? [];
  const columnWindow = useColumnWindow({
    count: gridColumns.length,
    scrollRef: gridScrollRef,
    getColumnWidth: (i) => {
      const col = gridColumns[i];
      return col ? colW(col.id) : DEFAULT_COL_W;
    },
  });

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
        const [t, f, e, ai, sk] = await Promise.all([
          api.tables().catch(() => []),
          api.functions().catch(() => []),
          api.extensions().catch(() => []),
          api.aiProviders().catch(() => []),
          api.skills().catch(() => []),
        ]);
        if (cancelled) return;
        setTables(t);
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
  const onCreateCloudTable = useCallback(async () => {
    if (!cloudProject || cloudCreating) return;
    setCloudCreating(true);
    setCloudCreateError(null);
    try {
      const id = await createCloudTable(cloudProject._id, "Untitled");
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
  const [syncLinks, setSyncLinks] = useState<Record<string, { cloudTableId: string; rowCount: number }>>({});
  const [pushingTableId, setPushingTableId] = useState<string | null>(null);
  const [syncErrors, setSyncErrors] = useState<Record<string, string>>({});
  // The open sync popover: the table id + the clicked row's viewport top, so the
  // popover anchors to the right of the row (design's `.sync-pop`).
  const [syncPopover, setSyncPopover] = useState<{ tableId: string; anchorTop: number } | null>(null);
  // A pending destructive-overwrite confirm: a linked table whose re-push would
  // overwrite cloud data. Holds the table + cloud row count for the warning copy.
  const [overwriteConfirm, setOverwriteConfirm] = useState<{ tableId: string; name: string; rowCount: number } | null>(null);

  // ── Auto-sync setting (TRI-3298) ─────────────────────────────────────────
  // The global `auto_sync_offline_tables` flag (default OFF), loaded from the
  // sidecar. When ON, local tables auto-link + push on create / debounced edit.
  // `autoSyncEnable` holds a pending enable-time destructive-overwrite confirm:
  // turning it ON requires confirming local tables will REPEATEDLY overwrite
  // their cloud copies. Toggling OFF is immediate (no confirm).
  const [autoSyncOn, setAutoSyncOn] = useState(false);
  const [autoSyncEnableConfirm, setAutoSyncEnableConfirm] = useState(false);
  // The nudge is dismissible and STAYS dismissed across sessions (localStorage).
  const [autoSyncNudgeDismissed, setAutoSyncNudgeDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem(AUTO_SYNC_NUDGE_DISMISSED_KEY) === "1"; } catch { return false; }
  });

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

  // Whether the auto-sync nudge should show: eligible cloud user, flag still
  // OFF, and not previously dismissed.
  const showAutoSyncNudge = autoSyncNudgeVisible({
    cloudEnabled, inCloud, isAuthenticated, autoSyncOn, dismissed: autoSyncNudgeDismissed,
  });

  // Dismiss the nudge — persist so it stays dismissed across sessions.
  const dismissAutoSyncNudge = useCallback(() => {
    setAutoSyncNudgeDismissed(true);
    try { localStorage.setItem(AUTO_SYNC_NUDGE_DISMISSED_KEY, "1"); } catch { /* ignore */ }
  }, []);

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
        pushing: pushingTableId === tableId,
        offline: healthStatus === "offline",
        needsOverwriteConfirm: overwriteConfirm?.tableId === tableId,
      }),
    [syncLinks, pushingTableId, healthStatus, overwriteConfirm],
  );

  // Run a single table push. `confirmOverwrite` is supplied by the confirm flow.
  // A 409 (LinkConflictError) means the server demands explicit confirmation:
  // surface the destructive-overwrite confirm instead of a generic error.
  const runPush = useCallback(
    async (tableId: string, confirmOverwrite: boolean) => {
      const apiUrl = API_URL;
      const token = getStoredAuthToken();
      const projectId = cloudProject?._id ?? null;
      if (!apiUrl || !token || !projectId) {
        setSyncErrors((m) => ({ ...m, [tableId]: "Sign in to a cloud workspace to sync." }));
        return;
      }
      setPushingTableId(tableId);
      setSyncErrors((m) => { const next = { ...m }; delete next[tableId]; return next; });
      try {
        const result = await api.pushTable({ apiUrl, token, projectId, localTableId: tableId, confirmOverwrite });
        setSyncLinks((m) => ({ ...m, [tableId]: { cloudTableId: result.cloudTableId, rowCount: result.rowCount } }));
        setOverwriteConfirm((c) => (c?.tableId === tableId ? null : c));
      } catch (e) {
        if (e instanceof CloudPushHttpError && isOverwriteConfirmNeeded(e)) {
          // Server says this table is linked and a re-push overwrites it. Route
          // into the destructive-overwrite confirm (naming the table + rows).
          const t = tables.find((x) => x.id === tableId);
          setOverwriteConfirm({ tableId, name: t?.name ?? "table", rowCount: t?.rows ?? 0 });
        } else {
          setSyncErrors((m) => ({ ...m, [tableId]: e instanceof Error ? e.message : "Push failed." }));
        }
      } finally {
        setPushingTableId(null);
      }
    },
    [cloudProject, tables],
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
  const onSyncAll = useCallback(() => {
    for (const t of tables) {
      if (syncStatusFor(t.id) !== "synced" && syncStatusFor(t.id) !== "syncing") {
        onPushTable(t.id);
      }
    }
  }, [tables, syncStatusFor, onPushTable]);

  // How many local tables have un-pushed work (drives `.sync-all-btn.has-pending`).
  const syncPending = useMemo(
    () => (showSyncUi ? pendingCount(tables.map((t) => syncStatusFor(t.id))) : 0),
    [showSyncUi, tables, syncStatusFor],
  );

  // Default the active cloud table to the first one once the list loads.
  useEffect(() => {
    if (!inCloud) return;
    if (cloudTables && cloudTables.length > 0 && cloudTableId === null) {
      setCloudTableId(cloudTables[0]._id);
    }
  }, [inCloud, cloudTables, cloudTableId]);

  // Switch to a different LOCAL project: also exit cloud mode so the sidecar
  // grid is shown. Tables change; global creds/extensions stay.
  const onProjectSwitched = useCallback(async (name: string) => {
    setShowProjects(false);
    setCloudProject(null);
    setCloudTableId(null);
    setProjectName(name);
    setView({ kind: "table" });
    const [t, e, ai] = await Promise.all([
      api.tables().catch(() => [] as TableSummary[]),
      api.extensions().catch(() => null),
      api.aiProviders().catch(() => null),
    ]);
    setTables(t);
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

  // ── Run single column ──────────────────────

  const runColumn = async (colId: string) => {
    const tableId = selectedTableId;
    if (!tableId) return;
    setRunningColId(colId);
    // Patch cells in place as the sidecar streams per-cell progress (SSE),
    // instead of refetching+replacing the whole grid after the run.
    try { await api.runColumnStream(colId, (e) => patchCell(tableId, e)); } catch { /* ignore */ }
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
    } catch { /* ignore */ }
    setRunningCells(s => { const n = new Set(s); n.delete(key); return n; });
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
    let updated = await api.table(selectedTableId);
    setTableData(updated);

    // Auto-run: re-run function columns that reference the edited column, for this row.
    if (autoRun) {
      const changed = updated.columns.find((c) => c.id === colId);
      if (changed) {
        const deps = updated.columns.filter((c) => c.kind === "function" && columnDependsOn(c, changed.name));
        if (deps.length) {
          for (const dc of deps) {
            // Force is scoped to the edited row only (`rowIds:[rowId]`): only the
            // cells whose input actually changed (this row's dependents) are
            // recomputed/re-billed — every OTHER row's already-`done` dependent
            // cell is left untouched (TRI-3283 L2).
            await api.runColumn(dc.id, { force: true, rowIds: [rowId] }).catch(() => {});
          }
          updated = await api.table(selectedTableId);
          setTableData(updated);
        }
      }
    }
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

  return (
    <div className="app-shell" style={{ ["--sidebar-w"]: `${sidebarWidth}px` } as CSSProperties}>
      {/* Update-available banner — a newer release than the running app. */}
      {update && !updateDismissed && (
        <div className="update-banner" role="status">
          <span className="update-banner__text">
            GTM Grid <strong>v{update.version}</strong> is available.
            {updateError ? ` ${updateError}` : ""}
          </span>
          <button
            className="btn btn--primary btn-sm"
            disabled={updating}
            onClick={() => void runUpdate()}
          >
            {updating ? "Updating…" : "Update & restart"}
          </button>
          {!updating && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setUpdateDismissed(true)}
            >
              Later
            </button>
          )}
        </div>
      )}

      {/* Workspace-invite accept banner (email-matched + ?invite= URL token).
          Self-gates: renders nothing when signed out / no pending invites. */}
      <PendingInvites onAccepted={onInviteAccepted} />
      {showTrialBanner && trialDaysLeft != null && (
        <div
          className={`trial-banner${trialDaysLeft <= 2 ? " trial-banner--urgent" : ""}`}
          role="status"
        >
          <span className="trial-banner__text">
            {trialDaysLeft === 0
              ? "Your trial ends today — add a card to keep cloud sync, realtime & shared credentials."
              : `Your trial ends in ${trialDaysLeft} day${trialDaysLeft === 1 ? "" : "s"} — add a card to keep your cloud features.`}
          </span>
          <button
            className="btn btn--primary btn-sm"
            onClick={() => setShowUpgrade(true)}
          >
            Upgrade now
          </button>
        </div>
      )}
      {/* Auto-sync nudge (TRI-3298) — clones the .trial-banner pattern. Shown to
          eligible cloud users while auto-sync is still OFF; dismissible and stays
          dismissed across sessions. Enabling routes through the same enable-time
          overwrite confirm as the settings toggle. */}
      {showAutoSyncNudge && (
        <div className="trial-banner auto-sync-nudge" role="status">
          <span className="trial-banner__text">
            Keep your local tables backed up — turn on auto-sync to push them to
            the cloud automatically. Your local version always overwrites the cloud copy.
          </span>
          <button
            className="btn btn--primary btn-sm"
            onClick={() => setAutoSyncEnableConfirm(true)}
          >
            Turn on auto-sync
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={dismissAutoSyncNudge}
          >
            Dismiss
          </button>
        </div>
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
              {inCloud ? cloudProject!.name : projectName}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
            </span>
          </button>
          <span className="sidebar-head-spacer" />
          {activeWorkspace && (
            <button className="sidebar-members" onClick={() => setShowWorkspaceSettings(true)} title="Workspace members & seats">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            </button>
          )}
        </div>

        <div className="sidebar-scroll">
          {/* Cloud tables section — shown only while a cloud project is open. */}
          {inCloud && (
            <div className="sidebar-section">
              <div className="sidebar-section-label">
                Tables (cloud){cloudLocked ? " 🔒" : ""}
                <button
                  title={cloudLocked ? "Upgrade to add cloud tables" : "New cloud table"}
                  disabled={cloudCreating || cloudLocked}
                  onClick={() => setShowNewTableChooser(true)}
                >
                  <Icon.Plus />
                </button>
              </div>
              {cloudTables === undefined ? (
                <div className="skeleton-row">
                  <div className="shimmer skeleton-bar" style={{ width: "65%", height: 13 }} />
                </div>
              ) : cloudTables.length === 0 ? (
                <div style={{ padding: "4px 16px", fontSize: 12, color: "var(--text-3)" }}>No tables yet</div>
              ) : (
                cloudTables.map((t) => (
                  <div
                    key={t._id}
                    className={`sidebar-item${t._id === cloudTableId && !cloudLocked ? " active" : ""}`}
                    style={cloudLocked ? { opacity: 0.6 } : undefined}
                    title={cloudLocked ? "Upgrade to unlock cloud tables" : undefined}
                    onClick={() =>
                      cloudLocked
                        ? setShowUpgrade(true)
                        : (setCloudTableId(t._id), setView({ kind: "table" }))
                    }
                  >
                    <span className="sidebar-item-icon">
                      {cloudLocked ? "🔒" : <Icon.Table />}
                    </span>
                    <span className="sidebar-item-name">{t.name}</span>
                    {!cloudLocked && (
                      <button
                        className="sidebar-item-del"
                        title="Delete table"
                        onClick={(e) => { e.stopPropagation(); setConfirmDeleteCloudTable({ _id: t._id, name: t.name }); }}
                      >
                        <Icon.Trash />
                      </button>
                    )}
                  </div>
                ))
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
                    onClick={() => setShowNewTableChooser(true)}
                  >
                    <span className="sidebar-item-icon" style={{ color: "var(--accent)" }}><Icon.Plus /></span>
                    <span className="sidebar-item-name" style={{ color: "var(--accent)" }}>
                      {cloudCreating ? "Creating…" : "New table"}
                    </span>
                  </div>
                  <div className="sidebar-item" onClick={() => setImportMode("cloud")}>
                    <span className="sidebar-item-icon"><Icon.Table /></span>
                    <span className="sidebar-item-name">Import CSV…</span>
                  </div>
                </>
              )}
              {cloudCreateError && (
                <div
                  className="account-menu-error"
                  role="alert"
                  style={{ margin: "4px 16px" }}
                >
                  {cloudCreateError}
                </div>
              )}
            </div>
          )}

          {/* Tables section (local). Hidden while a cloud project is open UNLESS
              the user is a connected cloud user — then it stays visible so local
              tables can be pushed to the open cloud workspace (TRI-3297). */}
          {(!inCloud || showSyncUi) && <>
          <div className="sidebar-section">
            <div className="sidebar-section-label">
              <span className="sidebar-label-text">Tables</span>
              <span className="sidebar-label-actions">
                {showSyncUi && (
                  <button
                    className={`sync-all-btn${syncPending ? " has-pending" : ""}`}
                    title={syncPending ? `Sync ${syncPending} table${syncPending > 1 ? "s" : ""}` : "All tables synced"}
                    disabled={pushingTableId !== null}
                    onClick={onSyncAll}
                  >
                    {pushingTableId !== null ? <span className="cell-spinner" /> : <Icon.CloudUp size={13} />}
                    {syncPending ? <span className="sync-all-count">{syncPending}</span> : null}
                  </button>
                )}
                <button onClick={() => setShowNewTableChooser(true)} title="New table">
                  <Icon.Plus />
                </button>
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
            {tables.length === 0 ? (
              <div style={{ padding: "4px 16px", fontSize: 12, color: "var(--text-3)" }}>No tables yet</div>
            ) : [...tables].sort((a, b) => Number(b.favorite) - Number(a.favorite)).map(t => (
              renamingTableId === t.id ? (
                <div key={t.id} className="sidebar-item" style={{ paddingTop: 2, paddingBottom: 2 }}>
                  <span className="sidebar-item-icon"><Icon.Table /></span>
                  <input
                    className="sidebar-rename-input"
                    value={renameDraft}
                    autoFocus
                    onChange={e => setRenameDraft(e.target.value)}
                    onBlur={() => commitRename(t.id, renameDraft)}
                    onKeyDown={e => {
                      if (e.key === "Enter") commitRename(t.id, renameDraft);
                      if (e.key === "Escape") setRenamingTableId(null);
                    }}
                  />
                </div>
              ) : (
              <div
                key={t.id}
                className={`sidebar-item${t.id === selectedTableId && view.kind === "table" ? " active" : ""}`}
                onClick={() => { setSelectedTableId(t.id); setView({ kind: "table" }); }}
                onContextMenu={e => openCtx(e, tableMenuItems(t))}
              >
                <span className="sidebar-item-icon"><Icon.Table /></span>
                <span className="sidebar-item-name">{t.name}</span>
                {t.favorite && <span className="sidebar-item-star"><Icon.Star filled /></span>}
                <button
                  className="sidebar-item-del"
                  title="Delete table"
                  onClick={e => { e.stopPropagation(); setConfirmDeleteTable(t); }}
                >
                  <Icon.Trash />
                </button>
                <button
                  className="sidebar-item-more"
                  title="Table options"
                  onClick={e => { e.stopPropagation(); openCtx(e, tableMenuItems(t)); }}
                >
                  <Icon.More />
                </button>
                {showSyncUi ? (
                  <button
                    className={`row-sync is-${syncStatusFor(t.id)}`}
                    title={SYNC_META[syncStatusFor(t.id)].label}
                    onClick={e => {
                      e.stopPropagation();
                      const top = (e.currentTarget.closest(".sidebar-item") as HTMLElement | null)?.getBoundingClientRect().top ?? 80;
                      setSyncPopover({ tableId: t.id, anchorTop: top });
                    }}
                  >
                    <SyncDot status={syncStatusFor(t.id)} />
                  </button>
                ) : (
                  <span className="sidebar-item-count">{t.rows}</span>
                )}
              </div>
              )
            ))}
            <div className="sidebar-item" style={{ marginTop: 2 }} onClick={() => setShowNewTableChooser(true)}>
              <span className="sidebar-item-icon" style={{ color: "var(--accent)" }}><Icon.Plus /></span>
              <span className="sidebar-item-name" style={{ color: "var(--accent)" }}>New table</span>
            </div>
            <div className="sidebar-item" onClick={() => setImportMode("local")}>
              <span className="sidebar-item-icon"><Icon.Table /></span>
              <span className="sidebar-item-name">Import CSV…</span>
            </div>
          </div>
          </>}

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
            <CloudGrid tableId={cloudTableId} openWebhookToken={openWebhookToken} />
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

        {!importMode && !inCloud && view.kind === "table" && <>
        {/* Toolbar */}
        <div className="toolbar">
          {tableData ? (
            <>
              <span className="toolbar-title">{tableData.name}</span>
              <span className="toolbar-meta">{tableData.rows.length} rows · {tableData.columns.length} cols</span>
            </>
          ) : (
            <span className="toolbar-title" style={{ color: "var(--text-3)" }}>
              {selectedTableId ? "Loading…" : "No table selected"}
            </span>
          )}

          {tableData && (
            <button
              className="autorun-toggle"
              onClick={toggleAutoRun}
              title="Computed fields auto-run when inputs change"
            >
              <span className="autorun-label">Auto-run</span>
              <span className={`autorun-switch${autoRun ? " on" : ""}`}><span className="autorun-knob" /></span>
            </button>
          )}

          <div className="toolbar-spacer" />

          {runProgress && (
            <span className="run-progress">
              <span className="cell-spinner" style={{ width: 11, height: 11 }} />
              Running {runProgress.current}/{runProgress.total}
            </span>
          )}

          {tableData && (
            <>
              <button
                className="btn btn-outline btn-sm"
                onClick={addRow}
                disabled={!!runProgress}
              >
                <Icon.Plus size={11} /> Add row
              </button>
              <div className="toolbar-sep" />
              <button
                className="btn btn-primary btn-sm"
                onClick={runAll}
                disabled={!!runProgress || fnColCount === 0}
                title={fnColCount === 0 ? "No function columns to run" : `Run ${fnColCount} function column${fnColCount !== 1 ? "s" : ""}`}
              >
                <Icon.Play size={10} />
                {runProgress ? "Running…" : "Run"}
              </button>
            </>
          )}
        </div>

        {/* Grid / Empty state */}
        {!selectedTableId ? (
          <div className="empty-state">
            <div className="empty-icon"><Icon.Grid /></div>
            <div className="empty-title">No table selected</div>
            <p className="empty-sub">Create your first table to start building your GTM data grid.</p>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary" onClick={() => setShowNewTableChooser(true)}>
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
        ) : tableData && tableData.columns.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon"><Icon.Zap /></div>
            <div className="empty-title">No columns yet</div>
            <p className="empty-sub">Add columns to define your data structure. Use function columns to enrich rows automatically.</p>
            <button className="btn btn-primary" onClick={openAddCol}>
              <Icon.Plus /> Add first column
            </button>
          </div>
        ) : tableData && tableData.rows.length === 0 && warmingTableId === tableData.id ? (
          <div className="empty-state">
            <div className="cell-spinner" style={{ width: 22, height: 22, borderWidth: 2, marginBottom: 14 }} />
            <div className="empty-title">Pulling results from Trigify…</div>
            <p className="empty-sub">Trigify is scraping your signal — first results can take a few minutes. They'll appear here automatically, and keep updating on your schedule.</p>
          </div>
        ) : tableData ? (
          <div className="grid-wrap" ref={gridScrollRef}>
            <table
              className="grid-table"
              style={{ width: GUTTER_W + tableData.columns.reduce((s, c) => s + colW(c.id), 0) + ADD_COL_W }}
            >
              <thead>
                <tr>
                  {/* Row-number gutter — the ONLY gutter cell (reserved once) */}
                  <th className="grid-th row-num-th col-row-num" />
                  <GridColSpacer side="left" width={columnWindow.spacers.left} as="th" />
                  {columnWindow.virtualColumns.map(vc => {
                    const col = tableData.columns[vc.index];
                    return (
                    <th
                      key={col.id}
                      className="grid-th"
                      style={{ width: colW(col.id), minWidth: MIN_COL_W, maxWidth: MAX_COL_W }}
                      onContextMenu={(e) =>
                        openCtx(e, [{ label: `Delete column “${col.name}”`, danger: true, onClick: () => deleteColumn(col.id) }])
                      }
                    >
                      <div className="th-inner">
                        <span className="th-name">{col.name}</span>
                        {col.kind === "function" && col.fn && (
                          <span className="th-fn-badge" title={col.fn}>{col.fn.split(".").pop()}</span>
                        )}
                        {col.kind === "function" && (
                          <button
                            className="th-run-btn"
                            title={`Run ${col.name}`}
                            onClick={() => runColumn(col.id)}
                            disabled={runningColId === col.id || !!runProgress}
                          >
                            {runningColId === col.id
                              ? <span className="cell-spinner" />
                              : <Icon.Play size={9} />}
                          </button>
                        )}
                      </div>
                      <div
                        className="col-resize"
                        title="Drag to resize"
                        onMouseDown={e => {
                          e.preventDefault();
                          startResize(col.id, e.clientX, colW(col.id));
                        }}
                      />
                    </th>
                    );
                  })}
                  <GridColSpacer side="right" width={columnWindow.spacers.right} as="th" />
                  {/* Add column */}
                  <th className="grid-th add-col-th" style={{ width: ADD_COL_W }}>
                    <button className="add-col-btn" onClick={openAddCol} title="Add column">
                      <Icon.Plus size={16} />
                    </button>
                  </th>
                </tr>
              </thead>
              {tableData.rows.length === 0 ? (
                <tbody>
                  <tr>
                    <td className="grid-td row-num-td" />
                    <GridColSpacer side="left" width={columnWindow.spacers.left} />
                    {columnWindow.virtualColumns.map(vc => {
                      const col = tableData.columns[vc.index];
                      return (
                      <td key={col.id} className="grid-td">
                        <div className="cell-wrap"><span className="cell-empty">—</span></div>
                      </td>
                      );
                    })}
                    <GridColSpacer side="right" width={columnWindow.spacers.right} />
                    <td className="grid-td" />
                  </tr>
                </tbody>
              ) : (
                <VirtualGridBody
                  rows={tableData.rows}
                  scrollRef={gridScrollRef}
                  rowHeight={rowHeight}
                  colSpan={tableData.columns.length + 2}
                  columnWindow={columnWindow}
                  renderRow={(row, idx, cw) => (
                    <tr key={row.id} className="grid-tr">
                      <td
                        className="grid-td row-num-td"
                        onContextMenu={(e) => openCtx(e, [{ label: "Delete row", danger: true, onClick: () => deleteRow(row.id) }])}
                      >
                        {idx + 1}
                      </td>
                      <GridColSpacer side="left" width={cw.spacers.left} />
                      {cw.virtualColumns.map(vc => {
                        const col = tableData.columns[vc.index];
                        const cell: Cell | undefined = row.cells[col.id];
                        return (
                          <td
                            key={col.id}
                            className="grid-td"
                            onContextMenu={(e) =>
                              openCtx(e, [
                                { label: "Clear cell", onClick: () => clearCell(row.id, col.id) },
                                { label: "Delete row", danger: true, onClick: () => deleteRow(row.id) },
                              ])
                            }
                          >
                            <CellContent
                              cell={cell}
                              col={col}
                              onEdit={v => setCell(row.id, col.id, v)}
                              onOpenDetails={() =>
                                setDetail({
                                  columnName: col.name,
                                  value: cell?.value ?? (cell?.error ? { error: cell.error } : null),
                                })
                              }
                              onExpand={(anchor) =>
                                setExpandCell({
                                  rowId: row.id,
                                  colId: col.id,
                                  columnName: col.name,
                                  value: cell?.value != null ? String(cell.value) : "",
                                  editable: col.kind === "manual",
                                  anchor,
                                })
                              }
                              onRunCell={col.kind === "function" ? () => runCell(row.id, col.id) : undefined}
                              running={runningCells.has(`${row.id}:${col.id}`)}
                            />
                          </td>
                        );
                      })}
                      <GridColSpacer side="right" width={cw.spacers.right} />
                      <td className="grid-td" />
                    </tr>
                  )}
                />
              )}
            </table>
          </div>
        ) : null}
        </>}
      </div>

      {/* ── Agent panel (Claude Code / Codex) ─ */}
      <Suspense fallback={null}>
        <AgentPanel
          onGridChange={refreshAll}
          activeTable={activeTable}
          cloud={agentCloud}
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
            onAdded={() => loadTable(tableData.id)}
            onOpenAiSettings={() => {
              setShowFunctions(false);
              const target = aiProviders[0]?.id ?? "anthropic";
              setView({ kind: "ai", id: target });
            }}
          />
        </Suspense>
      )}

      {showNewTableChooser && (
        <NewTableChooser
          inCloud={inCloud}
          onClose={() => setShowNewTableChooser(false)}
          onBlank={() => {
            if (inCloud) void onCreateCloudTable();
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
          onClose={() => setShowNewTable(false)}
          onCreated={id => {
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
      {showSyncUi && syncPopover && (() => {
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
