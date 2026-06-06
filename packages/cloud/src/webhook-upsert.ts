/**
 * Pure upsert-match logic for the webhook UPSERT path (server-side match).
 *
 * The webhook worker used to fetch the whole grid and match the upsert row in
 * JS, then write each mapped cell with its own `setCell` — which metered ONCE
 * PER CELL, over-billing an N-field upsert N times vs the create path's one
 * action per record. The fix moves the match server-side into a single atomic
 * Convex mutation (`internal.webhooks.upsertWebhookRow`). This module holds the
 * pure, exhaustively-testable kernel of that mutation: deciding whether a stored
 * cell value in the upsert-key column equals the incoming value.
 *
 * Equality rule (deliberately narrow): the upsert key is compared as a SCALAR
 * (string / number / boolean). Two scalars match when they are strictly equal
 * (`===`). Object / array upsert keys are UNSUPPORTED and never match — a webhook
 * should match on a stable identifier (an email, an id, a slug), not a nested
 * structure, and silently deep-comparing JSON would be surprising and slow. A
 * non-scalar incoming value therefore yields NO match, so the worker inserts a
 * fresh row instead of guessing.
 *
 * Pure of `node:*` and of Convex codegen so it bundles into both the Convex
 * (esbuild) graph and Vitest. Mirrors the `CellMerge` / `CascadePlanner` shape:
 * the rule lives here and is unit-tested; convex/ wires it to `ctx`.
 */

/** A scalar an upsert key may be matched on. */
export type UpsertScalar = string | number | boolean;

/**
 * True when `value` is a scalar we support as an upsert key (string / number /
 * boolean) AND is not an empty string. `null` / `undefined` / objects / arrays
 * are NOT valid upsert keys (an absent or structural key can never identify an
 * existing row), so they return false.
 */
export function isValidUpsertKeyValue(value: unknown): value is UpsertScalar {
  if (value === null || value === undefined) return false;
  const t = typeof value;
  if (t === "string") return value !== "";
  return t === "number" || t === "boolean";
}

/**
 * True when a stored upsert-key cell value matches the incoming value. Both
 * sides must be supported scalars (see {@link isValidUpsertKeyValue}); the
 * comparison is strict (`===`), so `1 !== "1"` and `true !== "true"` — types
 * are NOT coerced. Returns false for any non-scalar on either side, so an upsert
 * on an unsupported key never collides with an existing row.
 */
export function matchesUpsertKey(stored: unknown, incoming: unknown): boolean {
  if (!isValidUpsertKeyValue(incoming)) return false;
  if (!isValidUpsertKeyValue(stored)) return false;
  return stored === incoming;
}

/**
 * Find the id of the FIRST stored cell whose value matches `incoming` under the
 * scalar-equality rule, scanning `cells` in order. Returns the matched cell's
 * `rowId`, or `null` when nothing matches (caller then inserts a new row). The
 * caller is responsible for pre-filtering `cells` to the upsert-key column.
 */
export function findUpsertRowId<RowId>(
  cells: ReadonlyArray<{ readonly rowId: RowId; readonly value: unknown }>,
  incoming: unknown,
): RowId | null {
  if (!isValidUpsertKeyValue(incoming)) return null;
  for (const cell of cells) {
    if (matchesUpsertKey(cell.value, incoming)) return cell.rowId;
  }
  return null;
}
