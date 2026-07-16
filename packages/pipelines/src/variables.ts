/**
 * Build stable, template-safe keys for columns exposed to an attached pipeline.
 * Names remain readable while duplicate names are disambiguated by column id.
 */
export function pipelineColumnVariables(
  columns: readonly { readonly id: string; readonly name: string }[],
): readonly { readonly columnId: string; readonly name: string; readonly key: string }[] {
  const bases = columns.map((column) => {
    const normalized = column.name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return normalized === "" ? "column" : /^[0-9]/.test(normalized) ? `column_${normalized}` : normalized;
  });
  const seen = new Map<string, number>();
  return columns.map((column, index) => {
    const base = bases[index] as string;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return { columnId: column.id, name: column.name, key: occurrence === 1 ? base : `${base}_${occurrence}` };
  });
}
