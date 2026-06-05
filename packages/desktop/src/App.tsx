import { useState, useEffect, useCallback, useRef } from "react";
import { api, TableSummary, FullTable, Column, Cell, ConnectorInfo, ExtensionInfo } from "./api";
import AgentPanel from "./AgentPanel";
import "./styles.css";

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

function CellContent({ cell, col, onEdit }: {
  cell: Cell | undefined;
  col: Column;
  onEdit: (value: string) => void;
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
    return (
      <div className="cell-wrap" title={cell.error ?? undefined}>
        <span className="cell-error">{cell.error ?? "error"}</span>
      </div>
    );
  }

  // done / has value
  if (isObjectOrArray(cell.value)) {
    return (
      <div className="cell-wrap">
        <span className="cell-json-chip" title={JSON.stringify(cell.value, null, 2)}>
          {truncateJSON(cell.value)}
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

// ─── Add Column Modal ────────────────────────────────────

interface AddColModalProps {
  tableId: string;
  connectors: ConnectorInfo[];
  onClose: () => void;
  onAdded: () => void;
}

function AddColModal({ tableId, connectors, onClose, onAdded }: AddColModalProps) {
  const [name, setName] = useState("");
  const [type, setType] = useState("text");
  const [mode, setMode] = useState<"manual" | "function">("manual");
  const [fnKey, setFnKey] = useState("");
  const [params, setParams] = useState<{ k: string; v: string }[]>([{ k: "", v: "" }]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const allMethods = connectors.flatMap(c =>
    c.methods.map(m => ({ key: `${c.provider}.${m.method}`, label: `${c.name} · ${m.label}`, description: m.description }))
  );

  const handleSubmit = async () => {
    if (!name.trim()) { setErr("Column name is required"); return; }
    if (mode === "function" && !fnKey) { setErr("Select a function"); return; }
    setSaving(true);
    setErr("");
    try {
      const paramObj: Record<string, unknown> = {};
      params.forEach(({ k, v }) => { if (k.trim()) paramObj[k.trim()] = v; });
      await api.addColumn(tableId, {
        name: name.trim(),
        type,
        fn: mode === "function" ? fnKey : undefined,
        params: mode === "function" ? paramObj : undefined,
      });
      onAdded();
      onClose();
    } catch (e: any) {
      setErr(e.message ?? "Failed to add column");
      setSaving(false);
    }
  };

  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <span className="modal-title">Add column</span>
          <button className="modal-close" onClick={onClose}><Icon.X /></button>
        </div>
        <div className="modal-body">
          <div className="form-row">
            <label className="form-label">Name</label>
            <input className="form-input" value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. Company name" autoFocus onKeyDown={e => e.key === "Enter" && handleSubmit()} />
          </div>
          <div className="form-row">
            <label className="form-label">Type</label>
            <select className="form-select" value={type} onChange={e => setType(e.target.value)}>
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="boolean">Boolean</option>
              <option value="date">Date</option>
              <option value="json">JSON</option>
            </select>
          </div>
          <div className="form-row">
            <label className="form-label">Source</label>
            <div className="toggle-group">
              <button className={`toggle-btn${mode === "manual" ? " active" : ""}`} onClick={() => setMode("manual")}>Manual</button>
              <button className={`toggle-btn${mode === "function" ? " active" : ""}`} onClick={() => setMode("function")}>Function</button>
            </div>
          </div>

          {mode === "function" && (
            <>
              <div className="form-row">
                <label className="form-label">Function</label>
                <select className="form-select" value={fnKey} onChange={e => setFnKey(e.target.value)}>
                  <option value="">— choose a function —</option>
                  {connectors.map(c => (
                    <optgroup key={c.provider} label={c.name}>
                      {c.methods.map(m => (
                        <option key={`${c.provider}.${m.method}`} value={`${c.provider}.${m.method}`}>
                          {m.label} — {m.description.slice(0, 48)}{m.description.length > 48 ? "…" : ""}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label className="form-label">Parameters</label>
                <div className="params-list">
                  {params.map((p, i) => (
                    <div key={i} className="param-row">
                      <input className="form-input" placeholder="key" value={p.k}
                        onChange={e => setParams(ps => ps.map((x, j) => j === i ? { ...x, k: e.target.value } : x))} />
                      <input className="form-input" placeholder="value or {{Column}}" value={p.v}
                        onChange={e => setParams(ps => ps.map((x, j) => j === i ? { ...x, v: e.target.value } : x))} />
                      <button className="param-del" onClick={() => setParams(ps => ps.filter((_, j) => j !== i))}>
                        <Icon.Trash />
                      </button>
                    </div>
                  ))}
                  <button className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }}
                    onClick={() => setParams(ps => [...ps, { k: "", v: "" }])}>
                    <Icon.Plus size={11} /> Add param
                  </button>
                </div>
                <p className="params-hint">
                  Use <code>{"{{Column Name}}"}</code> to reference values from other columns in the same row.
                </p>
              </div>
            </>
          )}

          {err && (
            <div style={{ color: "var(--danger)", fontSize: 12, background: "var(--danger-bg)", padding: "6px 10px", borderRadius: "var(--r-sm)" }}>
              {err}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={saving}>
            {saving ? "Adding…" : "Add column"}
          </button>
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

  // Connectors / extensions
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({});

  // Modals
  const [showAddCol, setShowAddCol] = useState(false);
  const [showNewTable, setShowNewTable] = useState(false);

  // Run state
  const [runProgress, setRunProgress] = useState<{ current: number; total: number } | null>(null);
  const [runningColId, setRunningColId] = useState<string | null>(null);

  // ── Boot ───────────────────────────────────

  useEffect(() => {
    Promise.all([api.health(), api.tables(), api.functions(), api.extensions()])
      .then(([h, t, f, e]) => {
        setHealthStatus("connected");
        setProjectName(h.project ?? "gtmgrid");
        setTables(t);
        setConnectors(f);
        setExtensions(e);
        if (t.length > 0) setSelectedTableId(t[0].id);
      })
      .catch(() => {
        setHealthStatus("offline");
        // still try to load tables without health
        Promise.all([api.tables(), api.functions(), api.extensions()])
          .then(([t, f, e]) => {
            setTables(t);
            setConnectors(f);
            setExtensions(e);
            if (t.length > 0) setSelectedTableId(t[0].id);
          })
          .catch(() => {});
      });
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

  // ─────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────

  const fnColCount = tableData?.columns.filter(c => c.kind === "function").length ?? 0;

  return (
    <div className="app">
      {/* ── Sidebar ─────────────────────── */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <Icon.Grid />
          </div>
          <span className="sidebar-project">{projectName}</span>
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
            ) : tables.map(t => (
              <div
                key={t.id}
                className={`sidebar-item${t.id === selectedTableId ? " active" : ""}`}
                onClick={() => setSelectedTableId(t.id)}
              >
                <span className="sidebar-item-icon"><Icon.Table /></span>
                <span className="sidebar-item-name">{t.name}</span>
                <span className="sidebar-item-count">{t.rows}</span>
              </div>
            ))}
            <div className="sidebar-item" style={{ marginTop: 2 }} onClick={() => setShowNewTable(true)}>
              <span className="sidebar-item-icon" style={{ color: "var(--accent)" }}><Icon.Plus /></span>
              <span className="sidebar-item-name" style={{ color: "var(--accent)" }}>New table</span>
            </div>
          </div>

          {/* Functions section */}
          <div className="sidebar-section">
            <div className="sidebar-section-label">
              <span>Functions</span>
            </div>
            {connectors.length === 0 ? (
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
            ))}
          </div>

          {/* Extensions section */}
          <div className="sidebar-section">
            <div className="sidebar-section-label">Extensions</div>
            {extensions.length === 0 ? (
              <div className="skeleton-row">
                <div className="shimmer skeleton-bar" style={{ width: "70%", height: 13 }} />
              </div>
            ) : extensions.map(e => (
              <div key={e.id} className="ext-item">
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {e.name}
                </span>
                <span className={`ext-badge ${e.connected ? "connected" : "no-key"}`}>
                  {e.connected ? "connected" : "no key"}
                </span>
              </div>
            ))}
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
            <button className="btn btn-primary" onClick={() => setShowAddCol(true)}>
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
                    <th key={col.id} className="grid-th" style={{ width: "var(--col-w)", minWidth: "var(--col-w-sm)" }}>
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
                    </th>
                  ))}
                  {/* Add column */}
                  <th className="grid-th add-col-th">
                    <button className="add-col-btn" onClick={() => setShowAddCol(true)} title="Add column">
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
                    <td className="grid-td row-num-td">{idx + 1}</td>
                    {tableData.columns.map(col => {
                      const cell: Cell | undefined = row.cells[col.id];
                      return (
                        <td key={col.id} className="grid-td">
                          <CellContent
                            cell={cell}
                            col={col}
                            onEdit={v => setCell(row.id, col.id, v)}
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
      </div>

      {/* ── Agent panel (Claude Code / Codex) ─ */}
      <AgentPanel onGridChange={refreshAll} />

      {/* ── Modals ──────────────────────── */}
      {showAddCol && tableData && (
        <AddColModal
          tableId={tableData.id}
          connectors={connectors}
          onClose={() => setShowAddCol(false)}
          onAdded={() => loadTable(tableData.id)}
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
