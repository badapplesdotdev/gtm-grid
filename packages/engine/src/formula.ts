// Formula compilation — turns a Clay-style expression into a QuickJS sandbox function
// body, and decides which helper libraries that expression needs.
//
// A formula column is just a `function` column with provider "formula"; its expression
// lives in `params.expression`. Unlike the prompt-templating in execute.ts (which splices
// raw cell *text* into a string), a formula needs typed VALUES: `{{Score}} + 1` must see
// the number 42, and `{{Email}}.split("@")` must see a quoted string. So we compile each
// `{{Column Name}}` to an `inputs[...]` lookup and run the result over a typed row object.

import {
  FORMULAJS_NAMES,
  FORMULAJS_SRC,
  LODASH_SRC,
  MOMENT_SRC,
} from "./sandbox-libs.generated.js";
import type { Column } from "./types.js";

export type FormulaLib = "lodash" | "moment" | "formulajs";

export interface CompiledFormula {
  /** A `function(inputs, sdk){ ... }` body for the QuickJS sandbox. */
  body: string;
  /** Helper libraries the expression references (so we inject only those). */
  libs: Set<FormulaLib>;
}

/** Same `{{Column Name}}` shape the prompt templater uses (execute.ts). */
const TOKEN_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

const FORMULAJS_NAME_SET = new Set(FORMULAJS_NAMES);

/** A formula column is a function column backed by the built-in `formula` connector. */
export function isFormulaColumn(col: Pick<Column, "provider">): boolean {
  return col.provider === "formula";
}

/** Read one key off a column's params blob without an `as` cast. `Column.params` is
 *  typed as a record already, so this is just a null-safe indexed lookup that keeps
 *  the value `unknown` for the caller to narrow. */
export function readParam(col: Pick<Column, "params">, key: string): unknown {
  return col.params?.[key];
}

/** The raw expression for a formula column (from params.expression). */
export function formulaExpression(col: Pick<Column, "params">): string {
  const expr = readParam(col, "expression");
  return typeof expr === "string" ? expr : "";
}

/** Detect which helper libraries an expression references. Conservative: over-inject
 *  rather than miss (injecting an unused lib only costs a one-time parse). */
export function detectLibs(expr: string): Set<FormulaLib> {
  const libs = new Set<FormulaLib>();
  // lodash: `_` used as a member/call/identifier, not part of another identifier.
  if (/(^|[^\w$.])_\s*[.([]/.test(expr)) libs.add("lodash");
  // moment: `moment(` or `moment.`
  if (/(^|[^\w$.])moment\s*[.(]/.test(expr)) libs.add("moment");
  // formulajs: any UPPERCASE identifier that is a known FormulaJS function name.
  const upper = expr.match(/\b[A-Z][A-Z0-9_]*\b/g);
  if (upper?.some((id) => FORMULAJS_NAME_SET.has(id))) libs.add("formulajs");
  return libs;
}

/** Replace `{{Column Name}}` with a typed lookup into the row `inputs` object. */
function substituteColumns(expr: string): string {
  return expr.replace(TOKEN_RE, (_m, name: string) => `inputs[${JSON.stringify(name.trim())}]`);
}

/**
 * Compile an expression into a sandbox function body + its library needs.
 * The body returns the expression value; helper-library globals (`_`, `moment`, and the
 * FormulaJS functions hoisted to bare names) are provided by {@link buildFormulaPrelude}.
 */
export function compileExpression(expr: string): CompiledFormula {
  const libs = detectLibs(expr);
  const compiled = substituteColumns(expr.trim());
  // An empty expression yields null rather than a syntax error.
  const body = `function(inputs, sdk){ return (${compiled || "null"}); }`;
  return { body, libs };
}

/**
 * Build the QuickJS prelude that loads the referenced helper libraries and exposes their
 * globals. lodash sets `globalThis._`, moment sets `globalThis.moment`, and FormulaJS
 * attaches `globalThis.formulajs` — we spread that onto globalThis so `VLOOKUP(...)`,
 * `SUM(...)` etc. resolve as bare names, the way spreadsheet users expect.
 */
export function buildFormulaPrelude(libs: Set<FormulaLib>): string {
  let out = "";
  if (libs.has("lodash")) out += LODASH_SRC + "\n;\n";
  if (libs.has("moment")) out += MOMENT_SRC + "\n;\n";
  if (libs.has("formulajs"))
    out += FORMULAJS_SRC + "\n; if (globalThis.formulajs) Object.assign(globalThis, globalThis.formulajs);\n";
  return out;
}
