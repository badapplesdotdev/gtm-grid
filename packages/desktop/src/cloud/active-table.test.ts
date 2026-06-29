import { describe, expect, it } from "vitest";
import {
  resolveActiveTable,
  type ActiveTableListEntry,
  type ActiveTablePaged,
} from "./active-table.js";

const LIST: ActiveTableListEntry[] = [
  { _id: "tbl_test", name: "Test" },
  { _id: "tbl_leads", name: "Leads" },
];

const PAGED: ActiveTablePaged = {
  name: "Test",
  columns: [{ name: "Domain" }, { name: "Company" }, { name: "Contact Name" }],
};

describe("resolveActiveTable — the agent's active-table hint", () => {
  // ── The regression this guards (TRI: goal made a NEW table) ──────────────────
  it("returns the list name BEFORE the paged fetch resolves (app opened onto a default table)", () => {
    // cloudTableId is set synchronously (auto-default-on-open), but the paged table
    // hasn't loaded yet. The hint MUST still carry the name, or the preamble drops
    // its "Active table" section and the agent spins up a brand-new table.
    const hint = resolveActiveTable("tbl_test", null, LIST);
    expect(hint).toEqual({ name: "Test", columns: [] });
  });

  it("returns the list name while the paged fetch is still loading (undefined)", () => {
    const hint = resolveActiveTable("tbl_test", undefined, LIST);
    expect(hint).toEqual({ name: "Test", columns: [] });
  });

  it("works for a manually-clicked non-first table before its paged fetch resolves", () => {
    const hint = resolveActiveTable("tbl_leads", null, LIST);
    expect(hint).toEqual({ name: "Leads", columns: [] });
  });

  // ── Once the paged table arrives ─────────────────────────────────────────────
  it("prefers the fully-loaded paged table (name + columns) once it resolves", () => {
    const hint = resolveActiveTable("tbl_test", PAGED, LIST);
    expect(hint).toEqual({ name: "Test", columns: ["Domain", "Company", "Contact Name"] });
  });

  it("uses the paged name even if it differs from the list (paged is the source of truth)", () => {
    // e.g. a rename landed in the paged fetch before the list refetched.
    const renamed: ActiveTablePaged = { name: "Test (renamed)", columns: [{ name: "Domain" }] };
    const hint = resolveActiveTable("tbl_test", renamed, LIST);
    expect(hint).toEqual({ name: "Test (renamed)", columns: ["Domain"] });
  });

  it("uses the paged table even when it is not in the list yet (just-created table)", () => {
    const fresh: ActiveTablePaged = { name: "Fresh", columns: [] };
    const hint = resolveActiveTable("tbl_fresh", fresh, LIST);
    expect(hint).toEqual({ name: "Fresh", columns: [] });
  });

  // ── No active table → no hint (preamble correctly omits the section) ─────────
  it("returns null when no table is selected (cloudTableId null) and nothing is paged", () => {
    expect(resolveActiveTable(null, null, LIST)).toBeNull();
  });

  it("returns null when the selected id is not in the list and not yet paged (stale/deleted id)", () => {
    expect(resolveActiveTable("tbl_ghost", null, LIST)).toBeNull();
  });

  it("returns null when the tables list is still loading (undefined) and nothing is paged", () => {
    expect(resolveActiveTable("tbl_test", null, undefined)).toBeNull();
  });

  it("returns null when the tables list is empty and nothing is paged", () => {
    expect(resolveActiveTable("tbl_test", null, [])).toBeNull();
  });

  it("returns null when there is no selection AND nothing paged AND no list", () => {
    expect(resolveActiveTable(null, null, null)).toBeNull();
  });

  // ── Column shaping ───────────────────────────────────────────────────────────
  it("maps paged columns to bare names in order", () => {
    const wide: ActiveTablePaged = {
      name: "Wide",
      columns: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }],
    };
    expect(resolveActiveTable("tbl_w", wide, LIST)?.columns).toEqual(["A", "B", "C", "D"]);
  });

  it("yields empty columns (never undefined) when falling back to the list name", () => {
    const hint = resolveActiveTable("tbl_test", null, LIST);
    expect(hint?.columns).toEqual([]);
    expect(Array.isArray(hint?.columns)).toBe(true);
  });
});
