// Generates packages/engine/src/bundled-manifests.generated.ts — the connector
// manifests shipped with the app (repo `extensions/*.json`) inlined as a frozen
// array of plain JSON objects.
//
// WHY inline (not read at runtime): these manifests must be available wherever
// columns run. The desktop sidecar reads `extensions/*.json` off disk at startup
// (packages/server/src/index.ts `seedExtensions`), but the cloud webhook worker
// (apps/web Inngest) runs on Vercel with NO repo-root `extensions/` directory, so
// it cannot read them from disk. Committing them as a generated module lets the
// engine expose `bundledConnectors()` identically in every environment — the fix
// for "sandbox: cannot read property <method>" on webhook auto-enrich, where a
// bundled connector (trigify/leadmagic/apollo/…) was missing from the worker's
// registry because nothing seeds them cloud-side.
//
// Run: pnpm --filter @gtmgrid/engine gen:bundled-manifests

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(here, "../../../extensions");
const outPath = resolve(here, "../src/bundled-manifests.generated.ts");

// Read every manifest, sorted by filename so the generated output is stable
// (deterministic diffs). Each file is the SAME JSON the sidecar seeds from disk.
const files = readdirSync(extDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

const manifests = [];
for (const file of files) {
  const raw = readFileSync(join(extDir, file), "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`bundled manifest ${file} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.id !== "string") {
    throw new Error(`bundled manifest ${file} is missing a string "id"`);
  }
  manifests.push(parsed);
}

const banner =
  "// GENERATED FILE — do not edit by hand. Run `pnpm --filter @gtmgrid/engine gen:bundled-manifests`.\n" +
  "// Connector manifests bundled with the app (repo `extensions/*.json`), inlined so the\n" +
  "// cloud webhook worker (which has no disk access to `extensions/`) can register them.\n" +
  "/* eslint-disable */\n";

writeFileSync(
  outPath,
  banner +
    "/** The connector manifests shipped with the app, as raw JSON (parse via `parseManifest`). */\n" +
    `export const BUNDLED_MANIFESTS: readonly unknown[] = ${JSON.stringify(manifests, null, 2)};\n`,
);

console.log(`wrote ${outPath}\n  ${manifests.length} bundled manifests: ${manifests.map((m) => m.id).join(", ")}`);
