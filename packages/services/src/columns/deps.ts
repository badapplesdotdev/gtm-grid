/**
 * Column dependency graph + dependency-ordered execution (TRI cascade).
 *
 * A function/connector column reads OTHER columns by interpolating `{{Column Name}}`
 * references inside its `params` values (recursively) or its run `condition`. This
 * module turns that string-ref model into a dependency graph and the schedulers a
 * "data cascade" needs: when a column produces data for a row, the columns that
 * depend on it must (re)run, in dependency order, until the chain is populated.
 *
 * Pure + dependency-free so every layer can share ONE implementation: the desktop
 * grid (manual-run cascade), the webhook enricher and the signal enricher
 * (server-side new-row enrichment). Generalized over {@link MinimalColumn} so both
 * the desktop `Column` (`id`) and the server projections (map `_id` → `id`) fit.
 *
 * Ported from the original (orphaned) desktop helpers in `App.tsx`; the
 * `runColumnsWithDeps` / `buildColumnDeps` / `isFreeColumn` semantics are unchanged
 * (see `runAllSchedule`/`deps` tests).
 */

/** The minimal column shape the dependency analysis needs. */
export interface MinimalColumn {
  readonly id: string;
  readonly name: string;
  /** "manual" | "function" — only function columns run. */
  readonly kind: string;
  /** Connector provider id; null/"formula" => free (no billable call). */
  readonly provider: string | null;
  /** Input params (may contain `{{Name}}` refs, recursively). */
  readonly params: Record<string, unknown>;
  /** Optional run condition (may contain `{{Name}}` refs). */
  readonly condition?: string | null;
}

/**
 * A function column is "free" to run when it dispatches no billable connector
 * call: a formula column (`provider === "formula"`) or a mapped/code column with
 * no connector provider. (Kept for callers that want to distinguish free vs paid
 * cascades; the desktop cascade runs ALL dependents regardless.)
 */
export function isFreeColumn(col: Pick<MinimalColumn, "kind" | "provider">): boolean {
  return col.kind === "function" && (col.provider == null || col.provider === "formula");
}

/** Every string leaf inside a params value (recurses objects/arrays). */
function paramStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) paramStrings(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) paramStrings(v, out);
}

/** True if any of a column's params/condition reference `{{columnName}}`. */
export function columnDependsOn(col: MinimalColumn, columnName: string): boolean {
  const re = new RegExp(
    `\\{\\{\\s*${columnName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}`,
  );
  // References live in the run condition OR anywhere inside the input params
  // (incl. nested objects/arrays and a formula column's params.expression).
  if (typeof col.condition === "string" && re.test(col.condition)) return true;
  const strings: string[] = [];
  paramStrings(col.params, strings);
  return strings.some((s) => re.test(s));
}

/**
 * Build the intra-set dependency graph: for each column, the set of OTHER columns'
 * ids it references via `{{Name}}`. Only columns within `cols` are considered — a
 * reference to a column outside the set imposes no ordering constraint here.
 */
export function buildColumnDeps(cols: readonly MinimalColumn[]): Map<string, Set<string>> {
  const deps = new Map<string, Set<string>>();
  for (const col of cols) {
    const set = new Set<string>();
    for (const other of cols) {
      if (other.id === col.id) continue;
      if (columnDependsOn(col, other.name)) set.add(other.id);
    }
    deps.set(col.id, set);
  }
  return deps;
}

/**
 * The ids of columns in `others` that `col` directly references via `{{Name}}`.
 * Convenience wrapper over {@link columnDependsOn} for placement: when a column is
 * created/edited we want the set of existing columns it now depends on, so it can be
 * slotted to their right. `col` itself is skipped if present in `others`.
 */
export function directDependencyIds(
  col: MinimalColumn,
  others: readonly MinimalColumn[],
): Set<string> {
  const ids = new Set<string>();
  for (const other of others) {
    if (other.id === col.id) continue;
    if (columnDependsOn(col, other.name)) ids.add(other.id);
  }
  return ids;
}

/**
 * True if `startId` transitively depends on itself — i.e. it participates in a
 * dependency cycle (incl. a self-reference). DFS over the forward dependency edges
 * in `deps` (`colId → ids it reads`). Used to BLOCK a column edit that would create a
 * circular `{{Name}}` reference (A reads B while B reads A).
 */
export function columnInCycle(startId: string, deps: Map<string, Set<string>>): boolean {
  const stack = [...(deps.get(startId) ?? [])];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === startId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const dep of deps.get(id) ?? []) stack.push(dep);
  }
  return false;
}

/**
 * Reorder `currentOrderIds` so every column appears after the in-set columns it
 * depends on, while moving as FEW columns as possible: Kahn's algorithm whose ready
 * frontier is always drained in CURRENT order. A column not involved in any
 * dependency violation keeps its existing slot, so manual column arrangement and
 * unrelated columns are preserved ("incremental" placement). Cycle-tolerant: any
 * columns left in a cycle are appended in their current order. Returns a permutation
 * of `currentOrderIds`.
 */
export function stableTopoOrder(
  currentOrderIds: readonly string[],
  deps: Map<string, Set<string>>,
): string[] {
  const inSet = new Set(currentOrderIds);
  const indeg = new Map<string, number>();
  for (const id of currentOrderIds) {
    let n = 0;
    for (const dep of deps.get(id) ?? []) if (inSet.has(dep)) n++;
    indeg.set(id, n);
  }
  // Ready frontier kept in current order; pick the earliest-positioned ready column
  // each step so nothing moves unless a dependency forces it.
  const pos = new Map(currentOrderIds.map((id, i) => [id, i]));
  const ready = currentOrderIds.filter((id) => (indeg.get(id) ?? 0) === 0);
  const out: string[] = [];
  const emitted = new Set<string>();
  while (ready.length > 0) {
    ready.sort((a, b) => pos.get(a)! - pos.get(b)!);
    const id = ready.shift()!;
    if (emitted.has(id)) continue;
    emitted.add(id);
    out.push(id);
    for (const other of currentOrderIds) {
      if (emitted.has(other)) continue;
      if ((deps.get(other) ?? new Set()).has(id)) {
        const next = (indeg.get(other) ?? 1) - 1;
        indeg.set(other, next);
        if (next <= 0) ready.push(other);
      }
    }
  }
  // Cycle stragglers — never reach in-degree 0; emit in current order, exactly once.
  for (const id of currentOrderIds) if (!emitted.has(id)) out.push(id);
  return out;
}

/**
 * The transitive set of columns that must (re)run after `seedIds` produced data —
 * everything downstream of the seeds in the dependency graph, the seeds themselves
 * excluded. Used by the manual-run cascade: run a column, then run its dependents.
 * Cycle-safe (a visited set bounds the walk).
 */
export function transitiveDependents(
  seedIds: readonly string[],
  cols: readonly MinimalColumn[],
): Set<string> {
  const deps = buildColumnDeps(cols);
  // Reverse edges: depId → columns that read it.
  const dependentsOf = new Map<string, Set<string>>();
  for (const [colId, depSet] of deps) {
    for (const depId of depSet) {
      const bucket = dependentsOf.get(depId);
      if (bucket) bucket.add(colId);
      else dependentsOf.set(depId, new Set([colId]));
    }
  }
  const seedSet = new Set(seedIds);
  const result = new Set<string>();
  const queue = [...seedIds];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const dependents = dependentsOf.get(cur);
    if (!dependents) continue;
    for (const d of dependents) {
      if (!result.has(d) && !seedSet.has(d)) {
        result.add(d);
        queue.push(d);
      }
    }
  }
  return result;
}

/**
 * Topologically order column ids (Kahn's algorithm) so a column always appears
 * after the in-set columns it depends on. Cycle-tolerant: any columns left in a
 * cycle are appended in their input order so every column appears exactly once.
 * For SEQUENTIAL execution (e.g. server Inngest steps); use {@link runColumnsWithDeps}
 * when parallelism is wanted.
 */
export function topoSortColumnIds(
  cols: readonly MinimalColumn[],
  deps: Map<string, Set<string>>,
): string[] {
  const ids = cols.map((c) => c.id);
  const inSet = new Set(ids);
  const indeg = new Map<string, number>();
  for (const id of ids) {
    let n = 0;
    const d = deps.get(id);
    if (d) for (const dep of d) if (inSet.has(dep)) n++;
    indeg.set(id, n);
  }
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  const out: string[] = [];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    out.push(id);
    for (const other of ids) {
      if (visited.has(other)) continue;
      const d = deps.get(other);
      if (d && d.has(id)) {
        const next = (indeg.get(other) ?? 1) - 1;
        indeg.set(other, next);
        if (next <= 0) queue.push(other);
      }
    }
  }
  // Cycle stragglers — never "ready" but must still be emitted exactly once.
  for (const id of ids) if (!visited.has(id)) out.push(id);
  return out;
}

/**
 * Run a set of function columns honouring their dependency graph with bounded
 * concurrency. Independent columns run in parallel (up to `concurrency`); a column
 * only starts once every in-set column it depends on has finished. Cyclic or
 * unresolvable dependencies are released once no further progress is possible, so
 * every column is attempted exactly once. `run` failures are swallowed per-column
 * so one bad column never blocks the rest. `onColumnSettled` fires after each
 * column completes (progress reporting).
 */
export async function runColumnsWithDeps<C extends MinimalColumn>(
  cols: readonly C[],
  deps: Map<string, Set<string>>,
  concurrency: number,
  run: (col: C) => Promise<void>,
  onColumnSettled?: () => void,
): Promise<void> {
  const byId = new Map(cols.map((c) => [c.id, c]));
  const done = new Set<string>();
  const inFlight = new Set<string>();
  const pending = new Set(cols.map((c) => c.id));
  const limit = Math.max(1, concurrency);

  const depsSatisfied = (id: string): boolean => {
    const d = deps.get(id);
    if (!d) return true;
    for (const dep of d) if (byId.has(dep) && !done.has(dep)) return false;
    return true;
  };

  return new Promise<void>((resolve) => {
    const pump = () => {
      if (pending.size === 0 && inFlight.size === 0) {
        resolve();
        return;
      }
      let eligible = [...pending].filter(depsSatisfied);
      // Deadlock guard: nothing eligible and nothing running (e.g. a cycle) —
      // release the rest so they still get attempted exactly once.
      if (eligible.length === 0 && inFlight.size === 0 && pending.size > 0) {
        eligible = [...pending];
      }
      for (const id of eligible) {
        if (inFlight.size >= limit) break;
        const col = byId.get(id);
        if (!col) {
          pending.delete(id);
          continue;
        }
        pending.delete(id);
        inFlight.add(id);
        void Promise.resolve()
          .then(() => run(col))
          .catch(() => {
            /* per-column failure must not abort the run */
          })
          .finally(() => {
            inFlight.delete(id);
            done.add(id);
            onColumnSettled?.();
            pump();
          });
      }
    };
    pump();
  });
}
