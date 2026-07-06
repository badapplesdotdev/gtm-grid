// Changelog surfaced in the "What's new" dialog on first launch after an update.
//
// The release pipeline (changesets) generates packages/desktop/CHANGELOG.md with
// one `## <version>` section per release. We bundle it at build time (`?raw`) and
// extract the human-readable notes for the running version, dropping the changeset
// commit-hash prefixes and the `@gtmgrid/*` internal dependency-bump lines.

import rawChangelog from "../CHANGELOG.md?raw";

/**
 * Return the raw markdown body of the `## <version>` section (without the heading),
 * or null if that version has no entry. `raw` is injectable for tests.
 */
export function changelogSection(version: string, raw: string = rawChangelog): string | null {
  const lines = raw.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const endRel = rest.findIndex((l) => /^##\s/.test(l));
  const body = (endRel === -1 ? rest : rest.slice(0, endRel)).join("\n").trim();
  return body.length > 0 ? body : null;
}

/**
 * Cleaned, user-facing notes for a version: the bullet lines with their changeset
 * hash prefixes stripped, excluding the internal `@gtmgrid/*` dependency bumps and
 * the bare `### Patch/Minor Changes` sub-headings. Empty when there's nothing
 * worth showing.
 */
export function changelogNotes(version: string, raw: string = rawChangelog): string[] {
  const body = changelogSection(version, raw);
  if (body === null) return [];
  const notes: string[] = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("-")) continue; // skip ### headings / blanks
    const item = t.replace(/^-\s*/, "");
    if (item.startsWith("@gtmgrid/")) continue; // internal dependency bump — noise
    const cleaned = item.replace(/^[0-9a-f]{7,40}:\s*/, "").trim();
    if (cleaned.length > 0) notes.push(cleaned);
  }
  return notes;
}

// ── Categorized parsing (the redesigned update flow) ──────────────────────────

/** One release's notes, categorized by changeset bump level. */
export interface ChangelogEntry {
  readonly version: string;
  /** `### Minor/Major Changes` bullets — new capabilities. */
  readonly added: readonly string[];
  /** `### Patch Changes` bullets — improvements and fixes. */
  readonly fixed: readonly string[];
}

/**
 * Parse ONE version section's bullets into categories. Multi-line bullets are
 * joined (continuation lines are indented, non-`-` lines); nested `@gtmgrid/*`
 * dependency bumps and hash prefixes are dropped like {@link changelogNotes}.
 */
export function changelogEntry(version: string, raw: string = rawChangelog): ChangelogEntry | null {
  const body = changelogSection(version, raw);
  if (body === null) return null;
  const added: string[] = [];
  const fixed: string[] = [];
  let bucket: string[] = fixed;
  let current: string | null = null;
  const flush = () => {
    if (current !== null && current.length > 0 && !current.startsWith("@gtmgrid/")) bucket.push(current);
    current = null;
  };
  for (const line of body.split("\n")) {
    const heading = /^###\s+(.*)$/.exec(line.trim());
    if (heading !== null) {
      flush();
      bucket = /minor|major/i.test(heading[1]) ? added : fixed;
      continue;
    }
    // Changesets emits top-level bullets at column 0; anything indented is a
    // continuation (sub-bullet or dep bump) of the current note.
    const bullet = /^-\s+(.*)$/.exec(line);
    if (bullet !== null) {
      flush();
      current = bullet[1].replace(/^[0-9a-f]{7,40}:\s*/, "").trim();
      continue;
    }
    // Continuation of the current bullet (indented prose or sub-bullets).
    if (current !== null && line.trim().length > 0) {
      const cont = line.trim().replace(/^-\s+/, "");
      if (!cont.startsWith("@gtmgrid/")) current = `${current} ${cont}`;
    }
  }
  flush();
  return { version, added, fixed };
}

/** Every release in the bundled changelog, newest first. */
export function changelogAll(raw: string = rawChangelog): ChangelogEntry[] {
  const versions: string[] = [];
  for (const line of raw.split("\n")) {
    const m = /^##\s+(\d+\.\d+\.\d+.*)$/.exec(line.trim());
    if (m !== null) versions.push(m[1].trim());
  }
  return versions
    .map((v) => changelogEntry(v, raw))
    .filter((e): e is ChangelogEntry => e !== null && (e.added.length > 0 || e.fixed.length > 0));
}

/**
 * Parse an INCOMING release's notes (electron-updater's releaseNotes — the
 * GitHub release body, same changesets markdown; may arrive as HTML). Falls
 * back to one uncategorized "fixed" bucket when no headings are found.
 */
export function parseReleaseNotes(input: unknown): { added: string[]; fixed: string[] } {
  const text =
    typeof input === "string"
      ? input
      : Array.isArray(input)
        ? input.map((n) => (n !== null && typeof n === "object" && "note" in n ? String((n as { note: unknown }).note ?? "") : "")).join("\n")
        : "";
  // Strip HTML if the provider converted markdown (crude but safe: tags → newlines for blocks, then entity basics).
  const plain = text
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<h3[^>]*>/gi, "\n### ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  const pseudo = `## x\n${plain}`;
  const entry = changelogEntry("x", pseudo);
  return { added: [...(entry?.added ?? [])], fixed: [...(entry?.fixed ?? [])] };
}

