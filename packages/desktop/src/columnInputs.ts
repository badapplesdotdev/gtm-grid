// Input-readiness check for function columns: which required inputs are unset,
// and which {{Column}} references point at columns that no longer exist. Drives
// the header "Waiting for inputs" badge and the muted cell state — a column
// with missing inputs should say so instead of failing silently per row.

const REF_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Collect every `{{Column Name}}` reference inside a params value (recursing
 *  into nested objects/arrays, matching the engine's resolveParams shape). */
function collectRefs(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    for (const m of value.matchAll(REF_RE)) out.add(m[1]);
  } else if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) collectRefs(v, out);
  }
}

/**
 * Returns the column's input problems, as human-readable tokens:
 * - a required param's name when it is unset/blank;
 * - `{{Name}}` when any param references a column that doesn't exist.
 * An empty array means the column's inputs are satisfiable.
 */
export function missingInputs(
  params: Record<string, unknown>,
  requiredInputs: string[],
  columnNames: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const key of requiredInputs) {
    const v = params[key];
    const blank = v == null || (typeof v === "string" && v.trim() === "");
    if (blank) out.push(key);
  }
  const refs = new Set<string>();
  collectRefs(params, refs);
  for (const ref of refs) {
    if (!columnNames.has(ref)) out.push(`{{${ref}}}`);
  }
  return out;
}
