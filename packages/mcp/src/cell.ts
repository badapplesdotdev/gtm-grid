/**
 * Cap a cell value before it goes back to the agent so one huge cell (e.g. a
 * 485K-char enrichment blob) can't blow the whole response budget and truncate
 * the table after row 1. Small/compiled values pass through untouched; large
 * strings/objects are sliced with a '…[+N chars]' marker so the agent knows it
 * was cut (and can extract the fields it needs via a code/formula column). The
 * full value always stays in the cell.
 *
 * Shared by the LOCAL (index.ts) and CLOUD (cloud-source.ts) get_table paths so
 * the cap is byte-identical in both modes.
 */
export const CELL_CAP = 500;

export function capCellValue(v: unknown): unknown {
  if (v == null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") {
    return v.length > CELL_CAP ? `${v.slice(0, CELL_CAP)}…[+${v.length - CELL_CAP} chars]` : v;
  }
  const s = JSON.stringify(v);
  if (s.length <= CELL_CAP) return v; // small object/array — keep structured
  return `${s.slice(0, CELL_CAP)}…[+${s.length - CELL_CAP} chars, full value in the cell]`;
}
