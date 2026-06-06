/**
 * CSV import — full-screen flow (drop → review → done).
 *
 * Implements the Claude Design "Import a CSV" flow, themed to the app's accent:
 *   - drop:   drag-drop / browse / paste / sample data
 *   - review: "Map your columns" — rename, cycle type, exclude, header toggle,
 *             an 8-row preview; "Create table" runs the import.
 *   - done:   success summary + a read-only result grid.
 *
 * Parsing/inference is the pure {@link CsvParser} from @gtmgrid/cloud; the actual
 * writes go through an injected {@link ImportWriter} (local sidecar or cloud
 * Convex), so this component is the same for both modes.
 */

import { Cause, Effect, Exit, Option } from "effect";
import {
  CsvParser,
  columnLabel,
  inferColumnType,
  normalizeHeaders,
  type CsvColumnType,
  type ParsedCsv,
} from "@gtmgrid/cloud";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  importTable,
  type ImportProgress,
  type ImportWriter,
} from "./csvImport";

// ── Local icons (the shared Icon set lacks these) ───────────────────────────
const I = {
  Upload: ({ s = 26 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
  ),
  FileText: ({ s = 14 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>
  ),
  Table: ({ s = 14 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18" /></svg>
  ),
  Check: ({ s = 12 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
  ),
  X: ({ s = 12 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
  ),
  Plus: ({ s = 12 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
  ),
  ArrowRight: ({ s = 15 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>
  ),
  ArrowLeft: ({ s = 14 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></svg>
  ),
  Calendar: ({ s = 12 }: { s?: number }) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
  ),
};

// ── Type metadata (glyph + colour per inferred type) ────────────────────────
const TYPES: CsvColumnType[] = ["text", "number", "boolean", "date"];
const TYPE_META: Record<
  CsvColumnType,
  { label: string; color: string; glyph?: string; icon?: "Calendar" | "Check" }
> = {
  text: { label: "Text", color: "var(--text-3)", glyph: "T" },
  number: { label: "Number", color: "#2563eb", glyph: "#" },
  boolean: { label: "Boolean", color: "var(--accent)", icon: "Check" },
  date: { label: "Date", color: "#d97706", icon: "Calendar" },
};

function TypeGlyph({ type, size = 12 }: { type: CsvColumnType; size?: number }) {
  const m = TYPE_META[type];
  if (m.icon === "Calendar") return <I.Calendar s={size} />;
  if (m.icon === "Check") return <I.Check s={size} />;
  return (
    <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: size }}>
      {m.glyph}
    </span>
  );
}

function cellNode(val: string, type: CsvColumnType): { node: React.ReactNode; mono: boolean } {
  const v = (val ?? "").trim();
  if (v === "") return { node: <span className="import-empty">—</span>, mono: false };
  if (type === "boolean") {
    const on = /^(true|yes|y)$/i.test(v);
    return {
      node: on ? <span className="import-bool on"><I.Check s={12} /></span> : <span className="import-empty">—</span>,
      mono: false,
    };
  }
  return { node: v, mono: type === "number" || type === "date" };
}

const SAMPLE_CSV = `Company,Founder,Domain,Employees,ARR ($M),Last Raised,Hiring
Ramp,Eric Glyman,ramp.com,950,300,2023-08-15,true
Clay,Kareem Amin,clay.com,120,40,2024-01-22,true
Vanta,Christina Cacioppo,vanta.com,700,220,2024-04-09,true
Mercury,Immad Akhund,mercury.com,800,180,2023-11-30,false
Linear,Karri Saarinen,linear.app,80,30,2024-06-18,true
Brex,Henrique Dubugras,brex.com,1200,350,2023-02-14,false
Retool,David Hsu,retool.com,500,160,2024-03-05,true
Notion,Ivan Zhao,notion.so,800,250,2023-09-21,true
Figma,Dylan Field,figma.com,1500,600,2024-05-02,false
Airtable,Howie Liu,airtable.com,900,375,2023-12-11,true`;

/** Parse text via the pure CsvParser, returning a tagged result (no throw). */
async function parseText(
  text: string,
): Promise<{ ok: true; data: ParsedCsv } | { ok: false; error: string }> {
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const p = yield* CsvParser;
      return yield* p.parse(text);
    }).pipe(Effect.provide(CsvParser.Default)),
  );
  if (Exit.isSuccess(exit)) return { ok: true, data: exit.value };
  const f = Cause.failureOption(exit.cause);
  return {
    ok: false,
    error: Option.isSome(f) ? f.value.message : "Could not read the file.",
  };
}

interface ReviewCol {
  idx: number;
  name: string;
  type: CsvColumnType;
  include: boolean;
}

/** Derive review columns from the parsed records + header toggle. */
function deriveCols(parsed: ParsedCsv, hasHeader: boolean): ReviewCol[] {
  const body = hasHeader ? parsed.records.slice(1) : parsed.records;
  const names = hasHeader
    ? normalizeHeaders(parsed.records[0]).headers
    : Array.from({ length: parsed.width }, (_, i) => columnLabel(i));
  return names.map((name, idx) => ({
    idx,
    name,
    type: inferColumnType(body.map((r) => r[idx] ?? "")),
    include: true,
  }));
}

export interface ImportCsvModalProps {
  /** Backend seam (local sidecar or cloud Convex). */
  writer: ImportWriter;
  /** Close without opening a table (table may still have been created). */
  onClose: () => void;
  /** Called once after rows are written, so a local list can refresh. */
  onImported?: (tableId: string) => void;
  /** Open the freshly imported table (select it + close). */
  onOpenTable: (tableId: string) => void;
}

export function ImportCsvModal({
  writer,
  onClose,
  onImported,
  onOpenTable,
}: ImportCsvModalProps) {
  const [stage, setStage] = useState<"drop" | "review" | "done">("drop");
  const [dragOver, setDragOver] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [fileName, setFileName] = useState("");
  const [tableName, setTableName] = useState("Imported table");
  const [hasHeader, setHasHeader] = useState(true);
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [cols, setCols] = useState<ReviewCol[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [result, setResult] = useState<{ tableId: string; rowCount: number; columnCount: number } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const ingest = useCallback(async (text: string, name: string | null) => {
    setParseError(null);
    const r = await parseText(text);
    if (!r.ok) {
      setParseError(r.error);
      return;
    }
    setParsed(r.data);
    setFileName(name ?? "pasted.csv");
    if (name) {
      const base = name.replace(/\.csv$/i, "").replace(/[_-]+/g, " ").trim();
      setTableName(base || "Imported table");
    }
    setHasHeader(true);
    setCols(deriveCols(r.data, true));
    setStage("review");
  }, []);

  const onFile = useCallback(
    (file: File | undefined | null) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => void ingest(String(e.target?.result ?? ""), file.name);
      reader.readAsText(file);
    },
    [ingest],
  );

  const toggleHeader = useCallback(
    (next: boolean) => {
      setHasHeader(next);
      if (parsed) setCols(deriveCols(parsed, next));
    },
    [parsed],
  );

  const bodyRows = useMemo(
    () => (parsed ? (hasHeader ? parsed.records.slice(1) : parsed.records) : []),
    [parsed, hasHeader],
  );
  const rowCount = bodyRows.length;
  const includedCols = cols.filter((c) => c.include);

  const setCol = (i: number, patch: Partial<ReviewCol>) =>
    setCols((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const cycleType = (i: number) =>
    setCol(i, { type: TYPES[(TYPES.indexOf(cols[i].type) + 1) % TYPES.length] });

  const runImport = useCallback(async () => {
    if (importing || !includedCols.length) return;
    setImporting(true);
    setImportError(null);
    setProgress(null);
    try {
      const res = await importTable(
        {
          name: tableName.trim() || "Imported table",
          columns: includedCols.map((c) => ({
            name: c.name.trim() || columnLabel(c.idx),
            type: c.type,
          })),
          rows: bodyRows.map((r) => includedCols.map((c) => r[c.idx] ?? "")),
        },
        writer,
        { onProgress: setProgress },
      );
      setResult(res);
      onImported?.(res.tableId);
      setStage("done");
    } catch (e: unknown) {
      const data = (e as { data?: { message?: string } })?.data;
      setImportError(
        data?.message ??
          (e instanceof Error ? e.message : "Import failed. Please try again."),
      );
    } finally {
      setImporting(false);
    }
  }, [importing, includedCols, tableName, bodyRows, writer, onImported]);

  const reset = () => {
    setStage("drop");
    setParsed(null);
    setCols([]);
    setPasting(false);
    setPasteText("");
    setParseError(null);
    setImportError(null);
    setResult(null);
  };

  // ── DROP ──
  if (stage === "drop") {
    return (
      <Shell topRight={<a className="import-link" onClick={onClose}>Cancel</a>}>
        <div className="import-eyebrow">New table</div>
        <h1 className="import-title">Import a CSV</h1>
        <p className="import-sub">
          Drop a file to create a table — gtm grid infers each column's type, then
          every column becomes a function you can run.
        </p>

        {!pasting ? (
          <div
            className={`import-dropzone${dragOver ? " over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); onFile(e.dataTransfer.files[0]); }}
            onClick={() => fileRef.current?.click()}
          >
            <span className="import-dz-ico"><I.Upload s={26} /></span>
            <div className="import-dz-title">Drag &amp; drop your CSV here</div>
            <div className="import-dz-sub">or <span className="import-dz-link">browse files</span> · up to 50 MB</div>
            <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: "none" }}
              onChange={(e) => onFile(e.target.files?.[0])} />
          </div>
        ) : (
          <div>
            <textarea className="import-paste" autoFocus value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={"Company,Founder,Employees\nRamp,Eric Glyman,950\n…"} />
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button className="btn btn-primary" disabled={!pasteText.trim()}
                onClick={() => void ingest(pasteText, null)}>Parse data</button>
              <button className="btn btn-outline" onClick={() => setPasting(false)}>Cancel</button>
            </div>
          </div>
        )}

        {parseError && <div className="import-error">{parseError}</div>}

        <div className="import-dz-actions">
          {!pasting && (
            <button className="import-alt" onClick={() => setPasting(true)}>
              <I.FileText s={14} /> Paste data instead
            </button>
          )}
          <button className="import-alt accent" onClick={() => void ingest(SAMPLE_CSV, "ai-companies.csv")}>
            <I.Table s={14} /> Use sample data (10 AI companies)
          </button>
        </div>
      </Shell>
    );
  }

  // ── DONE ──
  if (stage === "done" && result) {
    const shown = bodyRows.slice(0, 9);
    const vis = includedCols;
    return (
      <Shell
        topRight={<a className="import-link" onClick={onClose}>Close</a>}
        footer={
          <>
            <button className="btn btn-outline" onClick={reset}>Import another</button>
            <span className="import-foot-spacer" />
            <button className="btn btn-primary btn-lg" onClick={() => onOpenTable(result.tableId)}>
              Open table <I.ArrowRight s={15} />
            </button>
          </>
        }
      >
        <div className="import-done-head">
          <span className="import-success"><I.Check s={22} /></span>
          <div>
            <h1 className="import-title" style={{ marginBottom: 4 }}>{tableName}</h1>
            <p className="import-sub" style={{ margin: 0 }}>
              Imported <span className="import-mono">{result.rowCount}</span> rows across{" "}
              <span className="import-mono">{vis.length}</span> columns. Add a function column to enrich them.
            </p>
          </div>
        </div>
        <PreviewGrid cols={vis} rows={shown} result tableName={tableName} rowCount={result.rowCount} />
      </Shell>
    );
  }

  // ── REVIEW ──
  const previewRows = bodyRows.slice(0, 8);
  return (
    <Shell
      topRight={<a className="import-link" onClick={reset}>Choose another file</a>}
      footer={
        <>
          <button className="btn btn-outline" onClick={reset}><I.ArrowLeft s={14} /> Back</button>
          <span className="import-foot-meta">
            <I.FileText s={12} /> {fileName} · <span className="import-mono">{rowCount}</span> rows ·{" "}
            <span className="import-mono">{includedCols.length}</span> columns
          </span>
          <span className="import-foot-spacer" />
          {importing && progress && (
            <span className="import-foot-meta">
              {progress.phase === "rows" ? "Importing rows" : "Creating columns"}{" "}
              <span className="import-mono">{progress.done}/{progress.total}</span>
            </span>
          )}
          <button className="btn btn-primary btn-lg" disabled={!includedCols.length || importing}
            onClick={() => void runImport()}>
            {importing ? "Creating…" : <>Create table <I.ArrowRight s={15} /></>}
          </button>
        </>
      }
    >
      <div className="import-eyebrow">New table · Review</div>
      <h1 className="import-title">Map your columns</h1>
      <p className="import-sub">
        We detected types from your data. Click a type glyph to change it, rename
        headers, or exclude columns you don't need.
      </p>

      <div className="import-review-bar">
        <div className="import-rb-name">
          <label className="form-label" style={{ marginBottom: 4 }}>Table name</label>
          <div className="import-input-wrap">
            <span className="import-input-ico"><I.Table s={14} /></span>
            <input className="form-input" style={{ paddingLeft: 32 }} value={tableName}
              onChange={(e) => setTableName(e.target.value)} />
          </div>
        </div>
        <label className="import-rb-header">
          <button type="button" role="switch" aria-checked={hasHeader}
            className={`import-toggle${hasHeader ? " on" : ""}`}
            onClick={() => toggleHeader(!hasHeader)}>
            <span className="import-toggle-knob" />
          </button>
          <span>First row is a header</span>
        </label>
      </div>

      {importError && <div className="import-error">{importError}</div>}

      <div className="import-grid-wrap">
        <table className="import-grid">
          <thead>
            <tr>
              <th className="import-rownum" />
              {cols.map((c, ci) => (
                <th key={ci} className={c.include ? "" : "excluded"}>
                  <div className="import-head">
                    <button className="import-type" style={{ color: TYPE_META[c.type].color }}
                      title={`Type: ${TYPE_META[c.type].label} — click to change`} onClick={() => cycleType(ci)}>
                      <TypeGlyph type={c.type} />
                    </button>
                    <input className="import-colname" value={c.name}
                      onChange={(e) => setCol(ci, { name: e.target.value })} />
                    <button className="import-excl" title={c.include ? "Exclude column" : "Include column"}
                      onClick={() => setCol(ci, { include: !c.include })}>
                      {c.include ? <I.X s={12} /> : <I.Plus s={12} />}
                    </button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {previewRows.map((r, ri) => (
              <tr key={ri}>
                <td className="import-rownum">{ri + 1}</td>
                {cols.map((c, ci) => {
                  const f = cellNode(r[ci] ?? "", c.type);
                  return (
                    <td key={ci} className={`${c.include ? "" : "excluded"}${f.mono ? " import-mono" : ""}`}>
                      {f.node}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {rowCount > previewRows.length && (
          <div className="import-more">+ {rowCount - previewRows.length} more rows</div>
        )}
      </div>
    </Shell>
  );
}

// ── Read-only result grid (done stage) ──────────────────────────────────────
function PreviewGrid({
  cols,
  rows,
  tableName,
  rowCount,
  result,
}: {
  cols: ReviewCol[];
  rows: string[][];
  tableName: string;
  rowCount: number;
  result?: boolean;
}) {
  return (
    <div className="import-mini">
      <div className="import-mini-bar">
        <span className="import-dots"><i /><i /><i /></span>
        <span className="import-mini-name">{tableName}</span>
        <span className="import-mini-meta">{rowCount} rows · {cols.length} cols</span>
      </div>
      <div className="import-grid-wrap" style={{ borderRadius: 0, border: "none" }}>
        <table className={`import-grid${result ? " result" : ""}`}>
          <thead>
            <tr>
              <th className="import-rownum" />
              {cols.map((c, ci) => (
                <th key={ci}>
                  <div className="import-head static">
                    <span className="import-type" style={{ color: TYPE_META[c.type].color }}>
                      <TypeGlyph type={c.type} />
                    </span>
                    <span className="import-colname-static">{c.name}</span>
                  </div>
                </th>
              ))}
              <th className="import-addcol"><span><I.Plus s={12} /> Function</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                <td className="import-rownum">{ri + 1}</td>
                {cols.map((c, ci) => {
                  const f = cellNode(r[c.idx] ?? "", c.type);
                  return <td key={ci} className={f.mono ? "import-mono" : ""}>{f.node}</td>;
                })}
                <td className="import-fncell"><span className="import-empty">—</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Full-screen shell (header / body / footer) ──────────────────────────────
// Exported so the cloud Webhook setup form (cloud/WebhookModal.tsx) shares the
// exact same full-screen surface as the CSV import flow.
export function Shell({
  children,
  topRight,
  footer,
}: {
  children: React.ReactNode;
  topRight?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="import-overlay">
      <div className="import-shell">
        <div className="import-topbar">
          <div className="import-brand">
            <span className="import-logo">G</span> gtm grid
          </div>
          {topRight}
        </div>
        <div className="import-body">{children}</div>
        {footer && <div className="import-footer">{footer}</div>}
      </div>
    </div>
  );
}
