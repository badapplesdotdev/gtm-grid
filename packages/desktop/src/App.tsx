import { useState, useEffect, useCallback, useRef } from "react";
import { api, TableSummary, FullTable, Column, Cell, ConnectorInfo, ExtensionInfo, AiProviderInfo } from "./api";
import AgentPanel from "./AgentPanel";
import { LogoMark } from "./Logo";
import CellDetails, { extractCode } from "./CellDetails";
import { ExtensionPanel, AiProviderPanel, ExtensionsBrowse, BrandIcon } from "./Panels";
import { AddColumnPopover, FunctionsModal } from "./AddColumn";
import "./styles.css";

// What the main area is showing.
type View =
  | { kind: "table" }
  | { kind: "extensions" }
  | { kind: "extension"; id: string }
  | { kind: "ai"; id: string };

// ─── Icons (inline SVG, no deps) ─────────────────────────

const Icon = {
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

function truncateJSON(val: unknown): string {
  const s = JSON.stringify(val);
  return s.length > 60 ? s.slice(0, 58) + "…" : s;
}

function isObjectOrArray(val: unknown): boolean {
  return val !== null && typeof val === "object";
}

// ─── Cell renderer ───────────────────────────────────────

function CellContent({ cell, col, onEdit, onOpenDetails }: {
  cell: Cell | undefined;
  col: Column;
  onEdit: (value: string) => void;
  onOpenDetails?: () => void;
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

  if (!cell || cell.status === "empty" || cell.status === "pending") {
    if (col.kind === "function") {
      return <div className="cell-wrap"><span className="cell-empty">—</span></div>;
    }
    return <div className="cell-wrap cell-editable" onClick={startEdit}><span className="cell-empty">empty</span></div>;
  }

  if (cell.status === "running") {
    return (
      <div className="cell-wrap">
        <span className="cell-running">
          <span className="cell-spinner"/>
          running
        </span>
      </div>
    );
  }

  if (cell.status === "error") {
    const code = cell.error?.match(/\b(\d{3})\b/)?.[1];
    return (
      <div className="cell-wrap" title={cell.error ?? "error"}>
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

  // Open the add-column popover anchored just below the clicked "+" button.
  const openAddCol = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setAddColAnchor({ left: r.left, top: r.bottom });
    setShowAddCol(true);
  };

  // Run state
  const [runProgress, setRunProgress] = useState<{ current: number; total: number } | null>(null);
  const [runningColId, setRunningColId] = useState<string | null>(null);

  // Cell details drawer + column widths (resize)
  const [detail, setDetail] = useState<{ columnName: string; value: unknown } | null>(null);
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem("gtmgrid:colWidths") || "{}");
    } catch {
      return {};
    }
  });
  const setColWidth = useCallback((colId: string, w: number) => {
    setColWidths((prev) => {
      const next = { ...prev, [colId]: Math.max(80, Math.round(w)) };
      try {
        localStorage.setItem("gtmgrid:colWidths", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

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

  const deleteTable = async (id: string) => {
    if (!window.confirm("Delete this table? This removes all of its columns and rows.")) return;
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
    { label: "Delete", danger: true, onClick: () => deleteTable(t.id) },
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
    if (selectedTableId) {
      const updated = await api.table(selectedTableId);
      setTableData(updated);
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

  return (
    <div className="app">
      {/* ── Sidebar ─────────────────────── */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <LogoMark size={26} />
          <div className="sidebar-brand">
            <span className="brand-name">gtm grid</span>
            <span className="sidebar-project">{projectName}</span>
          </div>
        </div>

        <div className="sidebar-scroll">
          {/* Tables section */}
          <div className="sidebar-section">
            <div className="sidebar-section-label">
              Tables
              <button onClick={() => setShowNewTable(true)} title="New table">
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
            <div className="sidebar-item" style={{ marginTop: 2 }} onClick={() => setShowNewTable(true)}>
              <span className="sidebar-item-icon" style={{ color: "var(--accent)" }}><Icon.Plus /></span>
              <span className="sidebar-item-name" style={{ color: "var(--accent)" }}>New table</span>
            </div>
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

        {/* Footer */}
        <div className="sidebar-footer">
          <span className={`status-dot ${healthStatus}`} />
          {healthStatus === "loading" && "Connecting…"}
          {healthStatus === "connected" && "Server online"}
          {healthStatus === "offline" && "Server offline"}
        </div>
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

        {/* Extensions gallery + detail panels */}
        {view.kind === "extensions" && (
          <ExtensionsBrowse
            extensions={extensions}
            onOpen={(id) => setView({ kind: "extension", id })}
          />
        )}
        {view.kind === "extension" && (
          <ExtensionPanel
            id={view.id}
            onConnected={refreshConnections}
            onBack={() => setView({ kind: "extensions" })}
          />
        )}
        {view.kind === "ai" && (() => {
          const p = aiProviders.find(x => x.id === view.id);
          return p ? <AiProviderPanel provider={p} onConnected={refreshConnections} /> : null;
        })()}

        {view.kind === "table" && <>
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
            <button className="btn btn-primary" onClick={() => setShowNewTable(true)}>
              <Icon.Plus /> Create table
            </button>
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
            <table className="grid-table">
              <thead>
                <tr>
                  {/* Row-number gutter */}
                  <th className="grid-th row-num-th col-row-num" />
                  {tableData.columns.map(col => (
                    <th
                      key={col.id}
                      className="grid-th"
                      style={{ width: colWidths[col.id] ?? 180, minWidth: 80 }}
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
                          startResize(col.id, e.clientX, colWidths[col.id] ?? 180);
                        }}
                      />
                    </th>
                  ))}
                  {/* Add column */}
                  <th className="grid-th add-col-th">
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

      {/* ── Modals ──────────────────────── */}
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
    </div>
  );
}
