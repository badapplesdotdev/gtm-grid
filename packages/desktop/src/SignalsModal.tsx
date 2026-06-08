// "From Signals" — pick a Trigify signal source, configure its criteria, and
// create a table that a local poller keeps filling with new results.

import { useEffect, useMemo, useRef, useState } from "react";
import { api, SignalSource } from "./api";

const SCHEDULES: { id: string; label: string }[] = [
  { id: "manual", label: "Manual" },
  { id: "hourly", label: "Hourly" },
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
];

// Fields surfaced in the main form (beyond `required`); the rest go under Advanced.
const COMMON = new Set([
  "keywords", "keywords_and", "keywords_not", "profile_url", "subreddit",
  "publication", "from_users", "github_repos", "time_frame", "max_results", "frequency",
]);

function humanize(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Turn one option token into {value,label}. "every-12h" → Every 12h; "0 (relevance)" → 0 — relevance. */
function optionOf(token: string): { value: string; label: string } {
  const t = token.trim();
  const paren = /^(\S+)\s*\((.+)\)$/.exec(t);
  if (paren) return { value: paren[1], label: `${paren[1]} — ${paren[2]}` };
  return { value: t, label: t.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) };
}

// Canonical Trigify option sets — used when the manifest field has no enum/description
// (many do not). Keyed by field name so every source gets consistent dropdowns.
const KNOWN_FIELD_OPTIONS: Record<string, string[]> = {
  time_frame: ["past-24h", "past-week", "past-month", "past-6-months", "past-year", "all-time"],
  frequency: ["hourly", "every-12h", "daily", "weekly", "monthly", "quarterly"],
  max_results: ["10", "25", "50", "100"],
};

/** Derive dropdown options for a field: explicit enum, a "a | b | c" description, a numeric range, or a known field. */
function fieldOptions(key: string, spec: any): { value: string; label: string }[] | null {
  if (Array.isArray(spec?.enum)) return spec.enum.map((o: string) => optionOf(String(o)));
  const desc = String(spec?.description ?? "");
  if (desc.includes(" | ")) return desc.split("|").map(optionOf);
  if ((spec?.type === "number" || spec?.type === "integer") && /(\d+)\s*-\s*(\d+)/.test(desc)) {
    const m = /(\d+)\s*-\s*(\d+)/.exec(desc)!;
    const min = +m[1], max = +m[2];
    const opts = [10, 25, 50, 100, 250, 500].filter((n) => n >= min && n <= max);
    return (opts.length ? opts : [min, max]).map((n) => ({ value: String(n), label: String(n) }));
  }
  if (KNOWN_FIELD_OPTIONS[key]) return KNOWN_FIELD_OPTIONS[key].map(optionOf);
  return null;
}

/** Chip/tag input: type a keyword, commit on Enter / comma / blur; × or Backspace removes. */
function TagInput({ tags, onChange, placeholder }: { tags: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const commit = (raw: string) => {
    const parts = raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = [...tags];
    for (const p of parts) if (!next.includes(p)) next.push(p);
    onChange(next);
    setText("");
  };
  return (
    <div className="sig-tags" onClick={() => inputRef.current?.focus()}>
      {tags.map((t, i) => (
        <span className="sig-tag" key={`${t}-${i}`}>
          {t}
          <button type="button" className="sig-tag-x" onClick={(e) => { e.stopPropagation(); onChange(tags.filter((_, j) => j !== i)); }}>×</button>
        </span>
      ))}
      <input
        ref={inputRef}
        className="sig-tags-input"
        value={text}
        placeholder={tags.length ? "" : placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commit(text); }
          else if (e.key === "Backspace" && !text && tags.length) onChange(tags.slice(0, -1));
        }}
        onBlur={() => commit(text)}
      />
    </div>
  );
}

/** Custom in-app dropdown (replaces the native <select>) with a styled popover menu. */
function Dropdown({
  value,
  options,
  placeholder = "Default",
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const selected = options.find((o) => o.value === value);
  return (
    <div className={`sig-dd${open ? " open" : ""}`} ref={ref}>
      <button type="button" className="sig-dd-btn" onClick={() => setOpen((o) => !o)}>
        <span className={selected ? "" : "sig-dd-ph"}>{selected ? selected.label : placeholder}</span>
        <svg className="sig-dd-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && (
        <div className="sig-dd-menu">
          <button type="button" className={`sig-dd-opt${!value ? " active" : ""}`} onClick={() => { onChange(""); setOpen(false); }}>{placeholder}</button>
          {options.map((o) => (
            <button type="button" key={o.value} className={`sig-dd-opt${o.value === value ? " active" : ""}`} onClick={() => { onChange(o.value); setOpen(false); }}>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SignalsModal({
  onClose,
  onCreated,
  onConnectTrigify,
}: {
  onClose: () => void;
  onCreated: (tableId: string, added: number) => void;
  onConnectTrigify: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [sources, setSources] = useState<SignalSource[]>([]);
  const [selected, setSelected] = useState<SignalSource | null>(null);
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("daily");
  const [values, setValues] = useState<Record<string, string | boolean | string[]>>({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.signalSources()
      .then((r) => {
        if (cancelled) return;
        setSources(r.sources);
        setConnected(r.trigifyConnected);
      })
      .catch(() => setError("Could not load signal sources."))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  const groups = useMemo(() => {
    const m = new Map<string, SignalSource[]>();
    for (const s of sources) {
      if (!m.has(s.group)) m.set(s.group, []);
      m.get(s.group)!.push(s);
    }
    return [...m.entries()];
  }, [sources]);

  const props = selected?.inputSchema?.properties ?? {};
  const required = new Set(selected?.inputSchema?.required ?? []);
  const fieldKeys = Object.keys(props).filter((k) => k !== "name");
  // Social-listening (keyword) searches get a Boolean OR/AND/NOT builder instead
  // of raw fields; everything else (time frame, max results, …) drops to Advanced.
  const BOOL_FIELDS = ["keywords", "keywords_and", "keywords_not"];
  const isKeywordSearch = "keywords" in props;
  const builderKeys = isKeywordSearch ? BOOL_FIELDS.filter((k) => k in props) : [];
  const nonBuilder = fieldKeys.filter((k) => !builderKeys.includes(k));
  // Scan settings (look-back, limit, scan frequency) get their own dropdown row in
  // the main form for keyword searches; the rest stay under Advanced.
  const SCAN_FIELDS = ["time_frame", "max_results", "frequency"];
  const mainKeys = isKeywordSearch ? [] : nonBuilder.filter((k) => required.has(k) || COMMON.has(k));
  const advancedKeys = isKeywordSearch
    ? nonBuilder.filter((k) => !SCAN_FIELDS.includes(k))
    : nonBuilder.filter((k) => !required.has(k) && !COMMON.has(k));

  const splitTerms = (raw: unknown): string[] =>
    Array.isArray(raw)
      ? raw.map((s) => String(s).trim()).filter(Boolean)
      : String(raw ?? "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  const queryPreview = (): string => {
    const or = splitTerms(values.keywords);
    const and = splitTerms(values.keywords_and);
    const not = splitTerms(values.keywords_not);
    let q = or.length > 1 ? `(${or.join(" OR ")})` : or[0] ?? "";
    for (const t of and) q = q ? `${q} AND ${t}` : t;
    if (not.length) q += `${q ? " " : ""}NOT (${not.join(" OR ")})`;
    return q;
  };

  const pick = (s: SignalSource) => {
    setSelected(s);
    setName(s.label);
    setValues({});
    setError(null);
    setShowAdvanced(false);
  };

  const setVal = (k: string, v: string | boolean | string[]) => setValues((p) => ({ ...p, [k]: v }));

  const buildConfig = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k of fieldKeys) {
      const spec = props[k] || {};
      const raw = values[k];
      if (raw === undefined || raw === "" || raw === false || (Array.isArray(raw) && raw.length === 0)) continue;
      if (spec.type === "array") {
        const arr = splitTerms(raw);
        if (arr.length) out[k] = arr;
      } else if (spec.type === "number" || spec.type === "integer") {
        const n = Number(raw);
        if (!Number.isNaN(n)) out[k] = n;
      } else if (spec.type === "boolean") {
        if (raw === true) out[k] = true;
      } else {
        out[k] = raw;
      }
    }
    return out;
  };

  const isEmptyVal = (v: unknown) => v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
  const missingRequired = selected
    ? [...required].filter((k) => k !== "name" && isEmptyVal(values[k])).map(humanize)
    : [];

  const submit = async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await api.createSignal({ sourceId: selected.id, name: name.trim() || selected.label, config: buildConfig(), schedule });
      if (r.error) { setError(r.error); return; }
      if (r.tableId) onCreated(r.tableId, r.added ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the signal.");
    } finally {
      setSubmitting(false);
    }
  };

  const renderBool = (k: string, title: string, op: "OR" | "AND" | "NOT", hint: string, req: boolean, ph: string) => (
    <div className="sig-field" key={k}>
      <label className="sig-label">
        {title} <span className={`sig-op sig-op-${op.toLowerCase()}`}>{op}</span>
        {req && <span className="sig-req">*</span>}
      </label>
      <TagInput tags={splitTerms(values[k])} onChange={(v) => setVal(k, v)} placeholder={ph} />
      <div className="sig-hint">{hint}</div>
    </div>
  );

  const renderSelect = (k: string, label: string) => {
    const spec = props[k];
    const opts = spec ? fieldOptions(k, spec) : null;
    if (!opts) return null;
    return (
      <div className="sig-field" key={k}>
        <label className="sig-label">{label}</label>
        <Dropdown value={String(values[k] ?? "")} options={opts} placeholder="Default" onChange={(v) => setVal(k, v)} />
      </div>
    );
  };

  const renderField = (k: string) => {
    const spec = props[k] || {};
    const isReq = required.has(k);
    const label = (
      <label className="sig-label">
        {humanize(k)}{isReq && <span className="sig-req">*</span>}
      </label>
    );
    if (spec.type === "boolean") {
      return (
        <div className="sig-field sig-field-check" key={k}>
          <input type="checkbox" checked={!!values[k]} onChange={(e) => setVal(k, e.target.checked)} />
          {label}
        </div>
      );
    }
    const opts = fieldOptions(k, spec);
    if (opts) {
      return (
        <div className="sig-field" key={k}>
          {label}
          <Dropdown value={String(values[k] ?? "")} options={opts} placeholder="—" onChange={(v) => setVal(k, v)} />
        </div>
      );
    }
    const isArray = spec.type === "array";
    const isNum = spec.type === "number" || spec.type === "integer";
    return (
      <div className="sig-field" key={k}>
        {label}
        {isArray ? (
          <textarea
            className="sig-input"
            rows={2}
            placeholder={spec.description || "Comma- or newline-separated"}
            value={String(values[k] ?? "")}
            onChange={(e) => setVal(k, e.target.value)}
          />
        ) : (
          <input
            className="sig-input"
            type={isNum ? "number" : "text"}
            placeholder={spec.description || ""}
            value={String(values[k] ?? "")}
            onChange={(e) => setVal(k, e.target.value)}
          />
        )}
      </div>
    );
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal sig-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sig-head">
          <div>
            <div className="sig-title">From Social Signals</div>
            <div className="sig-sub">Create a table that fills itself from a Trigify social signal.</div>
          </div>
          <button className="sig-x" onClick={onClose}>✕</button>
        </div>

        {loading ? (
          <div className="sig-body"><div className="cell-spinner" style={{ width: 18, height: 18, borderWidth: 2 }} /></div>
        ) : !connected ? (
          <div className="sig-body sig-connect">
            <p>Connect your Trigify API key first — signals are powered by Trigify saved searches.</p>
            <button className="skill-btn primary" onClick={onConnectTrigify}>Connect Trigify</button>
          </div>
        ) : !selected ? (
          <div className="sig-body">
            {groups.map(([group, items]) => (
              <div className="sig-group" key={group}>
                <div className="sig-group-label">{group}</div>
                <div className="sig-grid">
                  {items.map((s) => (
                    <button key={s.id} className="sig-source" onClick={() => pick(s)}>
                      <span className="sig-source-name">{s.label}</span>
                      <span className="sig-source-caret">›</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="sig-body">
            <button className="sig-back" onClick={() => setSelected(null)}>‹ All social signals</button>
            <div className="sig-config-head">{selected.label}</div>

            <div className="sig-field">
              <label className="sig-label">Table name</label>
              <input className="sig-input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            {isKeywordSearch && (
              <div className="sig-bool">
                {renderBool("keywords", "Any of these", "OR", "Match posts containing ANY of these terms.", true, "react, next.js, remix")}
                {"keywords_and" in props &&
                  renderBool("keywords_and", "Must also include", "AND", "Narrow to posts that ALSO contain all of these.", false, "hiring")}
                {"keywords_not" in props &&
                  renderBool("keywords_not", "Exclude", "NOT", "Drop posts that contain any of these.", false, "intern, junior")}
                <div className="sig-preview">
                  <span className="sig-preview-label">Query preview</span>
                  <code className="sig-preview-q">{queryPreview() || "—"}</code>
                </div>
              </div>
            )}

            {isKeywordSearch && (
              <div className="sig-scan">
                {renderSelect("time_frame", "Look back")}
                {renderSelect("max_results", "Limit")}
                {renderSelect("frequency", "Scan frequency")}
              </div>
            )}

            {mainKeys.map(renderField)}

            {advancedKeys.length > 0 && (
              <>
                <button className="sig-advanced-toggle" onClick={() => setShowAdvanced((a) => !a)}>
                  {showAdvanced ? "▾" : "▸"} Advanced ({advancedKeys.length})
                </button>
                {showAdvanced && advancedKeys.map(renderField)}
              </>
            )}

            <div className="sig-field">
              <label className="sig-label">Pull schedule</label>
              <div className="sig-schedule">
                {SCHEDULES.map((s) => (
                  <button
                    key={s.id}
                    className={`sig-sched-btn${schedule === s.id ? " active" : ""}`}
                    onClick={() => setSchedule(s.id)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <div className="sig-hint">
                Runs a local cron while the app is open and catches up on launch. {schedule === "manual" ? "Manual = pull only when you click Sync." : ""}
              </div>
            </div>

            {error && <div className="sig-error">{error}</div>}
            {missingRequired.length > 0 && <div className="sig-hint">Required: {missingRequired.join(", ")}</div>}

            <div className="sig-actions">
              <button className="skill-btn ghost" onClick={() => setSelected(null)}>Back</button>
              <button className="skill-btn primary" onClick={submit} disabled={submitting || missingRequired.length > 0}>
                {submitting ? "Creating…" : "Create signal table"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
