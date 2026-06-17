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
