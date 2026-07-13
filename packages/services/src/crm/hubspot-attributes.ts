/**
 * Pure HubSpot property layer (TRI: crm-sync): maps HubSpot property metadata
 * into the neutral cell-type vocabulary (`crm-values.ts`), flattens property
 * values (flat strings in HubSpot's API) into `FlatValue`s, and compiles the
 * wizard's filter ops into an optional CRM-search prefilter.
 *
 * Worker-authoritative filtering: the search prefilter is only an
 * optimization — every record is re-checked against the flattened text
 * (`matchesAllFilters`), so a filter always means exactly what the wizard
 * preview showed, regardless of HubSpot operator semantics (e.g.
 * CONTAINS_TOKEN's token matching vs our substring "contains").
 */

import type { CrmAttrType, CrmFilter, FlatValue } from "./crm-values.js";

/** The property metadata bits the mapping needs (from GET /crm/v3/properties). */
export interface HubspotPropertyMeta {
  readonly name: string;
  readonly type: string;
  readonly fieldType: string;
  readonly referencedObjectType?: string | null;
}

/**
 * HubSpot property type → neutral attr type, or null when unsupported.
 * Property NAMES refine plain strings (HubSpot types "email" and "domain"
 * as ordinary strings; the neutral types drive match-key suggestions).
 */
export function mapHubspotPropertyType(meta: HubspotPropertyMeta): CrmAttrType | null {
  if (meta.referencedObjectType === "OWNER") return "actor-reference";
  switch (meta.type) {
    case "string":
      if (meta.name === "email" || meta.name.endsWith("_email")) return "email-address";
      if (meta.name === "domain" || meta.name === "website") return "domain";
      if (meta.fieldType === "phonenumber") return "phone-number";
      return "text";
    case "number":
      return "number";
    case "enumeration":
      return "select";
    case "bool":
      return "checkbox";
    case "date":
      return "date";
    case "datetime":
      return "timestamp";
    case "phone_number":
      return "phone-number";
    default:
      return null;
  }
}

/** "2024-03-11T09:30:00.000Z" → "2024-03-11" (dates stay human, not techy). */
const datePart = (v: string): string => (v.includes("T") ? v.slice(0, v.indexOf("T")) : v);

/**
 * Flatten one HubSpot property value (always a string or null in the v3 API)
 * by its neutral attr type. Multi-value enumerations arrive ";"-separated.
 */
export function flattenHubspotValue(type: CrmAttrType, raw: string | null | undefined): FlatValue {
  const text = raw === null || raw === undefined ? "" : String(raw);
  if (text === "") return { kind: "text", text: "" };
  switch (type) {
    case "checkbox":
      return { kind: "text", text: text === "true" ? "Yes" : text === "false" ? "No" : text };
    case "date":
    case "timestamp":
      return { kind: "text", text: datePart(text) };
    case "select":
    case "status":
      return { kind: "text", text: text.split(";").filter((p) => p !== "").join(", ") };
    case "actor-reference":
      return { kind: "actor", actorId: text };
    default:
      return { kind: "text", text };
  }
}

/**
 * CRM-search prefilter for one wizard filter, when the op's semantics are
 * certain enough to narrow the pull. Returns undefined for ops that only run
 * worker-side ("is not", "is unknown" — HubSpot's NOT_HAS_PROPERTY and NEQ
 * treat missing values differently than our flattened-text predicate).
 */
export function toHubspotSearchFilter(f: CrmFilter): Record<string, unknown> | undefined {
  switch (f.op) {
    case "is":
      return f.attrType === "text" || f.attrType === "number" || f.attrType === "select"
        ? { propertyName: f.attrSlug, operator: "EQ", value: f.value }
        : undefined;
    case "contains":
      // CONTAINS_TOKEN is token-based (whole words), a SUPERSET-ish narrow of
      // our substring semantics only for whole-word values — compile it only
      // as a best effort; the worker predicate is authoritative either way.
      return f.attrType === "text" ? { propertyName: f.attrSlug, operator: "CONTAINS_TOKEN", value: `*${f.value}*` } : undefined;
    case "is known":
      return { propertyName: f.attrSlug, operator: "HAS_PROPERTY" };
    case "after":
      return f.attrType === "date" || f.attrType === "timestamp"
        ? { propertyName: f.attrSlug, operator: "GT", value: f.value }
        : undefined;
    case "is not":
    case "is unknown":
      return undefined;
  }
}

/**
 * Combine per-filter prefilters into one CRM-search body (AND within a single
 * filterGroup), or undefined when nothing is expressible. NOTE: the search
 * endpoint caps results at 10k — callers must treat a compiled prefilter as
 * an optimization for SMALL result sets and fall back to plain paging when
 * nothing compiles.
 */
export function toHubspotSearchBody(
  filters: ReadonlyArray<CrmFilter>,
): Record<string, unknown> | undefined {
  const parts = filters
    .map(toHubspotSearchFilter)
    .filter((p): p is Record<string, unknown> => p !== undefined);
  if (parts.length === 0) return undefined;
  return { filterGroups: [{ filters: parts }] };
}
