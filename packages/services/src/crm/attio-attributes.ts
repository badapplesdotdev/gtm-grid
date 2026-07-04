/**
 * Pure Attio attribute layer (TRI: crm-sync): flattens Attio's typed value
 * entries into grid cell text, and compiles the wizard's six filter ops into
 * (a) an optional server-side Attio filter for narrowing the pull and (b) a
 * worker-side predicate that is ALWAYS applied.
 *
 * Worker-authoritative filtering: the server-side filter is only an
 * optimization — every record is re-checked here against the flattened text,
 * so a filter always means exactly what the wizard preview showed, regardless
 * of Attio operator semantics.
 *
 * Reference values (record links, actors) carry no display name in the API —
 * `flattenAttrValue` returns a `ref` descriptor and the sync worker resolves
 * names in batches per run (AttioClient.resolveRecordNames / listMembers).
 */

/** One entry of an Attio record's `values[attrSlug]` array (shape varies by type). */
export type AttioValueEntry = Record<string, unknown>;

/** Attio attribute types the field picker supports in v1. */
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
export type AttioAttrType = (typeof SUPPORTED_ATTR_TYPES)[number];

export const isSupportedAttrType = (t: string): t is AttioAttrType =>
  (SUPPORTED_ATTR_TYPES as ReadonlyArray<string>).includes(t);

/** A flattened cell: plain text, or a reference the worker must resolve to a name. */
export type FlatValue =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "ref"; readonly targetObject: string; readonly targetRecordId: string }
  | { readonly kind: "actor"; readonly actorId: string };

const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

const first = (entries: ReadonlyArray<AttioValueEntry> | undefined): AttioValueEntry | undefined =>
  entries && entries.length > 0 ? entries[0] : undefined;

/** "2024-03-11T09:30:00.000000000Z" → "2024-03-11" (dates stay human, not techy). */
const datePart = (v: string): string => (v.includes("T") ? v.slice(0, v.indexOf("T")) : v);

const currencyText = (e: AttioValueEntry): string => {
  const amount = e.currency_value;
  if (amount === null || amount === undefined) return "";
  const code = str(e.currency_code);
  const n = Number(amount);
  const formatted = Number.isFinite(n) ? n.toLocaleString("en-US") : str(amount);
  return code ? `${formatted} ${code}` : formatted;
};

const locationText = (e: AttioValueEntry): string =>
  [e.locality, e.region, e.country_code]
    .map(str)
    .filter((s) => s !== "")
    .join(", ");

const nested = (e: AttioValueEntry, key: string, sub: string): string => {
  const obj = e[key];
  return obj && typeof obj === "object" ? str((obj as Record<string, unknown>)[sub]) : "";
};

/**
 * Flatten ONE value entry by attribute type. Multi-value attributes (emails,
 * domains) are joined by {@link flattenAttrValue}.
 */
function flattenEntry(type: AttioAttrType, e: AttioValueEntry): FlatValue {
  switch (type) {
    case "text":
      return { kind: "text", text: str(e.value) };
    case "number":
    case "rating":
      return { kind: "text", text: str(e.value) };
    case "checkbox":
      return { kind: "text", text: e.value === true ? "Yes" : e.value === false ? "No" : "" };
    case "personal-name":
      return { kind: "text", text: str(e.full_name) || [str(e.first_name), str(e.last_name)].filter(Boolean).join(" ") };
    case "email-address":
      return { kind: "text", text: str(e.email_address) };
    case "domain":
      return { kind: "text", text: str(e.domain) };
    case "phone-number":
      return { kind: "text", text: str(e.phone_number) || str(e.original_phone_number) };
    case "currency":
      return { kind: "text", text: currencyText(e) };
    case "date":
      return { kind: "text", text: datePart(str(e.value)) };
    case "timestamp":
      return { kind: "text", text: datePart(str(e.value)) };
    case "select":
      return { kind: "text", text: nested(e, "option", "title") };
    case "status":
      return { kind: "text", text: nested(e, "status", "title") };
    case "location":
      return { kind: "text", text: locationText(e) };
    case "record-reference": {
      const target = str(e.target_object);
      const id = str(e.target_record_id);
      return id ? { kind: "ref", targetObject: target, targetRecordId: id } : { kind: "text", text: "" };
    }
    case "actor-reference": {
      const id = str(e.referenced_actor_id);
      return id ? { kind: "actor", actorId: id } : { kind: "text", text: "" };
    }
  }
}

/**
 * Flatten an attribute's value entries to a single cell value. Multi-value
 * text-ish attributes join with ", "; multi-value references keep only the
 * first (a cell holds one name; Attio's own grid does the same).
 */
export function flattenAttrValue(
  type: AttioAttrType,
  entries: ReadonlyArray<AttioValueEntry> | undefined,
): FlatValue {
  if (!entries || entries.length === 0) return { kind: "text", text: "" };
  if (type === "record-reference" || type === "actor-reference") {
    return flattenEntry(type, first(entries) as AttioValueEntry);
  }
  const texts = entries
    .map((e) => flattenEntry(type, e))
    .flatMap((f) => (f.kind === "text" && f.text !== "" ? [f.text] : []));
  return { kind: "text", text: texts.join(", ") };
}

// ── Filters ───────────────────────────────────────────────────────────────────

/** The wizard's filter ops (mirrors the design's dropdown). */
export const FILTER_OPS = ["is", "is not", "contains", "is known", "is unknown", "after"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface CrmFilter {
  readonly attrSlug: string;
  readonly attrType: AttioAttrType;
  readonly op: FilterOp;
  readonly value: string;
}

/**
 * Server-side Attio prefilter for one filter, when the op's semantics are
 * certain enough to narrow the pull ($eq / $contains / $not_empty / $gt).
 * Returns undefined for ops that only run worker-side ("is not", "is unknown").
 * Only plain single-value types get $eq/$contains prefilters — structured
 * types (name/email/domain/…) match on flattened text worker-side.
 */
export function toAttioFilter(f: CrmFilter): Record<string, unknown> | undefined {
  const plain = f.attrType === "text" || f.attrType === "number";
  switch (f.op) {
    case "is":
      return plain ? { [f.attrSlug]: { $eq: f.attrType === "number" ? Number(f.value) : f.value } } : undefined;
    case "contains":
      return f.attrType === "text" ? { [f.attrSlug]: { $contains: f.value } } : undefined;
    case "is known":
      return { [f.attrSlug]: { $not_empty: true } };
    case "after":
      return f.attrType === "date" || f.attrType === "timestamp"
        ? { [f.attrSlug]: { $gt: f.value } }
        : undefined;
    case "is not":
    case "is unknown":
      return undefined;
  }
}

/** Combine per-filter prefilters into one Attio `filter` body (AND), or undefined. */
export function toAttioFilterBody(
  filters: ReadonlyArray<CrmFilter>,
): Record<string, unknown> | undefined {
  const parts = filters.map(toAttioFilter).filter((p): p is Record<string, unknown> => p !== undefined);
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return { $and: parts };
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
