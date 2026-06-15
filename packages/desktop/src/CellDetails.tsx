// Cell details panel — click a cell holding JSON to see every field flattened
// into pills. Click a field to add it as a new column or map it onto an existing
// one. Lives in the right rail (over the agent panel), so the grid stays visible
// and newly-created columns are immediately on screen.

import { useMemo, useState } from "react";

import { Sheet, SheetContent } from "./components/ui/sheet";

interface FlatField {
  path: string[];
  value: unknown;
  type: string;
}

function typeOf(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
function typeIcon(t: string): string {
  return t === "number" ? "#" : t === "boolean" ? "☑" : t === "array" ? "[ ]" : t === "object" ? "{ }" : "T";
}
function flatten(value: unknown, prefix: string[] = [], out: FlatField[] = [], depth = 0): FlatField[] {
  if (value && typeof value === "object" && !Array.isArray(value) && depth < 6) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) out.push({ path: prefix, value, type: "object" });
    else for (const [k, v] of entries) flatten(v, [...prefix, k], out, depth + 1);
  } else {
    out.push({ path: prefix, value, type: typeOf(value) });
  }
  return out;
}
function preview(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === "object") return "{…}";
  const s = String(v);
  return s.length > 60 ? s.slice(0, 60) + "…" : s;
}
const leafName = (f: FlatField) => f.path[f.path.length - 1] ?? "value";

export default function CellDetails({
  source,
  columns,
  onClose,
  onCreate,
  onMapTo,
}: {
  source: { columnName: string; value: unknown };
  columns: { id: string; name: string }[];
  onClose: () => void;
  /**
   * Promote a response field to a new column / map onto an existing one. Optional:
   * when omitted (e.g. the cloud grid, which doesn't yet support promote/map), the
   * drawer is VIEW-ONLY — you can still inspect and copy the full response.
   */
  onCreate?: (path: string[], label: string) => Promise<void> | void;
  onMapTo?: (path: string[], targetId: string) => Promise<void> | void;
}) {
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");
  const [busy, setBusy] = useState(false);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);

  const fields = useMemo(() => flatten(source.value), [source.value]);
  const visible = fields
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => !q || (f.path.join(".") + " " + preview(f.value)).toLowerCase().includes(q.toLowerCase()));

  const copyJson = () => navigator.clipboard?.writeText(JSON.stringify(source.value, null, 2)).catch(() => {});

  const select = (i: number) => {
    setSelected(selected === i ? null : i);
    setDraftName(leafName(fields[i]));
    setDoneMsg(null);
  };
  const create = async (f: FlatField, name: string) => {
    if (!onCreate) return;
    setBusy(true);
    try {
      await onCreate(f.path, name.trim() || leafName(f));
      setDoneMsg(`Added “${name.trim() || leafName(f)}” to the table`);
      setSelected(null);
    } finally {
      setBusy(false);
    }
  };
  const map = async (f: FlatField, targetId: string, targetName: string) => {
    if (!onMapTo) return;
    setBusy(true);
    try {
      await onMapTo(f.path, targetId);
      setDoneMsg(`Mapped onto “${targetName}”`);
      setSelected(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="cell-details" srTitle="Cell details">
      <div className="cd-header">
        <span className="cd-title">⚡ Cell details</span>
        <div className="cd-header-actions">
          <button className="cd-icon-btn" title="Copy JSON" onClick={copyJson}>⧉</button>
          <button className="cd-icon-btn" title="Close" onClick={onClose}>✕</button>
        </div>
      </div>

      <div className="cd-body">
        <div className="cd-search">
          <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
        </div>
        {doneMsg && <div className="cd-done">✓ {doneMsg}</div>}

        <div className="cd-fields">
          {visible.map(({ f, i }) => (
            <div key={i} className={`cd-pill-wrap ${selected === i ? "open" : ""}`}>
              <button className="cd-pill" onClick={() => select(i)} title={f.path.join(".")}>
                <span className={`cd-type cd-type-${f.type}`}>{typeIcon(f.type)}</span>
                <span className="cd-name">{leafName(f)}</span>
                <span className="cd-value">{preview(f.value)}</span>
              </button>

              {selected === i && onCreate && (
                <div className="cd-action">
                  <div className="cd-action-title">Add “{leafName(f)}” as new column</div>
                  <div className="cd-create-row">
                    <input
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && create(f, draftName)}
                      spellCheck={false}
                      autoFocus
                    />
                    <button className="cd-create-btn" disabled={busy} onClick={() => create(f, draftName)}>
                      {busy ? "…" : "Create column"}
                    </button>
                  </div>
                  {onMapTo && columns.length > 0 && (
                    <>
                      <div className="cd-or">or map to an existing column</div>
                      <div className="cd-map-list">
                        {columns.map((c) => (
                          <button key={c.id} disabled={busy} onClick={() => map(f, c.id, c.name)}>
                            {c.name}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="cd-footer">
        from <strong>{source.columnName}</strong> · {fields.length} fields
      </div>
      </SheetContent>
    </Sheet>
  );
}

/** Generated column code that extracts a JSON path from the source column. */
export function extractCode(path: string[]): string {
  return (
    `function(inputs){ var v; try { v = JSON.parse(inputs.src); } catch(e) { v = inputs.src; } ` +
    `var p = ${JSON.stringify(path)}; for (var i=0;i<p.length;i++){ if (v==null) return null; v = v[p[i]]; } ` +
    `return (v && typeof v==='object') ? JSON.stringify(v) : (v==null?null:v); }`
  );
}
