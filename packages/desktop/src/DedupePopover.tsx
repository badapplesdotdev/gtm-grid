// Deduplication settings popover (mirrors Clay's "Deduplication" panel). Keeps a
// table unique on one column: pick the column, choose keep-oldest/newest, and the
// backend sweeps existing duplicates. Backend-agnostic: the caller injects
// `setDedupe`/`dedupeTable` (the local sidecar `api.*` or the cloud tRPC
// mutations), so the SAME popover drives both local and cloud tables.

import { useState } from "react";
import { Dialog, DialogContent } from "./components/ui/dialog";

type Keep = "oldest" | "newest";

export function DedupePopover({
  columns,
  current,
  setDedupe,
  dedupeTable,
  onClose,
  onChanged,
}: {
  columns: { id: string; name: string }[];
  current: { column: string; keep: Keep } | null;
  /** Persist (or clear) the dedupe config; backend sweeps + returns the count. */
  setDedupe: (body: {
    column: string | null;
    keep?: Keep;
  }) => Promise<{ deleted: number }>;
  /** Run a one-shot sweep with the saved config. */
  dedupeTable: () => Promise<{ deleted: number }>;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [enabled, setEnabled] = useState(!!current);
  const [column, setColumn] = useState<string>(current?.column ?? "");
  const [keep, setKeep] = useState<Keep>(current?.keep ?? "oldest");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  // Persist a config change (and surface how many existing dupes were swept).
  const save = async (next: { on: boolean; column: string; keep: Keep }) => {
    setSaving(true);
    setErr("");
    setMsg("");
    try {
      const body = next.on && next.column ? { column: next.column, keep: next.keep } : { column: null };
      const r = await setDedupe(body);
      if (r.deleted) setMsg(`Removed ${r.deleted} duplicate row${r.deleted === 1 ? "" : "s"}.`);
      else setMsg(next.on && next.column ? "Auto-dedupe on." : "Auto-dedupe off.");
      onChanged();
    } catch (e) {
      setErr((e as Error)?.message ?? "Failed to update deduplication");
    } finally {
      setSaving(false);
    }
  };

  const toggle = (on: boolean) => {
    setEnabled(on);
    if (!on) void save({ on: false, column, keep });
    else if (column) void save({ on: true, column, keep });
  };
  const pickColumn = (id: string) => {
    setColumn(id);
    if (enabled && id) void save({ on: true, column: id, keep });
  };
  const pickKeep = (k: Keep) => {
    setKeep(k);
    if (enabled && column) void save({ on: true, column, keep: k });
  };
  const dedupeNow = async () => {
    setSaving(true);
    setErr("");
    try {
      const r = await dedupeTable();
      setMsg(r.deleted ? `Removed ${r.deleted} duplicate row${r.deleted === 1 ? "" : "s"}.` : "No duplicates found.");
      onChanged();
    } catch (e) {
      setErr((e as Error)?.message ?? "Dedupe failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="dedupe-pop" overlayClassName="bare-scrim" aria-label="Deduplication" srTitle="Deduplication">
        <div className="dedupe-pop-head">Deduplication</div>

        <label className="dedupe-toggle-row">
          <span className="dedupe-toggle-text">
            <span className="dedupe-toggle-name">Auto-dedupe rows</span>
            <span className="dedupe-sub">Continuously check for and delete duplicate rows that have the same value in a specific column.</span>
          </span>
          <span className={`autorun-switch${enabled ? " on" : ""}`} onClick={() => !saving && toggle(!enabled)}>
            <span className="autorun-knob" />
          </span>
        </label>

        {enabled && (
          <div className="dedupe-body">
            <label className="form-label">Dedupe via column <span className="fnx-param-req">*</span></label>
            <select className="form-input form-select" value={column} onChange={(e) => pickColumn(e.target.value)} disabled={saving}>
              <option value="">Select a column</option>
              {columns.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <p className="params-hint">If the cell is blank or longer than 200 characters, the row will not be deleted. Matching is exact (no normalization).</p>

            <div className="form-label">When duplicate rows are added…</div>
            <label className="dedupe-radio">
              <input type="radio" name="dedupe-keep" checked={keep === "oldest"} onChange={() => pickKeep("oldest")} disabled={saving} />
              <span className="dedupe-radio-text">
                <span className="dedupe-radio-name">Keep oldest row</span>
                <span className="dedupe-sub">Rows that match existing rows will be deleted.</span>
              </span>
            </label>
            <label className="dedupe-radio">
              <input type="radio" name="dedupe-keep" checked={keep === "newest"} onChange={() => pickKeep("newest")} disabled={saving} />
              <span className="dedupe-radio-text">
                <span className="dedupe-radio-name">Keep newest row</span>
                <span className="dedupe-sub">Any existing row will be deleted; enrichments will run on the new row.</span>
              </span>
            </label>

            <button className="btn btn-outline btn-sm dedupe-now" onClick={dedupeNow} disabled={saving || !column}>
              {saving ? "Working…" : "Dedupe existing rows now"}
            </button>
          </div>
        )}

        {msg && <div className="dedupe-msg">{msg}</div>}
        {err && <div className="conn-err dedupe-err">{err}</div>}
      </DialogContent>
    </Dialog>
  );
}
