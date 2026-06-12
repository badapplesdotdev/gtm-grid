/**
 * Inbound-webhook field mapping, used by the public receiver route
 * (`app/api/webhooks/[token]/route.ts`). Lives outside the route file so it can
 * be unit-tested (App Router route files may only export handlers).
 */

/** A single field-mapping entry: a JSON path → the target column id. */
export interface MappingEntry {
  readonly path: string;
  readonly columnId: string;
}

/** The mapping path that means "the whole request body" (the Clay-style raw
 *  Webhook column). Mirrors WEBHOOK_PAYLOAD_PATH in @gtmgrid/services. */
export const PAYLOAD_PATH = "$";

/** The value shape the `$` entry writes — what the grid renders as
 *  "Received <date>" and the cell-details panel flattens for field promotion. */
export interface WebhookCellValue {
  readonly receivedAt: number;
  readonly payload: unknown;
}

/**
 * Read a value out of `body` at a dotted/bracketed `path` (e.g. `a.b[0].c` or
 * `payload.email`). Returns `undefined` when any segment is missing.
 */
export function valueAtPath(body: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\w+)\]/g, ".$1")
    .split(".")
    .filter((s) => s.length > 0);
  let current: unknown = body;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Apply the stored mapping to the body → `{ columnId: value }` (skip missing).
 * The `$` entry maps the ENTIRE body as `{ receivedAt, payload }` into its
 * column — so a record is always visible in the grid even when no field
 * mappings are configured.
 */
export function applyMapping(
  body: unknown,
  mapping: readonly MappingEntry[],
  receivedAt: number,
): Record<string, unknown> {
  const cells: Record<string, unknown> = {};
  for (const entry of mapping) {
    if (entry.path === PAYLOAD_PATH) {
      const value: WebhookCellValue = { receivedAt, payload: body };
      cells[entry.columnId] = value;
      continue;
    }
    const value = valueAtPath(body, entry.path);
    if (value === undefined) continue;
    cells[entry.columnId] = value;
  }
  return cells;
}
