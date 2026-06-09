/**
 * `chunk` — the shared batching helper for the grid repositories' bulk inserts.
 *
 * Both {@link import("./cell-repo.js").CellRepoLive} and
 * {@link import("./row-repo.js").RowRepoLive} split a wide bulk insert into
 * fixed-size batches so a single `INSERT` never exceeds Postgres' 65535
 * bind-parameter cap. The split logic is identical for cells and rows, so it
 * lives here once instead of being copy-pasted into each repo.
 */

/** Split `items` into consecutive chunks of at most `size`, preserving order. */
export const chunk = <T>(items: readonly T[], size: number): T[][] => {
  if (size <= 0) throw new Error("chunk size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};
