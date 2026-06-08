// "From Signals" — pick a Trigify signal source, configure its criteria, and
// create a table that a local poller keeps filling with new results.

import { useEffect, useMemo, useState } from "react";
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

export function SignalsModal({
  onClose,
  onCreated,
  onConnectTrigify,
}: {
  onClose: () => void;
  onCreated: (tableId: string) => void;
  onConnectTrigify: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [sources, setSources] = useState<SignalSource[]>([]);
  const [selected, setSelected] = useState<SignalSource | null>(null);
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("daily");
  const [values, setValues] = useState<Record<string, string | boolean>>({});
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
  const mainKeys = fieldKeys.filter((k) => required.has(k) || COMMON.has(k));
  const advancedKeys = fieldKeys.filter((k) => !required.has(k) && !COMMON.has(k));

  const pick = (s: SignalSource) => {
    setSelected(s);
    setName(s.label);
    setValues({});
    setError(null);
    setShowAdvanced(false);
  };

  const setVal = (k: string, v: string | boolean) => setValues((p) => ({ ...p, [k]: v }));

  const buildConfig = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k of fieldKeys) {
      const spec = props[k] || {};
      const raw = values[k];
      if (raw === undefined || raw === "" || raw === false) continue;
      if (spec.type === "array") {
        const arr = String(raw).split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
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

  const missingRequired = selected
    ? [...required].filter((k) => k !== "name" && (values[k] === undefined || values[k] === "")).map(humanize)
    : [];

  const submit = async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await api.createSignal({ sourceId: selected.id, name: name.trim() || selected.label, config: buildConfig(), schedule });
      if (r.error) { setError(r.error); return; }
      if (r.tableId) onCreated(r.tableId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the signal.");
    } finally {
      setSubmitting(false);
    }
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
    if (Array.isArray(spec.enum)) {
      return (
        <div className="sig-field" key={k}>
          {label}
          <select className="sig-input" value={String(values[k] ?? "")} onChange={(e) => setVal(k, e.target.value)}>
            <option value="">—</option>
            {spec.enum.map((o: string) => <option key={o} value={o}>{o}</option>)}
          </select>
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
            <div className="sig-title">From Signals</div>
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
            <button className="sig-back" onClick={() => setSelected(null)}>‹ All signals</button>
            <div className="sig-config-head">{selected.label}</div>

            <div className="sig-field">
              <label className="sig-label">Table name</label>
              <input className="sig-input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>

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
