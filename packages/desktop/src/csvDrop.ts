/**
 * Pure helpers for window drag-and-drop CSV import. Kept separate from React so
 * the file-type guard is unit-testable without a DOM.
 *
 * Tauri runs with `dragDropEnabled: false` (tauri.conf.json), so the webview
 * receives standard HTML5 drop events and `DataTransfer.files` — these helpers
 * operate on those `File` objects.
 */

/** True when a dropped file looks like a CSV — by MIME type or `.csv` extension.
 *  Some browsers report CSV as `application/vnd.ms-excel`, so accept that too. */
export function isCsvFile(file: { name: string; type: string }): boolean {
  const type = (file.type || "").toLowerCase();
  if (type === "text/csv" || type === "application/vnd.ms-excel") return true;
  return /\.csv$/i.test(file.name);
}

/** The first CSV file in a drop's file list, or `null` if none qualify. */
export function firstCsvFile(files: ArrayLike<File> | null | undefined): File | null {
  if (!files) return null;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f && isCsvFile(f)) return f;
  }
  return null;
}

/** True when a drag carries files (vs. text/element drags), so we only engage
 *  the drop overlay for OS file drags. */
export function dragHasFiles(types: ArrayLike<string> | readonly string[] | undefined): boolean {
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === "Files") return true;
  }
  return false;
}
