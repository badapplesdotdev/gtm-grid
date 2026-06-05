// Add-column flow: a clean popover to create a manual column (name + type),
// and a full Functions browser (category nav + searchable list + configure-as-
// column detail) for function columns.

import { useState, useMemo, useEffect, useRef, ReactNode, CSSProperties } from "react";
import { api, ConnectorInfo, AiProviderInfo } from "./api";
import { BrandIcon } from "./Panels";

// ─── icons ───────────────────────────────────────────────

const X = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
);
const Chevron = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
);
const SearchIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
);

// Column-type tiles.
const TYPE_ICONS: Record<string, ReactNode> = {
  text: <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700 }}>T</span>,
  number: <span style={{ fontWeight: 700 }}>#</span>,
  boolean: (
    <svg width="20" height="14" viewBox="0 0 24 16" fill="none" stroke="currentColor" strokeWidth="2"><rect x="1" y="1" width="22" height="14" rx="7" /><circle cx="8" cy="8" r="3.5" fill="currentColor" /></svg>
  ),
  date: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
  ),
  json: <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700 }}>{"{ }"}</span>,
};
const TYPES = [
  { id: "text", label: "Text" },
  { id: "number", label: "Number" },
  { id: "boolean", label: "Boolean" },
  { id: "date", label: "Date" },
  { id: "json", label: "JSON" },
];

// ─── Add column popover ──────────────────────────────────

export function AddColumnPopover({
  tableId,
  anchor,
  onClose,
  onAdded,
  onUseFunction,
}: {
  tableId: string;
  anchor: { left: number; top: number } | null;
  onClose: () => void;
  onAdded: () => void;
  onUseFunction: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState("text");
  const [saving, setSaving] = useState(false);

  const add = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.addColumn(tableId, { name: name.trim(), type });
      onAdded();
      onClose();
    } catch {
      setSaving(false);
    }
  };

  // Position the popover just below the "+" button, clamped to the viewport.
  const W = 380;
  const style: CSSProperties = anchor
    ? {
        position: "fixed",
        top: Math.min(anchor.top + 6, window.innerHeight - 360),
        left: Math.max(12, Math.min(anchor.left, window.innerWidth - W - 12)),
      }
    : { position: "fixed", top: "14vh", left: "50%", transform: "translateX(-50%)" };

  return (
    <div className="popover-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="addcol" style={style} onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="addcol-name"
          placeholder="Column name"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />

        <div className="addcol-types">
          {TYPES.map((t) => (
            <button key={t.id} className={`addcol-type${type === t.id ? " active" : ""}`} onClick={() => setType(t.id)}>
              <span className="addcol-type-icon">{TYPE_ICONS[t.id]}</span>
              <span className="addcol-type-label">{t.label}</span>
            </button>
          ))}
        </div>

        <button className="btn btn-primary addcol-submit" onClick={add} disabled={saving || !name.trim()}>
          {saving ? "Adding…" : "Add column"}
        </button>

        <div className="addcol-or"><span>OR</span></div>

        <button className="addcol-fn" onClick={onUseFunction}>
          <div className="addcol-fn-text">
            <span className="addcol-fn-title">Use a function</span>
            <span className="addcol-fn-sub">Browse enrichment, scoring, and more</span>
          </div>
          <span className="addcol-fn-caret">{Chevron}</span>
        </button>
      </div>
    </div>
  );
}

// ─── Functions browser ───────────────────────────────────

interface Fn {
  fnKey: string;
  provider: string;
  providerName: string;
  logo: string | null;
  label: string;
  description: string;
  credits: number;
  input: Record<string, unknown> | null;
  source: string | null;
  batchSize: number;
  category: string;
}

// Connector categories that map directly to a gallery category.
const CONNECTOR_CATEGORY: Record<string, string> = {
  formatting: "Formatting",
  ai: "AI",
  scoring: "Scoring",
  verification: "Verification",
  scraping: "Scraping",
  extraction: "Extraction",
};

const CATEGORY_ORDER = [
  "AI",
  "Enrich people",
  "Enrich company",
  "Find email",
  "Verify email",
  "Find phone",
  "Search",
  "Formatting",
  "Scoring",
  "Verification",
  "Scraping",
  "Extraction",
  "Ads",
  "Jobs",
  "Signals",
];

function categorize(provider: string, connectorCategory: string, label: string, description: string): string {
  if (provider === "ai") return "AI";
  if (CONNECTOR_CATEGORY[connectorCategory]) return CONNECTOR_CATEGORY[connectorCategory];
  const s = `${label} ${description}`.toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => s.includes(w));
  if (has("mobile", "phone")) return "Find phone";
  if (has("verify", "validation", "validate", "deliverab")) return "Verify email";
  if (has("reverse email", "email finder", "find email", "work email", "personal email") || (has("email") && has("find")))
    return "Find email";
  if (has("scrap")) return "Scraping";
  if (has("score", "scoring", "intent")) return "Scoring";
  if (has("extract")) return "Extraction";
  if (has("format", "normalize")) return "Formatting";
  if (has("advert", " ads", "ad intelligence", "ad library")) return "Ads";
  if (has("job", "hiring", "posting")) return "Jobs";
  if (has("signal", "post", "engage", "comment", "reaction", "follower", "tweet")) return "Signals";
  if (has("company", "organization", "firmograph", "technograph")) return "Enrich company";
  if (has("person", "people", "profile", "contact", "enrich", "lookup")) return "Enrich people";
  if (has("search")) return "Search";
  return "Enrich people";
}

export function FunctionsModal({
  tableId,
  connectors,
  columns,
  onClose,
  onAdded,
  onOpenAiSettings,
}: {
  tableId: string;
  connectors: ConnectorInfo[];
  columns: string[];
  onClose: () => void;
  onAdded: () => void;
  onOpenAiSettings?: () => void;
}) {
  const fns: Fn[] = useMemo(
    () =>
      connectors.flatMap((c) =>
        c.methods.map((m) => ({
          fnKey: `${c.provider}.${m.method}`,
          provider: c.provider,
          providerName: c.name,
          logo: c.logo ?? null,
          label: m.label,
          description: m.description,
          credits: m.credits,
          input: m.input ?? null,
          source: m.source ?? null,
          batchSize: m.batchSize ?? 1,
          category: categorize(c.provider, c.category, m.label, m.description),
        })),
      ),
    [connectors],
  );

  const [query, setQuery] = useState("");
  const [nav, setNav] = useState<string>("All"); // "All" | category | "__provider"
  const [selected, setSelected] = useState<Fn | null>(null);

  const q = query.trim().toLowerCase();
  const matched = q
    ? fns.filter((f) => f.label.toLowerCase().includes(q) || f.providerName.toLowerCase().includes(q) || f.description.toLowerCase().includes(q))
    : fns;

  // categories present, in canonical order
  const presentCats = CATEGORY_ORDER.filter((cat) => fns.some((f) => f.category === cat));

  // Build the grouped middle list depending on the nav selection.
  const groups: { label: string; items: Fn[] }[] = useMemo(() => {
    let list = matched;
    if (nav !== "All" && nav !== "__provider") list = list.filter((f) => f.category === nav);

    if (nav === "__provider") {
      const byProvider = new Map<string, Fn[]>();
      for (const f of list) {
        if (!byProvider.has(f.providerName)) byProvider.set(f.providerName, []);
        byProvider.get(f.providerName)!.push(f);
      }
      return [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, items]) => ({ label, items }));
    }

    // group by category (canonical order)
    const order = nav === "All" ? presentCats : [nav];
    return order
      .map((cat) => ({ label: cat, items: list.filter((f) => f.category === cat) }))
      .filter((g) => g.items.length > 0);
  }, [matched, nav, presentCats]);

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="fnx">
        <div className="fnx-header">
          <span className="fnx-title">Functions</span>
          <button className="modal-close" onClick={onClose}>{X}</button>
        </div>

        <div className="fnx-search">
          {SearchIcon}
          <input
            className="fnx-search-input"
            placeholder="Search functions…"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="fnx-body">
          {/* left nav */}
          <div className="fnx-nav">
            <button className={`fnx-nav-item${nav === "All" ? " active" : ""}`} onClick={() => setNav("All")}>All</button>
            {presentCats.map((cat) => (
              <button key={cat} className={`fnx-nav-item${nav === cat ? " active" : ""}`} onClick={() => setNav(cat)}>{cat}</button>
            ))}
            <div className="fnx-nav-sep" />
            <button className={`fnx-nav-item${nav === "__provider" ? " active" : ""}`} onClick={() => setNav("__provider")}>By provider</button>
          </div>

          {/* middle list */}
          <div className="fnx-list">
            {groups.length === 0 ? (
              <div className="fnx-empty">No functions match “{query}”.</div>
            ) : (
              groups.map((g) => (
                <div key={g.label} className="fnx-group">
                  <div className="fnx-group-label">{g.label}</div>
                  {g.items.map((f) => (
                    <button
                      key={f.fnKey}
                      className={`fnx-row${selected?.fnKey === f.fnKey ? " active" : ""}`}
                      onClick={() => setSelected(f)}
                    >
                      <span className="fnx-row-label">{f.label}</span>
                      <span className="fnx-row-logo"><BrandIcon logo={f.logo} name={f.providerName} size={18} /></span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>

          {/* right detail */}
          <div className="fnx-detail">
            {selected ? (
              selected.provider === "ai" ? (
                <AiGenerateDetail
                  key={selected.fnKey}
                  fn={selected}
                  tableId={tableId}
                  columns={columns}
                  onAdded={() => { onAdded(); onClose(); }}
                  onOpenAiSettings={onOpenAiSettings}
                />
              ) : (
                <FunctionDetail key={selected.fnKey} fn={selected} tableId={tableId} columns={columns} onAdded={() => { onAdded(); onClose(); }} />
              )
            ) : (
              <div className="fnx-detail-empty">
                <div className="fnx-detail-empty-title">Select a function</div>
                <div className="fnx-detail-empty-sub">Choose from the list to see its parameters and configure it as a column</div>
              </div>
            )}
          </div>
        </div>

        <div className="fnx-footer">{fns.length} functions</div>
      </div>
    </div>
  );
}

function FunctionDetail({
  fn,
  tableId,
  columns,
  onAdded,
}: {
  fn: Fn;
  tableId: string;
  columns: string[];
  onAdded: () => void;
}) {
  const props = (fn.input?.properties ?? {}) as Record<string, { description?: string; type?: string }>;
  const required = new Set((fn.input?.required as string[] | undefined) ?? []);
  const paramKeys = Object.keys(props);

  const [tab, setTab] = useState<"details" | "configure">("details");
  const [colName, setColName] = useState(fn.label);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const setVal = (k: string, v: string) => setValues((p) => ({ ...p, [k]: v }));

  const add = async () => {
    if (!colName.trim()) { setErr("Column name is required"); return; }
    setSaving(true);
    setErr("");
    try {
      const params: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(values)) if (v.trim()) params[k] = v.trim();
      await api.addColumn(tableId, { name: colName.trim(), fn: fn.fnKey, params });
      onAdded();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to add column");
      setSaving(false);
    }
  };

  const inputCount = paramKeys.length;

  return (
    <div className="fnx-cfg">
      <div className="fnx-cfg-head">
        <div className="fnx-cfg-icon"><BrandIcon logo={fn.logo} name={fn.providerName} size={26} /></div>
        <div style={{ minWidth: 0 }}>
          <div className="fnx-cfg-title">{fn.label}</div>
          <div className="fnx-cfg-sub">
            {inputCount} input{inputCount !== 1 ? "s" : ""} · outputs text
            {fn.credits > 0 && <> · {fn.credits} credit{fn.credits !== 1 ? "s" : ""}</>}
          </div>
        </div>
      </div>
      {fn.description && <p className="fnx-cfg-desc">{fn.description}</p>}

      <div className="fnx-tabs">
        <button className={`fnx-tab${tab === "details" ? " active" : ""}`} onClick={() => setTab("details")}>Details</button>
        <button className={`fnx-tab${tab === "configure" ? " active" : ""}`} onClick={() => setTab("configure")}>Configure</button>
      </div>

      {tab === "details" ? (
        <div className="fnx-tabpane">
          <div className="fnx-cfg-section">Input</div>
          {inputCount === 0 ? (
            <div className="fnx-io-box"><span className="fnx-io-muted">No inputs</span></div>
          ) : (
            <div className="fnx-io-box">
              {paramKeys.map((k) => (
                <div key={k} className="fnx-io-row">
                  <div className="fnx-io-top">
                    <span className="fnx-io-name">{k}</span>
                    {required.has(k) && <span className="fnx-io-req">required</span>}
                    <span className="fnx-io-type">{props[k]?.type ?? "text"}</span>
                  </div>
                  {props[k]?.description && <div className="fnx-io-desc">{props[k].description}</div>}
                </div>
              ))}
            </div>
          )}

          <div className="fnx-cfg-section">Output</div>
          <div className="fnx-io-box fnx-io-inline">
            <span className="fnx-io-name">Returns</span>
            <span className="fnx-io-type">text</span>
            <span className="fnx-io-batch">batch size {fn.batchSize}</span>
          </div>

          {fn.source && (
            <>
              <div className="fnx-cfg-section">Source code</div>
              <pre className="fnx-source"><code>{fn.source}</code></pre>
            </>
          )}
        </div>
      ) : (
        <div className="fnx-tabpane">
          <label className="form-label">Column name</label>
          <input className="form-input" value={colName} onChange={(e) => setColName(e.target.value)} placeholder="Column name" />

          {inputCount > 0 && (
            <>
              <div className="fnx-cfg-section">Inputs</div>
              {paramKeys.map((k) => (
                <div key={k} className="fnx-param">
                  <label className="fnx-param-label">
                    {k}{required.has(k) && <span className="fnx-param-req">*</span>}
                  </label>
                  <input
                    className="form-input"
                    list="fnx-columns"
                    placeholder={props[k]?.description ? props[k].description : `value or {{Column}}`}
                    value={values[k] ?? ""}
                    onChange={(e) => setVal(k, e.target.value)}
                  />
                </div>
              ))}
              <datalist id="fnx-columns">
                {columns.map((c) => <option key={c} value={`{{${c}}}`} />)}
              </datalist>
              <p className="params-hint">Map each input to a value, or reference a column with <code>{"{{Column name}}"}</code>.</p>
            </>
          )}
          {err && <div className="conn-err">{err}</div>}
        </div>
      )}

      <button
        className="btn btn-primary fnx-cfg-add"
        onClick={() => (tab === "details" ? setTab("configure") : add())}
        disabled={saving}
      >
        {tab === "details" ? "Use this function" : saving ? "Adding…" : "Add column"}
      </button>
    </div>
  );
}

// ─── AI Generate (dedicated rich form) ───────────────────
// Column name + model picker (from connected providers) + optional system
// prompt + a prompt box with "/" column-chip insertion + advanced (max tokens).

const BrainIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
    <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
  </svg>
);

function AiGenerateDetail({
  fn,
  tableId,
  columns,
  onAdded,
  onOpenAiSettings,
}: {
  fn: Fn;
  tableId: string;
  columns: string[];
  onAdded: () => void;
  onOpenAiSettings?: () => void;
}) {
  const [providers, setProviders] = useState<AiProviderInfo[] | null>(null);
  const [colName, setColName] = useState("AI Generated");
  const [model, setModel] = useState("");
  const [system, setSystem] = useState("");
  const [prompt, setPrompt] = useState("");
  const [maxTokens, setMaxTokens] = useState("512");
  const [advOpen, setAdvOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const promptRef = useRef<HTMLTextAreaElement>(null);
  // "/" column-insertion menu: index of the slash + the typed query after it.
  const [slash, setSlash] = useState<{ index: number; query: string } | null>(null);

  useEffect(() => {
    api.aiProviders().then(setProviders).catch(() => setProviders([]));
  }, []);

  const connected = (providers ?? []).filter((p) => p.connected);
  const modelOptions = connected.flatMap((p) => p.models.map((m) => ({ provider: p.name, value: m })));
  // Default the model to the first available option once providers load.
  useEffect(() => {
    if (!model && modelOptions.length) setModel(modelOptions[0].value);
  }, [providers]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasProvider = connected.length > 0;

  function onPromptChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setPrompt(v);
    const caret = e.target.selectionStart ?? v.length;
    const m = v.slice(0, caret).match(/\/([\w .-]*)$/);
    setSlash(m ? { index: caret - m[0].length, query: m[1] } : null);
  }

  function insertColumn(col: string) {
    if (!slash) return;
    const before = prompt.slice(0, slash.index);
    const after = prompt.slice(slash.index + 1 + slash.query.length);
    const token = `{{${col}}}`;
    const next = before + token + after;
    setPrompt(next);
    setSlash(null);
    requestAnimationFrame(() => {
      const pos = (before + token).length;
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(pos, pos);
    });
  }

  const slashMatches = slash
    ? columns.filter((c) => c.toLowerCase().includes(slash.query.toLowerCase())).slice(0, 8)
    : [];

  const add = async () => {
    if (!colName.trim()) { setErr("Column name is required"); return; }
    if (!prompt.trim()) { setErr("Prompt is required"); return; }
    if (!hasProvider) { setErr("Connect an AI provider first"); return; }
    setSaving(true);
    setErr("");
    try {
      const params: Record<string, unknown> = { prompt: prompt.trim() };
      if (system.trim()) params.system = system.trim();
      if (model) params.model = model;
      const mt = parseInt(maxTokens, 10);
      if (!Number.isNaN(mt) && mt > 0) params.maxTokens = mt;
      await api.addColumn(tableId, { name: colName.trim(), fn: fn.fnKey, params });
      onAdded();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to add column");
      setSaving(false);
    }
  };

  return (
    <div className="fnx-cfg ai-cfg">
      <div className="fnx-cfg-head">
        <div className="fnx-cfg-icon ai-cfg-icon">{BrainIcon}</div>
        <div>
          <div className="fnx-cfg-title">AI Generate</div>
          <div className="fnx-cfg-sub">Generate text using any connected LLM</div>
        </div>
      </div>

      <label className="form-label">Column name</label>
      <input className="form-input" value={colName} onChange={(e) => setColName(e.target.value)} placeholder="Column name" />

      <label className="form-label">Model</label>
      <select
        className="form-input ai-model-select"
        value={model}
        onChange={(e) => setModel(e.target.value)}
        disabled={!hasProvider}
      >
        {!hasProvider && <option value="">Select model…</option>}
        {connected.map((p) => (
          <optgroup key={p.id} label={p.name}>
            {p.models.map((m) => <option key={m} value={m}>{m}</option>)}
          </optgroup>
        ))}
      </select>
      {!hasProvider && (
        <div className="ai-no-provider">
          No AI providers connected.{" "}
          {onOpenAiSettings ? (
            <button className="ai-link" onClick={onOpenAiSettings}>Configure providers in AI Providers settings.</button>
          ) : (
            <span>Configure providers in AI Providers settings.</span>
          )}
        </div>
      )}

      <label className="form-label">System prompt <span className="form-label-opt">(optional)</span></label>
      <textarea
        className="form-input ai-textarea"
        rows={2}
        placeholder="You are a helpful assistant…"
        value={system}
        onChange={(e) => setSystem(e.target.value)}
      />

      <label className="form-label">Prompt</label>
      <div className="ai-prompt-wrap">
        <textarea
          ref={promptRef}
          className="form-input ai-textarea ai-prompt"
          rows={5}
          placeholder="Write a personalized message for /First Name who works at /Company…"
          value={prompt}
          onChange={onPromptChange}
          onBlur={() => setTimeout(() => setSlash(null), 120)}
        />
        {slash && slashMatches.length > 0 && (
          <div className="ai-slash-menu">
            {slashMatches.map((c) => (
              <button key={c} className="ai-slash-item" onMouseDown={(e) => { e.preventDefault(); insertColumn(c); }}>
                <span className="ai-slash-chip">{c}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="params-hint">Type <code>/</code> to insert a column value as a chip.</p>

      <button className="ai-adv-toggle" onClick={() => setAdvOpen((o) => !o)}>
        <span className={`ai-adv-caret${advOpen ? " open" : ""}`}>{Chevron}</span> Advanced
      </button>
      {advOpen && (
        <div className="ai-adv">
          <label className="form-label">Max tokens</label>
          <input
            className="form-input"
            type="number"
            min={1}
            value={maxTokens}
            onChange={(e) => setMaxTokens(e.target.value)}
            placeholder="512"
          />
        </div>
      )}

      {err && <div className="conn-err">{err}</div>}

      <div className="ai-cfg-foot">
        {!hasProvider && <span className="ai-cfg-foot-note">Connect an AI provider to continue</span>}
        <button className="btn btn-primary fnx-cfg-add" onClick={add} disabled={saving || !hasProvider}>
          {saving ? "Adding…" : "Add column"}
        </button>
      </div>
    </div>
  );
}
