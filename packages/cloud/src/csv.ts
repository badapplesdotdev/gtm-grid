/**
 * CSV parsing for table import (pure, browser- and Convex-bundle-safe).
 *
 * Turns raw CSV text into a {@link ParsedCsv}: a rectangular grid of string
 * cells (`records`), plus the detected delimiter and any warnings. The import UI
 * then decides whether the first row is a header (toggle), normalizes the header
 * names, infers a type per column, and lets the user rename / retype / exclude
 * columns before writing them as real columns + rows.
 *
 * This is the "pure, fully testable" heart of CSV import — a hand-rolled RFC-4180
 * tokenizer (no dependency) that defends against the common real-world gotchas:
 *
 *   - a UTF-8 BOM at the start of the file,
 *   - CRLF / CR / LF line endings (and newlines *inside* quoted fields),
 *   - quoted fields with embedded delimiters/newlines and escaped `""` quotes,
 *   - alternative delimiters (`;`, tab, `|`) auto-detected from the first line,
 *   - empty / whitespace-only files (typed failure),
 *   - ragged rows (short rows padded, long rows kept — every record padded to a
 *     common width),
 *   - trailing / fully-blank lines (skipped),
 *   - a configurable row cap (default 10k) so a huge paste can't lock the UI.
 *
 * Header normalization ({@link normalizeHeaders}) and type inference
 * ({@link inferColumnType}) are exported as separate pure helpers so the UI can
 * recompute them live as the "first row is a header" toggle flips.
 *
 * Follows the canonical Effect service shape (see sample-service.ts): typed error
 * in the error channel via {@link CsvParseError}, no thrown exceptions, no `as`.
 * Pure of `node:*` so it bundles into both the Vite (browser) and Convex graphs.
 */

import { Data, Effect } from "effect";

/** Raised when CSV text cannot yield any rows (empty / whitespace-only). */
export class CsvParseError extends Data.TaggedError("CsvParseError")<{
  readonly message: string;
}> {}

/** The candidate delimiters we auto-detect between, in preference order. */
export const CANDIDATE_DELIMITERS = [",", ";", "\t", "|"] as const;
export type Delimiter = (typeof CANDIDATE_DELIMITERS)[number];

/** Column types we infer on import (a subset of the engine's ColumnType). */
export type CsvColumnType = "text" | "number" | "boolean" | "date";

/** Default cap on imported records (header + data). */
export const DEFAULT_MAX_ROWS = 10_000;

/** Options for {@link CsvParser.parse}. */
export interface ParseOptions {
  /** Force a delimiter instead of auto-detecting from the first line. */
  readonly delimiter?: Delimiter;
  /** Cap on records kept; extras are dropped and `truncated` is set. */
  readonly maxRows?: number;
}

/** The normalized result of parsing CSV text (header not yet split off). */
export interface ParsedCsv {
  /** All non-blank rows, each padded to exactly `width` string cells. */
  readonly records: string[][];
  /** Column count (max field count across records). */
  readonly width: number;
  /** The delimiter used (detected or forced). */
  readonly delimiter: Delimiter;
  /** True when the row cap was hit and later rows were dropped. */
  readonly truncated: boolean;
  /** Human-readable notes surfaced in the import preview. */
  readonly warnings: string[];
}

const BOM = "﻿";

/**
 * Tokenize CSV text into raw records (arrays of string fields) per RFC-4180.
 *
 * A single pass with a tiny state machine: outside quotes a delimiter ends a
 * field and CR/LF ends a record; inside quotes (`"`) delimiters and newlines are
 * literal and `""` is an escaped quote. CRLF collapses to one record boundary.
 */
function tokenize(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let fieldWasQuoted = false;
  let sawAnyChar = false;

  const endField = () => {
    record.push(field);
    field = "";
    fieldWasQuoted = false;
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
    sawAnyChar = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === "" && !fieldWasQuoted) {
      inQuotes = true;
      fieldWasQuoted = true;
      sawAnyChar = true;
      continue;
    }
    if (ch === delimiter) {
      endField();
      sawAnyChar = true;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      continue;
    }
    field += ch;
    sawAnyChar = true;
  }

  if (sawAnyChar || field !== "" || record.length > 0) endRecord();
  return records;
}

/** A record that is entirely empty (one blank field, or all blank fields). */
const isBlankRecord = (rec: readonly string[]): boolean =>
  rec.every((f) => f === "");

/**
 * Detect the most likely delimiter by counting unquoted occurrences on the first
 * non-empty line. Ties prefer the earlier candidate (comma first).
 */
function detectDelimiter(text: string): Delimiter {
  let firstLine = text;
  {
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (!inQuotes && (ch === "\n" || ch === "\r")) {
        firstLine = text.slice(0, i);
        break;
      }
    }
  }
  const countUnquoted = (delim: string): number => {
    let inQuotes = false;
    let count = 0;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (!inQuotes && ch === delim) count++;
    }
    return count;
  };
  let best: Delimiter = ",";
  let bestCount = 0;
  for (const d of CANDIDATE_DELIMITERS) {
    const c = countUnquoted(d);
    if (c > bestCount) {
      best = d;
      bestCount = c;
    }
  }
  return best;
}

/** The fallback name for a column with no header text. */
export const columnLabel = (index: number): string => `Column ${index + 1}`;

/**
 * Normalize a raw header record into clean column names:
 *   - trim each header,
 *   - replace empty headers with `Column N` (1-based position),
 *   - de-duplicate case-insensitively by suffixing ` 2`, ` 3`, ...
 * Returns the names plus any warnings (empty/duplicate corrections).
 */
export function normalizeHeaders(raw: readonly string[]): {
  headers: string[];
  warnings: string[];
} {
  const warnings: string[] = [];
  let emptyCount = 0;
  let dupCount = 0;
  const seen = new Map<string, number>();
  const headers: string[] = [];

  raw.forEach((cell, idx) => {
    let name = (cell ?? "").trim();
    if (name === "") {
      name = columnLabel(idx);
      emptyCount++;
    }
    const key = name.toLowerCase();
    const prior = seen.get(key) ?? 0;
    if (prior > 0) {
      let n = prior + 1;
      let candidate = `${name} ${n}`;
      while (seen.has(candidate.toLowerCase())) {
        n++;
        candidate = `${name} ${n}`;
      }
      seen.set(key, n);
      seen.set(candidate.toLowerCase(), 1);
      headers.push(candidate);
      dupCount++;
    } else {
      seen.set(key, 1);
      headers.push(name);
    }
  });

  if (emptyCount > 0)
    warnings.push(
      `${emptyCount} empty header${emptyCount === 1 ? "" : "s"} auto-named.`,
    );
  if (dupCount > 0)
    warnings.push(
      `${dupCount} duplicate header${dupCount === 1 ? "" : "s"} renamed.`,
    );
  return { headers, warnings };
}

const DATE_RE = /^\d{4}-\d{1,2}-\d{1,2}$/;
const DATE_SLASH_RE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
const NUMBER_RE = /^-?\$?[\d,]+(\.\d+)?%?$/;
const BOOL_RE = /^(true|false|yes|no|y|n)$/i;

/**
 * Infer a column type from its (non-empty) sample values. A column is `number` /
 * `boolean` / `date` only when EVERY non-empty value matches that shape;
 * otherwise it falls back to `text`. Mirrors the design's `inferType`.
 */
export function inferColumnType(values: readonly string[]): CsvColumnType {
  const v = values.map((x) => (x ?? "").trim()).filter((x) => x !== "");
  if (v.length === 0) return "text";
  if (v.every((x) => DATE_RE.test(x) || DATE_SLASH_RE.test(x))) return "date";
  if (v.every((x) => NUMBER_RE.test(x))) return "number";
  if (v.every((x) => BOOL_RE.test(x))) return "boolean";
  return "text";
}

function parseCsv(
  input: string,
  opts: ParseOptions = {},
): Effect.Effect<ParsedCsv, CsvParseError> {
  return Effect.gen(function* () {
    const text = input.startsWith(BOM) ? input.slice(1) : input;
    if (text.trim() === "") {
      return yield* Effect.fail(
        new CsvParseError({ message: "The file is empty." }),
      );
    }

    const delimiter = opts.delimiter ?? detectDelimiter(text);
    const all = tokenize(text, delimiter);

    const warnings: string[] = [];
    const nonBlank = all.filter((r) => !isBlankRecord(r));
    const blankSkipped = all.length - nonBlank.length;

    if (nonBlank.length === 0) {
      return yield* Effect.fail(
        new CsvParseError({ message: "No rows found." }),
      );
    }

    const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
    const truncated = nonBlank.length > maxRows;
    const kept = truncated ? nonBlank.slice(0, maxRows) : nonBlank;

    const width = kept.reduce((w, r) => Math.max(w, r.length), 0);
    let ragged = 0;
    const records = kept.map((r) => {
      if (r.length !== width) ragged++;
      return r.length === width
        ? r
        : [...r, ...Array(width - r.length).fill("")];
    });

    if (ragged > 0)
      warnings.push(
        `${ragged} row${ragged === 1 ? "" : "s"} had a different column count (padded to ${width}).`,
      );
    if (blankSkipped > 0)
      warnings.push(
        `${blankSkipped} blank line${blankSkipped === 1 ? "" : "s"} skipped.`,
      );
    if (truncated)
      warnings.push(
        `Only the first ${maxRows.toLocaleString()} rows were imported.`,
      );

    return {
      records,
      width,
      delimiter,
      truncated,
      warnings,
    } satisfies ParsedCsv;
  });
}

/**
 * CSV parsing service. Dependency-free and synchronous (mirrors
 * {@link CellCoercionService}); `parse` returns the normalized {@link ParsedCsv}
 * or fails with a typed {@link CsvParseError}.
 */
export class CsvParser extends Effect.Service<CsvParser>()("CsvParser", {
  sync: () => ({
    parse: (
      text: string,
      opts?: ParseOptions,
    ): Effect.Effect<ParsedCsv, CsvParseError> => parseCsv(text, opts),
  }),
}) {}
