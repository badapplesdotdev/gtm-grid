/**
 * Import a Google Sheet into a table — pick file → pick tab → map columns → bind.
 *
 * Three decisions in here are product decisions, not layout:
 *
 * 1. **You can only pick from ALREADY-SELECTED spreadsheets.** Under the
 *    `drive.file` scope we cannot list a user's Drive, so this modal offers the
 *    files they authorised in the Google Picker and links out to add more. A
 *    free-text spreadsheet id box would look more capable and 404 every time.
 *
 * 2. **The key column is pushed hard.** Without one, rows are identified by their
 *    SHEET ROW NUMBER, and the first upstream sort or delete makes a re-sync
 *    overwrite the wrong grid rows. The modal defaults to the first header that
 *    looks like an identifier and warns explicitly when the user opts out.
 *
 * 3. **Unmapped headers become NEW columns by default.** Importing a sheet
 *    almost always means "bring these columns in"; forcing a user to pre-create
 *    matching columns first would make the common path the laborious one.
 *
 * Plain React: no Effect in the view layer (CLAUDE.md).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiClient } from "./cloud/client";
import { openExternalUrl } from "./cloud/open-external";
import { Dialog, DialogContent } from "./components/ui/dialog";

export interface SheetImportModalProps {
  readonly workspaceId: string;
  readonly tableId: string;
  /** Existing columns, so a header can map onto one instead of creating a duplicate. */
  readonly existingColumns: readonly { readonly id: string; readonly name: string }[];
  readonly onClose: () => void;
  /** Called after the binding is created and its first sync finishes. */
  readonly onImported: () => void;
}

type Phase =
  | { readonly kind: "pickFile" }
  | { readonly kind: "pickTab"; readonly file: PickedFile; readonly tabs: readonly string[] }
  | { readonly kind: "map"; readonly file: PickedFile; readonly tab: string; readonly preview: Preview }
  | { readonly kind: "working"; readonly note: string }
  | { readonly kind: "error"; readonly message: string };

interface PickedFile {
  readonly id: string;
  readonly name: string;
}
interface Preview {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/** `""` means "don't import this header"; `NEW` means "create a column for it". */
const NEW = "__new__";
const SKIP = "";

/** Mirrors the router's zod enum — a loose `string` here fails the mutation's type. */
type Schedule = "manual" | "hourly" | "daily" | "weekly";
const SCHEDULES: readonly Schedule[] = ["manual", "hourly", "daily", "weekly"];
const SCHEDULE_LABELS: Record<Schedule, string> = {
  manual: "Only when I ask",
  hourly: "Hourly",
  daily: "Daily",
  weekly: "Weekly",
};
/** Narrow without a cast (CLAUDE.md): a match RETURNS the union member itself. */
const asSchedule = (v: string): Schedule => {
  for (const s of SCHEDULES) if (s === v) return s;
  return "daily";
};

/**
 * Guess the key column.
 *
 * Ordered by how reliably each identifies a row in GTM data, not alphabetically.
 * Getting this right by default is what keeps most users out of the row-number
 * failure mode entirely — they accept the suggestion without reading the warning.
 */
const KEY_HINTS = ["email", "id", "domain", "url", "linkedin", "company"];
const guessKey = (headers: readonly string[]): string | null => {
  for (const hint of KEY_HINTS) {
    const hit = headers.find((h) => h.trim().toLowerCase().includes(hint));
    if (hit !== undefined) return hit;
  }
  return null;
};

const message = (e: unknown, fallback: string): string =>
  e instanceof Error && e.message !== "" ? e.message : fallback;

export function SheetImportModal(props: SheetImportModalProps) {
  const { workspaceId, tableId, existingColumns, onClose, onImported } = props;
  const [phase, setPhase] = useState<Phase>({ kind: "pickFile" });
  const [files, setFiles] = useState<readonly PickedFile[] | null>(null);
  const [headerRow, setHeaderRow] = useState(1);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [keyHeader, setKeyHeader] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<Schedule>("daily");

  const loadFiles = useCallback(async () => {
    if (!apiClient) return;
    try {
      const res = await apiClient.google.pickedFiles.query({ workspaceId });
      setFiles(res.files);
    } catch (e) {
      setPhase({ kind: "error", message: message(e, "Could not read your selected spreadsheets.") });
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  // Declared BEFORE chooseFile, which calls it when a spreadsheet has exactly
  // one tab. Ordering matters here beyond style: the reverse needs an
  // exhaustive-deps suppression to compile, and a suppressed dep list is how a
  // stale `headerRow` would silently get baked into the preview call.
  const chooseTab = useCallback(
    async (file: PickedFile, tab: string, row: number = headerRow) => {
      if (!apiClient) return;
      setPhase({ kind: "working", note: "Reading the first few rows…" });
      try {
        const preview = await apiClient.sheets.preview.query({
          workspaceId,
          spreadsheetId: file.id,
          sheetTitle: tab,
          headerRow: row,
        });
        if (preview.headers.length === 0) {
          setPhase({
            kind: "error",
            message: `No headers found on row ${row}. If the sheet has a title banner, try a later header row.`,
          });
          return;
        }
        // Default: map onto an existing column of the same name, else create one.
        const byName = new Map(existingColumns.map((c) => [c.name.trim().toLowerCase(), c.id]));
        const initial: Record<string, string> = {};
        for (const h of preview.headers) {
          if (h.trim() === "") continue;
          initial[h] = byName.get(h.trim().toLowerCase()) ?? NEW;
        }
        setMapping(initial);
        setKeyHeader(guessKey(preview.headers));
        setPhase({ kind: "map", file, tab, preview });
      } catch (e) {
        setPhase({ kind: "error", message: message(e, "Could not read that tab.") });
      }
    },
    [workspaceId, headerRow, existingColumns],
  );

  const chooseFile = useCallback(
    async (file: PickedFile) => {
      if (!apiClient) return;
      setPhase({ kind: "working", note: "Reading the spreadsheet…" });
      try {
        const { tabs } = await apiClient.sheets.listTabs.query({ workspaceId, spreadsheetId: file.id });
        if (tabs.length === 0) {
          setPhase({ kind: "error", message: "That spreadsheet has no tabs to import." });
          return;
        }
        // One tab is not a choice — skip straight to mapping.
        const only = tabs[0];
        if (tabs.length === 1 && only !== undefined) {
          await chooseTab(file, only);
          return;
        }
        setPhase({ kind: "pickTab", file, tabs });
      } catch (e) {
        setPhase({ kind: "error", message: message(e, "Could not open that spreadsheet.") });
      }
    },
    [workspaceId, chooseTab],
  );

  const mappedHeaders = useMemo(
    () => Object.entries(mapping).filter(([, target]) => target !== SKIP),
    [mapping],
  );

  const submit = useCallback(async () => {
    if (phase.kind !== "map" || !apiClient) return;
    const { file, tab } = phase;
    setPhase({ kind: "working", note: "Creating columns…" });
    try {
      // Create a column for every header the user left on "New column", then
      // build the header→columnId mapping the binding stores.
      const columns: { header: string; columnId: string }[] = [];
      for (const [header, target] of mappedHeaders) {
        if (target === NEW) {
          const created = await apiClient.grid.addColumn.mutate({
            tableId,
            name: header,
            type: "text",
            kind: "manual",
          });
          const columnId = typeof created === "string" ? created : created.id;
          columns.push({ header, columnId });
        } else {
          columns.push({ header, columnId: target });
        }
      }
      if (columns.length === 0) {
        setPhase({ kind: "error", message: "Map at least one column to import." });
        return;
      }

      setPhase({ kind: "working", note: "Linking the sheet…" });
      const { id } = await apiClient.sheets.create.mutate({
        workspaceId,
        tableId,
        spreadsheetId: file.id,
        spreadsheetName: file.name,
        sheetTitle: tab,
        headerRow,
        columns,
        keyHeader,
        schedule,
      });

      // Creating deliberately does not sync (a big sheet would time out the
      // mutation), so the first pull is an explicit follow-up call.
      setPhase({ kind: "working", note: "Importing rows…" });
      await apiClient.sheets.syncNow.mutate({ workspaceId, bindingId: id });
      onImported();
      onClose();
    } catch (e) {
      setPhase({ kind: "error", message: message(e, "Could not import that sheet.") });
    }
  }, [phase, mappedHeaders, workspaceId, tableId, headerRow, keyHeader, schedule, onImported, onClose]);

  const openPicker = useCallback(async () => {
    if (!apiClient) return;
    const { url } = await apiClient.google.pickerUrl.query({ workspaceId });
    await openExternalUrl(url);
  }, [workspaceId]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sheet-import-modal">
        <h2 className="sheet-import-title">Import from Google Sheets</h2>

        {phase.kind === "working" && <p className="sheet-import-note">{phase.note}</p>}

        {phase.kind === "error" && (
          <>
            <p className="sheet-import-error">{phase.message}</p>
            <button className="skill-btn" onClick={() => setPhase({ kind: "pickFile" })}>
              Start over
            </button>
          </>
        )}

        {phase.kind === "pickFile" && (
          <>
            <p className="sheet-import-note">
              Choose one of the spreadsheets you&rsquo;ve given GTM Grid access to.
            </p>
            {files === null ? (
              <p className="sheet-import-note">Loading…</p>
            ) : files.length === 0 ? (
              <>
                {/* The state that is otherwise a dead end: connected, but nothing
                    reachable. Explain and offer the fix in one step. */}
                <p className="sheet-import-note">
                  You haven&rsquo;t selected any spreadsheets yet. GTM Grid can only open files you
                  pick.
                </p>
                <button className="skill-btn primary" onClick={() => void openPicker()}>
                  Select spreadsheets
                </button>
              </>
            ) : (
              <>
                <ul className="sheet-import-list">
                  {files.map((f) => (
                    <li key={f.id}>
                      <button className="skill-btn" onClick={() => void chooseFile(f)}>
                        {f.name || f.id}
                      </button>
                    </li>
                  ))}
                </ul>
                <button className="skill-btn" onClick={() => void openPicker()}>
                  Add another spreadsheet
                </button>
              </>
            )}
          </>
        )}

        {phase.kind === "pickTab" && (
          <>
            <p className="sheet-import-note">Which tab in {phase.file.name}?</p>
            <ul className="sheet-import-list">
              {phase.tabs.map((t) => (
                <li key={t}>
                  <button className="skill-btn" onClick={() => void chooseTab(phase.file, t)}>
                    {t}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {phase.kind === "map" && (
          <>
            <p className="sheet-import-note">
              {phase.file.name} · {phase.tab}
            </p>

            <label className="sheet-import-field">
              Header row
              <input
                type="number"
                min={1}
                max={50}
                value={headerRow}
                onChange={(e) => setHeaderRow(Math.max(1, Number(e.target.value) || 1))}
                onBlur={() => void chooseTab(phase.file, phase.tab)}
              />
            </label>

            <table className="sheet-import-map">
              <thead>
                <tr>
                  <th>Sheet column</th>
                  <th>Sample</th>
                  <th>Import into</th>
                </tr>
              </thead>
              <tbody>
                {phase.preview.headers.map((h, i) => (
                  <tr key={`${h}-${i}`}>
                    <td>{h || <em>(no header)</em>}</td>
                    <td className="sheet-import-sample">{phase.preview.rows[0]?.[i] ?? ""}</td>
                    <td>
                      <select
                        value={mapping[h] ?? SKIP}
                        disabled={h.trim() === ""}
                        onChange={(e) => setMapping((m) => ({ ...m, [h]: e.target.value }))}
                      >
                        <option value={NEW}>New column</option>
                        {existingColumns.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                        <option value={SKIP}>Don&rsquo;t import</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <label className="sheet-import-field">
              Match rows on
              <select value={keyHeader ?? SKIP} onChange={(e) => setKeyHeader(e.target.value || null)}>
                {phase.preview.headers
                  .filter((h) => h.trim() !== "")
                  .map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                <option value={SKIP}>Nothing — use row position</option>
              </select>
            </label>
            {keyHeader === null && (
              // Not a soft nudge: this is the one setting that can silently
              // corrupt the table later, and the corruption looks like our bug.
              <p className="sheet-import-warning">
                Without a matching column, rows are tracked by their position in the sheet. If anyone
                sorts or deletes a row in Google Sheets, the next sync will update the wrong rows.
              </p>
            )}

            <label className="sheet-import-field">
              Re-sync
              <select value={schedule} onChange={(e) => setSchedule(asSchedule(e.target.value))}>
                {SCHEDULES.map((s) => (
                  <option key={s} value={s}>
                    {SCHEDULE_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>

            <div className="sheet-import-actions">
              <button className="skill-btn" onClick={onClose}>
                Cancel
              </button>
              <button
                className="skill-btn primary"
                disabled={mappedHeaders.length === 0}
                onClick={() => void submit()}
              >
                Import {mappedHeaders.length} column{mappedHeaders.length === 1 ? "" : "s"}
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
