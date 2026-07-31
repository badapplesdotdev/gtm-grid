/**
 * The pure half of sheet import: header alignment, identity, hashing, ranges.
 *
 * These are tested directly because every real-world failure of a spreadsheet
 * import lives here rather than in the HTTP. Google returns RAGGED rows (trailing
 * empties are omitted), humans retype headers with different case and trailing
 * spaces, tabs are called "Q3 Leads" and "Won/Lost", and duplicate headers are
 * routine in exported sheets. Each of those silently moves data into the wrong
 * column or invents a phantom row if handled naively.
 */

import { describe, expect, it } from "vitest";
import {
  mapRows,
  normalizeHeader,
  pauseCopy,
  pauseReasonFor,
  rangeFor,
  valuesHashOf,
} from "./sheet-import-service.js";

const COLUMNS = [
  { header: "Company", columnId: "col_company" },
  { header: "Domain", columnId: "col_domain" },
];

describe("normalizeHeader", () => {
  it("ignores case and surrounding whitespace", () => {
    // "Email " vs "email" would otherwise silently unmap a column, presenting as
    // "the import stopped filling that field" with nothing to explain it.
    expect(normalizeHeader("  Email ")).toBe("email");
    expect(normalizeHeader("EMAIL")).toBe("email");
  });
});

describe("rangeFor", () => {
  it("quotes the tab name so spaces and slashes survive", () => {
    expect(rangeFor({ sheetTitle: "Q3 Leads", headerRow: 1 })).toBe("'Q3 Leads'!A1:ZZ");
    expect(rangeFor({ sheetTitle: "Won/Lost", headerRow: 1 })).toBe("'Won/Lost'!A1:ZZ");
  });

  it("doubles internal apostrophes, per A1 notation", () => {
    expect(rangeFor({ sheetTitle: "Morgan's list", headerRow: 1 })).toBe("'Morgan''s list'!A1:ZZ");
  });

  it("starts at the declared header row, not always row 1", () => {
    // Real sheets carry title banners above the header.
    expect(rangeFor({ sheetTitle: "Leads", headerRow: 3 })).toBe("'Leads'!A3:ZZ");
  });
});

describe("mapRows — header alignment", () => {
  it("maps values by header, not by position", () => {
    const { rows } = mapRows(
      [
        ["Domain", "Company"],
        ["acme.com", "Acme"],
      ],
      COLUMNS,
      null,
    );
    // Columns are declared Company-then-Domain; the sheet has them reversed.
    expect(rows[0]?.values).toEqual(["Acme", "acme.com"]);
  });

  it("matches headers case- and whitespace-insensitively", () => {
    const { rows, missingHeaders } = mapRows(
      [
        [" company ", "DOMAIN"],
        ["Acme", "acme.com"],
      ],
      COLUMNS,
      null,
    );
    expect(missingHeaders).toEqual([]);
    expect(rows[0]?.values).toEqual(["Acme", "acme.com"]);
  });

  it("reports a mapped header the sheet no longer has, and blanks it rather than failing", () => {
    // Someone renamed a column. The rest of the import is still correct and
    // useful; failing outright would strand the table.
    const { rows, missingHeaders } = mapRows(
      [
        ["Company"],
        ["Acme"],
      ],
      COLUMNS,
      null,
    );
    expect(missingHeaders).toEqual(["Domain"]);
    expect(rows[0]?.values).toEqual(["Acme", ""]);
  });

  it("takes the FIRST of duplicate headers", () => {
    // Exported sheets routinely repeat a header; taking the last one moves data
    // between columns with no warning.
    const { rows } = mapRows(
      [
        ["Company", "Domain", "Company"],
        ["Acme", "acme.com", "WRONG"],
      ],
      COLUMNS,
      null,
    );
    expect(rows[0]?.values).toEqual(["Acme", "acme.com"]);
  });

  it("survives RAGGED rows — Google omits trailing empty cells", () => {
    const { rows } = mapRows(
      [
        ["Company", "Domain"],
        ["Acme"], // no domain cell at all, not an empty string
      ],
      COLUMNS,
      null,
    );
    expect(rows[0]?.values).toEqual(["Acme", ""]);
  });

  it("skips wholly blank spacer lines", () => {
    const { rows } = mapRows(
      [
        ["Company", "Domain"],
        ["Acme", "acme.com"],
        [],
        ["", ""],
        ["Beta", "beta.com"],
      ],
      COLUMNS,
      null,
    );
    expect(rows.map((r) => r.values[0])).toEqual(["Acme", "Beta"]);
  });

  it("returns nothing for a header-only sheet", () => {
    expect(mapRows([["Company", "Domain"]], COLUMNS, null).rows).toEqual([]);
  });

  it("returns nothing for a completely empty sheet", () => {
    expect(mapRows([], COLUMNS, null).rows).toEqual([]);
  });
});

describe("mapRows — identity", () => {
  it("uses the key column's value when a key header is set", () => {
    const { rows } = mapRows(
      [
        ["Company", "Domain"],
        ["Acme", "acme.com"],
        ["Beta", "beta.com"],
      ],
      COLUMNS,
      "Domain",
    );
    expect(rows.map((r) => r.externalKey)).toEqual(["acme.com", "beta.com"]);
  });

  it("trims the key, so 'acme.com ' and 'acme.com' are the same row", () => {
    const { rows } = mapRows(
      [
        ["Company", "Domain"],
        ["Acme", "  acme.com  "],
      ],
      COLUMNS,
      "Domain",
    );
    expect(rows[0]?.externalKey).toBe("acme.com");
  });

  it("SKIPS rows whose key is blank rather than inventing identity", () => {
    // A synthetic key would create a phantom grid row that reappears on every
    // sync and can never be reconciled with anything in the sheet.
    const { rows } = mapRows(
      [
        ["Company", "Domain"],
        ["Acme", "acme.com"],
        ["Orphan", ""],
      ],
      COLUMNS,
      "Domain",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalKey).toBe("acme.com");
  });

  it("falls back to the SHEET ROW NUMBER when there is no key column", () => {
    // Row 1 is the header, so the first data row is sheet row 2.
    const { rows } = mapRows(
      [
        ["Company", "Domain"],
        ["Acme", "acme.com"],
        ["Beta", "beta.com"],
      ],
      COLUMNS,
      null,
    );
    expect(rows.map((r) => r.externalKey)).toEqual(["2", "3"]);
  });

  it("row-number identity SHIFTS when a row is deleted upstream — the documented hazard", () => {
    // Pinning the known weakness of keyless mode, not endorsing it: "Beta" was
    // row 3 and becomes row 2 once "Acme" is removed, so a re-sync overwrites
    // Acme's grid row with Beta's data. This is why the UI steers users to a key.
    const before = mapRows(
      [
        ["Company", "Domain"],
        ["Acme", "acme.com"],
        ["Beta", "beta.com"],
      ],
      COLUMNS,
      null,
    );
    const after = mapRows(
      [
        ["Company", "Domain"],
        ["Beta", "beta.com"],
      ],
      COLUMNS,
      null,
    );
    expect(before.rows[1]?.externalKey).toBe("3");
    expect(after.rows[0]?.externalKey).toBe("2");
    expect(after.rows[0]?.values[0]).toBe("Beta");
  });

  it("key identity is STABLE across a deletion — why a key column matters", () => {
    const after = mapRows(
      [
        ["Company", "Domain"],
        ["Beta", "beta.com"],
      ],
      COLUMNS,
      "Domain",
    );
    expect(after.rows[0]?.externalKey).toBe("beta.com");
  });
});

describe("valuesHashOf", () => {
  it("is stable for identical values, so an unchanged row skips its writes", () => {
    expect(valuesHashOf(["Acme", "acme.com"])).toBe(valuesHashOf(["Acme", "acme.com"]));
  });

  it("changes when any value changes", () => {
    expect(valuesHashOf(["Acme", "acme.com"])).not.toBe(valuesHashOf(["Acme", "acme.io"]));
  });

  it("distinguishes ORDER, so two columns swapping is a real change", () => {
    expect(valuesHashOf(["a", "b"])).not.toBe(valuesHashOf(["b", "a"]));
  });

  it("distinguishes an empty string from a missing trailing value", () => {
    expect(valuesHashOf(["a", ""])).not.toBe(valuesHashOf(["a"]));
  });
});

describe("pauseReasonFor", () => {
  it("treats 404 as file_gone — deleted and never-picked are indistinguishable", () => {
    // Under drive.file both produce 404 and both need the same human action.
    expect(pauseReasonFor(404)).toBe("file_gone");
  });

  it("treats 401/403 as a revoked grant", () => {
    expect(pauseReasonFor(401)).toBe("auth_revoked");
    expect(pauseReasonFor(403)).toBe("auth_revoked");
  });

  it("does NOT pause on transient failures — those must retry", () => {
    for (const status of [429, 500, 503, 0]) expect(pauseReasonFor(status)).toBeNull();
  });
});

describe("pauseCopy", () => {
  it("tells the user what to DO, and names the never-picked case", () => {
    // The single most likely cause of a 404 under drive.file, and invisible
    // unless the copy says it.
    expect(pauseCopy("file_gone")).toMatch(/never selected/i);
    expect(pauseCopy("auth_revoked")).toMatch(/reconnect/i);
  });

  it("never leaks a raw status or tag", () => {
    for (const reason of ["auth_revoked", "file_gone", "sheet_gone", "something_new"]) {
      expect(pauseCopy(reason)).not.toMatch(/\b40[0-9]\b|_/);
    }
  });
});
