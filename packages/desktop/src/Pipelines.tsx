import type {
  PipelineGraph,
  PipelineGraphPatch,
  PipelineNode,
  PipelineNodeType,
} from "@gtmgrid/pipelines";
import { PIPELINE_RESULT_OUTPUT_KEY } from "@gtmgrid/pipelines/binding";
import { pipelineColumnVariables } from "@gtmgrid/pipelines/variables";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { api, type AiProviderInfo, type ConnectorInfo, type FunctionMethod } from "./api";
import { FunctionsModal, type FunctionChoice } from "./AddColumn";
import { categorize, FnIcon } from "./FnIcon";
import { ClaudeMark } from "./ClaudeMark";
import { apiClient } from "./cloud/client";
import { usePipeline, usePipelineMutations, usePipelineRun, usePipelineRuns, usePipelines } from "./cloud/usePipelines";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog";

const NODE_W = 88;
const NODE_H = 82;
const CANVAS_W = 3200;
const CANVAS_H = 1800;

const nodeMeta: Record<PipelineNodeType, { label: string; glyph: string; tone: string }> = {
  input: { label: "Trigger", glyph: "▶", tone: "slate" },
  tool: { label: "Tool", glyph: "↗", tone: "blue" },
  ai: { label: "AI", glyph: "✦", tone: "violet" },
  formula: { label: "Formula", glyph: "ƒ", tone: "amber" },
  http: { label: "HTTP", glyph: "⇄", tone: "cyan" },
  code: { label: "Code", glyph: "{ }", tone: "green" },
  condition: { label: "IF", glyph: "IF", tone: "green" },
  output: { label: "Output", glyph: "OUT", tone: "slate" },
  pipeline: { label: "Pipeline", glyph: "⌘", tone: "indigo" },
};

function PipelineNodeIcon({ node, connectors, providers, size = 26 }: {
  node: PipelineNode;
  connectors: readonly ConnectorInfo[];
  providers: readonly AiProviderInfo[];
  size?: number;
}) {
  if (node.type === "ai") {
    const provider = providers.find((candidate) => candidate.id === node.config.provider);
    if (provider && (provider.id.toLowerCase() === "anthropic" || provider.name.toLowerCase() === "anthropic")) {
      return <ClaudeMark size={size} />;
    }
    if (provider) return <FnIcon fn={{ logo: provider.logo, providerName: provider.name, category: "AI" }} size={size} />;
  }
  if (node.type === "tool") {
    const connector = connectors.find((candidate) => candidate.provider === node.config.provider);
    const method = connector?.methods.find((candidate) => candidate.method === node.config.method);
    if (connector) return <FnIcon fn={{ logo: connector.logo ?? null, providerName: connector.name, category: categorize(connector.provider, method?.category) }} size={size} />;
  }
  return <>{nodeMeta[node.type].glyph}</>;
}

function PipelineMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="5" cy="6" r="2.3" /><circle cx="19" cy="6" r="2.3" /><circle cx="12" cy="18" r="2.3" />
      <path d="M7.3 6h9.4M6.3 8l4.4 7.8M17.7 8l-4.4 7.8" />
    </svg>
  );
}

type PipelineListItem = {
  id: string;
  name: string;
  description: string | null;
  updatedAt: number;
};

type PipelineBinding = {
  id: string;
  versionId: string;
  tableId: string;
  inputMapping: Readonly<Record<string, string>>;
  outputMapping: Readonly<Record<string, string>>;
  executionTarget: "local" | "cloud";
  autoRun: boolean;
  enabled: boolean;
};

type TableVariable = {
  columnId: string;
  name: string;
  type: string;
  key: string;
  token: string;
};

export function PipelineSidebar({
  projectId,
  activeId,
  onBrowse,
  onOpen,
  onDeleted,
}: {
  projectId: string | null;
  activeId: string | null;
  onBrowse: () => void;
  onOpen: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  const { data, isLoading } = usePipelines(projectId);
  const mutations = usePipelineMutations(projectId);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const confirmDelete = async () => {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await mutations.remove(pendingDelete.id);
      const deletedId = pendingDelete.id;
      setPendingDelete(null);
      onDeleted(deletedId);
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDeleting(false);
    }
  };
  return (
    <div className="sidebar-section pipeline-sidebar-section">
      <div className="sidebar-section-label">
        <span className="sidebar-label-text">Pipelines</span>
        <button className="section-link" onClick={onBrowse}>Browse all</button>
      </div>
      {isLoading ? (
        <div className="skeleton-row"><div className="shimmer skeleton-bar" style={{ width: "62%", height: 13 }} /></div>
      ) : data && data.length > 0 ? (
        data.slice(0, 6).map((pipeline) => (
          <div key={pipeline.id} className={`sidebar-item${activeId === pipeline.id ? " active" : ""}`} onClick={() => onOpen(pipeline.id)} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onOpen(pipeline.id); } }} role="button" tabIndex={0}>
            <span className="sidebar-item-icon"><PipelineMark size={14} /></span>
            <span className="sidebar-item-name">{pipeline.name}</span>
            <button className="sidebar-item-del" title={`Delete ${pipeline.name}`} aria-label={`Delete ${pipeline.name}`} onClick={(event) => { event.stopPropagation(); setDeleteError(null); setPendingDelete({ id: pipeline.id, name: pipeline.name }); }}><TrashIcon /></button>
          </div>
        ))
      ) : (
        <div className="sidebar-item" onClick={onBrowse} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onBrowse(); } }} role="button" tabIndex={0}><span className="sidebar-item-icon pipeline-sidebar-create">＋</span><span className="sidebar-item-name">New pipeline</span></div>
      )}
      {pendingDelete && <DeletePipelineDialog name={pendingDelete.name} deleting={deleting} error={deleteError} onCancel={() => { if (!deleting) setPendingDelete(null); }} onConfirm={() => void confirmDelete()} />}
    </div>
  );
}

export function PipelinesHub({
  projectId,
  attachTableId,
  onOpen,
}: {
  projectId: string | null;
  attachTableId?: string;
  onOpen: (id: string) => void;
}) {
  const { data, isLoading, error } = usePipelines(projectId);
  const mutations = usePipelineMutations(projectId);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const create = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const result = await mutations.create("Untitled pipeline");
      onOpen(result.pipeline.id);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="pipelines-hub">
      <header className="pipelines-hub-head">
        <div>
          <div className="pipelines-eyebrow"><PipelineMark size={14} /> AUTOMATION LAYER</div>
          <h1>Pipelines</h1>
          <p>Build reusable enrichment logic once, then attach it to any table.</p>
        </div>
        <button className="btn btn-primary" onClick={() => void create()} disabled={creating || !projectId}>
          <span>＋</span>{creating ? "Creating…" : "New pipeline"}
        </button>
      </header>

      {attachTableId && (
        <div className="pipeline-attach-banner">
          <span className="pipeline-pulse" />
          <div><strong>Attach an automation</strong><span>Choose a pipeline, confirm its column mappings, then run it from the table.</span></div>
        </div>
      )}
      {createError && <div className="pipeline-error">{createError}</div>}
      {error && <div className="pipeline-error">{error instanceof Error ? error.message : "Could not load pipelines."}</div>}

      <div className="pipeline-hub-tools">
        <div className="pipeline-search">⌕ <span>Search pipelines</span><kbd>⌘ K</kbd></div>
        <div className="pipeline-filter active">All</div>
        <div className="pipeline-filter">Drafts</div>
        <div className="pipeline-filter">Deployed</div>
      </div>

      {isLoading ? (
        <div className="pipeline-card-grid">{[0, 1, 2].map((n) => <div key={n} className="pipeline-card pipeline-card-loading" />)}</div>
      ) : data && data.length > 0 ? (
        <div className="pipeline-card-grid">
          {(data as PipelineListItem[]).map((pipeline, index) => (
            <button key={pipeline.id} className="pipeline-card" onClick={() => onOpen(pipeline.id)}>
              <div className="pipeline-card-top">
                <span className={`pipeline-card-mark tone-${["blue", "amber", "green", "violet"][index % 4]}`}><PipelineMark size={18} /></span>
                <span className="pipeline-draft-pill"><i /> Draft</span>
              </div>
              <h3>{pipeline.name}</h3>
              <p>{pipeline.description || "A reusable record-processing pipeline ready to configure."}</p>
              <div className="pipeline-card-flow"><span>IN</span><b /><span>ƒ</span><b /><span>OUT</span></div>
              <footer><span>Edited {new Date(pipeline.updatedAt).toLocaleDateString()}</span><strong>{attachTableId ? "Configure attachment →" : "Open canvas →"}</strong></footer>
            </button>
          ))}
        </div>
      ) : (
        <button className="pipeline-empty-stage" onClick={() => void create()} disabled={creating || !projectId}>
          <span className="pipeline-empty-orbit"><PipelineMark size={28} /></span>
          <strong>Your automation layer starts here</strong>
          <span>Turn a repeated set of enrichments, decisions and outputs into a reusable pipeline.</span>
          <em>Build your first pipeline →</em>
        </button>
      )}
    </div>
  );
}

function edgePath(source: PipelineNode, target: PipelineNode, sourcePort?: string) {
  const x1 = source.position.x + NODE_W;
  const y1 = source.position.y + (sourcePort === "true" ? 25 : sourcePort === "false" ? 57 : NODE_H / 2);
  const x2 = target.position.x;
  const y2 = target.position.y + NODE_H / 2;
  const bend = Math.max(54, Math.abs(x2 - x1) * 0.48);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

function TrashIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" /></svg>;
}

type NodeExecutionStatus = "queued" | "running" | "succeeded" | "failed" | "skipped";

function NodeCard({ node, connectors, providers, selected, executionStatus, readOnly = false, zoom, onSelect, onOpen, onInsert, onRunTo, onRename, onDelete, onDrag, onDragEnd }: {
  node: PipelineNode;
  connectors: readonly ConnectorInfo[];
  providers: readonly AiProviderInfo[];
  selected: boolean;
  executionStatus?: NodeExecutionStatus;
  readOnly?: boolean;
  zoom: number;
  onSelect: () => void;
  onOpen: () => void;
  onInsert?: (anchor: { x: number; y: number }, sourcePort?: "true" | "false") => void;
  onRunTo: () => void;
  onRename?: (name: string) => Promise<void>;
  onDelete?: () => void;
  onDrag: (x: number, y: number) => void;
  onDragEnd: (x: number, y: number) => Promise<void>;
}) {
  const shellRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(node.name);
  useEffect(() => setDraftName(node.name), [node.name]);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const start = useRef<{ pointerX: number; pointerY: number; nodeX: number; nodeY: number } | null>(null);
  const activePointerId = useRef<number | null>(null);
  const meta = nodeMeta[node.type];
  const down = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (readOnly) { onSelect(); return; }
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointerId.current = event.pointerId;
    start.current = { pointerX: event.clientX, pointerY: event.clientY, nodeX: node.position.x, nodeY: node.position.y };
    onSelect();
  };
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (readOnly) return;
    if (!start.current || activePointerId.current !== event.pointerId) return;
    drag.current = {
      x: Math.max(24, start.current.nodeX + (event.clientX - start.current.pointerX) / zoom),
      y: Math.max(24, start.current.nodeY + (event.clientY - start.current.pointerY) / zoom),
    };
    if (shellRef.current) shellRef.current.style.transform = `translate3d(${drag.current.x}px, ${drag.current.y}px, 0)`;
    onDrag(drag.current.x, drag.current.y);
  };
  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (activePointerId.current !== event.pointerId) return;
    const finalPosition = drag.current;

    // Clear the interaction synchronously. Saving the new position can involve
    // a network round trip; keeping these refs live until that finishes makes
    // the node continue following later pointer events after it was dropped.
    start.current = null;
    drag.current = null;
    activePointerId.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (finalPosition) void onDragEnd(Math.round(finalPosition.x), Math.round(finalPosition.y));
  };
  const finishRename = async () => {
    const next = draftName.trim();
    setRenaming(false);
    if (next && next !== node.name && onRename) await onRename(next);
    else setDraftName(node.name);
  };
  return (
    <div ref={shellRef} className={`pipeline-node-shell tone-${meta.tone}${selected ? " selected" : ""}${executionStatus ? ` run-${executionStatus}` : ""}`} style={{ transform: `translate3d(${node.position.x}px, ${node.position.y}px, 0)` }} data-node-interactive data-run-status={executionStatus}>
      {selected && !readOnly && <div className="pipeline-node-toolbar" aria-label={`${node.name} actions`}>
        <button title="Test workflow" aria-label="Test workflow" onClick={(event) => { event.stopPropagation(); onRunTo(); }}>▶</button>
        {onRename && <button title="Rename node" aria-label="Rename node" onClick={(event) => { event.stopPropagation(); setDraftName(node.name); setRenaming(true); }}>✎</button>}
        <button title="Configure node" aria-label="Configure node" onClick={(event) => { event.stopPropagation(); onOpen(); }}>✦</button>
        {onDelete && <button className="danger" title="Delete node" aria-label="Delete node" onClick={(event) => { event.stopPropagation(); onDelete(); }}><TrashIcon /></button>}
        <button title="More node settings" aria-label="More node settings" onClick={(event) => { event.stopPropagation(); onOpen(); }}>•••</button>
      </div>}
      <button className="pipeline-node" onPointerDown={down} onPointerMove={move} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag} onClick={() => { onSelect(); if (readOnly) onOpen(); }} onDoubleClick={readOnly ? undefined : onOpen} title={readOnly ? "Click to inspect this execution" : "Double-click to configure"}>
        <span className="pipeline-node-port in" />
        <span className="pipeline-node-glyph"><PipelineNodeIcon node={node} connectors={connectors} providers={providers} /></span>
        <span className="pipeline-node-arrow">↗</span>
        {node.type === "condition" ? <><span className="pipeline-node-port true" /><span className="pipeline-branch-label true">true</span><span className="pipeline-node-port false" /><span className="pipeline-branch-label false">false</span></> : <span className="pipeline-node-port out" />}
      </button>
      {renaming ? <input className="pipeline-node-title-input" value={draftName} autoFocus onChange={(event) => setDraftName(event.target.value)} onBlur={() => void finishRename()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void finishRename(); } else if (event.key === "Escape") { event.preventDefault(); setDraftName(node.name); setRenaming(false); } }} onClick={(event) => event.stopPropagation()} /> : <strong className="pipeline-node-title" onDoubleClick={(event) => { if (!readOnly && onRename) { event.stopPropagation(); setDraftName(node.name); setRenaming(true); } }}>{node.name}</strong>}
      <small className="pipeline-node-kind">{meta.label}</small>
      {onInsert && (node.type === "condition" ? <>
        <button className="pipeline-node-add branch true" title="Add to true branch" onClick={(event) => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); onInsert({ x: rect.right, y: rect.top + rect.height / 2 }, "true"); }}>＋</button>
        <button className="pipeline-node-add branch false" title="Add to false branch" onClick={(event) => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); onInsert({ x: rect.right, y: rect.top + rect.height / 2 }, "false"); }}>＋</button>
      </> : <button className="pipeline-node-add" title={`Add after ${node.name}`} onClick={(event) => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); onInsert({ x: rect.right, y: rect.top + rect.height / 2 }); }}>＋</button>)}
    </div>
  );
}

function templateFor(node: PipelineNode): string {
  return node.type === "input" ? `{{inputs.${node.config.key}}}` : `{{nodes.${node.id}}}`;
}

function ancestorsOf(nodeId: string, graph: PipelineGraph): PipelineNode[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const visit = (id: string) => {
    for (const edge of graph.edges.filter((item) => item.target === id)) {
      if (seen.has(edge.source)) continue;
      seen.add(edge.source);
      visit(edge.source);
    }
  };
  visit(nodeId);
  return graph.nodes.filter((node) => seen.has(node.id) && byId.has(node.id));
}

function inputProperties(method: FunctionMethod | undefined): Array<{ key: string; required: boolean; description: string }> {
  const schema = method?.input;
  if (!schema || typeof schema !== "object") return [];
  const record = schema as { properties?: Record<string, { description?: string; title?: string }>; required?: string[] };
  return Object.entries(record.properties ?? {}).map(([key, value]) => ({
    key,
    required: record.required?.includes(key) ?? false,
    description: value.description ?? value.title ?? "",
  }));
}

function TemplateField({ value, multiline = false, placeholder, onCommit }: {
  value: string;
  multiline?: boolean;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const tokens = useMemo(() => {
    const found: Array<{ raw: string; path: string; start: number; end: number; label: string }> = [];
    const pattern = /\{\{\s*([^{}]+?)\s*\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(draft)) !== null) {
      const path = match[1]?.trim() ?? "variable";
      const leaf = path.split(".").at(-1) ?? path;
      found.push({ raw: match[0], path, start: match.index, end: match.index + match[0].length, label: leaf.replace(/_/g, " ") });
    }
    return found;
  }, [draft]);
  const drop = (event: DragEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    event.preventDefault();
    const token = event.dataTransfer.getData("text/plain");
    if (!token) return;
    const target = event.currentTarget;
    const start = target.selectionStart ?? draft.length;
    const next = `${draft.slice(0, start)}${token}${draft.slice(target.selectionEnd ?? start)}`;
    setDraft(next);
    onCommit(next);
  };
  const removeToken = (token: (typeof tokens)[number]) => {
    const next = `${draft.slice(0, token.start)}${draft.slice(token.end)}`;
    setDraft(next);
    onCommit(next);
  };
  const props = {
    value: draft,
    placeholder,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(event.target.value),
    onBlur: () => draft !== value && onCommit(draft),
    onDragOver: (event: DragEvent<HTMLInputElement | HTMLTextAreaElement>) => event.preventDefault(),
    onDrop: drop,
  };
  return <div className={`pipeline-template-control${multiline ? " multiline" : ""}${tokens.length > 0 ? " has-tokens" : ""}`}>
    {multiline ? <textarea {...props} className="pipeline-template-input" /> : <input {...props} className="pipeline-template-input" />}
    {tokens.length > 0 && <div className="pipeline-template-tokens" aria-label="Variables used in this field">{tokens.map((token) => <span className="pipeline-template-chip" key={`${token.start}-${token.raw}`} title={token.raw}><i>↳</i><span>{token.label}</span><button type="button" aria-label={`Remove ${token.label}`} title={`Remove ${token.raw}`} onMouseDown={(event) => event.preventDefault()} onClick={() => removeToken(token)}>×</button></span>)}</div>}
  </div>;
}

type SelectOption = { value: string; label: string; disabled?: boolean };

function AppSelect({ value, options, placeholder = "Select…", ariaLabel, disabled = false, searchable = false, onChange }: {
  value: string;
  options: readonly SelectOption[];
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  searchable?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: globalThis.PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) { setOpen(false); setSearch(""); }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  const selected = options.find((option) => option.value === value);
  const query = search.trim().toLowerCase();
  const visible = query ? options.filter((option) => option.label.toLowerCase().includes(query)) : options;
  return <div className="pipeline-select" ref={root}>
    <button type="button" className="pipeline-select-trigger" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen((current) => !current)}>
      <span className={selected ? "" : "placeholder"}>{selected?.label ?? placeholder}</span><span className={`pipeline-select-caret${open ? " open" : ""}`}>›</span>
    </button>
    {open && <div className="pipeline-select-menu" role="listbox" aria-label={ariaLabel}>
      {searchable && <input className="pipeline-select-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search…" autoFocus />}
      <div className="pipeline-select-options">
        {visible.map((option) => <button key={option.value} type="button" role="option" aria-selected={option.value === value} disabled={option.disabled} className={`pipeline-select-option${option.value === value ? " active" : ""}`} onClick={() => { onChange(option.value); setOpen(false); setSearch(""); }}><span className="pipeline-select-check">{option.value === value ? "✓" : ""}</span><span>{option.label}</span></button>)}
        {visible.length === 0 && <div className="pipeline-select-empty">No matching options</div>}
      </div>
    </div>}
  </div>;
}

type ConditionNode = Extract<PipelineNode, { type: "condition" }>;
type ConditionRule = NonNullable<ConditionNode["config"]["conditions"]>[number];

const conditionOperators: Array<{ value: ConditionRule["operator"]; label: string }> = [
  { value: "equals", label: "is equal to" },
  { value: "not_equals", label: "is not equal to" },
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "does not contain" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with", label: "ends with" },
  { value: "greater_than", label: "is greater than" },
  { value: "less_than", label: "is less than" },
  { value: "is_empty", label: "is empty" },
  { value: "is_not_empty", label: "is not empty" },
];

function compileConditionRule(rule: ConditionRule): string {
  const left = `(${rule.left.trim() || "undefined"})`;
  const right = rule.valueType === "number"
    ? `Number(${JSON.stringify(rule.right)})`
    : rule.valueType === "boolean"
      ? (rule.right === "true" ? "true" : "false")
      : rule.valueType === "date"
        ? `new Date(${JSON.stringify(rule.right)}).getTime()`
        : JSON.stringify(rule.right);
  const value = rule.valueType === "number" ? `Number(${left})` : rule.valueType === "date" ? `new Date(${left}).getTime()` : rule.valueType === "boolean" ? `Boolean(${left})` : `String(${left} ?? "")`;
  if (rule.operator === "equals") return `${value} === ${right}`;
  if (rule.operator === "not_equals") return `${value} !== ${right}`;
  if (rule.operator === "contains") return `${value}.includes(String(${right}))`;
  if (rule.operator === "not_contains") return `!${value}.includes(String(${right}))`;
  if (rule.operator === "starts_with") return `${value}.startsWith(String(${right}))`;
  if (rule.operator === "ends_with") return `${value}.endsWith(String(${right}))`;
  if (rule.operator === "greater_than") return `${value} > ${right}`;
  if (rule.operator === "less_than") return `${value} < ${right}`;
  if (rule.operator === "is_empty") return `${left} == null || ${value}.length === 0`;
  return `${left} != null && ${value}.length > 0`;
}

function compileConditions(rules: readonly ConditionRule[], match: "all" | "any"): string {
  if (rules.length === 0) return "false";
  return rules.map((rule) => `(${compileConditionRule(rule)})`).join(match === "all" ? " && " : " || ");
}

function ConditionBuilder({ node, onCommit }: { node: ConditionNode; onCommit: (values: Record<string, unknown>) => void }) {
  const match = node.config.match ?? "all";
  const rules = node.config.conditions ?? [{ id: "condition_1", left: "", operator: "equals", right: "", valueType: "string" } satisfies ConditionRule];
  const save = (nextRules: readonly ConditionRule[], nextMatch = match) => onCommit({ conditions: nextRules, match: nextMatch, expression: compileConditions(nextRules, nextMatch) });
  const update = (id: string, values: Partial<ConditionRule>) => save(rules.map((rule) => rule.id === id ? { ...rule, ...values } : rule));
  return <div className="pipeline-condition-builder">
    <div className="pipeline-condition-head"><strong>Conditions</strong><label>Match<AppSelect ariaLabel="Condition match mode" value={match} options={[{ value: "all", label: "All conditions" }, { value: "any", label: "Any condition" }]} onChange={(value) => save(rules, value as "all" | "any")} /></label></div>
    {rules.map((rule, index) => <div className="pipeline-condition-rule" key={rule.id}>
      <div className="pipeline-condition-rule-top"><span>{index + 1}</span><AppSelect ariaLabel={`Condition ${index + 1} value type`} value={rule.valueType} options={[{ value: "string", label: "String" }, { value: "number", label: "Number" }, { value: "boolean", label: "Boolean" }, { value: "date", label: "Date & time" }]} onChange={(value) => update(rule.id, { valueType: value as ConditionRule["valueType"] })} />{rules.length > 1 && <button title="Remove condition" onClick={() => save(rules.filter((item) => item.id !== rule.id))}>×</button>}</div>
      <TemplateField value={rule.left} placeholder="Value or input expression" onCommit={(value) => update(rule.id, { left: value })} />
      <AppSelect ariaLabel={`Condition ${index + 1} operator`} value={rule.operator} options={conditionOperators} onChange={(value) => update(rule.id, { operator: value as ConditionRule["operator"] })} />
      {rule.operator !== "is_empty" && rule.operator !== "is_not_empty" && (rule.valueType === "boolean" ? <AppSelect ariaLabel={`Condition ${index + 1} comparison value`} value={rule.right} options={[{ value: "true", label: "True" }, { value: "false", label: "False" }]} onChange={(value) => update(rule.id, { right: value })} /> : <TemplateField value={rule.right} placeholder="Comparison value" onCommit={(value) => update(rule.id, { right: value })} />)}
    </div>)}
    <button className="btn btn-outline btn-sm pipeline-condition-add" onClick={() => save([...rules, { id: `condition_${Date.now().toString(36)}`, left: "", operator: "equals", right: "", valueType: "string" }])}>＋ Add condition</button>
    <details><summary>Advanced expression</summary><TemplateField multiline value={node.config.expression} placeholder="e.g. inputs.score > 50" onCommit={(expression) => onCommit({ expression, conditions: undefined })} /></details>
  </div>;
}

function NodeConfiguration({ node, connectors, providers, onPatch }: {
  node: PipelineNode;
  connectors: ConnectorInfo[];
  providers: AiProviderInfo[];
  onPatch: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(node.name);
  useEffect(() => setName(node.name), [node.id, node.name]);
  const toolConnector = node.type === "tool" ? connectors.find((item) => item.provider === node.config.provider) : undefined;
  const toolMethod = node.type === "tool" ? toolConnector?.methods.find((item) => item.method === node.config.method) : undefined;
  const aiProvider = node.type === "ai" ? providers.find((item) => item.id === node.config.provider) : undefined;
  const commitConfig = (values: Record<string, unknown>) => onPatch({ config: values });
  return (
    <div className="pipeline-config-form">
      <label>Node name<input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== node.name ? void onPatch({ name: name.trim() }) : undefined} /></label>

      {node.type === "tool" && <>
        <label>Tool provider<AppSelect searchable ariaLabel="Tool provider" value={node.config.provider} options={connectors.map((connector) => ({ value: connector.provider, label: connector.name }))} onChange={(value) => { const connector = connectors.find((item) => item.provider === value); const method = connector?.methods[0]; if (connector && method) void commitConfig({ provider: connector.provider, method: method.method, params: {} }); }} /></label>
        <label>Operation<AppSelect searchable ariaLabel="Tool operation" value={node.config.method} options={toolConnector?.methods.map((method) => ({ value: method.method, label: method.label })) ?? []} onChange={(value) => void commitConfig({ method: value, params: {} })} /></label>
        {toolMethod?.description && <p className="pipeline-field-help">{toolMethod.description}</p>}
        {inputProperties(toolMethod).map((field) => <label key={field.key}>{field.key}{field.required && <b>Required</b>}<TemplateField value={String(node.config.params[field.key] ?? "")} placeholder={field.description || `Map ${field.key}`} onCommit={(value) => void commitConfig({ params: { ...node.config.params, [field.key]: value } })} /></label>)}
        {inputProperties(toolMethod).length === 0 && <div className="pipeline-config-note"><i /> This operation has no configurable inputs.</div>}
      </>}

      {node.type === "ai" && <>
        <label>Provider<AppSelect searchable ariaLabel="AI provider" value={node.config.provider ?? ""} placeholder="Select provider…" options={providers.map((provider) => ({ value: provider.id, label: `${provider.name}${provider.connected ? "" : " · not connected"}` }))} onChange={(value) => { const provider = providers.find((item) => item.id === value); void commitConfig({ provider: value, model: provider?.models[0] }); }} /></label>
        <label>Model<AppSelect searchable ariaLabel="AI model" value={node.config.model ?? ""} placeholder="Select model…" disabled={!aiProvider} options={aiProvider?.models.map((model) => ({ value: model, label: model })) ?? []} onChange={(value) => void commitConfig({ model: value })} /></label>
        <label>System instructions<TemplateField multiline value={node.config.system ?? ""} placeholder="You are a precise enrichment assistant…" onCommit={(value) => void commitConfig({ system: value })} /></label>
        <label>Prompt<TemplateField multiline value={node.config.prompt ?? ""} placeholder="e.g. Translate this value into French…" onCommit={(value) => void commitConfig({ prompt: value })} /></label>
        <label>Response format<AppSelect ariaLabel="AI response format" value={node.config.responseFormat ?? "text"} options={[{ value: "text", label: "Text" }, { value: "json", label: "JSON" }]} onChange={(value) => void commitConfig({ responseFormat: value })} /></label>
      </>}

      {node.type === "formula" && <label>Expression<TemplateField multiline value={node.config.expression} placeholder="e.g. {{inputs.columns.company_name}}" onCommit={(value) => void commitConfig({ expression: value })} /></label>}
      {node.type === "condition" && <ConditionBuilder node={node} onCommit={(values) => void commitConfig(values)} />}
      {node.type === "code" && <label>Code<TemplateField multiline value={node.config.source} placeholder={"function (inputs) {\n  return inputs;\n}"} onCommit={(value) => void commitConfig({ source: value })} /></label>}
      {node.type === "http" && <><label>Method<AppSelect ariaLabel="HTTP method" value={node.config.method} options={["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => ({ value: method, label: method }))} onChange={(value) => void commitConfig({ method: value })} /></label><label>URL<TemplateField value={node.config.url} placeholder="https://api.example.com/…" onCommit={(value) => void commitConfig({ url: value })} /></label></>}
      {node.type === "input" && <><div className="pipeline-trigger-card"><span>▶</span><div><strong>Table execution</strong><p>This workflow starts when its attached column runs for a row. Schedule and webhook triggers will be configured here when those trigger types are added.</p></div></div><label>Incoming record key<TemplateField value={node.config.key} onCommit={(value) => void commitConfig({ key: value })} /></label></>}
      {node.type === "output" && <label>Output key<TemplateField value={node.config.key} onCommit={(value) => void commitConfig({ key: value })} /></label>}
    </div>
  );
}

function useEscapeDismiss(onClose: () => void) {
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, []);
}

function DeletePipelineDialog({ name, deleting, error, onCancel, onConfirm }: {
  name: string;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return <Dialog open onOpenChange={(open) => { if (!open && !deleting) onCancel(); }}>
    <DialogContent className="pipeline-delete-dialog" overlayClassName="pipeline-delete-backdrop" aria-labelledby="pipeline-delete-title">
      <span className="pipeline-delete-icon"><TrashIcon /></span>
      <div><div className="pipeline-panel-kicker">DELETE AUTOMATION</div><DialogTitle id="pipeline-delete-title">Delete “{name}”?</DialogTitle></div>
      <DialogDescription>This permanently removes the pipeline, its table attachments and its run history. Table data already written by completed runs will stay in place.</DialogDescription>
      {error && <div className="pipeline-error" role="alert">{error}</div>}
      <footer><button className="btn btn-outline" autoFocus onClick={onCancel} disabled={deleting}>Cancel</button><button className="btn btn-danger" onClick={onConfirm} disabled={deleting}>{deleting ? "Deleting…" : "Delete pipeline"}</button></footer>
    </DialogContent>
  </Dialog>;
}

function NodeInspector({ node, graph, connectors, providers, tableVariables, attachedTableName, onPatch, onRemove, onClose, onTestPrevious }: {
  node: PipelineNode;
  graph: PipelineGraph;
  connectors: ConnectorInfo[];
  providers: AiProviderInfo[];
  tableVariables: readonly TableVariable[];
  attachedTableName?: string;
  onPatch: (patch: Record<string, unknown>) => Promise<void>;
  onRemove: () => void;
  onClose: () => void;
  onTestPrevious: () => void;
}) {
  useEscapeDismiss(onClose);
  const [tab, setTab] = useState<"parameters" | "settings">("parameters");
  const upstream = useMemo(() => ancestorsOf(node.id, graph), [graph, node.id]);
  return <div className="pipeline-inspector-backdrop" role="dialog" aria-modal="true" aria-label={`Configure ${node.name}`}>
    <div className="pipeline-inspector">
      <header><span className={`pipeline-inspector-icon tone-${nodeMeta[node.type].tone}`}><PipelineNodeIcon node={node} connectors={connectors} providers={providers} size={20} /></span><strong>{node.name}</strong><span>{nodeMeta[node.type].label}</span><div /><button className="btn btn-primary btn-sm pipeline-inspector-test" onClick={onTestPrevious}>▷ Test workflow</button><button className="btn btn-ghost btn-icon pipeline-inspector-close" aria-label="Close node configuration" onClick={onClose}>×</button></header>
      <div className="pipeline-inspector-grid">
        <section className="pipeline-inspector-data pipeline-inspector-input">
          <div className="pipeline-inspector-section-head"><strong>INPUT</strong><span>Schema&nbsp;&nbsp; Table&nbsp;&nbsp; JSON</span></div>
          {attachedTableName ? <p><strong>{attachedTableName}</strong> is attached. Drag a column or an earlier node output into any parameter or prompt.</p> : <p>Attach a table to expose its columns here as draggable variables.</p>}
          <button className="btn btn-primary btn-sm pipeline-execute-previous" onClick={onTestPrevious}>{attachedTableName ? "Test 1 record" : "Choose table & test"}</button>
          {tableVariables.length > 0 && <div className="pipeline-variable-group"><div className="pipeline-variable-group-title"><strong>TABLE COLUMNS</strong><span>{tableVariables.length}</span></div>{tableVariables.map((variable) => <button className="pipeline-table-variable" key={variable.columnId} draggable onDragStart={(event) => event.dataTransfer.setData("text/plain", variable.token)} title={`Drag ${variable.name} into a parameter`}><span>{variable.name.slice(0, 1).toUpperCase()}</span><div><strong>{variable.name}</strong><small>{variable.type} · {variable.token}</small></div><b>⋮⋮</b></button>)}</div>}
          <div className="pipeline-upstream-list">{upstream.map((item) => <div className="pipeline-upstream-node" key={item.id}><span className={`tone-${nodeMeta[item.type].tone}`}><PipelineNodeIcon node={item} connectors={connectors} providers={providers} size={16} /></span><div><strong>{item.name}</strong><small>{item.type === "input" ? item.config.key : item.id}</small></div><button draggable onDragStart={(event) => event.dataTransfer.setData("text/plain", templateFor(item))} title="Drag into a parameter">{templateFor(item)}</button></div>)}</div>
          {upstream.length === 0 && tableVariables.length === 0 && <div className="pipeline-data-empty">This is the first node in the path.</div>}
        </section>
        <section className="pipeline-inspector-parameters">
          <div className="pipeline-parameter-tabs"><button className={tab === "parameters" ? "active" : ""} onClick={() => setTab("parameters")}>Parameters</button><button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>Settings</button></div>
          {tab === "parameters" ? <NodeConfiguration node={node} connectors={connectors} providers={providers} onPatch={onPatch} /> : <div className="pipeline-config-form"><label>On error<AppSelect ariaLabel="On error behavior" value={node.onError ?? "abort"} options={[{ value: "abort", label: "Stop workflow" }, { value: "continue", label: "Continue with error" }]} onChange={(value) => void onPatch({ onError: value })} /></label>{node.type !== "input" && node.type !== "output" && <button className="btn btn-danger pipeline-button-wide" onClick={onRemove}>Delete node</button>}<div className="pipeline-config-note"><i /> Draft changes save automatically. Deployed versions remain immutable.</div></div>}
        </section>
        <section className="pipeline-inspector-data pipeline-inspector-output">
          <div className="pipeline-inspector-section-head"><strong>OUTPUT</strong><span>Schema&nbsp;&nbsp; Table&nbsp;&nbsp; JSON</span></div>
          <div className="pipeline-output-empty"><span>↳</span><strong>No test result yet</strong><p>{attachedTableName ? "Test one record to inspect this node's input and output in Logs." : "Attach this workflow once, then test a record to inspect its run in Logs."}</p><button className="btn btn-primary btn-sm" onClick={onTestPrevious}>{attachedTableName ? "Test 1 record" : "Attach & test"}</button></div>
        </section>
      </div>
    </div>
  </div>;
}

type RunNodeRecord = {
  nodeId: string;
  rowId: string;
  status: NodeExecutionStatus;
  error: string | null;
  inputData: unknown;
  outputData: unknown;
  durationMs: number | null;
  actionConsumed: boolean;
  startedAt: number;
  finishedAt: number | null;
};

function JsonData({ value, empty }: { value: unknown; empty: string }) {
  if (value === undefined || value === null) return <div className="pipeline-run-data-empty">{empty}</div>;
  const display = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value, null, 2);
  return <pre className="pipeline-run-json">{display}</pre>;
}

function dataTypeLabel(value: unknown): string {
  if (typeof value === "string") return "TEXT";
  if (typeof value === "number") return "NUMBER";
  if (typeof value === "boolean") return "BOOLEAN";
  if (value === null || value === undefined) return "—";
  return "JSON";
}

function RunNodeInspector({ node, record, connectors, providers, onClose }: { node: PipelineNode; record?: RunNodeRecord; connectors: readonly ConnectorInfo[]; providers: readonly AiProviderInfo[]; onClose: () => void }) {
  useEscapeDismiss(onClose);
  return <div className="pipeline-inspector-backdrop" role="dialog" aria-modal="true" aria-label={`Execution data for ${node.name}`}>
    <div className="pipeline-inspector pipeline-run-inspector">
      <header><span className={`pipeline-inspector-icon tone-${nodeMeta[node.type].tone}`}><PipelineNodeIcon node={node} connectors={connectors} providers={providers} size={20} /></span><strong>{node.name}</strong><span>{nodeMeta[node.type].label}</span><div /><span className={`pipeline-run-status-pill status-${record?.status ?? "queued"}`}>{record?.status ?? "queued"}</span><button className="btn btn-ghost btn-icon pipeline-inspector-close" aria-label="Close run details" onClick={onClose}>×</button></header>
      <div className="pipeline-inspector-grid">
        <section className="pipeline-inspector-data"><div className="pipeline-inspector-section-head"><strong>INPUT</strong><span>{dataTypeLabel(record?.inputData)}</span></div><JsonData value={record?.inputData} empty="No input was recorded for this node." /></section>
        <section className="pipeline-inspector-parameters"><div className="pipeline-parameter-tabs"><button className="active">Configuration at execution</button></div><div className="pipeline-run-config-summary"><div><span>Node ID</span><code>{node.id}</code></div><div><span>Duration</span><strong>{record?.durationMs === null || record?.durationMs === undefined ? "—" : `${record.durationMs.toLocaleString()} ms`}</strong></div><div><span>Action charged</span><strong>{record?.actionConsumed ? "1 action" : "No"}</strong></div>{record?.error && <div className="pipeline-run-node-error"><span>Error</span><strong>{record.error}</strong></div>}<JsonData value={node.config} empty="No configuration." /></div></section>
        <section className="pipeline-inspector-data pipeline-inspector-output"><div className="pipeline-inspector-section-head"><strong>OUTPUT</strong><span>{dataTypeLabel(record?.outputData)}</span></div><JsonData value={record?.outputData} empty={record?.status === "running" ? "This node is still running…" : "This node returned no output."} /></section>
      </div>
    </div>
  </div>;
}

function AttachPanel({ pipelineId, versionId, graph, cloudCapable, bindings, initialTableId, initialOutputColumnId, projectId, onDone, onRunStarted, onClose }: {
  pipelineId: string;
  versionId: string;
  graph: PipelineGraph;
  cloudCapable: boolean;
  bindings: readonly PipelineBinding[];
  initialTableId?: string;
  initialOutputColumnId?: string;
  projectId: string | null;
  onDone: (message: string) => void;
  onRunStarted: (runId: string, message: string) => void;
  onClose: () => void;
}) {
  const mutations = usePipelineMutations(projectId);
  const [tables, setTables] = useState<Array<{ id: string; name: string; rows: number }>>([]);
  const [tableId, setTableId] = useState(initialTableId ?? "");
  const [columns, setColumns] = useState<Array<{ id: string; name: string }>>([]);
  const [rowCount, setRowCount] = useState(0);
  const [firstRowId, setFirstRowId] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  const [autoRun, setAutoRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bindingId, setBindingId] = useState<string | null>(null);
  const [bindingVersionId, setBindingVersionId] = useState(versionId);
  const [savedConfig, setSavedConfig] = useState<string | null>(null);
  const autoAttachAttempted = useRef(false);
  useEffect(() => {
    if (!projectId) return;
    void apiClient.grid.listTables.query({ projectId }).then((items) => {
      const next = items.map((table) => ({ id: String(table.id), name: table.name, rows: table.rows ?? 0 }));
      setTables(next);
      setTableId((current) => current || next[0]?.id || "");
    }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [projectId]);
  useEffect(() => {
    if (!tableId) { setColumns([]); setRowCount(0); setFirstRowId(null); return; }
    void apiClient.grid.getTablePage.query({ tableId, limit: 1 }).then((table) => {
      setColumns(table.columns.map((column) => ({ id: column._id, name: column.name })));
      setFirstRowId(table.rows[0]?._id ?? null);
      setRowCount(tables.find((item) => item.id === tableId)?.rows ?? table.rows.length);
      const existing = bindings.find((binding) => binding.tableId === tableId && binding.enabled);
      const tableColumns = table.columns.map((column) => ({ id: column._id, name: column.name }));
      const outputIndex = initialOutputColumnId ? tableColumns.findIndex((column) => column.id === initialOutputColumnId) : -1;
      const defaultInputColumn = outputIndex > 0 ? tableColumns[outputIndex - 1]?.id : tableColumns.find((column) => column.id !== initialOutputColumnId)?.id;
      const existingOutputColumn = existing?.outputMapping[PIPELINE_RESULT_OUTPUT_KEY] ?? Object.values(existing?.outputMapping ?? {})[0];
      const contextualOutputs = initialOutputColumnId ? { [PIPELINE_RESULT_OUTPUT_KEY]: initialOutputColumnId } : {};
      const nextInputs = existing ? { ...existing.inputMapping } : Object.fromEntries(graph.nodes.filter((node) => node.type === "input").flatMap((node) => defaultInputColumn ? [[node.config.key, defaultInputColumn]] : []));
      const nextOutputs = { ...(existingOutputColumn ? { [PIPELINE_RESULT_OUTPUT_KEY]: existingOutputColumn } : {}), ...contextualOutputs };
      const nextAutoRun = existing?.autoRun ?? false;
      setInputs(nextInputs);
      setOutputs(nextOutputs);
      setAutoRun(nextAutoRun);
      setBindingId(existing?.id ?? null);
      setBindingVersionId(existing?.versionId ?? versionId);
      setSavedConfig(existing ? JSON.stringify({ inputs: existing.inputMapping, outputs: nextOutputs, target: cloudCapable ? "cloud" : "local", autoRun: existing.autoRun }) : null);
    }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [bindings, cloudCapable, graph, initialOutputColumnId, tableId, tables, versionId]);
  const inputNodes = graph.nodes.filter((node) => node.type === "input");
  const target = cloudCapable ? "cloud" : "local";
  const pipelineOutputColumnId = outputs[PIPELINE_RESULT_OUTPUT_KEY] ?? "";
  const mappingComplete = inputNodes.every((node) => Boolean(inputs[node.config.key])) && Boolean(pipelineOutputColumnId);
  const submit = async () => {
    if (!tableId) { setError("Choose a table before attaching this pipeline."); return; }
    setBusy(true); setError(null);
    try {
      const binding = await mutations.attach({ pipelineId, versionId, tableId, inputMapping: inputs, outputMapping: outputs, executionTarget: target, autoRun });
      setBindingId(binding.id);
      setBindingVersionId(binding.versionId);
      setSavedConfig(JSON.stringify({ inputs, outputs, target, autoRun }));
      onDone(`Attached to ${tables.find((table) => table.id === tableId)?.name ?? "the table"}. You can now test one record or run it from the table.`);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const currentConfig = JSON.stringify({ inputs, outputs, target, autoRun });
  const attachmentUsesOlderVersion = bindingId !== null && bindingVersionId !== versionId;
  const attachmentDirty = bindingId !== null && (savedConfig !== currentConfig || attachmentUsesOlderVersion);
  const attachedTableName = tables.find((table) => table.id === tableId)?.name;
  useEffect(() => {
    if (!initialOutputColumnId || !mappingComplete || busy || autoAttachAttempted.current || (bindingId !== null && !attachmentDirty)) return;
    autoAttachAttempted.current = true;
    void submit();
  }, [attachmentDirty, bindingId, busy, initialOutputColumnId, mappingComplete, tableId]);
  return (
    <div className="pipeline-attach-panel">
      <div className="pipeline-attach-head"><div><div className="pipeline-panel-kicker">{bindingId ? "ATTACHED TABLE" : "ATTACH & TEST"}</div><h3>{bindingId ? attachedTableName ?? "Table attached" : "Connect to a table"}</h3></div><button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close attach panel">×</button></div><p>{bindingId ? "This attachment is saved. Test it whenever you like, or change the mapping below." : "Choose a table, map its columns, then test one real record before running at scale."}</p>
      <label>Table<AppSelect searchable ariaLabel="Pipeline table" value={tableId} placeholder="Select table…" options={tables.map((table) => ({ value: table.id, label: `${table.name} · ${table.rows.toLocaleString()} rows` }))} onChange={setTableId} /></label>
      {inputNodes.map((node) => <label key={`input-${node.id}`}>Input variable <code>{`{{inputs.${node.config.key}}}`}</code>: {node.name}<AppSelect searchable ariaLabel={`Input column for ${node.name}`} value={inputs[node.config.key] ?? ""} placeholder="Choose the source column…" options={columns.map((column) => ({ value: column.id, label: column.name }))} onChange={(value) => setInputs({ ...inputs, [node.config.key]: value })} /></label>)}
      <label>Pipeline output column<AppSelect searchable ariaLabel="Pipeline output column" value={pipelineOutputColumnId} placeholder="Choose the pipeline result column…" options={columns.map((column) => ({ value: column.id, label: column.name }))} onChange={(value) => setOutputs({ [PIPELINE_RESULT_OUTPUT_KEY]: value })} /></label>
      <div className="pipeline-attach-summary"><strong>One structured result</strong><p>Completed paths are saved together in this cell. Every table column is already available as a workflow variable.</p>{columns.length > 0 && <code>{`{{inputs.columns.${pipelineColumnVariables(columns)[0]?.key ?? "column_name"}}}`}</code>}</div>
      {!cloudCapable && <div className="pipeline-device-note">This workflow contains a device-only step, so it runs while the app is open.</div>}
      {error && <div className="pipeline-error">{error}</div>}
      {bindingId === null || attachmentDirty ? <button className="btn btn-primary pipeline-button-wide" onClick={() => void submit()} disabled={busy || !tableId || !mappingComplete}>{busy ? "Saving…" : !mappingComplete ? "Map columns to continue" : attachmentUsesOlderVersion ? "Update attachment to latest version" : bindingId ? "Save attachment changes" : "Attach to table"}</button> : target === "cloud" ? <div className="pipeline-attach-actions"><button className="btn btn-outline pipeline-button-wide" onClick={() => { if (!firstRowId) return; setBusy(true); setError(null); void mutations.createRun({ pipelineId, versionId: bindingVersionId, bindingId, tableId, executionTarget: "cloud", totalRecords: 1, rowIds: [firstRowId], writeOutputs: false }).then((run) => onRunStarted(run.id, "One-record dry run queued. Watch the highlighted nodes move through the workflow." )).catch((err) => setError(err instanceof Error ? err.message : String(err))).finally(() => setBusy(false)); }} disabled={busy || !firstRowId}>{busy ? "Starting…" : "Test 1 record"}</button><button className="btn btn-primary pipeline-button-wide" onClick={() => { setBusy(true); setError(null); void mutations.createRun({ pipelineId, versionId: bindingVersionId, bindingId, tableId, executionTarget: "cloud", totalRecords: rowCount }).then((run) => onRunStarted(run.id, `${rowCount.toLocaleString()}-record run queued. Watch progress here or open Runs.`)).catch((err) => setError(err instanceof Error ? err.message : String(err))).finally(() => setBusy(false)); }} disabled={busy || rowCount === 0}>{busy ? "Starting…" : `Run all ${rowCount.toLocaleString()}`}</button><small>Tests read one real row and show every node result without changing the table.</small></div> : <div className="pipeline-config-note"><i /> Attached for device execution. Start it from the table while this app is open.</div>}
    </div>
  );
}

export function PipelineEditor({ pipelineId, projectId, attachTableId, attachOutputColumnId, onBack }: {
  pipelineId: string;
  projectId: string | null;
  attachTableId?: string;
  attachOutputColumnId?: string;
  onBack: () => void;
}) {
  const detail = usePipeline(pipelineId);
  const mutations = usePipelineMutations(projectId);
  const runs = usePipelineRuns(pipelineId);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const activeRun = usePipelineRun(activeRunId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [runInspectorOpen, setRunInspectorOpen] = useState(false);
  const [consoleTab, setConsoleTab] = useState<"runs" | "log" | "summary">("runs");
  const [nodeMenu, setNodeMenu] = useState<{ sourceId: string; sourcePort?: "true" | "false"; x: number; y: number } | null>(null);
  const [functionPickerSource, setFunctionPickerSource] = useState<{ sourceId: string; sourcePort?: "true" | "false" } | null>(null);
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [providers, setProviders] = useState<AiProviderInfo[]>([]);
  const [viewport, setViewport] = useState({ x: 80, y: 80, zoom: 1 });
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [attachOpen, setAttachOpen] = useState(Boolean(attachTableId));
  const [dragPositions, setDragPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [attachedTable, setAttachedTable] = useState<{ id: string; name: string; variables: readonly TableVariable[]; testRows: readonly { id: string; label: string }[] } | null>(null);
  const [testRowId, setTestRowId] = useState("");
  const canvasRef = useRef<HTMLDivElement>(null);
  const panStart = useRef<{ pointerX: number; pointerY: number; x: number; y: number } | null>(null);
  const fittedPipeline = useRef<string | null>(null);
  const autoDeployedTablePipeline = useRef(false);

  useEffect(() => {
    let live = true;
    void Promise.all([api.functions(), api.aiProviders()]).then(([nextConnectors, nextProviders]) => {
      if (!live) return;
      setConnectors(nextConnectors);
      setProviders(nextProviders);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => { live = false; };
  }, []);

  const version = detail.data?.draft ?? detail.data?.deployed ?? null;
  const bindings = (detail.data?.bindings ?? []) as readonly PipelineBinding[];
  const activeBinding = bindings.find((binding) => binding.enabled && binding.tableId === attachTableId)
    ?? bindings.find((binding) => binding.enabled)
    ?? null;
  const graph = version?.graph as PipelineGraph | undefined;
  const executionGraph = activeRun.data?.graph as PipelineGraph | null | undefined;
  const viewingExecution = activeRunId !== null;
  const displayGraph = viewingExecution ? executionGraph ?? graph : graph;
  useEffect(() => {
    if (displayGraph && selectedId === null) setSelectedId(displayGraph.nodes.find((node) => node.type !== "input")?.id ?? displayGraph.nodes[0]?.id ?? null);
  }, [displayGraph, selectedId]);
  const nodeById = useMemo(() => new Map(graph?.nodes.map((node) => [node.id, node]) ?? []), [graph]);
  const displayNodeById = useMemo(() => new Map(displayGraph?.nodes.map((node) => [node.id, node]) ?? []), [displayGraph]);
  const visualNodeById = useMemo(() => new Map(displayGraph?.nodes.map((node) => [node.id, !viewingExecution && dragPositions[node.id] ? { ...node, position: dragPositions[node.id]! } : node]) ?? []), [displayGraph, dragPositions, viewingExecution]);
  const selected = selectedId ? displayNodeById.get(selectedId) ?? null : null;
  const nodeRecords = (activeRun.data?.nodes ?? []) as RunNodeRecord[];
  const nodeStatus = useMemo(() => {
    const result = new Map<string, NodeExecutionStatus>();
    const rank: Record<NodeExecutionStatus, number> = { queued: 0, skipped: 1, succeeded: 2, failed: 3, running: 4 };
    for (const record of nodeRecords) {
      const current = result.get(record.nodeId);
      if (!current || rank[record.status] >= rank[current]) result.set(record.nodeId, record.status);
    }
    if (result.size === 0 && activeRun.data?.run.status === "queued") {
      const first = displayGraph?.nodes.find((node) => node.type === "input") ?? displayGraph?.nodes[0];
      if (first) result.set(first.id, "queued");
    }
    return result;
  }, [activeRun.data?.run.status, displayGraph, nodeRecords]);
  const selectedRunRecord = selectedId ? [...nodeRecords].reverse().find((record) => record.nodeId === selectedId) : undefined;

  useEffect(() => {
    if (!activeBinding) { setAttachedTable(null); return; }
    let live = true;
    void apiClient.grid.getTablePage.query({ tableId: activeBinding.tableId, limit: 50 }).then((table) => {
      if (!live) return;
      const outputColumnIds = new Set(Object.values(activeBinding.outputMapping));
      const inputColumns = table.columns.filter((column) => !outputColumnIds.has(column._id));
      const variables = pipelineColumnVariables(inputColumns.map((column) => ({ id: column._id, name: column.name }))).map((variable) => {
        const column = table.columns.find((item) => item._id === variable.columnId);
        return { ...variable, type: column?.type ?? "value", token: `{{inputs.columns.${variable.key}}}` };
      });
      const previewColumnId = Object.values(activeBinding.inputMapping)[0];
      const valueByRow = new Map(table.cells.filter((cell) => cell.columnId === previewColumnId).map((cell) => [cell.rowId, cell.value]));
      const testRows = table.rows.map((row, index) => {
        const preview = valueByRow.get(row._id);
        const suffix = preview === undefined || preview === null || preview === "" ? "" : ` · ${String(preview).slice(0, 48)}`;
        return { id: row._id, label: `Row ${index + 1}${suffix}` };
      });
      setAttachedTable({ id: activeBinding.tableId, name: table.table.name ?? "Attached table", variables, testRows });
      setTestRowId((current) => testRows.some((row) => row.id === current) ? current : testRows[0]?.id ?? "");
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => { live = false; };
  }, [activeBinding?.id, activeBinding?.tableId]);

  const fitCanvas = useCallback(() => {
    if (!displayGraph || !canvasRef.current || displayGraph.nodes.length === 0) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const minX = Math.min(...displayGraph.nodes.map((node) => node.position.x));
    const minY = Math.min(...displayGraph.nodes.map((node) => node.position.y));
    const maxX = Math.max(...displayGraph.nodes.map((node) => node.position.x + NODE_W + 70));
    const maxY = Math.max(...displayGraph.nodes.map((node) => node.position.y + NODE_H + 38));
    const zoom = Math.max(.45, Math.min(1.15, Math.min((rect.width - 120) / Math.max(1, maxX - minX), (rect.height - 110) / Math.max(1, maxY - minY))));
    setViewport({ x: (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom, zoom });
  }, [displayGraph]);
  useEffect(() => {
    const fitKey = `${pipelineId}:${activeRunId ?? "editor"}`;
    if (!displayGraph || fittedPipeline.current === fitKey) return;
    fittedPipeline.current = fitKey;
    const frame = requestAnimationFrame(fitCanvas);
    return () => cancelAnimationFrame(frame);
  }, [activeRunId, displayGraph, fitCanvas, pipelineId]);

  const canvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("[data-node-interactive], .pipeline-node-picker, .pipeline-canvas-controls")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    panStart.current = { pointerX: event.clientX, pointerY: event.clientY, x: viewport.x, y: viewport.y };
    setNodeMenu(null);
  };
  const canvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!panStart.current) return;
    setViewport((current) => ({ ...current, x: panStart.current!.x + event.clientX - panStart.current!.pointerX, y: panStart.current!.y + event.clientY - panStart.current!.pointerY }));
  };
  const canvasPointerUp = () => { panStart.current = null; };
  const canvasWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const rect = event.currentTarget.getBoundingClientRect();
      const nextZoom = Math.max(.35, Math.min(1.8, viewport.zoom * Math.exp(-event.deltaY * .002)));
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      const worldX = (cursorX - viewport.x) / viewport.zoom;
      const worldY = (cursorY - viewport.y) / viewport.zoom;
      setViewport({ x: cursorX - worldX * nextZoom, y: cursorY - worldY * nextZoom, zoom: nextZoom });
    } else {
      setViewport((current) => ({ ...current, x: current.x - (event.shiftKey ? event.deltaY : event.deltaX), y: current.y - (event.shiftKey ? 0 : event.deltaY) }));
    }
  };

  const patch = async (patches: readonly PipelineGraphPatch[], success?: string) => {
    setBusy(true); setError(null);
    try { await mutations.patchDraft(pipelineId, patches); if (success) setMessage(success); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const patchNode = (nodeId: string, values: Record<string, unknown>) => patch([{ op: "update_node", nodeId, patch: values } as PipelineGraphPatch]);
  const insertNode = async (type: Exclude<PipelineNodeType, "input" | "output" | "pipeline">, sourceId?: string, sourcePort?: "true" | "false", toolChoice?: FunctionChoice) => {
    if (!graph) return;
    const edge = sourceId ? graph.edges.find((item) => item.source === sourceId && (sourcePort === undefined || item.sourcePort === sourcePort)) : graph.edges[graph.edges.length - 1];
    const source = nodeById.get(sourceId ?? edge?.source ?? "");
    const target = edge ? nodeById.get(edge.target) : undefined;
    if (!source) return;
    const id = `${type}_${Date.now().toString(36)}`;
    const desiredX = source.position.x + 270;
    const shift = target && target.position.x < desiredX + NODE_W + 80 ? desiredX + NODE_W + 80 - target.position.x : 0;
    const base = { id, name: nodeMeta[type].label, position: { x: desiredX, y: source.position.y } };
    const defaultConnector = toolChoice ? connectors.find((item) => item.provider === toolChoice.provider) : connectors[0];
    const defaultMethod = toolChoice ? defaultConnector?.methods.find((item) => item.method === toolChoice.fnKey.split(".")[1]) : defaultConnector?.methods[0];
    const defaultProvider = providers.find((item) => item.connected && item.models.length > 0) ?? providers.find((item) => item.models.length > 0);
    const node: PipelineNode = type === "tool" ? { ...base, type, name: toolChoice?.label ?? defaultMethod?.label ?? "Choose a tool", config: { provider: toolChoice?.provider ?? defaultConnector?.provider ?? "formatting", method: toolChoice?.fnKey.split(".")[1] ?? defaultMethod?.method ?? "titleCase", params: {} } }
      : type === "ai" ? { ...base, type, name: "Generate with AI", config: { provider: defaultProvider?.id, model: defaultProvider?.models[0], prompt: "", responseFormat: "text" } }
        : type === "formula" ? { ...base, type, name: "Transform value", config: { expression: "" } }
        : type === "http" ? { ...base, type, name: "Call HTTP endpoint", config: { method: "GET", url: "", headers: {} } }
          : type === "code" ? { ...base, type, name: "Run code", config: { source: "" } }
            : { ...base, type: "condition", name: "IF", config: { expression: "", match: "all", conditions: [{ id: "condition_1", left: "", operator: "equals", right: "", valueType: "string" }] } };
    const shiftPatches = shift > 0 && target ? graph.nodes.filter((item) => item.position.x >= target.position.x).map((item) => ({ op: "update_node", nodeId: item.id, patch: { position: { x: item.position.x + shift, y: item.position.y } } } as PipelineGraphPatch)) : [];
    if (!edge) {
      const firstEdges: PipelineGraphPatch[] = source.type === "condition"
        ? [{ op: "add_edge", edge: { id: `edge_${source.id}_${sourcePort ?? "true"}_${id}`, source: source.id, target: id, sourcePort: sourcePort ?? "true" } }]
        : [{ op: "add_edge", edge: { id: `edge_${source.id}_${id}`, source: source.id, target: id, ...(sourcePort ? { sourcePort } : {}) } }];
      await patch([{ op: "add_node", node }, ...firstEdges, ...shiftPatches], `${node.name} added to the draft.`);
      setSelectedId(id); setInspectorOpen(true); setNodeMenu(null); return;
    }
    const outgoing = type === "condition"
      ? [{ op: "add_edge", edge: { id: `${edge.id}-true`, source: id, target: edge.target, sourcePort: "true" } }] as const
      : [{ op: "add_edge", edge: { id: `${edge.id}-b`, source: id, target: edge.target } }] as const;
    await patch([...shiftPatches, { op: "add_node", node }, { op: "remove_edge", edgeId: edge.id }, { op: "add_edge", edge: { id: `${edge.id}-a`, source: edge.source, target: id, sourcePort: edge.sourcePort, targetPort: edge.targetPort } }, ...outgoing] as readonly PipelineGraphPatch[], `${node.name} inserted into the draft.`);
    setSelectedId(id); setInspectorOpen(true); setNodeMenu(null);
  };
  const removeNode = async (nodeId: string) => {
    if (!graph) return;
    const node = nodeById.get(nodeId);
    if (!node || node.type === "input" || node.type === "output") return;
    const inbound = graph.edges.filter((edge) => edge.target === nodeId);
    const outbound = graph.edges.filter((edge) => edge.source === nodeId);
    const targets = [...new Set(outbound.map((edge) => edge.target))];
    if (inbound.length !== 1 || targets.length > 1) { setError("Delete or reconnect this node's branches before removing it."); return; }
    if (outbound.length === 0) {
      await patch([{ op: "remove_node", nodeId }], "Node removed. The previous step is now the end of this path.");
      setSelectedId(inbound[0]!.source);
      setInspectorOpen(false);
      return;
    }
    const targetEdge = outbound.find((edge) => edge.target === targets[0])!;
    await patch([{ op: "remove_node", nodeId }, { op: "add_edge", edge: { id: `rejoin_${Date.now().toString(36)}`, source: inbound[0]!.source, target: targetEdge.target, sourcePort: inbound[0]!.sourcePort, targetPort: targetEdge.targetPort } }], "Node removed and the path reconnected.");
    setSelectedId(inbound[0]!.source);
    setInspectorOpen(false);
  };
  const removeSelected = async () => {
    if (selected) await removeNode(selected.id);
  };
  const migratedGraph = useRef<string | null>(null);
  useEffect(() => {
    if (!graph || migratedGraph.current === pipelineId) return;
    const legacyOutputs = graph.nodes.filter((node) => node.type === "output");
    const mirroredFalseEdges = graph.nodes.filter((node) => node.type === "condition").flatMap((node) => {
      const outgoing = graph.edges.filter((edge) => edge.source === node.id);
      const trueTargets = new Set(outgoing.filter((edge) => edge.sourcePort === "true").map((edge) => edge.target));
      return outgoing.filter((edge) => edge.sourcePort === "false" && trueTargets.has(edge.target));
    });
    const placeholderConfigPatches = graph.nodes.flatMap((node): PipelineGraphPatch[] => {
      if (node.type === "ai" && /^Use this value to produce the requested result:\s*\{\{(?:nodes|inputs)\.[^}]+\}\}$/.test(node.config.prompt)) {
        return [{ op: "update_node", nodeId: node.id, patch: { config: { ...node.config, prompt: "" } } }];
      }
      if (node.type === "formula" && /^\{\{(?:nodes|inputs)\.[^}]+\}\}$/.test(node.config.expression)) {
        return [{ op: "update_node", nodeId: node.id, patch: { config: { ...node.config, expression: "" } } }];
      }
      if (node.type === "http" && node.config.url === "https://api.example.com") {
        return [{ op: "update_node", nodeId: node.id, patch: { config: { ...node.config, url: "" } } }];
      }
      if (node.type === "code" && node.config.source === "function(inputs) { return Object.values(inputs)[0]; }") {
        return [{ op: "update_node", nodeId: node.id, patch: { config: { ...node.config, source: "" } } }];
      }
      if (node.type === "condition" && node.config.expression === "String((Object.values(inputs)[0]) ?? \"\") === \"\"") {
        return [{ op: "update_node", nodeId: node.id, patch: { config: { ...node.config, expression: "", conditions: [{ id: "condition_1", left: "", operator: "equals", right: "", valueType: "string" }] } } }];
      }
      return [];
    });
    const cleanup: PipelineGraphPatch[] = [
      ...mirroredFalseEdges.map((edge) => ({ op: "remove_edge", edgeId: edge.id } as PipelineGraphPatch)),
      ...legacyOutputs.map((node) => ({ op: "remove_node", nodeId: node.id } as PipelineGraphPatch)),
      ...placeholderConfigPatches,
    ];
    migratedGraph.current = pipelineId;
    if (cleanup.length === 0) return;
    void patch(cleanup, placeholderConfigPatches.length > 0 ? "Starter text converted to placeholders." : mirroredFalseEdges.length > 0 ? "Unused mirrored IF branches removed." : "Output nodes removed. Each path now ends at its last step.");
  }, [graph, pipelineId]);
  const deploy = async () => { setBusy(true); setError(null); try { const deployed = await mutations.deploy(pipelineId); setMessage(`Version ${deployed.version} deployed. Attached tables now use this version.`); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); } };
  useEffect(() => {
    if (!attachTableId || !attachOutputColumnId || !detail.data?.draft || detail.data.deployed || busy || autoDeployedTablePipeline.current) return;
    autoDeployedTablePipeline.current = true;
    setBusy(true);
    setMessage("Preparing the pipeline-backed column…");
    void mutations.deploy(pipelineId)
      .then(() => { setAttachOpen(true); setMessage("The originating table is selected and the attachment is being saved."); })
      .catch((reason) => { autoDeployedTablePipeline.current = false; setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => setBusy(false));
  }, [attachOutputColumnId, attachTableId, busy, detail.data?.deployed, detail.data?.draft, mutations, pipelineId]);
  const prepareAttach = async () => {
    setInspectorOpen(false);
    setConsoleOpen(true);
    setError(null);
    if (detail.data?.draft) {
      setBusy(true);
      try {
        const next = await mutations.deploy(pipelineId);
        setMessage(`Version ${next.version} deployed. Choose a table and map its columns to test it.`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
        return;
      }
      setBusy(false);
    } else {
      setMessage("Choose a table and map its columns, then test one record.");
    }
    setAttachOpen(true);
  };
  const showRun = (runId: string, nextMessage: string) => {
    setActiveRunId(runId);
    setAttachOpen(false);
    setInspectorOpen(false);
    setRunInspectorOpen(false);
    setSelectedId(null);
    setConsoleOpen(true);
    setConsoleTab("log");
    setMessage(nextMessage);
  };
  const testAttachedRecord = async () => {
    if (!activeBinding) {
      await prepareAttach();
      return;
    }
    if (activeBinding.executionTarget !== "cloud") {
      setMessage("This attachment runs on this device. Change it to cloud execution to test it from the canvas.");
      setAttachOpen(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const table = await apiClient.grid.getTablePage.query({ tableId: activeBinding.tableId, limit: 1 });
      const selectedRowId = testRowId || table.rows[0]?._id;
      if (!selectedRowId) throw new Error("The attached table has no records to test.");

      const outputColumnId = activeBinding.outputMapping[PIPELINE_RESULT_OUTPUT_KEY]
        ?? Object.values(activeBinding.outputMapping)[0];
      if (!outputColumnId) throw new Error("The attached pipeline output column no longer exists. Edit the attachment to choose one.");

      // A one-record test may execute the current draft without changing the
      // deployed production version. Full/table-triggered runs remain deployed-only.
      const targetVersion = detail.data?.draft ?? detail.data?.deployed;
      if (!targetVersion) throw new Error("This pipeline has no version to test.");
      const outputVariable = pipelineColumnVariables(table.columns.map((column) => ({ id: column._id, name: column.name })))
        .find((variable) => variable.columnId === outputColumnId);
      if (outputVariable && JSON.stringify(targetVersion.graph).includes(`inputs.columns.${outputVariable.key}`)) {
        const primaryInputKey = targetVersion.graph.nodes.find((node) => node.type === "input")?.config.key ?? "record";
        throw new Error(`The workflow is using its own output column (${outputVariable.name}) as an input. Replace that chip with the source column or {{inputs.${primaryInputKey}}}.`);
      }

      // Normalize old per-node mappings and advance a deployed attachment when
      // needed. Draft tests deliberately keep the production binding pinned.
      const needsBindingUpdate = activeBinding.outputMapping[PIPELINE_RESULT_OUTPUT_KEY] !== outputColumnId
        || (targetVersion.status === "deployed" && activeBinding.versionId !== targetVersion.id);
      const binding = needsBindingUpdate ? await mutations.attach({
          pipelineId,
          versionId: targetVersion.status === "draft" ? activeBinding.versionId : targetVersion.id,
          tableId: activeBinding.tableId,
          inputMapping: { ...activeBinding.inputMapping },
          outputMapping: { [PIPELINE_RESULT_OUTPUT_KEY]: outputColumnId },
          executionTarget: "cloud",
          autoRun: activeBinding.autoRun,
        }) : activeBinding;
      const run = await mutations.createRun({
        pipelineId,
        versionId: targetVersion.id,
        bindingId: binding.id,
        tableId: activeBinding.tableId,
        executionTarget: "cloud",
        totalRecords: 1,
        rowIds: [selectedRowId],
        writeOutputs: false,
      });
      showRun(run.id, `Dry-running one record from the attached table${targetVersion.status === "draft" ? " against the current draft" : ""}. The table will not be changed.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const deletePipeline = async () => {
    setBusy(true);
    setDeleteError(null);
    try {
      await mutations.remove(pipelineId);
      onBack();
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  };

  if (detail.isLoading || !graph || !detail.data) return <div className="pipeline-editor-loading"><span className="cell-spinner" /> Loading pipeline…</div>;
  if (detail.error) return <div className="pipeline-error">{detail.error instanceof Error ? detail.error.message : "Could not load pipeline."}</div>;

  const activeVersion = version!;
  const deployed = detail.data.deployed;
  const renderGraph = displayGraph ?? graph;
  return (
    <div className="pipeline-editor-shell">
      <header className="pipeline-editor-top">
        <button className="btn btn-outline btn-icon pipeline-editor-back" aria-label="Back" onClick={viewingExecution ? () => { setActiveRunId(null); setRunInspectorOpen(false); setSelectedId(null); setConsoleTab("runs"); } : onBack}>←</button>
        <div className="pipeline-title-lockup"><span className="pipeline-title-mark"><PipelineMark size={16} /></span><div><strong>{detail.data.pipeline.name}</strong><span><i /> {detail.data.draft ? "Draft changes" : `Deployed v${deployed?.version ?? 1}`}</span></div></div>
        <div className="pipeline-editor-spacer" />
        {viewingExecution ? <button className="btn btn-outline btn-sm" onClick={() => { setActiveRunId(null); setRunInspectorOpen(false); setSelectedId(null); setConsoleTab("runs"); }}>Back to editor</button> : <>
          <button className="btn btn-outline btn-sm" onClick={() => { setConsoleOpen(true); setConsoleTab("summary"); setMessage(`Graph valid · ${activeVersion.compiledPlan.actionEstimate.maximumPerRecord} maximum actions per cloud record.`); }}>✓ Validate</button>
          <button className="btn btn-outline btn-sm" onClick={() => setConsoleOpen((open) => !open)}>▤ Logs</button>
          <button className="btn btn-outline btn-sm" onClick={() => { setConsoleOpen(true); setConsoleTab("runs"); }}>◷ Runs</button>
          <button className="btn btn-outline btn-icon pipeline-delete-trigger" title="Delete pipeline" aria-label="Delete pipeline" onClick={() => { setDeleteError(null); setDeleteOpen(true); }}><TrashIcon /></button>
          {activeBinding && <button className="btn btn-outline btn-sm" title="Edit saved table attachment" onClick={() => setAttachOpen(true)}>Attached · {attachedTable?.name ?? "table"}</button>}
          {activeBinding && attachedTable && attachedTable.testRows.length > 0 && <div className="pipeline-test-row-select"><AppSelect searchable ariaLabel="Sample row for pipeline test" value={testRowId} placeholder="Choose test row…" options={attachedTable.testRows.map((row) => ({ value: row.id, label: row.label }))} onChange={setTestRowId} /></div>}
          <button className="btn btn-outline btn-sm pipeline-attach-action" onClick={() => void (activeBinding ? testAttachedRecord() : prepareAttach())} disabled={busy}>{activeBinding ? (busy ? "Starting test…" : "Test 1 record") : detail.data.draft ? "Deploy & attach" : "Attach & test"}</button>
          {detail.data.draft && <button className="btn btn-primary btn-sm" onClick={() => void deploy()} disabled={busy}>Deploy version</button>}
        </>}
      </header>

      <div className="pipeline-editor-body">
        <main className="pipeline-canvas-wrap">
          <div className="pipeline-canvas-status"><span>{viewingExecution ? "Execution" : "Canvas"}</span><b>{renderGraph.nodes.length} nodes</b>{viewingExecution ? <><b className={`status-${activeRun.data?.run.status}`}>{activeRun.data?.run.status ?? "Loading"}</b><b>{activeRun.data?.run.processedRecords ?? 0}/{activeRun.data?.run.totalRecords ?? 0} records</b></> : <><b>▶ Table trigger</b><b>{activeVersion.compiledPlan.capabilities.cloud ? "☁ Cloud ready" : "▣ Device only"}</b></>}<em>{viewingExecution ? "Read-only run · click a node for its input and output" : "Drag background to pan · pinch/⌘ scroll to zoom"}</em></div>
          <div ref={canvasRef} className={`pipeline-canvas${panStart.current ? " panning" : ""}${viewingExecution ? " execution-view" : ""}`} role="application" aria-label={viewingExecution ? "Read-only pipeline execution canvas" : "Pipeline graph canvas"} onPointerDown={canvasPointerDown} onPointerMove={canvasPointerMove} onPointerUp={canvasPointerUp} onPointerCancel={canvasPointerUp} onWheel={canvasWheel}>
            <div className="pipeline-canvas-stage" style={{ width: CANVAS_W, height: CANVAS_H, transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}>
              <svg className="pipeline-edge-layer" width={CANVAS_W} height={CANVAS_H} aria-hidden="true">
                {renderGraph.edges.map((edge) => {
                  const source = visualNodeById.get(edge.source); const target = visualNodeById.get(edge.target);
                  return source && target ? <path key={edge.id} d={edgePath(source, target, edge.sourcePort)} className={edge.sourcePort ? `branch-${edge.sourcePort}` : ""} /> : null;
                })}
              </svg>
              {renderGraph.nodes.map((node) => <NodeCard key={node.id} node={node} connectors={connectors} providers={providers} selected={node.id === selectedId} readOnly={viewingExecution} executionStatus={viewingExecution ? nodeStatus.get(node.id) : undefined} zoom={viewport.zoom} onSelect={() => setSelectedId(node.id)} onOpen={() => { setSelectedId(node.id); if (viewingExecution) setRunInspectorOpen(true); else setInspectorOpen(true); }} onRunTo={() => { setSelectedId(node.id); void testAttachedRecord(); }} onRename={!viewingExecution ? (name) => patchNode(node.id, { name }) : undefined} onDelete={!viewingExecution && node.type !== "input" && node.type !== "output" ? () => { setSelectedId(node.id); void removeNode(node.id); } : undefined} onInsert={!viewingExecution && node.type !== "output" ? (anchor, sourcePort) => { const rect = canvasRef.current?.getBoundingClientRect(); if (rect) setNodeMenu({ sourceId: node.id, sourcePort, x: anchor.x - rect.left, y: anchor.y - rect.top }); } : undefined} onDrag={(x, y) => setDragPositions((current) => ({ ...current, [node.id]: { x, y } }))} onDragEnd={async (x, y) => { if (viewingExecution) return; await patchNode(node.id, { position: { x, y } }); setDragPositions((current) => { const next = { ...current }; delete next[node.id]; return next; }); }} />)}
            </div>
            {!viewingExecution && nodeMenu && <div className="pipeline-node-picker" style={{ left: Math.min(nodeMenu.x + 8, (canvasRef.current?.clientWidth ?? 600) - 225), top: Math.min(nodeMenu.y - 24, (canvasRef.current?.clientHeight ?? 500) - 310) }} data-node-interactive><div><strong>Add {nodeMenu.sourcePort ? `to ${nodeMenu.sourcePort} branch` : "next step"}</strong><button onClick={() => setNodeMenu(null)}>×</button></div>{(["tool", "ai", "formula", "condition", "http", "code"] as const).map((type) => <button key={type} onClick={() => { if (type === "tool") { setFunctionPickerSource({ sourceId: nodeMenu.sourceId, sourcePort: nodeMenu.sourcePort }); setNodeMenu(null); } else void insertNode(type, nodeMenu.sourceId, nodeMenu.sourcePort); }}><span className={`tone-${nodeMeta[type].tone}`}>{nodeMeta[type].glyph}</span><div><strong>{nodeMeta[type].label}</strong><small>{type === "tool" ? "Search the full Functions catalog" : type === "ai" ? "Pick provider and model" : type === "condition" ? "Branch on a rule" : "Add to this path"}</small></div><b>→</b></button>)}</div>}
            <div className="pipeline-canvas-controls" data-node-interactive><button title="Zoom in" onClick={() => setViewport((current) => ({ ...current, zoom: Math.min(1.8, current.zoom + .15) }))}>＋</button><button title="Zoom out" onClick={() => setViewport((current) => ({ ...current, zoom: Math.max(.35, current.zoom - .15) }))}>−</button><button title="Fit workflow" onClick={fitCanvas}>⌗</button><span>{Math.round(viewport.zoom * 100)}%</span></div>
          </div>
          {consoleOpen && <div className="pipeline-run-console"><div className="pipeline-console-head"><strong>RUNS & LOGS</strong><div><button className={consoleTab === "runs" ? "active" : ""} onClick={() => setConsoleTab("runs")}>Runs</button><button className={consoleTab === "log" ? "active" : ""} onClick={() => setConsoleTab("log")} disabled={!activeRunId}>Node log</button><button className={consoleTab === "summary" ? "active" : ""} onClick={() => setConsoleTab("summary")}>Summary</button></div><button onClick={() => setConsoleOpen(false)}>×</button></div>
            {consoleTab === "runs" ? <div className="pipeline-console-runs">{runs.isLoading ? <div className="pipeline-console-empty">Loading runs…</div> : runs.data && runs.data.length > 0 ? runs.data.map((run) => <button key={run.id} className={`pipeline-console-run${run.id === activeRunId ? " active" : ""}`} onClick={() => { setActiveRunId(run.id); setSelectedId(null); setRunInspectorOpen(false); setConsoleTab("log"); }}><span className={`pipeline-run-dot status-${run.status}`} /><span><strong>{new Date(run.createdAt).toLocaleString()}</strong><small>{run.executionTarget} · {run.trigger}</small></span><span><strong>{run.status}</strong><small>{run.processedRecords}/{run.totalRecords} records</small></span><span><strong>{run.consumedActions} actions</strong><small>Open execution →</small></span></button>) : <div className="pipeline-console-empty"><span>▷</span><div><strong>No runs yet</strong><p>Attach this workflow to a table, map its inputs, then test one record.</p></div></div>}</div>
              : consoleTab === "log" ? <div className="pipeline-node-log">{activeRun.isLoading ? <div className="pipeline-console-empty">Loading execution…</div> : nodeRecords.length > 0 ? nodeRecords.map((record, index) => { const node = displayNodeById.get(record.nodeId); return <button key={`${record.rowId}-${record.nodeId}-${index}`} onClick={() => { setSelectedId(record.nodeId); setRunInspectorOpen(true); }}><span className={`pipeline-run-dot status-${record.status}`} /><span><strong>{node?.name ?? record.nodeId}</strong><small>{record.rowId}</small></span><span><strong>{record.status}</strong><small>{record.durationMs === null ? "—" : `${record.durationMs} ms`}{record.actionConsumed ? " · 1 action" : ""}</small></span>{record.error && <em>{record.error}</em>}</button>; }) : <div className="pipeline-console-empty"><span className="cell-spinner" /><div><strong>{activeRun.data?.run.status === "queued" ? "Waiting for a worker…" : "No node events yet"}</strong><p>The first node will highlight as soon as execution begins.</p></div></div>}</div>
                : error ? <div className="pipeline-console-line error"><span>ERROR</span>{error}</div> : <div className="pipeline-console-summary">{message && <div className="pipeline-console-line ok"><span>INFO</span>{message}</div>}{activeRun.data ? <><strong>Run {activeRun.data.run.status}</strong><span>{activeRun.data.run.processedRecords}/{activeRun.data.run.totalRecords} records · {activeRun.data.run.consumedActions} actions consumed</span>{activeRun.data.run.firstError && <div className="pipeline-console-line error"><span>ERROR</span>{activeRun.data.run.firstError}</div>}</> : <div className="pipeline-console-empty"><span>▷</span><div><strong>Attach, then test on one real record</strong><p>The source column becomes <code>{"{{inputs.record}}"}</code>; node results are stored here.</p></div></div>}</div>}
          </div>}
        </main>
      </div>
      {!viewingExecution && attachOpen && deployed && <aside className="pipeline-attach-drawer"><AttachPanel pipelineId={pipelineId} versionId={deployed.id} graph={deployed.graph as PipelineGraph} cloudCapable={deployed.compiledPlan.capabilities.cloud} bindings={bindings} initialTableId={attachTableId ?? activeBinding?.tableId} initialOutputColumnId={attachOutputColumnId} projectId={projectId} onDone={(nextMessage) => { setMessage(nextMessage); setConsoleOpen(true); setConsoleTab("summary"); }} onRunStarted={showRun} onClose={() => setAttachOpen(false)} /></aside>}
      {!viewingExecution && selected && inspectorOpen && <NodeInspector node={selected} graph={graph} connectors={connectors} providers={providers} tableVariables={attachedTable?.variables ?? []} attachedTableName={attachedTable?.name} onPatch={(values) => patchNode(selected.id, values)} onRemove={() => void removeSelected()} onClose={() => setInspectorOpen(false)} onTestPrevious={() => void testAttachedRecord()} />}
      {viewingExecution && selected && runInspectorOpen && <RunNodeInspector node={selected} record={selectedRunRecord} connectors={connectors} providers={providers} onClose={() => setRunInspectorOpen(false)} />}
      {!viewingExecution && functionPickerSource && <FunctionsModal connectors={connectors} onClose={() => setFunctionPickerSource(null)} onSelected={(choice) => void insertNode("tool", functionPickerSource.sourceId, functionPickerSource.sourcePort, choice)} />}
      {deleteOpen && <DeletePipelineDialog name={detail.data.pipeline.name} deleting={busy} error={deleteError} onCancel={() => { if (!busy) setDeleteOpen(false); }} onConfirm={() => void deletePipeline()} />}
    </div>
  );
}
