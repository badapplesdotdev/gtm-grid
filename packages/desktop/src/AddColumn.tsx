// Add-column flow: a clean popover to create a manual column (name + type),
// and a full Functions browser (category nav + searchable list + configure-as-
// column detail) for function columns.

import { useState, useMemo, useEffect, useRef, createContext, useContext, ReactNode, CSSProperties } from "react";
import { api, ConnectorInfo, type Column } from "./api";
import { Dialog, DialogContent } from "./components/ui/dialog";

/**
 * The subset of the data API the column-authoring modals need. Injected so the
 * SAME modals serve both environments: local mode uses the local `api`
 * (default); cloud mode supplies a cloud-backed adapter (apps/web tRPC) via
 * {@link ColumnAuthoringApiProvider}. This is what lets the add-column popover,
 * the Functions browser (incl. AI + formula), and the edit-column modal work
 * identically in cloud as in local — the only difference is which backend the
 * four calls hit.
 *
 * It's a React context (not a prop) because the Functions browser is composed
 * of several nested sub-components that each call the API; a context lets them
 * all read the active backend without threading a prop through every layer.
 */
export interface ColumnAuthoringApi {
  addColumn: (
    tableId: string,
    body: {
      name: string;
      type?: string;
      fn?: string;
      code?: string;
      params?: Record<string, unknown>;
      condition?: string | null;
    },
  ) => Promise<{ id: string }>;
  updateColumn: (
    columnId: string,
    patch: {
      name?: string;
      type?: string;
      kind?: string;
      provider?: string | null;
      method?: string | null;
      code?: string | null;
      params?: Record<string, unknown>;
      condition?: string | null;
    },
  ) => Promise<{ ok: boolean; tableId?: string; id?: string }>;
  generateFormula: (typeof api)["generateFormula"];
  aiProviders: (typeof api)["aiProviders"];
  /** Preview a column's function on the first N rows (the HTTP column "Try" action). */
  previewFunction: (
    tableId: string,
    body: {
      provider: string;
      method: string;
      params: Record<string, unknown>;
      limit?: number;
    },
  ) => Promise<{ results: Array<{ rowId: string; value?: unknown; error?: string }> }>;
}

// The desktop is cloud-only: the real column-authoring backend is ALWAYS supplied
// by CloudGrid via {@link ColumnAuthoringApiProvider}. The default just inherits
// the surviving sidecar-backed reads (formula/AI/preview) and throws if a mutation
// is somehow attempted without a provider.
const ColumnAuthoringApiContext = createContext<ColumnAuthoringApi>({
  addColumn: () => Promise.reject(new Error("No column-authoring backend")),
  updateColumn: () => Promise.reject(new Error("No column-authoring backend")),
  generateFormula: api.generateFormula,
  aiProviders: api.aiProviders,
  previewFunction: () => Promise.reject(new Error("No column-authoring backend")),
});

/** Wrap the column-authoring modals to point them at a non-local backend. */
export const ColumnAuthoringApiProvider = ColumnAuthoringApiContext.Provider;

/** The active column-authoring backend (local `api` by default). */
export function useColumnApi(): ColumnAuthoringApi {
  return useContext(ColumnAuthoringApiContext);
}

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
const FnGlyph = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
);
const PipelineGlyph = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="5" cy="6" r="2.25" />
    <circle cx="19" cy="6" r="2.25" />
    <circle cx="19" cy="18" r="2.25" />
    <path d="M7.25 6h5.5a4 4 0 0 1 4 4v5.75" />
  </svg>
);

// Category glyphs, the function icon, and the categorizer live in ./FnIcon
// (eager module) so the DataGrid headers can render provider identity without
// loading this lazy chunk; re-exported here for backwards compatibility.
import { CATEGORY_ICON, CATEGORY_ORDER, FnIcon, OTHER_CATEGORY, categorize } from "./FnIcon";
export { CATEGORY_ICON, FnIcon };

// Column-type tiles.
export const TYPE_ICONS: Record<string, ReactNode> = {
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

/** A synced table's CRM hookup for the add-column popover ("From HubSpot"). */
export interface AddColumnCrmSource {
  /** Display name of the CRM ("Attio", "HubSpot"). */
  readonly providerName: string;
  readonly logo: string;
  /** The source's fields NOT yet mapped to columns (fetched on expand). */
  readonly fetchAvailableFields: () => Promise<
    ReadonlyArray<{ attrSlug: string; attrType: string; title: string; sample: string }>
  >;
  /** Map one more field onto the binding (server backfills via sync). */
  readonly addField: (field: { attrSlug: string; attrType: string; title: string }) => Promise<void>;
}

export function AddColumnPopover({
  tableId,
  anchor,
  onClose,
  onAdded,
  onUseFunction,
  onUsePipeline,
  crm,
}: {
  tableId: string;
  anchor: { left: number; top: number } | null;
  onClose: () => void;
  onAdded: () => void;
  onUseFunction: () => void;
  /** Opens the pipeline library with this table retained as attachment context. */
  onUsePipeline?: (outputColumnId: string) => void;
  /** Present only on synced tables — adds the "From {CRM}" section. */
  crm?: AddColumnCrmSource;
}) {
  const gridApi = useColumnApi();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [crmView, setCrmView] = useState(false);
  const [crmFields, setCrmFields] = useState<
    ReadonlyArray<{ attrSlug: string; attrType: string; title: string; sample: string }> | null
  >(null);
  const [crmError, setCrmError] = useState<string | null>(null);

  const openCrmView = async () => {
    if (!crm) return;
    setCrmView(true);
    setCrmError(null);
    try {
      setCrmFields(await crm.fetchAvailableFields());
    } catch (e) {
      setCrmError(e instanceof Error ? e.message : "Could not load fields.");
    }
  };

  const addCrmField = async (field: { attrSlug: string; attrType: string; title: string }) => {
    if (!crm || saving) return;
    setSaving(true);
    setCrmError(null);
    try {
      await crm.addField(field);
      onAdded();
      onClose();
    } catch (e) {
      setCrmError(e instanceof Error ? e.message : "Could not add the field.");
      setSaving(false);
    }
  };

  // Add a manual column of the chosen type. Name is optional — falls back to
  // the type label so a single click on a type row always works.
  const add = async (type: string) => {
    if (saving) return;
    const colName = name.trim() || TYPES.find((t) => t.id === type)?.label || "Column";
    setSaving(true);
    try {
      await gridApi.addColumn(tableId, { name: colName, type });
      onAdded();
      onClose();
    } catch {
      setSaving(false);
    }
  };

  const addPipelineColumn = async () => {
    if (!onUsePipeline || saving) return;
    setSaving(true);
    try {
      const column = await gridApi.addColumn(tableId, { name: name.trim() || "Pipeline output", type: "json" });
      onAdded();
      onUsePipeline(column.id);
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

  if (crm && crmView) {
    const query = name.trim().toLowerCase();
    const shown = (crmFields ?? []).filter(
      (f) => query === "" || f.title.toLowerCase().includes(query) || f.attrSlug.toLowerCase().includes(query),
    );
    return (
      <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
        <DialogContent className="addcol acx" style={style} overlayClassName="bare-scrim" srTitle={`Add a ${crm.providerName} field`}>
          <div className="acx-group-label acx-crm-head">
            <button className="acx-back" onClick={() => setCrmView(false)} aria-label="Back">‹</button>
            From {crm.providerName}
          </div>
          <input
            className="acx-name"
            placeholder="Search fields…"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
          <div className="acx-group acx-crm-fields">
            {crmFields === null && !crmError ? (
              <div className="acx-crm-empty"><span className="cell-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /></div>
            ) : shown.length === 0 && !crmError ? (
              <div className="acx-crm-empty">Every field from this source is already synced.</div>
            ) : (
              shown.map((f) => (
                <button key={f.attrSlug} className="acx-item" onClick={() => void addCrmField(f)} disabled={saving}>
                  <span className="acx-item-icon"><img src={crm.logo} alt="" width={15} height={15} /></span>
                  <span className="acx-item-text">
                    <span className="acx-item-title">{f.title}</span>
                    <span className="acx-item-sub">{f.sample || "no sample values"}</span>
                  </span>
                  <span className="acx-type-add">Add</span>
                </button>
              ))
            )}
            {crmError && <div className="acx-crm-error" role="alert">{crmError}</div>}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="addcol acx" style={style} overlayClassName="bare-scrim" srTitle="Add column">
        <input
          className="acx-name"
          placeholder="Column name…"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add("text")}
        />

        {crm && (
          <div className="acx-group">
            <div className="acx-group-label">Synced source</div>
            <button className="acx-item" onClick={() => void openCrmView()}>
              <span className="acx-item-icon"><img src={crm.logo} alt="" width={15} height={15} /></span>
              <span className="acx-item-text">
                <span className="acx-item-title">From {crm.providerName}</span>
                <span className="acx-item-sub">Add another field from this source</span>
              </span>
              <span className="acx-item-caret">{Chevron}</span>
            </button>
          </div>
        )}

        {/* Actions — pipelines retain this table as attachment context. */}
        <div className="acx-group">
          <div className="acx-group-label">Automation &amp; enrichment</div>
          {onUsePipeline && (
            <button className="acx-item" onClick={() => void addPipelineColumn()} disabled={saving}>
              <span className="acx-item-icon acx-icon-pipeline">{PipelineGlyph}</span>
              <span className="acx-item-text">
                <span className="acx-item-title">Pipeline</span>
                <span className="acx-item-sub">Use an existing pipeline or create a new one</span>
              </span>
              <span className="acx-item-caret">{Chevron}</span>
            </button>
          )}
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
      </DialogContent>
    </Dialog>
  );
}

// ─── Functions browser ───────────────────────────────────

export interface FunctionChoice {
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

// Nav clusters — categories grouped with a divider line between each group.
// "All" is rendered first and sits with the AI cluster (no line in between).
const NAV_CLUSTERS: string[][] = [
  ["AI", "Formula"],
  ["Enrich people", "Enrich company", "Find email", "Verify email", "Find phone", "Search"],
  ["Formatting", "Scoring", "Verification", "Scraping", "Extraction"],
  ["Tables"],
  ["Ads", "Jobs", "Signals"],
];

export function FunctionsModal({
  tableId,
  connectors,
  onClose,
  onAdded,
  onSelected,
  onOpenAiSettings,
}: {
  tableId?: string;
  connectors: ConnectorInfo[];
  onClose: () => void;
  /** Fired after the column is created. Carries the new column (desktop shape)
   *  so the parent can open the edit panel on it — the Clay flow: picking a
   *  function ADDS the column immediately, configuration happens in the rail. */
  onAdded?: (col?: Column) => void;
  /** Selection-only mode used by the pipeline canvas. Configuration continues
   * in the workflow node inspector instead of creating a table column. */
  onSelected?: (fn: FunctionChoice) => void;
  onOpenAiSettings?: () => void;
}) {
  const gridApi = useColumnApi();
  const [adding, setAdding] = useState(false);
  const [addErr, setAddErr] = useState("");

  // Add the chosen function as a column with default config, then hand the new
  // column to the parent so the ColumnEditPanel opens for mapping/settings.
  const useFn = async (f: FunctionChoice) => {
    if (adding) return;
    if (onSelected) {
      onSelected(f);
      onClose();
      return;
    }
    if (!tableId || !onAdded) return;
    setAdding(true);
    setAddErr("");
    try {
      const name = f.label;
      // JSON-output providers default the column type to json (drill-in works).
      const type = f.provider === "http" || f.provider === "table" ? "json" : "text";
      const res = await gridApi.addColumn(tableId, { name, type, fn: f.fnKey, params: {} });
      onAdded({
        id: res.id,
        name,
        type,
        kind: "function",
        provider: f.provider,
        method: f.fnKey.split(".")[1] ?? null,
        fn: f.fnKey,
        code: null,
        params: {},
        condition: null,
      });
      onClose();
    } catch (e) {
      setAddErr((e as Error)?.message ?? "Failed to add column");
      setAdding(false);
    }
  };
  const fns: FunctionChoice[] = useMemo(
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
          category: categorize(c.provider, m.category),
        })),
      ),
    [connectors],
  );

  const [query, setQuery] = useState("");
  const [nav, setNav] = useState<string>("All"); // "All" | category | "__provider"
  const [selected, setSelected] = useState<FunctionChoice | null>(null);

  const q = query.trim().toLowerCase();
  const matched = q
    ? fns.filter((f) => f.label.toLowerCase().includes(q) || f.providerName.toLowerCase().includes(q) || f.description.toLowerCase().includes(q))
    : fns;

  // categories present, in canonical order
  const presentCats = CATEGORY_ORDER.filter((cat) => fns.some((f) => f.category === cat));

  // Build the grouped middle list depending on the nav selection.
  const groups: { label: string; items: FunctionChoice[] }[] = useMemo(() => {
    let list = matched;
    if (nav !== "All" && nav !== "__provider") list = list.filter((f) => f.category === nav);

    if (nav === "__provider") {
      const byProvider = new Map<string, FunctionChoice[]>();
      for (const f of list) {
        if (!byProvider.has(f.providerName)) byProvider.set(f.providerName, []);
        byProvider.get(f.providerName)!.push(f);
      }
      return [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, items]) => ({ label, items }));
    }

    // group by category (canonical order); methods that fit no category are
    // listed under "Other" in the All view ONLY — never miscategorised.
    const order = nav === "All" ? [...presentCats, OTHER_CATEGORY] : [nav];
    return order
      .map((cat) => ({ label: cat, items: list.filter((f) => f.category === cat) }))
      .filter((g) => g.items.length > 0);
  }, [matched, nav, presentCats]);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="fnx" srTitle="Functions">
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

          {/* right detail — read-only info; "Add to table" creates the column
              immediately and configuration continues in the edit panel */}
          <div className="fnx-detail">
            {selected ? (
              <FunctionDetail
                key={selected.fnKey}
                fn={selected}
                busy={adding}
                err={addErr}
                onUse={() => void useFn(selected)}
                actionLabel={onSelected ? "Add to pipeline" : "Add to table"}
                actionHint={onSelected ? "Adds this function as a node, then opens its workflow configuration." : "Adds the column right away — map inputs and run settings in the editor that opens."}
                onOpenAiSettings={onOpenAiSettings}
              />
            ) : (
              <div className="fnx-detail-empty">
                <div className="fnx-detail-empty-title">Select a function</div>
                <div className="fnx-detail-empty-sub">{onSelected ? "Choose from the list to inspect its inputs, then add it as a workflow node." : "Choose from the list to see its inputs, then add it as a column and map it in the editor"}</div>
              </div>
            )}
          </div>
        </div>

        <div className="fnx-footer">{fns.length} functions</div>
      </DialogContent>
    </Dialog>
  );
}

/** Read-only function preview (inputs / output / source). The Clay flow: there
 *  is no inline configure step — "Add to table" creates the column with default
 *  config and the parent opens the ColumnEditPanel for mapping + run settings. */
function FunctionDetail({
  fn,
  busy,
  err,
  onUse,
  actionLabel,
  actionHint,
  onOpenAiSettings,
}: {
  fn: FunctionChoice;
  busy: boolean;
  err: string;
  onUse: () => void;
  actionLabel: string;
  actionHint: string;
  onOpenAiSettings?: () => void;
}) {
  const props = (fn.input?.properties ?? {}) as Record<string, { description?: string; type?: string }>;
  const required = new Set((fn.input?.required as string[] | undefined) ?? []);
  const paramKeys = Object.keys(props);
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

        {fn.provider === "ai" && onOpenAiSettings && (
          <p className="params-hint">
            Models come from your connected AI providers.{" "}
            <button className="ai-link" onClick={onOpenAiSettings}>Manage providers</button>
          </p>
        )}
      </div>

      {err && <div className="conn-err">{err}</div>}

      <button className="btn btn-primary fnx-cfg-add" onClick={onUse} disabled={busy}>
        {busy ? "Adding…" : actionLabel}
      </button>
      <p className="params-hint fnx-cfg-addhint">{actionHint}</p>
    </div>
  );
}

// ─── Formula column (shared building blocks) ─────────────

const SparkleIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" /></svg>
);

/** A textarea with the shared "/" column-insertion menu (mirrors AiGenerateDetail).
 *  Pass `footer` to render an in-box footer bar (a hint + e.g. a Generate button),
 *  which also draws the border around the textarea+footer as one box. */
export function SlashTextarea({
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
export function FormulaInput({
  value, setValue, columns, mode = "formula", rows = 4, placeholder,
}: {
  value: string;
  setValue: (v: string) => void;
  columns: string[];
  mode?: "formula" | "condition";
  rows?: number;
  placeholder?: string;
}) {
  const gridApi = useColumnApi();
  const [genOpen, setGenOpen] = useState(false);
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const generate = async () => {
    if (!desc.trim()) { setErr("Describe it first"); return; }
    setBusy(true);
    setErr("");
    try {
      const r = await gridApi.generateFormula(desc.trim(), columns, mode);
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
            {busy ? <span className="gen-spinner" /> : "Generate"}
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
export function RunSettings({
  condition, setCondition, columns,
}: {
  condition: string;
  setCondition: (v: string) => void;
  columns: string[];
}) {
  const gridApi = useColumnApi();
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
      const r = await gridApi.generateFormula(desc.trim(), columns, "condition");
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
                  {busy ? <span className="gen-spinner" /> : <span className="formula-gen-spark">{SparkleIcon}</span>}
                  {busy ? "Generating…" : "Generate"}
                </button>
              </div>
            }
          />
          {err && <div className="conn-err run-cond-err">{err}</div>}
          <input
            className="form-input formula-mono run-cond-formula"
            placeholder="E.g., !!{{Company Domain}}"
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            spellCheck={false}
          />
          <p className="params-hint">A JavaScript boolean expression — describe it above and Generate, or write it directly. When false, the column skips that row (no run, no credits).</p>
        </div>
      )}
    </div>
  );
}

export const FX_TYPES: Array<[string, string]> = [
  ["text", "Text"],
  ["number", "Number"],
  ["boolean", "Boolean"],
  ["date", "Date"],
  ["json", "JSON"],
];

// ─── HTTP request (dedicated rich form) ──────────────────
// A full request builder — Method, Endpoint (with "/" column chips), Query and
// Header key/value editors, Body, plus response shaping (pick fields, remove
// empties, metadata) and transport options (redirects, timeout, retries). Shared
// by the add-column detail and the edit modal so both render identically.

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

interface KV {
  key: string;
  value: string;
}
interface HttpState {
  method: string;
  url: string;
  query: KV[];
  body: string;
  headers: KV[];
  responseFields: string;
  removeEmpty: boolean;
  returnMetadata: boolean;
  followRedirects: boolean;
  maxRedirects: string;
  timeout: string;
  retryOnFailure: boolean;
  maxRetries: string;
}

function kvFromObj(o: unknown): KV[] {
  return o && typeof o === "object" && !Array.isArray(o)
    ? Object.entries(o as Record<string, unknown>).map(([key, v]) => ({ key, value: v == null ? "" : String(v) }))
    : [];
}
function kvToObj(pairs: KV[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of pairs) if (key.trim()) out[key.trim()] = value;
  return out;
}

function httpStateFromParams(p: Record<string, unknown>): HttpState {
  return {
    method: typeof p.method === "string" ? p.method : "GET",
    url: typeof p.url === "string" ? p.url : "",
    query: kvFromObj(p.query),
    body: typeof p.body === "string" ? p.body : p.body != null ? JSON.stringify(p.body, null, 2) : "",
    headers: kvFromObj(p.headers),
    responseFields: Array.isArray(p.responseFields)
      ? (p.responseFields as string[]).join("\n")
      : typeof p.responseFields === "string"
        ? p.responseFields
        : "",
    removeEmpty: p.removeEmpty !== false,
    returnMetadata: !!p.returnMetadata,
    followRedirects: p.followRedirects !== false,
    maxRedirects: p.maxRedirects != null ? String(p.maxRedirects) : "",
    timeout: p.timeout != null ? String(p.timeout) : "",
    retryOnFailure: p.retryOnFailure !== false,
    maxRetries: p.maxRetries != null ? String(p.maxRetries) : "",
  };
}

function httpStateToParams(s: HttpState): Record<string, unknown> {
  const params: Record<string, unknown> = { method: s.method, url: s.url.trim() };
  const q = kvToObj(s.query);
  if (Object.keys(q).length) params.query = q;
  const h = kvToObj(s.headers);
  if (Object.keys(h).length) params.headers = h;
  if (s.body.trim()) {
    // A JSON object/array body is stored typed (so the connector sends it as
    // application/json); anything else (incl. {{templated}} strings) stays raw.
    try {
      const parsed = JSON.parse(s.body);
      params.body = parsed && typeof parsed === "object" ? parsed : s.body;
    } catch {
      params.body = s.body;
    }
  }
  const rf = s.responseFields
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (rf.length) params.responseFields = rf;
  params.removeEmpty = s.removeEmpty;
  params.returnMetadata = s.returnMetadata;
  params.followRedirects = s.followRedirects;
  params.retryOnFailure = s.retryOnFailure;
  const mr = parseInt(s.maxRedirects, 10);
  if (!Number.isNaN(mr)) params.maxRedirects = mr;
  const to = parseInt(s.timeout, 10);
  if (!Number.isNaN(to)) params.timeout = to;
  const mx = parseInt(s.maxRetries, 10);
  if (!Number.isNaN(mx)) params.maxRetries = mx;
  return params;
}

/** A repeatable key/value editor (headers, query params). Values autocomplete to {{Column}}. */
function KeyValueEditor({
  pairs, onChange, listId, valuePlaceholder = "Value or {{Column}}",
}: {
  pairs: KV[];
  onChange: (pairs: KV[]) => void;
  listId: string;
  valuePlaceholder?: string;
}) {
  const setPair = (i: number, patch: Partial<KV>) => onChange(pairs.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  return (
    <div className="http-kv">
      {pairs.map((p, i) => (
        <div className="http-kv-row" key={i}>
          <input className="form-input http-kv-key" placeholder="Key" value={p.key} onChange={(e) => setPair(i, { key: e.target.value })} />
          <input className="form-input http-kv-val" list={listId} placeholder={valuePlaceholder} value={p.value} onChange={(e) => setPair(i, { value: e.target.value })} />
          <button className="http-kv-del" type="button" title="Remove" onClick={() => onChange(pairs.filter((_, idx) => idx !== i))}>{X}</button>
        </div>
      ))}
      <button className="http-kv-add" type="button" onClick={() => onChange([...pairs, { key: "", value: "" }])}>+ Add {pairs.length ? "another" : "row"}</button>
    </div>
  );
}

/** A collapsible "— Optional" field section, mirroring the request-builder layout. */
export function HttpField({ title, optional, defaultOpen, children }: { title: string; optional?: boolean; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="http-field">
      <button type="button" className="http-field-head" onClick={() => setOpen((o) => !o)}>
        <span className={`http-field-caret${open ? " open" : ""}`}>{Chevron}</span>
        <span className="http-field-name">{title}</span>
        {optional && <span className="http-field-opt">— Optional</span>}
      </button>
      {open && <div className="http-field-body">{children}</div>}
    </div>
  );
}

/** A label + iOS-style switch row for boolean options. */
function HttpToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="http-toggle">
      <span className="http-toggle-label">{label} <span className="http-field-opt">— Optional</span></span>
      <span className={`http-switch${checked ? " on" : ""}`}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="http-switch-knob" />
      </span>
    </label>
  );
}

/** The shared HTTP request field set. Reports serialized params via onChange on every edit. */
export function HttpRequestForm({
  columns, initial, onChange,
}: {
  columns: string[];
  initial?: Record<string, unknown>;
  onChange: (params: Record<string, unknown>) => void;
}) {
  const [s, setS] = useState<HttpState>(() => httpStateFromParams(initial ?? {}));
  const upd = (patch: Partial<HttpState>) => setS((prev) => ({ ...prev, ...patch }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { onChange(httpStateToParams(s)); }, [s]);
  const listId = "http-col-values";

  return (
    <div className="http-form">
      <datalist id={listId}>{columns.map((c) => <option key={c} value={`{{${c}}}`} />)}</datalist>

      <label className="form-label">Method</label>
      <select className="form-input form-select" value={s.method} onChange={(e) => upd({ method: e.target.value })}>
        {HTTP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>

      <label className="form-label">Endpoint <span className="fnx-param-req">*</span></label>
      <SlashTextarea value={s.url} onChange={(v) => upd({ url: v })} columns={columns} rows={2} className="formula-mono" placeholder="https://api.example.com/v1/search?id={{Id}}  ·  type / to insert a column" />

      <HttpField title="Query parameters" optional defaultOpen={s.query.length > 0}>
        <KeyValueEditor pairs={s.query} onChange={(query) => upd({ query })} listId={listId} />
      </HttpField>

      <HttpField title="Body" optional defaultOpen={!!s.body}>
        <SlashTextarea value={s.body} onChange={(v) => upd({ body: v })} columns={columns} rows={5} className="formula-mono" placeholder={'{ "domain": "{{Domain}}" }  ·  JSON or raw text, type / to insert a column'} />
      </HttpField>

      <HttpField title="Headers" optional defaultOpen={s.headers.length > 0}>
        <KeyValueEditor pairs={s.headers} onChange={(headers) => upd({ headers })} listId={listId} valuePlaceholder="e.g. Bearer {{API Key}}" />
      </HttpField>

      <HttpField title="Response values to return" optional defaultOpen={!!s.responseFields}>
        <textarea className="form-input ai-textarea formula-mono" rows={3} spellCheck={false} value={s.responseFields} placeholder={"email\ncompany.name\nresults.0.id"} onChange={(e) => upd({ responseFields: e.target.value })} />
        <p className="params-hint">One dot-path per line. Leave empty to return the whole response.</p>
      </HttpField>

      <HttpToggle label="Remove empty values" checked={s.removeEmpty} onChange={(removeEmpty) => upd({ removeEmpty })} />
      <HttpToggle label="Return response metadata" checked={s.returnMetadata} onChange={(returnMetadata) => upd({ returnMetadata })} />
      <HttpToggle label="Follow redirects" checked={s.followRedirects} onChange={(followRedirects) => upd({ followRedirects })} />

      {s.followRedirects && (
        <HttpField title="Max redirects" optional>
          <input className="form-input" type="number" min={0} value={s.maxRedirects} placeholder="5" onChange={(e) => upd({ maxRedirects: e.target.value })} />
        </HttpField>
      )}

      <HttpField title="Response timeout (ms)" optional defaultOpen={!!s.timeout}>
        <input className="form-input" type="number" min={1} value={s.timeout} placeholder="30000" onChange={(e) => upd({ timeout: e.target.value })} />
      </HttpField>

      <HttpToggle label="Retry on failure" checked={s.retryOnFailure} onChange={(retryOnFailure) => upd({ retryOnFailure })} />
      {s.retryOnFailure && (
        <HttpField title="Max retries" optional>
          <input className="form-input" type="number" min={0} value={s.maxRetries} placeholder="3" onChange={(e) => upd({ maxRetries: e.target.value })} />
        </HttpField>
      )}
    </div>
  );
}

function previewValueText(v: unknown): string {
  if (v === undefined) return "(no value)";
  const s = v === null ? "null" : typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 220 ? s.slice(0, 220) + "…" : s;
}

/** "Try on N rows" — dry-runs the current request against the first N rows and shows
 *  each result inline, without saving the column or writing any cell. */
export function TryRowsButton({
  tableId, provider, method, params, limit = 5,
}: {
  tableId: string;
  provider: string;
  method: string;
  params: Record<string, unknown>;
  limit?: number;
}) {
  const gridApi = useColumnApi();
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Array<{ rowId: string; value?: unknown; error?: string }> | null>(null);
  const [err, setErr] = useState("");
  // Only the HTTP connector needs an endpoint before it can preview; other
  // providers dry-run with whatever params are mapped.
  const noUrl = provider === "http" && !String(params.url ?? "").trim();

  const run = async () => {
    setBusy(true); setErr(""); setResults(null);
    try {
      const r = await gridApi.previewFunction(tableId, { provider, method, params, limit });
      setResults(r.results);
    } catch (e) {
      setErr((e as Error)?.message ?? "Preview failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="http-try">
      <button type="button" className="btn btn-outline btn-sm" onClick={run} disabled={busy || noUrl} title={noUrl ? "Add an endpoint first" : undefined}>
        {busy ? "Running…" : `Try on ${limit} rows`}
      </button>
      {err && <div className="conn-err http-try-errbox">{err}</div>}
      {results && (
        <div className="http-try-results">
          {results.length === 0 ? (
            <div className="http-try-empty">No rows yet — add rows to the table to preview.</div>
          ) : (
            results.map((r, i) => (
              <div key={r.rowId} className={`http-try-row${r.error ? " is-err" : ""}`}>
                <span className="http-try-idx">{i + 1}</span>
                {r.error
                  ? <span className="http-try-msg is-err">{r.error}</span>
                  : <code className="http-try-msg">{previewValueText(r.value)}</code>}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
