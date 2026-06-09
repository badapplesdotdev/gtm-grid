// Generates packages/engine/src/sandbox-libs.generated.ts — the minified sources of
// lodash, moment, and @formulajs/formulajs as string constants, plus the list of
// FormulaJS export names (used to decide whether a formula needs FormulaJS injected).
//
// These libraries run INSIDE the QuickJS sandbox, so they cannot be `import`ed by the
// guest — their source is injected as a prelude. We commit the generated strings rather
// than reading node_modules at runtime, so the bundled Tauri sidecar (which has no
// predictable node_modules layout) and tsx/test runs all work identically.
//
// Run: pnpm --filter @gtmgrid/engine gen:formula-libs

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "../src/sandbox-libs.generated.ts");

const lodash = readFileSync(require.resolve("lodash/lodash.min.js"), "utf8");
const moment = readFileSync(require.resolve("moment/min/moment.min.js"), "utf8");

// FormulaJS's `exports` map blocks deep subpaths, so resolve the package root via its
// package.json and read the browser (UMD) bundle, which attaches `globalThis.formulajs`.
const fjsRoot = dirname(require.resolve("@formulajs/formulajs/package.json"));
const formulajs = readFileSync(join(fjsRoot, "lib/browser/formula.min.js"), "utf8");

// Collect the FormulaJS function names so formula.ts can detect whether an expression
// uses any spreadsheet function (and only then pay to inject the 139 KB bundle).
let names = [];
try {
  const mod = require(join(fjsRoot, "lib/cjs/index.cjs"));
  names = Object.keys(mod).filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k));
} catch {
  // Fallback: scrape uppercase identifiers exported by the bundle.
  names = [...new Set(formulajs.match(/\b[A-Z][A-Z0-9_]{1,}\b/g) ?? [])];
}
names.sort();

const enc = (s) => JSON.stringify(s);
const banner =
  "// GENERATED FILE — do not edit by hand. Run `pnpm --filter @gtmgrid/engine gen:formula-libs`.\n" +
  "// Minified lodash / moment / @formulajs/formulajs sources injected into the QuickJS\n" +
  "// sandbox on demand for formula columns, plus the FormulaJS export-name list.\n" +
  "/* eslint-disable */\n";

writeFileSync(
  outPath,
  banner +
    `export const LODASH_SRC = ${enc(lodash)};\n\n` +
    `export const MOMENT_SRC = ${enc(moment)};\n\n` +
    `export const FORMULAJS_SRC = ${enc(formulajs)};\n\n` +
    `export const FORMULAJS_NAMES: readonly string[] = ${JSON.stringify(names)};\n`,
);

console.log(
  `wrote ${outPath}\n  lodash ${lodash.length}B  moment ${moment.length}B  formulajs ${formulajs.length}B  names ${names.length}`,
);
