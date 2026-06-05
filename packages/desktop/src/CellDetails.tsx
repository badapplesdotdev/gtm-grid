// Cell details drawer — click a cell holding JSON to see every field flattened
// and mapped, then promote a field to a new column or map it onto an existing
// one (Revcode's "Cell details" panel).

import { useMemo, useState } from "react";

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
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? "" : "s"}]`;
  if (typeof v === "object") return "{…}";
  const s = String(v);
  return s.length > 90 ? s.slice(0, 90) + "…" : s;
}

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
  onCreate: (path: string[], label: string) => Promise<void> | void;
  onMapTo: (path: string[], targetId: string) => Promise<void> | void;
}) {
  const [q, setQ] = useState("");
  const [mapOpen, setMapOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const fields = useMemo(() => flatten(source.value), [source.value]);
  const filtered = fields.filter((f, i) => {
    void i;
    if (!q) return true;
    const hay = (f.path.join(".") + " " + preview(f.value)).toLowerCase();
    return hay.includes(q.toLowerCase());
  });
  const leafName = (f: FlatField) => f.path[f.path.length - 1] ?? "value";

  return (
    <>
      <div className="cd-backdrop" onClick={onClose} />
      <aside className="cell-details">
        <div className="cd-header">
          <span className="cd-title">⚡ Cell details</span>
          <button className="cd-close" onClick={onClose} title="Close">
            ✕
          </button>
        </div>
        <div className="cd-source">
          from <strong>{source.columnName}</strong> · {fields.length} fields
        </div>
        <div className="cd-search">
          <input placeholder="Search fields…" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
        </div>
        <div className="cd-fields">
          {filtered.map((f, i) => {
            const idx = fields.indexOf(f);
            return (
              <div className="cd-field" key={idx}>
                <div className="cd-field-row">
                  <span className={`cd-type cd-type-${f.type}`}>{typeIcon(f.type)}</span>
                  <span className="cd-name" title={f.path.join(".")}>
                    {leafName(f)}
                  </span>
                  <span
                    className="cd-value"
                    title={typeof f.value === "object" ? JSON.stringify(f.value, null, 2) : String(f.value)}
                  >
                    {preview(f.value)}
                  </span>
                </div>
                <div className="cd-actions">
                  <button
                    className="cd-add"
                    disabled={busy === idx}
                    onClick={async () => {
                      setBusy(idx);
                      try {
                        await onCreate(f.path, leafName(f));
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {busy === idx ? "…" : "+ Column"}
                  </button>
                  <div className="cd-map-wrap">
                    <button className="cd-map" onClick={() => setMapOpen(mapOpen === idx ? null : idx)}>
                      Map to ▾
                    </button>
                    {mapOpen === idx && (
                      <div className="cd-map-menu">
                        {columns.length === 0 && <div className="cd-map-empty">No columns yet</div>}
                        {columns.map((c) => (
                          <button
                            key={c.id}
                            onClick={async () => {
                              setMapOpen(null);
                              setBusy(idx);
                              try {
                                await onMapTo(f.path, c.id);
                              } finally {
                                setBusy(null);
                              }
                            }}
                          >
                            {c.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </aside>
    </>
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
