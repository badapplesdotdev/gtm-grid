import { describe, it, expect } from "vitest";
import { changelogSection, changelogNotes } from "./changelog";

const SAMPLE = `# @gtmgrid/desktop

## 0.12.0

### Minor Changes

- 4f0cede: Add drag-to-resize to the agent panel, matching the app sidebar.

### Patch Changes

- @gtmgrid/analytics@0.12.0
- @gtmgrid/cloud@0.12.0

## 0.11.1

### Patch Changes

- 2fdb753: Make the column edit panel keyboard-accessible.
  - @gtmgrid/analytics@0.11.1

## 0.11.0

### Minor Changes

- 6d2bc93: Clay-style column UX
`;

describe("changelogSection", () => {
  it("extracts the body of a version section without the heading", () => {
    const body = changelogSection("0.12.0", SAMPLE);
    expect(body).toContain("Add drag-to-resize to the agent panel");
    expect(body).not.toContain("## 0.12.0");
    // Stops at the next version heading.
    expect(body).not.toContain("0.11.1");
  });

  it("returns null for an unknown version", () => {
    expect(changelogSection("9.9.9", SAMPLE)).toBeNull();
  });
});

describe("changelogNotes", () => {
  it("returns cleaned notes, dropping hashes and dependency bumps", () => {
    expect(changelogNotes("0.12.0", SAMPLE)).toEqual([
      "Add drag-to-resize to the agent panel, matching the app sidebar.",
    ]);
  });

  it("keeps meaningful patch notes but drops @gtmgrid bumps", () => {
    expect(changelogNotes("0.11.1", SAMPLE)).toEqual([
      "Make the column edit panel keyboard-accessible.",
    ]);
  });

  it("returns an empty array for an unknown version", () => {
    expect(changelogNotes("9.9.9", SAMPLE)).toEqual([]);
  });
});

// ── Categorized parsing (the redesigned update flow) ──────────────────────────

import { changelogAll, changelogEntry, parseReleaseNotes } from "./changelog";

const CATEGORIZED = `# @gtmgrid/desktop

## 1.6.0

### Minor Changes

- 53ccedf: HubSpot CRM sync alongside Attio.
- 309ac60: Add more CRM fields from the add-column menu.

### Patch Changes

- 53ccedf: Empty CRM lists now configure and sync correctly.
  - @gtmgrid/services@1.6.0

## 1.5.1

### Patch Changes

- e02d94d: CRM sync fixes from the first live Attio connection.
  - A missing Attio scope now pauses the sync with a clear banner.
  - Reference-name lookups tolerate rejected bulk id filters.
  - @gtmgrid/analytics@1.5.1
`;

describe("changelogEntry — categorized by bump level", () => {
  it("splits Minor→added and Patch→fixed, stripping hashes and dep bumps", () => {
    const e = changelogEntry("1.6.0", CATEGORIZED);
    expect(e).not.toBeNull();
    expect(e!.added).toEqual([
      "HubSpot CRM sync alongside Attio.",
      "Add more CRM fields from the add-column menu.",
    ]);
    expect(e!.fixed).toEqual(["Empty CRM lists now configure and sync correctly."]);
  });

  it("joins a multi-line bullet's sub-bullets into one readable note", () => {
    const e = changelogEntry("1.5.1", CATEGORIZED);
    expect(e!.added).toEqual([]);
    expect(e!.fixed).toHaveLength(1);
    expect(e!.fixed[0]).toContain("first live Attio connection");
    expect(e!.fixed[0]).toContain("missing Attio scope");
    expect(e!.fixed[0]).not.toContain("@gtmgrid/");
  });

  it("unknown version → null", () => {
    expect(changelogEntry("9.9.9", CATEGORIZED)).toBeNull();
  });
});

describe("changelogAll", () => {
  it("returns every non-empty release, newest first", () => {
    const all = changelogAll(CATEGORIZED);
    expect(all.map((e) => e.version)).toEqual(["1.6.0", "1.5.1"]);
  });
});

describe("parseReleaseNotes — the incoming update's GitHub release body", () => {
  it("parses changesets markdown into categories", () => {
    const r = parseReleaseNotes("### Minor Changes\n\n- abc1234: A new thing.\n\n### Patch Changes\n\n- def5678: A fix.");
    expect(r.added).toEqual(["A new thing."]);
    expect(r.fixed).toEqual(["A fix."]);
  });

  it("tolerates HTML-converted notes and null", () => {
    const r = parseReleaseNotes("<h3>Minor Changes</h3><ul><li>A new thing.</li></ul>");
    expect(r.added).toEqual(["A new thing."]);
    expect(parseReleaseNotes(null)).toEqual({ added: [], fixed: [] });
  });
});

describe("build-channel suffix", () => {
  const RAW = ["## 1.10.0", "", "- Fixed: a thing", ""].join("\n");

  it("matches a -staging build against its base version", () => {
    // vite.config.ts appends the channel so an installed app says which backend
    // it talks to. Without this the changelog silently never appears on staging
    // — a null return, no error, nothing to notice.
    expect(changelogSection("1.10.0-staging", RAW)).toContain("a thing");
    expect(changelogSection("1.10.0-dev", RAW)).toContain("a thing");
  });

  it("does NOT strip a real prerelease suffix", () => {
    // 1.10.0-rc.1 may have its own heading; collapsing it into 1.10.0 would show
    // the wrong release notes.
    expect(changelogSection("1.10.0-rc.1", RAW)).toBeNull();
  });

  it("leaves a plain version untouched", () => {
    expect(changelogSection("1.10.0", RAW)).toContain("a thing");
  });
});
