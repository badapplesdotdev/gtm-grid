// ColumnEditPanel — the Clay-style right-rail column editor (replaces the old
// centered ColumnSettingsModal). Opened from the column header (Edit column /
// right-click), it shows the FULL configuration that executes on every run:
//
//   provider identity → account status → name → input mappings (required
//   first, each bound to a source column via a typed dropdown) → the
//   kind-specific body (AI prompt / formula / HTTP request / custom code) →
//   run settings ("only run if") → preview → a Save split-button
//   (run 10 rows / run all / save only).
//
// The point: a column an AI agent configured via MCP is exactly as legible and
// re-runnable as one a human built — the panel renders the stored config, and
// the engine re-executes that same config on Save & run. Works in both
// environments via the injected ColumnAuthoringApi (local sidecar or cloud).

import { useEffect, useMemo, useRef, useState } from "react";
import { api, type AiProviderInfo, type Column, type ConnectorInfo, type ExtensionInfo } from "./api";
import {
  useColumnApi,
  SlashTextarea,
  FormulaInput,
  RunSettings,
  HttpRequestForm,
  TryRowsButton,
  HttpField,
  TYPE_ICONS,
  FX_TYPES,
} from "./AddColumn";
import { FnIcon, CATEGORY_ICON, categorize, buildColumnMetaMap } from "./FnIcon";

const X = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
);
const Chevron = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
);
const Check = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
);

export interface PanelColumnRef {
  id: string;
  name: string;
  type: string;
}

/** Extract `Name` from a pure `{{Name}}` mapping (whitespace-tolerant). */
function pureColumnRef(value: string): string | null {
  const m = value.match(/^\{\{\s*(.+?)\s*\}\}$/);
  return m ? m[1] : null;
}

/** One input param bound to a source column (typed dropdown) or a custom
 *  value/template (slash-aware text). Mirrors Clay's "Column mapping" rows. */
function MappingField({
  paramKey,
  required,
  description,
  value,
  onChange,
  columns,
}: {
  paramKey: string;
  required: boolean;
  description?: string;
  value: string;
  onChange: (v: string) => void;
  columns: PanelColumnRef[];
}) {
  const ref = pureColumnRef(value);
  const matched = ref ? columns.find((c) => c.name === ref) : undefined;
  // Pure column ref (or empty) renders as a dropdown; anything else (literal,
  // mixed template) as the custom text mode.
  const [mode, setMode] = useState<"column" | "custom">(matched || value.trim() === "" ? "column" : "custom");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const missing = required && value.trim() === "";

  return (
    <div className={`cep-map${missing ? " cep-map-missing" : ""}`}>
      <div className="cep-map-label-row">
        <label className="fnx-param-label">
          {paramKey}
          {required && <span className="fnx-param-req">*</span>}
        </label>
        <button
          type="button"
          className="cep-map-mode"
          onClick={() => {
            if (mode === "custom") onChange("");
            setMode(mode === "column" ? "custom" : "column");
            setOpen(false);
          }}
        >
          {mode === "column" ? "Use custom value" : "Map a column"}
        </button>
      </div>
      {description && <div className="cep-map-desc">{description}</div>}

      {mode === "column" ? (
        <div className="ai-select" ref={wrapRef}>
          <button type="button" className="form-input ai-select-btn" onClick={() => setOpen((o) => !o)}>
            {matched ? (
              <span className="cep-map-sel">
                <span className="cep-type-icon">{TYPE_ICONS[matched.type] ?? TYPE_ICONS.text}</span>
                {matched.name}
              </span>
            ) : (
              <span className="ai-select-placeholder">{ref ? `{{${ref}}} — column not found` : "Select a column…"}</span>
            )}
            <span className={`ai-select-caret${open ? " open" : ""}`}>{Chevron}</span>
          </button>
          {open && (
            <div className="ai-select-menu">
              {columns.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`ai-select-item${matched?.id === c.id ? " active" : ""}`}
                  onClick={() => { onChange(`{{${c.name}}}`); setOpen(false); }}
                >
                  <span className="ai-select-check">{matched?.id === c.id ? Check : null}</span>
                  <span className="cep-type-icon">{TYPE_ICONS[c.type] ?? TYPE_ICONS.text}</span>
                  <span className="ai-select-item-label">{c.name}</span>
                </button>
              ))}
              {!required && (
                <button
                  type="button"
                  className="ai-select-item"
                  onClick={() => { onChange(""); setOpen(false); }}
                >
                  <span className="ai-select-check">{!value.trim() ? Check : null}</span>
                  <span className="ai-select-item-label cep-map-none">Leave empty</span>
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <SlashTextarea
          value={value}
          onChange={onChange}
          columns={columns.map((c) => c.name)}
          rows={1}
          placeholder={`Value or template — type / to insert a column`}
        />
      )}
    </div>
  );
}

/** Clay-style save split-button: a primary action + a caret menu of run scopes. */
function SaveSplitButton({
  saving,
  onSave,
  rowCount,
}: {
  saving: boolean;
  onSave: (run?: { force?: boolean; rowIds?: "first10" | "all" }) => void;
  rowCount: number;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const n10 = Math.min(10, rowCount);
  return (
    <div className="cep-save" ref={wrapRef}>
      <button
        className="btn btn-primary cep-save-main"
        disabled={saving}
        onClick={() => onSave(rowCount > 0 ? { force: true, rowIds: "first10" } : undefined)}
      >
        {saving ? "Saving…" : rowCount > 0 ? `Save & run ${n10} row${n10 !== 1 ? "s" : ""}` : "Save"}
      </button>
      <button className="btn btn-primary cep-save-caret" disabled={saving} onClick={() => setOpen((o) => !o)}>
        {Chevron}
      </button>
      {open && (
        <div className="cep-save-menu">
          <button className="ctx-item" onClick={() => { setOpen(false); onSave({ force: true, rowIds: "all" }); }}>
            Save &amp; run all rows
          </button>
          <button className="ctx-item" onClick={() => { setOpen(false); onSave(undefined); }}>
            Save without running
          </button>
        </div>
      )}
    </div>
  );
}

export function ColumnEditPanel({
  column,
  columns,
  connectors,
  tableId,
  rows,
  onClose,
  onSaved,
  onOpenExtension,
}: {
  column: Column;
  /** All of the table's columns (the panel filters out the edited one). */
  columns: PanelColumnRef[];
  connectors: ConnectorInfo[];
  tableId?: string;
  rows: Array<{ id: string }>;
  onClose: () => void;
  /** Fired after a successful save; `run` asks the parent to run the column
   *  with that scope (the Save split-button's choice). */
  onSaved: (run?: { force?: boolean; rowIds?: string[] }) => void;
  /** Open the provider's extension panel (local only — manage the API key). */
  onOpenExtension?: (providerId: string) => void;
}) {
  const gridApi = useColumnApi();
  const isFormula = column.provider === "formula" || column.fn === "formula.eval";
  const isAi = column.provider === "ai";
  const isHttp = column.provider === "http";
  const isCode = !column.provider && column.fn === "code";
  const isFunction = !!column.provider || !!column.fn;
  const isEnrichment = isFunction && !isFormula && !isAi && !isHttp && !isCode;
  const p: Record<string, unknown> = column.params ?? {};

  // ── Identity: resolve the connector + method this column executes ──
  const connector = useMemo(
    () => connectors.find((c) => c.provider === column.provider) ?? null,
    [connectors, column.provider],
  );
  const methodInfo = useMemo(
    () => connector?.methods.find((m) => m.method === column.method) ?? null,
    [connector, column.method],
  );
  const meta = useMemo(() => {
    const map = buildColumnMetaMap(connectors);
    return column.fn ? map.get(column.fn) ?? null : null;
  }, [connectors, column.fn]);
  const identity = meta ?? {
    providerName: column.provider ?? (isCode ? "Code" : "Column"),
    logo: null,
    methodLabel: column.method ?? (isCode ? "code" : column.type),
    category: isCode ? "Code" : categorize(column.provider ?? "", connector?.category ?? "", "", ""),
    credits: undefined as number | undefined,
  };

  // ── Input mapping state (connector columns) ──
  // Field order: the method's schema (required first), then any extra params
  // the author (human or agent) set that the schema doesn't know about.
  const schemaProps = (methodInfo?.input?.properties ?? {}) as Record<string, { description?: string; type?: string }>;
  const requiredKeys = new Set(((methodInfo?.input as { required?: string[] } | null | undefined)?.required ?? []).map(String));
  const orderedSchemaKeys = useMemo(() => {
    const keys = Object.keys(schemaProps);
    return [...keys.filter((k) => requiredKeys.has(k)), ...keys.filter((k) => !requiredKeys.has(k))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [methodInfo]);
  const extraKeys = isEnrichment ? Object.keys(p).filter((k) => !(k in schemaProps)) : [];

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
  // http: the full request builder reports serialized params on every edit
  const [httpParams, setHttpParams] = useState<Record<string, unknown>>(p);
  // enrichment: every schema key (even unset ones — so missing required inputs
  // are visible and mappable) + any extra agent-set params
  const [params, setParams] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    if (isEnrichment) {
      for (const k of orderedSchemaKeys) {
        const v = p[k];
        out[k] = v == null ? "" : typeof v === "string" ? v : String(v);
      }
      for (const k of extraKeys) {
        const v = p[k];
        out[k] = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
      }
    }
    return out;
  });
  const [aiProviderList, setAiProviderList] = useState<AiProviderInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // ── Account / credential status (connector columns with auth) ──
  const [ext, setExt] = useState<ExtensionInfo | null | undefined>(undefined);
  useEffect(() => {
    if (!isEnrichment || !column.provider || !connector?.requiresCredential) return;
    let on = true;
    api.extensions()
      .then((list) => { if (on) setExt(list.find((e) => e.id === column.provider) ?? null); })
      .catch(() => { if (on) setExt(null); });
    return () => { on = false; };
  }, [isEnrichment, column.provider, connector?.requiresCredential]);

  useEffect(() => {
    if (!isAi) return;
    gridApi.aiProviders().then(setAiProviderList).catch(() => {});
  }, [isAi, gridApi]);
  const models = aiProviderList.filter((p) => p.connected).flatMap((p) => p.models);
  // The AI provider whose catalog contains the column's CURRENT model — its
  // identity (Anthropic, OpenAI, Hermes, OpenRouter…) brands the column.
  const aiModelProvider = isAi && model ? aiProviderList.find((p) => p.models.includes(model)) ?? null : null;

  // A column should never reference itself in an expression/condition/mapping.
  const otherColumns = columns.filter((c) => c.id !== column.id);
  const otherColumnNames = otherColumns.map((c) => c.name);

  const buildPatch = () => {
    const patch: Parameters<typeof gridApi.updateColumn>[1] = {
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
    } else if (isHttp) {
      patch.params = httpParams;
    } else if (isEnrichment) {
      // Merge edited mappings over the original params; drop keys cleared to "".
      const np: Record<string, unknown> = { ...p };
      for (const [k, v] of Object.entries(params)) {
        if (v.trim()) np[k] = v;
        else delete np[k];
      }
      patch.params = np;
    } else if (!isFunction) {
      patch.type = type; // manual column
    }
    return patch;
  };

  const save = async (run?: { force?: boolean; rowIds?: "first10" | "all" }) => {
    if (!name.trim()) { setErr("Column name is required"); return; }
    setSaving(true);
    setErr("");
    try {
      await gridApi.updateColumn(column.id, buildPatch());
      onSaved(
        run
          ? {
              force: run.force,
              rowIds: run.rowIds === "first10" ? rows.slice(0, 10).map((r) => r.id) : undefined,
            }
          : undefined,
      );
      onClose();
    } catch (e) {
      setErr((e as Error)?.message ?? "Failed to save");
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

  const previewMethod = column.fn === "code" ? null : column.method;

  return (
    <aside className="col-panel">
      {/* ── Identity: what this column executes ── */}
      <header className="cep-head">
        <span className="cep-head-icon">
          {isAi ? (
            // AI columns wear the MODEL's provider identity (Anthropic, OpenAI,
            // Hermes, OpenRouter…); brain glyph until a model is picked.
            <FnIcon
              fn={{ logo: aiModelProvider?.logo ?? null, providerName: aiModelProvider?.name ?? "AI", category: "AI" }}
              size={26}
            />
          ) : isFormula || isCode ? (
            <span className="fn-cat-icon" style={{ width: 26, height: 26 }}>
              {CATEGORY_ICON[isFormula ? "Formula" : "Code"]}
            </span>
          ) : (
            <FnIcon fn={{ logo: identity.logo, providerName: identity.providerName, category: identity.category }} size={26} />
          )}
        </span>
        <div className="cep-head-text">
          <div className="cep-head-title">
            {isAi
              ? `${aiModelProvider?.name ?? "AI"} · ${model || "Generate"}`
              : isFunction
                ? `${identity.providerName} · ${identity.methodLabel}`
                : "Edit column"}
          </div>
          <div className="cep-head-sub">
            {methodInfo?.description ?? (isAi ? "Generate text using any connected LLM" : isFormula ? "Compute a value per row with JavaScript" : isHttp ? "Call any API endpoint" : isCode ? "Custom code — runs the function below per row" : "Manual column")}
          </div>
        </div>
        {identity.credits != null && identity.credits > 0 && (
          <span className="cep-credits" title="Credits consumed per row">{identity.credits}/row</span>
        )}
        <button className="cd-icon-btn" onClick={onClose} title="Close">{X}</button>
      </header>

      <div className="cep-body">
        {/* ── Account / credential status ── */}
        {isEnrichment && connector?.requiresCredential && ext !== undefined && (
          <div className="cep-account">
            <span className={`cep-account-dot${ext?.connected ? " on" : ""}`} />
            <span className="cep-account-text">
              {ext?.connected ? `${identity.providerName} account connected` : `No ${identity.providerName} API key — runs will fail`}
            </span>
            {onOpenExtension && column.provider && (
              <button className="ai-link" onClick={() => { onClose(); onOpenExtension(column.provider!); }}>
                Manage
              </button>
            )}
          </div>
        )}

        <label className="form-label">Column name</label>
        <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} />

        {/* ── Column mapping (connector columns) ── */}
        {isEnrichment && (orderedSchemaKeys.length > 0 || extraKeys.length > 0) && (
          <>
            <div className="fnx-cfg-section">Column mapping</div>
            {orderedSchemaKeys.filter((k) => requiredKeys.has(k)).map((k) => (
              <MappingField
                key={k}
                paramKey={k}
                required
                description={schemaProps[k]?.description}
                value={params[k] ?? ""}
                onChange={(v) => setParams((prev) => ({ ...prev, [k]: v }))}
                columns={otherColumns}
              />
            ))}
            {orderedSchemaKeys.some((k) => !requiredKeys.has(k)) && (
              <HttpField
                title="Optional inputs"
                optional
                defaultOpen={orderedSchemaKeys.some((k) => !requiredKeys.has(k) && (params[k] ?? "").trim() !== "")}
              >
                {orderedSchemaKeys.filter((k) => !requiredKeys.has(k)).map((k) => (
                  <MappingField
                    key={k}
                    paramKey={k}
                    required={false}
                    description={schemaProps[k]?.description}
                    value={params[k] ?? ""}
                    onChange={(v) => setParams((prev) => ({ ...prev, [k]: v }))}
                    columns={otherColumns}
                  />
                ))}
              </HttpField>
            )}
            {extraKeys.length > 0 && (
              <>
                <div className="fnx-cfg-section">Other parameters</div>
                {extraKeys.map((k) => (
                  <div key={k} className="fnx-param">
                    <label className="fnx-param-label">{k}</label>
                    <input
                      className="form-input"
                      value={params[k] ?? ""}
                      onChange={(e) => setParams((prev) => ({ ...prev, [k]: e.target.value }))}
                      placeholder="value or {{Column}}"
                    />
                  </div>
                ))}
              </>
            )}
          </>
        )}

        {/* ── Kind-specific body: the exact thing the engine runs ── */}
        {isFormula && (
          <>
            <label className="form-label">Formula</label>
            <FormulaInput value={expression} setValue={setExpression} columns={otherColumnNames} mode="formula" placeholder={'{{Email}}.split("@")[1]'} />
            <label className="form-label">Output type</label>
            {TypePicker}
          </>
        )}

        {isAi && (
          <>
            <label className="form-label">Prompt</label>
            <SlashTextarea value={prompt} onChange={setPrompt} columns={otherColumnNames} rows={5} placeholder="Write a personalized opener for {{First Name}} at {{Company}}…" />
            <label className="form-label">System prompt <span className="form-label-opt">(optional)</span></label>
            <textarea className="form-input ai-textarea" rows={2} value={system} onChange={(e) => setSystem(e.target.value)} placeholder="You are a helpful assistant…" />
            <label className="form-label">Model</label>
            <input className="form-input" list="cep-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder="e.g. claude-haiku-4-5" />
            <datalist id="cep-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
            <label className="form-label">Max tokens <span className="form-label-opt">(optional)</span></label>
            <input className="form-input" type="number" min={1} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="512" />
          </>
        )}

        {isHttp && <HttpRequestForm columns={otherColumnNames} initial={p} onChange={setHttpParams} />}

        {isCode && (
          <>
            <div className="fnx-cfg-section">Code</div>
            <pre className="fnx-source cep-code"><code>{column.code ?? "(code unavailable)"}</code></pre>
            <p className="params-hint">This column runs the function above per row. Inputs come from its params{Object.keys(p).length ? ` (${Object.keys(p).map((k) => `${k}: ${typeof p[k] === "string" ? p[k] : JSON.stringify(p[k])}`).join(", ")})` : ""}.</p>
          </>
        )}

        {!isFunction && (
          <>
            <label className="form-label">Type</label>
            {TypePicker}
          </>
        )}

        {/* ── Run settings (only run if) ── */}
        {isFunction && <RunSettings condition={condition} setCondition={setCondition} columns={otherColumnNames} />}

        {/* ── Preview (dry-run, nothing saved or billed to cells) ── */}
        {isFunction && tableId && column.provider && previewMethod && (
          <TryRowsButton
            tableId={tableId}
            provider={column.provider}
            method={previewMethod}
            params={isHttp ? httpParams : isEnrichment ? params : p}
            limit={5}
          />
        )}

        {err && <div className="conn-err">{err}</div>}
      </div>

      <footer className="cep-foot">
        <button className="btn" onClick={onClose} disabled={saving}>Cancel</button>
        {isFunction ? (
          <SaveSplitButton saving={saving} onSave={save} rowCount={rows.length} />
        ) : (
          <button className="btn btn-primary" onClick={() => save()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </footer>
    </aside>
  );
}

export default ColumnEditPanel;
