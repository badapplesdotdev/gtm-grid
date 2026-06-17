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
