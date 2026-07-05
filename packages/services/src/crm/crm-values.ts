/**
 * Provider-neutral CRM value + filter layer (TRI: crm-sync). This is the
 * shared vocabulary every CRM client maps INTO: a single supported cell-type
 * union, the flattened cell value shape, and the wizard's filter ops with
 * their worker-side predicate.
 *
 * Worker-authoritative filtering: a provider MAY compile some filters into a
 * server-side prefilter (an optimization only — see each provider's
 * `compileServerFilter`), but every record is ALWAYS re-checked here against
 * the flattened text, so a filter means exactly what the wizard preview
 * showed regardless of provider operator semantics.
 */

/**
 * Attribute types the field picker supports. One neutral union across
 * providers — Attio's types map 1:1, HubSpot property types map into it
 * (e.g. `enumeration` → "select", `bool` → "checkbox").
 */
export const SUPPORTED_ATTR_TYPES = [
  "text",
  "personal-name",
  "email-address",
  "domain",
  "phone-number",
  "number",
  "currency",
  "date",
  "timestamp",
  "checkbox",
  "select",
  "status",
  "rating",
  "location",
  "record-reference",
  "actor-reference",
] as const;
export type CrmAttrType = (typeof SUPPORTED_ATTR_TYPES)[number];

export const isSupportedAttrType = (t: string): t is CrmAttrType =>
  (SUPPORTED_ATTR_TYPES as ReadonlyArray<string>).includes(t);

/** A flattened cell: plain text, or a reference the worker must resolve to a name. */
export type FlatValue =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "ref"; readonly targetObject: string; readonly targetRecordId: string }
  | { readonly kind: "actor"; readonly actorId: string };

// ── Filters ───────────────────────────────────────────────────────────────────

/** The wizard's filter ops (mirrors the design's dropdown). */
export const FILTER_OPS = ["is", "is not", "contains", "is known", "is unknown", "after"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface CrmFilter {
  readonly attrSlug: string;
  readonly attrType: CrmAttrType;
  readonly op: FilterOp;
  readonly value: string;
}

/**
 * Worker-side predicate over the FLATTENED text of the filtered attribute —
 * always applied, authoritative. Text ops are case-insensitive except "is",
 * which is an exact match (what non-technical users expect from "is").
 */
export function matchesFilter(f: CrmFilter, flatText: string): boolean {
  const text = flatText.trim();
  const value = f.value.trim();
  switch (f.op) {
    case "is":
      return text === value;
    case "is not":
      return text !== value;
    case "contains":
      return text.toLowerCase().includes(value.toLowerCase());
    case "is known":
      return text !== "";
    case "is unknown":
      return text === "";
    case "after": {
      const a = Date.parse(text);
      const b = Date.parse(value);
      return Number.isFinite(a) && Number.isFinite(b) && a > b;
    }
  }
}

export const matchesAllFilters = (
  filters: ReadonlyArray<CrmFilter>,
  flatTextByAttr: (attrSlug: string) => string,
): boolean => filters.every((f) => matchesFilter(f, flatTextByAttr(f.attrSlug)));
