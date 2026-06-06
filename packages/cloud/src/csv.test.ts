/**
 * Tests for the CSV import parser + helpers (csv.ts).
 *
 * Outcome-focused per docs/effect-conventions.md: assert the returned
 * {@link ParsedCsv} or the typed {@link CsvParseError} in the Effect error
 * channel via `Effect.runPromiseExit` + `Cause.failureOption` — never try/catch.
 * One ≥ test per documented CSV gotcha, plus the pure header/type helpers.
 */

import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  CsvParseError,
  CsvParser,
  DEFAULT_MAX_ROWS,
  inferColumnType,
  normalizeHeaders,
  type ParseOptions,
  type ParsedCsv,
} from "./csv.js";

const parse = (
  text: string,
  opts?: ParseOptions,
): Effect.Effect<ParsedCsv, CsvParseError, CsvParser> =>
  Effect.gen(function* () {
    const p = yield* CsvParser;
    return yield* p.parse(text, opts);
  });

const run = (text: string, opts?: ParseOptions): Promise<ParsedCsv> =>
  Effect.runPromise(parse(text, opts).pipe(Effect.provide(CsvParser.Default)));

const failureOf = async (
  text: string,
  opts?: ParseOptions,
): Promise<CsvParseError> => {
  const exit = await Effect.runPromiseExit(
    parse(text, opts).pipe(Effect.provide(CsvParser.Default)),
  );
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) return failure.value;
  }
  throw new Error("expected a typed failure");
};

describe("happy path", () => {
  it("returns padded records, width and delimiter", async () => {
    const r = await run("name,age,city\nAcme,42,NYC\nGlobex,7,LA");
    expect(r.records).toEqual([
      ["name", "age", "city"],
      ["Acme", "42", "NYC"],
      ["Globex", "7", "LA"],
    ]);
    expect(r.width).toBe(3);
    expect(r.delimiter).toBe(",");
    expect(r.truncated).toBe(false);
    expect(r.warnings).toEqual([]);
  });
});

describe("BOM", () => {
  it("strips a leading UTF-8 BOM", async () => {
    const r = await run("﻿name,age\nAcme,42");
    expect(r.records[0]).toEqual(["name", "age"]);
  });
});

describe("line endings", () => {
  it("handles CRLF", async () => {
    const r = await run("a,b\r\n1,2\r\n3,4");
    expect(r.records).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("handles lone CR", async () => {
    const r = await run("a,b\r1,2\r3,4");
    expect(r.records).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});

describe("RFC-4180 quoting", () => {
  it("keeps delimiters inside quoted fields", async () => {
    const r = await run('name,note\n"Acme, Inc",hello');
    expect(r.records[1]).toEqual(["Acme, Inc", "hello"]);
  });

  it("keeps newlines inside quoted fields", async () => {
    const r = await run('a,b\n"line1\nline2",x');
    expect(r.records[1]).toEqual(["line1\nline2", "x"]);
  });

  it("unescapes doubled quotes", async () => {
    const r = await run('quote\n"she said ""hi"""');
    expect(r.records[1]).toEqual(['she said "hi"']);
  });
});

describe("delimiter detection", () => {
  it("detects semicolons", async () => {
    const r = await run("a;b;c\n1;2;3");
    expect(r.delimiter).toBe(";");
    expect(r.records[0]).toEqual(["a", "b", "c"]);
  });

  it("detects tabs", async () => {
    const r = await run("a\tb\n1\t2");
    expect(r.delimiter).toBe("\t");
  });

  it("honors a forced delimiter", async () => {
    const r = await run("a;b,c\n1;2,3", { delimiter: "," });
    expect(r.delimiter).toBe(",");
    expect(r.records[0]).toEqual(["a;b", "c"]);
  });

  it("ignores a delimiter inside the quoted first cell", async () => {
    const r = await run('"a;b";c\n1;2');
    expect(r.delimiter).toBe(";");
    expect(r.records[0]).toEqual(["a;b", "c"]);
  });
});

describe("empty / whitespace-only file", () => {
  it("fails on an empty string", async () => {
    expect(await failureOf("")).toBeInstanceOf(CsvParseError);
  });
  it("fails on whitespace only", async () => {
    expect(await failureOf("   \n  \t \n")).toBeInstanceOf(CsvParseError);
  });
});

describe("header-only file", () => {
  it("succeeds with a single record", async () => {
    const r = await run("name,age,city");
    expect(r.records).toEqual([["name", "age", "city"]]);
    expect(r.width).toBe(3);
  });
});

describe("ragged rows", () => {
  it("pads every record to the max width, with a warning", async () => {
    const r = await run("a,b\n1\n4,5,6");
    expect(r.width).toBe(3);
    expect(r.records).toEqual([
      ["a", "b", ""],
      ["1", "", ""],
      ["4", "5", "6"],
    ]);
    expect(r.warnings.some((w) => /different column count/i.test(w))).toBe(true);
  });
});

describe("trailing / blank lines", () => {
  it("ignores a trailing newline", async () => {
    const r = await run("a,b\n1,2\n");
    expect(r.records).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(r.warnings.some((w) => /blank line/i.test(w))).toBe(false);
  });

  it("skips fully-blank interior lines with a warning", async () => {
    const r = await run("a,b\n1,2\n\n3,4");
    expect(r.records).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(r.warnings.some((w) => /blank line/i.test(w))).toBe(true);
  });
});

describe("row cap", () => {
  it("truncates at maxRows and warns", async () => {
    const r = await run("a\n1\n2\n3\n4", { maxRows: 3 });
    expect(r.records).toEqual([["a"], ["1"], ["2"]]);
    expect(r.truncated).toBe(true);
    expect(r.warnings.some((w) => /first 3 rows/i.test(w))).toBe(true);
  });

  it("defaults to DEFAULT_MAX_ROWS", async () => {
    const big = Array(DEFAULT_MAX_ROWS + 5).fill("x").join("\n");
    const r = await run(big);
    expect(r.records.length).toBe(DEFAULT_MAX_ROWS);
    expect(r.truncated).toBe(true);
  });
});

describe("stray quotes", () => {
  it("treats a quote in the middle of an unquoted field literally", async () => {
    const r = await run('a,b\n12",34');
    expect(r.records[1]).toEqual(['12"', "34"]);
  });
});

describe("normalizeHeaders", () => {
  it("trims, auto-names empties, and de-dupes case-insensitively", () => {
    const { headers, warnings } = normalizeHeaders([
      " name ",
      "",
      "name",
      "Name",
    ]);
    expect(headers).toEqual(["name", "Column 2", "name 2", "Name 3"]);
    expect(warnings.some((w) => /empty header/i.test(w))).toBe(true);
    expect(warnings.some((w) => /duplicate header/i.test(w))).toBe(true);
  });
});

describe("inferColumnType", () => {
  it("infers number, ignoring currency/percent/commas and blanks", () => {
    expect(inferColumnType(["1", "2,000", "$3.50", "20%", ""])).toBe("number");
  });
  it("infers date for ISO and slash forms", () => {
    expect(inferColumnType(["2024-01-02", "2023-12-31"])).toBe("date");
    expect(inferColumnType(["1/2/24", "12/31/2023"])).toBe("date");
  });
  it("infers boolean for true/false/yes/no/y/n", () => {
    expect(inferColumnType(["true", "no", "Y", "N"])).toBe("boolean");
  });
  it("falls back to text on mixed values", () => {
    expect(inferColumnType(["1", "hello", "3"])).toBe("text");
  });
  it("is text for an all-empty column", () => {
    expect(inferColumnType(["", "  ", ""])).toBe("text");
  });
});
