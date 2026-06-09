/**
 * Read-only renderer for a shared table snapshot. A server component (pure
 * render, no interactivity) — distinct from the desktop's editable `CellContent`
 * grid. Reconstructs the dense grid from the snapshot's position-indexed cells
 * and renders columns (with a function-column badge) + rows.
 */

import type { TableShareSnapshot } from "@gtmgrid/services";
import styles from "./share.module.css";

/** A function column's connector badge, e.g. "apollo.enrichPerson" or "ƒ code". */
function fnBadge(col: TableShareSnapshot["columns"][number]): string | null {
  if (col.kind !== "function") return null;
  if (col.provider) return col.method ? `${col.provider}.${col.method}` : col.provider;
  return col.code ? "ƒ code" : "ƒ";
}

/** Render a single cell value: empty → dash, object/array → JSON, else string. */
function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") {
    return <span className={styles.empty}>—</span>;
  }
  if (typeof value === "object") {
    return <pre className={styles.json}>{JSON.stringify(value, null, 2)}</pre>;
  }
  return <>{String(value)}</>;
}

export function ShareGrid({ snapshot }: { snapshot: TableShareSnapshot }) {
  const { columns, rows, cells } = snapshot;

  // Reconstruct the dense grid from the sparse, position-indexed cells.
  const grid: unknown[][] = Array.from({ length: rows }, () =>
    new Array<unknown>(columns.length).fill(undefined),
  );
  for (const cell of cells) {
    if (cell.row >= 0 && cell.row < rows && cell.column >= 0 && cell.column < columns.length) {
      grid[cell.row][cell.column] = cell.value;
    }
  }

  return (
    <div className={styles.gridWrap}>
      <table className={styles.grid}>
        <thead>
          <tr>
            <th className={styles.rownum} aria-label="row number" />
            {columns.map((col, i) => {
              const badge = fnBadge(col);
              return (
                <th key={i}>
                  <span className={styles.colName}>{col.name}</span>
                  {badge && <span className={styles.fn}>{badge}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {grid.length === 0 ? (
            <tr>
              <td className={styles.rownum} />
              <td colSpan={columns.length} className={styles.empty}>
                No rows in this table.
              </td>
            </tr>
          ) : (
            grid.map((row, r) => (
              <tr key={r}>
                <td className={styles.rownum}>{r + 1}</td>
                {row.map((value, c) => (
                  <td key={c}>
                    <CellValue value={value} />
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
