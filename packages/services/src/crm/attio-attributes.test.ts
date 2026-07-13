/**
 * The pure Attio attribute layer: typed value entries → cell text, and the
 * six wizard filter ops → (server prefilter, worker predicate). The worker
 * predicate is authoritative — these tests pin its exact semantics.
 */

import { describe, expect, it } from "vitest";
import { flattenAttrValue, toAttioFilter, toAttioFilterBody, type AttioAttrType } from "./attio-attributes.js";
import { matchesAllFilters, matchesFilter, type CrmFilter } from "./crm-values.js";

const text = (type: AttioAttrType, entries: ReadonlyArray<Record<string, unknown>>): string => {
  const flat = flattenAttrValue(type, entries);
  if (flat.kind !== "text") throw new Error(`expected text, got ${flat.kind}`);
  return flat.text;
};

describe("flattenAttrValue — per attribute type", () => {
  it.each<[AttioAttrType, Record<string, unknown>, string]>([
    ["text", { value: "VP Engineering" }, "VP Engineering"],
    ["number", { value: 320 }, "320"],
    ["rating", { value: 4 }, "4"],
    ["checkbox", { value: true }, "Yes"],
    ["checkbox", { value: false }, "No"],
    ["personal-name", { full_name: "Sarah Chen", first_name: "Sarah", last_name: "Chen" }, "Sarah Chen"],
    ["personal-name", { first_name: "Sarah", last_name: "Chen" }, "Sarah Chen"],
    ["email-address", { email_address: "sarah.chen@vercel.com" }, "sarah.chen@vercel.com"],
    ["domain", { domain: "vercel.com" }, "vercel.com"],
    ["phone-number", { phone_number: "+14155550142" }, "+14155550142"],
    ["phone-number", { original_phone_number: "+1 415 555 0142" }, "+1 415 555 0142"],
    ["currency", { currency_value: 45000000, currency_code: "USD" }, "45,000,000 USD"],
    ["currency", { currency_value: 12000 }, "12,000"],
    ["date", { value: "2024-03-11" }, "2024-03-11"],
    ["timestamp", { value: "2024-03-11T09:30:00.000000000Z" }, "2024-03-11"],
    ["select", { option: { title: "Fintech" } }, "Fintech"],
    ["status", { status: { title: "Contract sent" } }, "Contract sent"],
    ["location", { locality: "San Francisco", region: "CA", country_code: "US" }, "San Francisco, CA, US"],
    ["location", { locality: null, region: null, country_code: "US" }, "US"],
  ])("%s", (type, entry, expected) => {
    expect(text(type, [entry])).toBe(expected);
  });

  it("empty / missing entries flatten to empty text", () => {
    expect(text("text", [])).toBe("");
    expect(flattenAttrValue("text", undefined)).toEqual({ kind: "text", text: "" });
    expect(text("select", [{}])).toBe("");
    expect(text("checkbox", [{}])).toBe("");
  });

  it("multi-value attributes join with a comma", () => {
    expect(
      text("email-address", [{ email_address: "a@x.com" }, { email_address: "b@x.com" }]),
    ).toBe("a@x.com, b@x.com");
    expect(text("domain", [{ domain: "x.com" }, { domain: "y.com" }])).toBe("x.com, y.com");
  });

  it("record references become ref descriptors for batch name resolution", () => {
    expect(
      flattenAttrValue("record-reference", [{ target_object: "companies", target_record_id: "rec_1" }]),
    ).toEqual({ kind: "ref", targetObject: "companies", targetRecordId: "rec_1" });
    // Multi-value refs keep only the first (a cell holds one name).
    expect(
      flattenAttrValue("record-reference", [
        { target_object: "companies", target_record_id: "rec_1" },
        { target_object: "companies", target_record_id: "rec_2" },
      ]),
    ).toEqual({ kind: "ref", targetObject: "companies", targetRecordId: "rec_1" });
    // A ref without an id degrades to empty text, not a broken ref.
    expect(flattenAttrValue("record-reference", [{ target_object: "companies" }])).toEqual({
      kind: "text",
      text: "",
    });
  });

  it("actor references become actor descriptors", () => {
    expect(flattenAttrValue("actor-reference", [{ referenced_actor_id: "member_9" }])).toEqual({
      kind: "actor",
      actorId: "member_9",
    });
  });
});

// ── Filters ───────────────────────────────────────────────────────────────────

const f = (op: CrmFilter["op"], value = "", attrType: AttioAttrType = "text"): CrmFilter => ({
  attrSlug: "title",
  attrType,
  op,
  value,
});

describe("toAttioFilter — server prefilter only where semantics are certain", () => {
  it("is → $eq on plain types only", () => {
    expect(toAttioFilter(f("is", "Founder"))).toEqual({ title: { $eq: "Founder" } });
    expect(toAttioFilter(f("is", "320", "number"))).toEqual({ title: { $eq: 320 } });
    expect(toAttioFilter(f("is", "a@x.com", "email-address"))).toBeUndefined();
  });

  it("contains → $contains on text only", () => {
    expect(toAttioFilter(f("contains", "Eng"))).toEqual({ title: { $contains: "Eng" } });
    expect(toAttioFilter(f("contains", "x", "domain"))).toBeUndefined();
  });

  it("is known → $not_empty on any type", () => {
    expect(toAttioFilter(f("is known", "", "email-address"))).toEqual({ title: { $not_empty: true } });
  });

  it("after → $gt on date/timestamp only", () => {
    expect(toAttioFilter(f("after", "2024-01-01", "date"))).toEqual({ title: { $gt: "2024-01-01" } });
    expect(toAttioFilter(f("after", "5", "number"))).toBeUndefined();
  });

  it("is not / is unknown are worker-side only", () => {
    expect(toAttioFilter(f("is not", "x"))).toBeUndefined();
    expect(toAttioFilter(f("is unknown"))).toBeUndefined();
  });

  it("filter body ANDs multiple prefilters and drops worker-only ops", () => {
    expect(toAttioFilterBody([])).toBeUndefined();
    expect(toAttioFilterBody([f("is unknown")])).toBeUndefined();
    expect(toAttioFilterBody([f("is", "Founder")])).toEqual({ title: { $eq: "Founder" } });
    expect(toAttioFilterBody([f("is", "Founder"), f("is known")])).toEqual({
      $and: [{ title: { $eq: "Founder" } }, { title: { $not_empty: true } }],
    });
  });
});

describe("matchesFilter — the authoritative worker predicate", () => {
  it.each<[CrmFilter["op"], string, string, boolean]>([
    ["is", "Founder", "Founder", true],
    ["is", "founder", "Founder", false], // "is" is exact
    ["is not", "Founder", "VP Sales", true],
    ["is not", "Founder", "Founder", false],
    ["contains", "eng", "VP Engineering", true], // contains is case-insensitive
    ["contains", "sales", "VP Engineering", false],
    ["is known", "", "anything", true],
    ["is known", "", "", false],
    ["is unknown", "", "", true],
    ["is unknown", "", "x", false],
    ["after", "2024-01-01", "2024-03-11", true],
    ["after", "2024-06-01", "2024-03-11", false],
    ["after", "2024-01-01", "not a date", false],
  ])("%s %s vs %s → %s", (op, value, flat, expected) => {
    expect(matchesFilter(f(op, value), flat)).toBe(expected);
  });

  it("whitespace around values never changes the answer", () => {
    expect(matchesFilter(f("is", " Founder "), "Founder")).toBe(true);
    expect(matchesFilter(f("is unknown"), "   ")).toBe(true);
  });

  it("matchesAllFilters ANDs across attributes", () => {
    const filters: CrmFilter[] = [
      { attrSlug: "stage", attrType: "status", op: "is", value: "Customer" },
      { attrSlug: "email", attrType: "email-address", op: "is known", value: "" },
    ];
    const record: Record<string, string> = { stage: "Customer", email: "a@x.com" };
    expect(matchesAllFilters(filters, (slug) => record[slug] ?? "")).toBe(true);
    expect(matchesAllFilters(filters, (slug) => (slug === "email" ? "" : record[slug] ?? ""))).toBe(false);
  });
});
