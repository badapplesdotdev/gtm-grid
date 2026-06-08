import { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { api, TableSummary, FullTable, Column, Cell, ConnectorInfo, ExtensionInfo, AiProviderInfo } from "./api";
import AgentPanel from "./AgentPanel";
import { LogoMark } from "./Logo";
import { AppLoader } from "./AppLoader";
import CellDetails, { extractCode } from "./CellDetails";
import { ExtensionPanel, AiProviderPanel, ExtensionsBrowse, BrandIcon } from "./Panels";
import { AddColumnPopover, FunctionsModal } from "./AddColumn";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { AccountBar } from "./cloud/AccountBar";
import { PendingInvites } from "./cloud/PendingInvites";
import { WorkspaceSettings } from "./cloud/WorkspaceSettings";
import { OnboardingFlow } from "./cloud/onboarding/OnboardingFlow";
import { cloudEnabled, syncWorkspacePlan } from "./cloud/client";
import { CloudGrid } from "./cloud/CloudGrid";
import { useMe, useActiveWorkspace, useAuthState } from "./cloud/auth";
import { useWorkspaceCredentials } from "./cloud/useWorkspaceCredentials";
import {
  useCloudProjects,
  useCloudTables,
  useCloudProjectMutations,
  useCloudGridMutations,
  type CloudProject,
} from "./cloud/useCloudGrid";
import { ImportCsvModal } from "./ImportCsvModal";
import type { ImportWriter } from "./csvImport";
import type { Id } from "./cloud/ids";
import "./styles.css";

// What the main area is showing.
type View =
  | { kind: "table" }
  | { kind: "extensions" }
  | { kind: "extension"; id: string }
  | { kind: "ai"; id: string };

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

// Persisted id of the last cloud project the user had open, so a relaunch
// reopens it (default-to-cloud for signed-in users).
const LAST_CLOUD_PROJECT_KEY = "gtmgrid:lastCloudProject";

// True if any of a function column's params reference {{columnName}}.
function columnDependsOn(col: Column, columnName: string): boolean {
  const re = new RegExp(`\\{\\{\\s*${columnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}`);
  return Object.values(col.params ?? {}).some((v) => typeof v === "string" && re.test(v));
}

// ─── Cell renderer ───────────────────────────────────────

const ExpandIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
    <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
  </svg>
);

export function CellContent({ cell, col, onEdit, onOpenDetails, onExpand, onRunCell, running }: {
  cell: Cell | undefined;
  col: Column;
  onEdit: (value: string) => void;
  onOpenDetails?: () => void;
  onExpand?: (anchor: { left: number; top: number; width: number }) => void;
  onRunCell?: () => void;
  running?: boolean;
}) {
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
}: {
  inCloud: boolean;
  onClose: () => void;
  onBlank: () => void;
  onCsv: () => void;
  onWebhook: () => void;
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
  const [aiProviders, setAiProviders] = useState<AiProviderInfo[]>([]);
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({});
  const [fnSectionOpen, setFnSectionOpen] = useState(false); // Functions section: collapsed by default
  const [aiSectionOpen, setAiSectionOpen] = useState(true);
  const [extSectionOpen, setExtSectionOpen] = useState(true);

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
  const { activeWorkspace, setActiveWorkspaceId } = useActiveWorkspace(me ?? null);

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
  useEffect(() => {
    if (!cloudEnabled || !isAuthenticated || me == null) return;
    if (me.workspaces.length > 0) return;
    if (autoStartedRef.current || onboarding !== null) return;
    autoStartedRef.current = true;
    setOnboarding({ initialScreen: "workspace", hasSession: true });
  }, [isAuthenticated, me, onboarding]);
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
  // Cloud create (project/table) UX: a busy flag to disable the trigger while the
  // mutation is in flight, and a surfaced error so a failed create never hangs
  // silently. Both are cleared on the next attempt / success.
  const [cloudCreating, setCloudCreating] = useState(false);
  const [cloudCreateError, setCloudCreateError] = useState<string | null>(null);
  // Whether the app is currently viewing a cloud project (vs. local).
  const inCloud = cloudProject !== null;

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
    if (!cloudProjects || cloudProjects.length === 0) return;
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
  }, [activeWorkspaceId, cloudProjects, cloudProject]);

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
        const [h, t, f, e, ai] = await Promise.all([
          api.health(),
          api.tables(),
          api.functions(),
          api.extensions(),
          api.aiProviders(),
        ]);
        if (cancelled) return;
        setHealthStatus("connected");
        setProjectName(h.project ?? "gtmgrid");
        setTables(t);
        setConnectors(f);
        setExtensions(e);
        setAiProviders(ai);
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
    const fnCols = tableData.columns.filter(c => c.kind === "function");
    if (!fnCols.length) return;
    setRunProgress({ current: 0, total: fnCols.length });
    for (let i = 0; i < fnCols.length; i++) {
      setRunProgress({ current: i + 1, total: fnCols.length });
      try { await api.runColumn(fnCols[i].id); } catch { /* continue */ }
    }
    setRunProgress(null);
    await loadTable(tableData.id);
  };

  // ── Run single column ──────────────────────

  const runColumn = async (colId: string) => {
    setRunningColId(colId);
    try { await api.runColumn(colId); } catch { /* ignore */ }
    setRunningColId(null);
    if (selectedTableId) await loadTable(selectedTableId);
  };

  // ── Run a single cell (this row × this function column) ──
  const runCell = async (rowId: string, colId: string) => {
    const key = `${rowId}:${colId}`;
    setRunningCells(s => new Set(s).add(key));
    try { await api.runColumn(colId, { force: true, rowIds: [rowId] }); } catch { /* ignore */ }
    if (selectedTableId) {
      const updated = await api.table(selectedTableId);
      setTableData(updated);
    }
    setRunningCells(s => { const n = new Set(s); n.delete(key); return n; });
  };

  // ── Add row ────────────────────────────────

  const addRow = async () => {
    if (!tableData) return;
    await api.addRow(tableData.id);
    await loadTable(tableData.id);
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
            await api.runColumn(dc.id, { force: true, rowIds: [rowId] }).catch(() => {});
          }
          updated = await api.table(selectedTableId);
          setTableData(updated);
        }
      }
    }
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
  if (cloudEnabled && !localMode && authLoading) {
    return <AppLoader inShell label="Signing you in…" />;
  }
  if (cloudEnabled && !localMode && !isAuthenticated) {
    return (
      <OnboardingFlow
        forced
        initialScreen="signin"
        hasSession={false}
        onClose={continueLocally}
        onDone={() => {}}
      />
    );
  }

  return (
    <div className="app-shell" style={{ ["--sidebar-w"]: `${sidebarWidth}px` } as CSSProperties}>
      {/* Workspace-invite accept banner (email-matched + ?invite= URL token).
          Self-gates: renders nothing when signed out / no pending invites. */}
      <PendingInvites onAccepted={setActiveWorkspaceId} />
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
                Tables (cloud)
                <button
                  title="New cloud table"
                  disabled={cloudCreating}
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
                    className={`sidebar-item${t._id === cloudTableId ? " active" : ""}`}
                    onClick={() => setCloudTableId(t._id)}
                  >
                    <span className="sidebar-item-icon"><Icon.Table /></span>
                    <span className="sidebar-item-name">{t.name}</span>
                    <button
                      className="sidebar-item-del"
                      title="Delete table"
                      onClick={(e) => { e.stopPropagation(); setConfirmDeleteCloudTable({ _id: t._id, name: t.name }); }}
                    >
                      <Icon.Trash />
                    </button>
                  </div>
                ))
              )}
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

          {/* Tables section (local) — hidden while a cloud project is open. */}
          {!inCloud && <>
          <div className="sidebar-section">
            <div className="sidebar-section-label">
              Tables
              <button onClick={() => setShowNewTableChooser(true)} title="New table">
                <Icon.Plus />
              </button>
            </div>
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
                <span className="sidebar-item-count">{t.rows}</span>
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

          {/* Extensions section — collapsible, with Browse all in the header */}
          <div className="sidebar-section">
            <div className="sidebar-section-label clickable" onClick={() => setExtSectionOpen(o => !o)}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className={`connector-group-toggle${extSectionOpen ? " open" : ""}`}>
                  <Icon.ChevronRight />
                </span>
                Extensions
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
            ) : extensions.map(e => (
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
            )))}
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
            ) : connectors.map(c => (
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
            )))}
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
        )}
        {importMode === "cloud" && cloudImportWriter && (
          <ImportCsvModal
            inline
            writer={cloudImportWriter}
            onClose={() => setImportMode(null)}
            onOpenTable={id => {
              setCloudTableId(id as Id<"tables">);
              setImportMode(null);
            }}
          />
        )}

        {/* Cloud project: the LIVE multiplayer grid (Convex). Replaces the local
            sidecar grid entirely while a cloud project is open. Hidden while a
            CSV import is open in this pane. */}
        {!importMode && inCloud && <CloudGrid tableId={cloudTableId} openWebhookToken={openWebhookToken} />}

        {/* Extensions gallery + detail panels */}
        {!importMode && !inCloud && view.kind === "extensions" && (
          <ExtensionsBrowse
            extensions={extensions}
            onOpen={(id) => setView({ kind: "extension", id })}
          />
        )}
        {!importMode && !inCloud && view.kind === "extension" && (
          <ExtensionPanel
            id={view.id}
            onConnected={refreshConnections}
            onBack={() => setView({ kind: "extensions" })}
            workspaceCreds={workspaceCreds}
          />
        )}
        {!importMode && !inCloud && view.kind === "ai" && (() => {
          const p = aiProviders.find(x => x.id === view.id);
          return p ? <AiProviderPanel provider={p} onConnected={refreshConnections} workspaceCreds={workspaceCreds} /> : null;
        })()}

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
        ) : tableData ? (
          <div className="grid-wrap">
            <table
              className="grid-table"
              style={{ width: GUTTER_W + tableData.columns.reduce((s, c) => s + colW(c.id), 0) + ADD_COL_W }}
            >
              <thead>
                <tr>
                  {/* Row-number gutter */}
                  <th className="grid-th row-num-th col-row-num" />
                  {tableData.columns.map(col => (
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
                  ))}
                  {/* Add column */}
                  <th className="grid-th add-col-th" style={{ width: ADD_COL_W }}>
                    <button className="add-col-btn" onClick={openAddCol} title="Add column">
                      <Icon.Plus size={16} />
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tableData.rows.length === 0 ? (
                  <tr>
                    <td className="grid-td row-num-td" />
                    {tableData.columns.map(col => (
                      <td key={col.id} className="grid-td">
                        <div className="cell-wrap"><span className="cell-empty">—</span></div>
                      </td>
                    ))}
                    <td className="grid-td" />
                  </tr>
                ) : tableData.rows.map((row, idx) => (
                  <tr key={row.id} className="grid-tr">
                    <td
                      className="grid-td row-num-td"
                      onContextMenu={(e) => openCtx(e, [{ label: "Delete row", danger: true, onClick: () => deleteRow(row.id) }])}
                    >
                      {idx + 1}
                    </td>
                    {tableData.columns.map(col => {
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
                    <td className="grid-td" />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        </>}
      </div>

      {/* ── Agent panel (Claude Code / Codex) ─ */}
      <AgentPanel
        onGridChange={refreshAll}
        activeTable={tableData ? { name: tableData.name, columns: tableData.columns.map((c) => c.name) } : null}
      />

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
        <OnboardingFlow
          initialScreen={onboarding.initialScreen}
          hasSession={onboarding.hasSession}
          onClose={() => setOnboarding(null)}
          onDone={(workspaceId) => {
            if (workspaceId !== null) setActiveWorkspaceId(workspaceId);
            setOnboarding(null);
          }}
        />
      )}

      {/* ── Modals ──────────────────────── */}
      {showWorkspaceSettings && activeWorkspace && (
        <WorkspaceSettings
          workspaceId={activeWorkspace._id}
          workspaceName={activeWorkspace.name}
          onClose={() => setShowWorkspaceSettings(false)}
        />
      )}

      {showAddCol && tableData && (
        <AddColumnPopover
          tableId={tableData.id}
          anchor={addColAnchor}
          onClose={() => setShowAddCol(false)}
          onAdded={() => loadTable(tableData.id)}
          onUseFunction={() => { setShowAddCol(false); setShowFunctions(true); }}
        />
      )}

      {showFunctions && tableData && (
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
        />
      )}

      {showNewTable && (
        <NewTableModal
          onClose={() => setShowNewTable(false)}
          onCreated={id => {
            api.tables().then(t => {
              setTables(t);
              setSelectedTableId(id);
            });
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
