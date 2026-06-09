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
const Check = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
);
const FnGlyph = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
);

// Category glyphs for built-in functions (no brand favicon). Stroke-based, inherit color.
const I = (d: string, extra?: ReactNode) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {d.split("|").map((p, i) => <path key={i} d={p} />)}
    {extra}
  </svg>
);
const CATEGORY_ICON: Record<string, ReactNode> = {
  AI: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
    </svg>
  ),
  Formatting: <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 13, lineHeight: 1 }}>Aa</span>,
  Formula: <span style={{ fontFamily: "var(--font-mono)", fontStyle: "italic", fontWeight: 700, fontSize: 13, lineHeight: 1 }}>fx</span>,
  Scoring: I("M3 3v18h18|m19 9-5 5-4-4-3 3"),
  Verification: I("M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z|m9 12 2 2 4-4"),
  Scraping: I("M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z|M2 12h20|M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z"),
  Extraction: I("m12 2 9 5-9 5-9-5 9-5z|m3 12 9 5 9-5|m3 17 9 5 9-5"),
  "Find email": I("M4 4h16v16H4z|m4 6 8 6 8-6"),
  "Verify email": I("M4 4h16v16H4z|m4 6 8 6 8-6"),
  "Find phone": I("M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L16 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"),
  "Enrich people": I("M16 21v-2a4 4 0 0 0-8 0v2|M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"),
  "Enrich company": I("M3 21h18|M5 21V7l7-4 7 4v14|M9 9h0M9 13h0M9 17h0M15 9h0M15 13h0M15 17h0"),
  Search: I("M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z|m21 21-4.3-4.3"),
  Ads: I("M3 11v2a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1z|M16 9a3 3 0 0 1 0 6"),
  Jobs: I("M3 7h18v13H3z|M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"),
  Signals: I("M4 11a9 9 0 0 1 9 9|M4 4a16 16 0 0 1 16 16|M5 19a1 1 0 1 0 0 .01z"),
};

// Function icon: brand favicon when present, otherwise a category glyph in a tinted box.
function FnIcon({ fn, size = 18 }: { fn: { logo: string | null; providerName: string; category: string }; size?: number }) {
  if (fn.logo) return <BrandIcon logo={fn.logo} name={fn.providerName} size={size} />;
  const glyph = CATEGORY_ICON[fn.category];
  if (!glyph) return <BrandIcon logo={null} name={fn.providerName} size={size} />;
  return <span className="fn-cat-icon" style={{ width: size, height: size }}>{glyph}</span>;
}

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
  const [saving, setSaving] = useState(false);

  // Add a manual column of the chosen type. Name is optional — falls back to
  // the type label so a single click on a type row always works.
  const add = async (type: string) => {
    if (saving) return;
    const colName = name.trim() || TYPES.find((t) => t.id === type)?.label || "Column";
    setSaving(true);
    try {
      await api.addColumn(tableId, { name: colName, type });
      onAdded();
      onClose();
    } catch {
      setSaving(false);
    }
  };

  // Position the popover just below the "+" button, clamped to the viewport.
  const W = 300;
  const style: CSSProperties = anchor
    ? {
        position: "fixed",
        top: Math.min(anchor.top + 6, window.innerHeight - 440),
        left: Math.max(12, Math.min(anchor.left, window.innerWidth - W - 12)),
      }
    : { position: "fixed", top: "14vh", left: "50%", transform: "translateX(-50%)" };

  return (
    <div className="popover-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="addcol acx" style={style} onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="acx-name"
          placeholder="Column name…"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add("text")}
        />

        {/* Actions — enrichment / AI route to the Functions browser */}
        <div className="acx-group">
          <div className="acx-group-label">Enrichment &amp; AI</div>
          <button className="acx-item" onClick={onUseFunction}>
            <span className="acx-item-icon acx-icon-accent">{CATEGORY_ICON.AI}</span>
            <span className="acx-item-text">
              <span className="acx-item-title">Use AI</span>
              <span className="acx-item-sub">Generate with any connected model</span>
            </span>
            <span className="acx-item-caret">{Chevron}</span>
          </button>
          <button className="acx-item" onClick={onUseFunction}>
            <span className="acx-item-icon">{FnGlyph}</span>
            <span className="acx-item-text">
              <span className="acx-item-title">Browse functions</span>
              <span className="acx-item-sub">Enrich, score, scrape, verify…</span>
            </span>
            <span className="acx-item-caret">{Chevron}</span>
          </button>
          <button className="acx-item" onClick={onUseFunction}>
            <span className="acx-item-icon"><span style={{ fontFamily: "var(--font-mono)", fontStyle: "italic", fontWeight: 700 }}>fx</span></span>
            <span className="acx-item-text">
              <span className="acx-item-title">Formula</span>
              <span className="acx-item-sub">Compute a value with JavaScript</span>
            </span>
            <span className="acx-item-caret">{Chevron}</span>
          </button>
        </div>

        {/* Basic column types — single click adds */}
        <div className="acx-group">
          <div className="acx-group-label">Column type</div>
          {TYPES.map((t) => (
            <button key={t.id} className="acx-item acx-type" onClick={() => add(t.id)} disabled={saving}>
              <span className="acx-item-icon">{TYPE_ICONS[t.id]}</span>
              <span className="acx-item-title">{t.label}</span>
              <span className="acx-type-add">Add</span>
            </button>
          ))}
        </div>
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
  output: string;
  category: string;
}

// Connector categories that map directly to a gallery category.
const CONNECTOR_CATEGORY: Record<string, string> = {
  formatting: "Formatting",
  ai: "AI",
  formula: "Formula",
  scoring: "Scoring",
  verification: "Verification",
  scraping: "Scraping",
  extraction: "Extraction",
};

const CATEGORY_ORDER = [
  "AI",
  "Formula",
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

// Nav clusters — categories grouped with a divider line between each group.
// "All" is rendered first and sits with the AI cluster (no line in between).
const NAV_CLUSTERS: string[][] = [
  ["AI", "Formula"],
  ["Enrich people", "Enrich company", "Find email", "Verify email", "Find phone", "Search"],
  ["Formatting", "Scoring", "Verification", "Scraping", "Extraction"],
  ["Ads", "Jobs", "Signals"],
];

function categorize(provider: string, connectorCategory: string, label: string, description: string): string {
  if (provider === "ai") return "AI";
  if (provider === "formula") return "Formula";
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
          output: m.output ?? "text",
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
          {/* left nav — categories grouped into clusters, separated by a line */}
          <div className="fnx-nav">
            <button className={`fnx-nav-item${nav === "All" ? " active" : ""}`} onClick={() => setNav("All")}>All</button>
            {(() => {
              const out: ReactNode[] = [];
              NAV_CLUSTERS.forEach((cluster, ci) => {
                const present = cluster.filter((cat) => presentCats.includes(cat));
                if (!present.length) return;
                if (ci > 0 && out.length) out.push(<div key={`sep-${ci}`} className="fnx-nav-sep" />);
                for (const cat of present) {
                  out.push(
                    <button key={cat} className={`fnx-nav-item${nav === cat ? " active" : ""}`} onClick={() => setNav(cat)}>{cat}</button>,
                  );
                }
              });
              return out;
            })()}
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
                      <span className="fnx-row-logo"><FnIcon fn={f} size={18} /></span>
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
              ) : selected.provider === "formula" ? (
                <FormulaDetail key={selected.fnKey} tableId={tableId} columns={columns} onAdded={() => { onAdded(); onClose(); }} />
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
  const [condition, setCondition] = useState("");
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
      await api.addColumn(tableId, { name: colName.trim(), fn: fn.fnKey, params, condition: condition.trim() || null });
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
        <div className="fnx-cfg-icon"><FnIcon fn={fn} size={26} /></div>
        <div style={{ minWidth: 0 }}>
          <div className="fnx-cfg-title">{fn.label}</div>
          <div className="fnx-cfg-sub">
            {inputCount} input{inputCount !== 1 ? "s" : ""} · outputs {fn.output}
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
            <span className="fnx-io-type">{fn.output}</span>
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
          <RunSettings condition={condition} setCondition={setCondition} columns={columns} />
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
  const [condition, setCondition] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const promptRef = useRef<HTMLTextAreaElement>(null);
  // "/" column-insertion menu: index of the slash + the typed query after it.
  const [slash, setSlash] = useState<{ index: number; query: string } | null>(null);

  // Custom in-app model dropdown (replaces the native <select> popup).
  const [modelOpen, setModelOpen] = useState(false);
  const modelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!modelOpen) return;
    const onDown = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [modelOpen]);

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
      await api.addColumn(tableId, { name: colName.trim(), fn: fn.fnKey, params, condition: condition.trim() || null });
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
      <div className="ai-select" ref={modelRef}>
        <button
          type="button"
          className="form-input ai-select-btn"
          onClick={() => hasProvider && setModelOpen((o) => !o)}
          disabled={!hasProvider}
        >
          <span className={model ? "" : "ai-select-placeholder"}>{model || "Select model…"}</span>
          <span className={`ai-select-caret${modelOpen ? " open" : ""}`}>{Chevron}</span>
        </button>
        {modelOpen && hasProvider && (
          <div className="ai-select-menu">
            {connected.map((p) => (
              <div key={p.id} className="ai-select-group">
                <div className="ai-select-group-label">{p.name}</div>
                {p.models.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`ai-select-item${model === m ? " active" : ""}`}
                    onClick={() => { setModel(m); setModelOpen(false); }}
                  >
                    <span className="ai-select-check">{model === m ? Check : null}</span>
                    <span className="ai-select-item-label">{m}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
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

      <RunSettings condition={condition} setCondition={setCondition} columns={columns} />

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

// ─── Formula column (shared building blocks) ─────────────

const SparkleIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" /></svg>
);
const FxGlyph = <span style={{ fontFamily: "var(--font-mono)", fontStyle: "italic", fontWeight: 700 }}>fx</span>;

/** A textarea with the shared "/" column-insertion menu (mirrors AiGenerateDetail).
 *  Pass `footer` to render an in-box footer bar (a hint + e.g. a Generate button),
 *  which also draws the border around the textarea+footer as one box. */
function SlashTextarea({
  value, onChange, columns, placeholder, rows = 4, className = "", footer,
}: {
  value: string;
  onChange: (v: string) => void;
  columns: string[];
  placeholder?: string;
  rows?: number;
  className?: string;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [slash, setSlash] = useState<{ index: number; query: string } | null>(null);

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    onChange(v);
    const caret = e.target.selectionStart ?? v.length;
    const m = v.slice(0, caret).match(/\/([\w .-]*)$/);
    setSlash(m ? { index: caret - m[0].length, query: m[1] } : null);
  }
  function insert(col: string) {
    if (!slash) return;
    const before = value.slice(0, slash.index);
    const after = value.slice(slash.index + 1 + slash.query.length);
    const token = `{{${col}}}`;
    onChange(before + token + after);
    setSlash(null);
    requestAnimationFrame(() => {
      const pos = (before + token).length;
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
    });
  }
  const matches = slash
    ? columns.filter((c) => c.toLowerCase().includes(slash.query.toLowerCase())).slice(0, 8)
    : [];

  return (
    <div className={`ai-prompt-wrap${footer ? " formula-box" : ""}`}>
      <textarea
        ref={ref}
        className={footer ? `formula-box-area ${className}` : `form-input ai-textarea ${className}`}
        rows={rows}
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={handleChange}
        onBlur={() => setTimeout(() => setSlash(null), 120)}
      />
      {slash && matches.length > 0 && (
        <div className="ai-slash-menu">
          {matches.map((c) => (
            <button key={c} className="ai-slash-item" onMouseDown={(e) => { e.preventDefault(); insert(c); }}>
              <span className="ai-slash-chip">{c}</span>
            </button>
          ))}
        </div>
      )}
      {footer}
    </div>
  );
}

/** A formula/expression editor: a "/"-aware box with an in-box footer ("Type / to
 *  insert column" + a Generate button). Clicking Generate reveals a one-line
 *  natural-language prompt that fills the box via the AI generator. Manual or AI. */
function FormulaInput({
  value, setValue, columns, mode = "formula", rows = 4, placeholder,
}: {
  value: string;
  setValue: (v: string) => void;
  columns: string[];
  mode?: "formula" | "condition";
  rows?: number;
  placeholder?: string;
}) {
  const [genOpen, setGenOpen] = useState(false);
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const generate = async () => {
    if (!desc.trim()) { setErr("Describe it first"); return; }
    setBusy(true);
    setErr("");
    try {
      const r = await api.generateFormula(desc.trim(), columns, mode);
      if (r.error) throw new Error(r.error);
      if (r.formula) { setValue(r.formula); setGenOpen(false); setDesc(""); }
    } catch (e: any) {
      setErr(e?.message ?? "Generation failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SlashTextarea
        value={value}
        onChange={setValue}
        columns={columns}
        rows={rows}
        className="formula-mono"
        placeholder={placeholder}
        footer={
          <div className="formula-box-foot">
            <span className="formula-box-hint">Type <code>/</code> to insert column</span>
            <button type="button" className="formula-gen-btn" onClick={() => setGenOpen((o) => !o)}>
              <span className="formula-gen-spark">{SparkleIcon}</span>
              Generate
            </button>
          </div>
        }
      />
      {genOpen && (
        <div className="formula-gen-row">
          <input
            className="form-input formula-gen-input"
            autoFocus
            placeholder={mode === "condition" ? "Describe when it should run…" : "Describe the formula…"}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); generate(); } }}
          />
          <button type="button" className="btn btn-primary formula-gen-go" onClick={generate} disabled={busy}>
            {busy ? "…" : "Generate"}
          </button>
          <button type="button" className="formula-ai-cancel" onClick={() => { setGenOpen(false); setErr(""); }}>{X}</button>
        </div>
      )}
      {err && <div className="conn-err">{err}</div>}
    </>
  );
}

/** "Run settings → Add run condition" — gates per-row execution (mirrors Clay).
 *  A natural-language box (with "/" insertion + Generate) drives the resolved
 *  boolean formula below it; either field can also be edited manually. */
function RunSettings({
  condition, setCondition, columns,
}: {
  condition: string;
  setCondition: (v: string) => void;
  columns: string[];
}) {
  const [enabled, setEnabled] = useState(!!condition.trim());
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const toggle = (on: boolean) => {
    setEnabled(on);
    if (!on) { setCondition(""); setDesc(""); setErr(""); }
  };

  const generate = async () => {
    if (!desc.trim()) { setErr("Describe the condition first"); return; }
    setBusy(true);
    setErr("");
    try {
      const r = await api.generateFormula(desc.trim(), columns, "condition");
      if (r.error) throw new Error(r.error);
      if (r.formula) setCondition(r.formula);
    } catch (e: any) {
      setErr(e?.message ?? "Generation failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="run-settings">
      <div className="run-settings-title">Run settings</div>
      <label className="run-cond-check">
        <input type="checkbox" checked={enabled} onChange={(e) => toggle(e.target.checked)} />
        <span className="run-cond-check-text">
          <span className="run-cond-check-name">Add run condition</span>
          <span className="run-cond-check-sub">Only run if this formula resolves to true.</span>
        </span>
      </label>
      {enabled && (
        <div className="run-cond-body">
          <SlashTextarea
            value={desc}
            onChange={setDesc}
            columns={columns}
            rows={4}
            placeholder="E.g., Only run when {{Score}} is over 4.2"
            footer={
              <div className="formula-box-foot">
                <span className="formula-box-hint">Type <code>/</code> to insert column</span>
                <button type="button" className="formula-gen-btn" onClick={generate} disabled={busy}>
                  <span className="formula-gen-spark">{SparkleIcon}</span>
                  {busy ? "Generating…" : "Generate"}
                </button>
              </div>
            }
          />
          <input
            className="form-input formula-mono run-cond-formula"
            placeholder="E.g., !!{{Company Domain}}"
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            spellCheck={false}
          />
          {err && <div className="conn-err">{err}</div>}
          <p className="params-hint">A JavaScript boolean expression — describe it above and Generate, or write it directly. When false, the column skips that row (no run, no credits).</p>
        </div>
      )}
    </div>
  );
}

const FX_TYPES: Array<[string, string]> = [
  ["text", "Text"],
  ["number", "Number"],
  ["boolean", "Boolean"],
  ["date", "Date"],
  ["json", "JSON"],
];

// ─── Formula (dedicated rich form) ───────────────────────
// Column name + a monospace expression editor (with "/" column chips and AI
// generation) + an output-type picker + optional "only run if" run settings.

function FormulaDetail({
  tableId, columns, onAdded,
}: {
  tableId: string;
  columns: string[];
  onAdded: () => void;
}) {
  const [colName, setColName] = useState("Formula");
  const [expression, setExpression] = useState("");
  const [type, setType] = useState("text");
  const [condition, setCondition] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const add = async () => {
    if (!colName.trim()) { setErr("Column name is required"); return; }
    if (!expression.trim()) { setErr("A formula is required"); return; }
    setSaving(true);
    setErr("");
    try {
      await api.addColumn(tableId, {
        name: colName.trim(),
        type,
        fn: "formula.eval",
        params: { expression: expression.trim() },
        condition: condition.trim() || null,
      });
      onAdded();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to add column");
      setSaving(false);
    }
  };

  return (
    <div className="fnx-cfg ai-cfg">
      <div className="fnx-cfg-head">
        <div className="fnx-cfg-icon ai-cfg-icon">{FxGlyph}</div>
        <div>
          <div className="fnx-cfg-title">Formula</div>
          <div className="fnx-cfg-sub">Compute a value per row with JavaScript</div>
        </div>
      </div>

      <label className="form-label">Column name</label>
      <input className="form-input" value={colName} onChange={(e) => setColName(e.target.value)} placeholder="Column name" />

      <label className="form-label">Formula</label>
      <FormulaInput value={expression} setValue={setExpression} columns={columns} mode="formula" placeholder={'{{Email}}.split("@")[1]'} />
      <p className="params-hint">
        Reference a column with <code>{"{{Column}}"}</code> or type <code>/</code>. Lodash <code>_</code>, <code>moment</code>, and Excel functions (<code>VLOOKUP</code>, <code>SUM</code>…) are available.
      </p>

      <label className="form-label">Output type</label>
      <div className="fx-types">
        {FX_TYPES.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`fx-type${type === id ? " active" : ""}`}
            onClick={() => setType(id)}
          >
            <span className="fx-type-icon">{TYPE_ICONS[id]}</span>
            {label}
          </button>
        ))}
      </div>

      <RunSettings condition={condition} setCondition={setCondition} columns={columns} />

      {err && <div className="conn-err">{err}</div>}

      <button className="btn btn-primary fnx-cfg-add" onClick={add} disabled={saving}>
        {saving ? "Adding…" : "Add column"}
      </button>
    </div>
  );
}

// ─── Column settings (edit an existing column) ───────────
// Reachable from the column header menu — edit the name, a formula column's
// expression, and the "only run if" condition on any function column.

export function ColumnSettingsModal({
  column, columns, onClose, onSaved,
}: {
  column: {
    id: string;
    name: string;
    type?: string;
    provider: string | null;
    fn: string | null;
    params: Record<string, unknown>;
    condition?: string | null;
  };
  columns: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isFormula = column.provider === "formula" || column.fn === "formula.eval";
  const isAi = column.provider === "ai";
  const isFunction = !!column.provider || !!column.fn;
  const isEnrichment = isFunction && !isFormula && !isAi; // connector/enrichment column
  const p = (column.params ?? {}) as Record<string, unknown>;

  const [name, setName] = useState(column.name);
  const [type, setType] = useState(column.type ?? "text");
  const [condition, setCondition] = useState(column.condition ?? "");
  // formula
  const [expression, setExpression] = useState(isFormula ? String(p.expression ?? "") : "");
  // ai
  const [prompt, setPrompt] = useState(isAi ? String(p.prompt ?? "") : "");
  const [system, setSystem] = useState(isAi ? String(p.system ?? "") : "");
  const [model, setModel] = useState(isAi ? String(p.model ?? "") : "");
  const [maxTokens, setMaxTokens] = useState(isAi && p.maxTokens != null ? String(p.maxTokens) : "");
  // enrichment: re-edit the existing input mappings
  const [params, setParams] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    if (isEnrichment) for (const [k, v] of Object.entries(p)) out[k] = v == null ? "" : typeof v === "string" ? v : String(v);
    return out;
  });
  const [models, setModels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // A column should never reference itself in an expression/condition/mapping.
  const otherColumns = columns.filter((c) => c !== column.name);

  useEffect(() => {
    if (!isAi) return;
    api.aiProviders().then((ps) => setModels(ps.filter((x) => x.connected).flatMap((x) => x.models))).catch(() => {});
  }, [isAi]);

  const save = async () => {
    if (!name.trim()) { setErr("Column name is required"); return; }
    setSaving(true);
    setErr("");
    try {
      const patch: Parameters<typeof api.updateColumn>[1] = {
        name: name.trim(),
        condition: condition.trim() || null,
      };
      if (isFormula) {
        patch.params = { ...p, expression: expression.trim() };
        patch.type = type;
      } else if (isAi) {
        const np: Record<string, unknown> = { ...p, prompt: prompt.trim() };
        np.system = system.trim() || undefined;
        np.model = model.trim() || undefined;
        const mt = parseInt(maxTokens, 10);
        np.maxTokens = !Number.isNaN(mt) && mt > 0 ? mt : undefined;
        for (const k of Object.keys(np)) if (np[k] === undefined) delete np[k];
        patch.params = np;
      } else if (isEnrichment) {
        patch.params = { ...p, ...params };
      } else {
        patch.type = type; // manual column
      }
      await api.updateColumn(column.id, patch);
      onSaved();
      onClose();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to save");
      setSaving(false);
    }
  };

  const TypePicker = (
    <div className="fx-types">
      {FX_TYPES.map(([id, label]) => (
        <button key={id} type="button" className={`fx-type${type === id ? " active" : ""}`} onClick={() => setType(id)}>
          <span className="fx-type-icon">{TYPE_ICONS[id]}</span>
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="popover-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="col-settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="col-settings-head">
          <div className="col-settings-title">Edit column{column.fn ? ` · ${column.fn}` : ""}</div>
          <button className="fnx-x" onClick={onClose}>{X}</button>
        </div>
        <div className="col-settings-body">
          <label className="form-label">Column name</label>
          <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} />

          {isFormula && (
            <>
              <label className="form-label">Formula</label>
              <FormulaInput value={expression} setValue={setExpression} columns={otherColumns} mode="formula" placeholder={'{{Email}}.split("@")[1]'} />
              <label className="form-label">Output type</label>
              {TypePicker}
            </>
          )}

          {isAi && (
            <>
              <label className="form-label">Prompt</label>
              <SlashTextarea value={prompt} onChange={setPrompt} columns={otherColumns} rows={5} placeholder="Write a personalized opener for {{First Name}} at {{Company}}…" />
              <label className="form-label">System prompt <span className="form-label-opt">(optional)</span></label>
              <textarea className="form-input ai-textarea" rows={2} value={system} onChange={(e) => setSystem(e.target.value)} placeholder="You are a helpful assistant…" />
              <label className="form-label">Model</label>
              <input className="form-input" list="colsettings-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. claude-haiku-4-5" />
              <datalist id="colsettings-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
              <label className="form-label">Max tokens <span className="form-label-opt">(optional)</span></label>
              <input className="form-input" type="number" min={1} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="512" />
            </>
          )}

          {isEnrichment && Object.keys(params).length > 0 && (
            <>
              <div className="fnx-cfg-section">Inputs</div>
              {Object.keys(params).map((k) => (
                <div key={k} className="fnx-param">
                  <label className="fnx-param-label">{k}</label>
                  <input
                    className="form-input"
                    list="colsettings-cols"
                    value={params[k]}
                    onChange={(e) => setParams((prev) => ({ ...prev, [k]: e.target.value }))}
                    placeholder="value or {{Column}}"
                  />
                </div>
              ))}
              <datalist id="colsettings-cols">{otherColumns.map((c) => <option key={c} value={`{{${c}}}`} />)}</datalist>
              <p className="params-hint">Map each input to a value, or reference a column with <code>{"{{Column}}"}</code>.</p>
            </>
          )}

          {!isFunction && (
            <>
              <label className="form-label">Type</label>
              {TypePicker}
            </>
          )}

          {isFunction && <RunSettings condition={condition} setCondition={setCondition} columns={otherColumns} />}

          {err && <div className="conn-err">{err}</div>}
        </div>
        <div className="col-settings-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}
