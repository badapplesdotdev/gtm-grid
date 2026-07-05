/**
 * The pure HubSpot property layer: property metadata → neutral attr types,
 * flat property strings → cell values, and the wizard filter ops → the
 * optional CRM-search prefilter. The worker predicate (crm-values.ts) stays
 * authoritative — these tests pin the mapping semantics.
 */

import { describe, expect, it } from "vitest";
import {
  flattenHubspotValue,
  mapHubspotPropertyType,
  toHubspotSearchBody,
  toHubspotSearchFilter,
} from "./hubspot-attributes.js";
import type { CrmFilter } from "./crm-values.js";

const meta = (over: Partial<Parameters<typeof mapHubspotPropertyType>[0]>) => ({
  name: "some_prop",
  type: "string",
  fieldType: "text",
  ...over,
});

describe("mapHubspotPropertyType — into the neutral vocabulary", () => {
  it("owners become actor references regardless of raw type", () => {
    expect(mapHubspotPropertyType(meta({ name: "hubspot_owner_id", type: "enumeration", referencedObjectType: "OWNER" }))).toBe(
      "actor-reference",
    );
  });

  it("email/domain property NAMES refine plain strings (match-key suggestions)", () => {
    expect(mapHubspotPropertyType(meta({ name: "email" }))).toBe("email-address");
    expect(mapHubspotPropertyType(meta({ name: "work_email" }))).toBe("email-address");
    expect(mapHubspotPropertyType(meta({ name: "domain" }))).toBe("domain");
    expect(mapHubspotPropertyType(meta({ name: "website" }))).toBe("domain");
    expect(mapHubspotPropertyType(meta({ name: "firstname" }))).toBe("text");
  });

  it("scalar types map 1:1", () => {
    expect(mapHubspotPropertyType(meta({ type: "number" }))).toBe("number");
    expect(mapHubspotPropertyType(meta({ type: "enumeration" }))).toBe("select");
    expect(mapHubspotPropertyType(meta({ type: "bool" }))).toBe("checkbox");
    expect(mapHubspotPropertyType(meta({ type: "date" }))).toBe("date");
    expect(mapHubspotPropertyType(meta({ type: "datetime" }))).toBe("timestamp");
    expect(mapHubspotPropertyType(meta({ type: "phone_number" }))).toBe("phone-number");
    expect(mapHubspotPropertyType(meta({ fieldType: "phonenumber" }))).toBe("phone-number");
  });

  it("unknown types are unsupported (null), never guessed", () => {
    expect(mapHubspotPropertyType(meta({ type: "object_coordinates" }))).toBeNull();
    expect(mapHubspotPropertyType(meta({ type: "json" }))).toBeNull();
  });
});

describe("flattenHubspotValue — flat strings → cell values", () => {
  it("empty/null/undefined flatten to empty text", () => {
    expect(flattenHubspotValue("text", null)).toEqual({ kind: "text", text: "" });
    expect(flattenHubspotValue("text", undefined)).toEqual({ kind: "text", text: "" });
    expect(flattenHubspotValue("checkbox", "")).toEqual({ kind: "text", text: "" });
  });

  it("booleans read as Yes/No, not true/false", () => {
    expect(flattenHubspotValue("checkbox", "true")).toEqual({ kind: "text", text: "Yes" });
    expect(flattenHubspotValue("checkbox", "false")).toEqual({ kind: "text", text: "No" });
  });

  it("datetimes drop the time part; plain dates pass through", () => {
    expect(flattenHubspotValue("timestamp", "2024-03-11T09:30:00.000Z")).toEqual({ kind: "text", text: "2024-03-11" });
    expect(flattenHubspotValue("date", "2024-03-11")).toEqual({ kind: "text", text: "2024-03-11" });
  });

  it("multi-select enumerations join ';' parts with a readable ', '", () => {
    expect(flattenHubspotValue("select", "SEO;Paid;Referral")).toEqual({ kind: "text", text: "SEO, Paid, Referral" });
    expect(flattenHubspotValue("select", "appointmentscheduled")).toEqual({ kind: "text", text: "appointmentscheduled" });
  });

  it("owner ids become actor descriptors the engine resolves to names", () => {
    expect(flattenHubspotValue("actor-reference", "owner_123")).toEqual({ kind: "actor", actorId: "owner_123" });
  });
});

describe("toHubspotSearchBody — the optional server prefilter", () => {
  const f = (over: Partial<CrmFilter>): CrmFilter => ({
    attrSlug: "lifecyclestage",
    attrType: "select",
    op: "is",
    value: "customer",
    ...over,
  });

  it("'is' compiles to EQ for plain values", () => {
    expect(toHubspotSearchFilter(f({}))).toEqual({ propertyName: "lifecyclestage", operator: "EQ", value: "customer" });
  });

  it("'is known' compiles to HAS_PROPERTY; 'after' to GT on dates", () => {
    expect(toHubspotSearchFilter(f({ op: "is known" }))).toEqual({ propertyName: "lifecyclestage", operator: "HAS_PROPERTY" });
    expect(toHubspotSearchFilter(f({ attrSlug: "createdate", attrType: "timestamp", op: "after", value: "2024-01-01" }))).toEqual({
      propertyName: "createdate",
      operator: "GT",
      value: "2024-01-01",
    });
  });

  it("worker-only ops ('is not', 'is unknown') never compile", () => {
    expect(toHubspotSearchFilter(f({ op: "is not" }))).toBeUndefined();
    expect(toHubspotSearchFilter(f({ op: "is unknown" }))).toBeUndefined();
  });

  it("compilable parts AND inside one filterGroup; nothing compilable → undefined", () => {
    expect(
      toHubspotSearchBody([f({}), f({ op: "is unknown" }), f({ attrSlug: "email", attrType: "email-address", op: "is known", value: "" })]),
    ).toEqual({
      filterGroups: [
        {
          filters: [
            { propertyName: "lifecyclestage", operator: "EQ", value: "customer" },
            { propertyName: "email", operator: "HAS_PROPERTY" },
          ],
        },
      ],
    });
    expect(toHubspotSearchBody([f({ op: "is not" })])).toBeUndefined();
    expect(toHubspotSearchBody([])).toBeUndefined();
  });
});
