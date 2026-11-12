/**
 * `describeDbError` — proves a repository failure reports the ACTUAL Postgres
 * reason (message + SQLSTATE), never the `DrizzleQueryError` query dump that
 * buried the reason in telemetry (the CSV bulk-import cells-insert regression).
 */

import { describe, expect, it } from "vitest";
import { describeDbError } from "./_db-error.js";

/** A DrizzleQueryError-shaped error: `.message` is the SQL, reason on `.cause`. */
const drizzleError = (cause: unknown): Error => {
  const e = new Error(
    'Failed query: insert into "cells" ("id", "value") values ' +
      "(default, $1), (default, $2)\nparams: a,b",
  );
  (e as { cause?: unknown }).cause = cause;
  return e;
};

/** A postgres-js driver error: carries `.message`, SQLSTATE `.code`, `.detail`. */
const pgError = (
  message: string,
  code: string,
  detail?: string,
): Error => {
  const e = new Error(message);
  Object.assign(e, { code, ...(detail !== undefined ? { detail } : {}) });
  return e;
};

describe("describeDbError", () => {
  it("surfaces the underlying Postgres reason + code, not the query dump", () => {
    const err = drizzleError(
      pgError(
        "unsupported Unicode escape sequence",
        "22P05",
        "\\u0000 cannot be converted to text.",
      ),
    );
    const msg = describeDbError("row bulk import", err);
    expect(msg).toContain("unsupported Unicode escape sequence");
    expect(msg).toContain("22P05");
    expect(msg).toContain("\\u0000 cannot be converted to text.");
    // The whole point: the SQL dump must NOT be what we record.
    expect(msg).not.toContain("Failed query:");
    expect(msg).not.toContain("$1");
  });

  it("finds the driver error even when nested deeper in the cause chain", () => {
    const err = drizzleError(
      Object.assign(new Error("wrapper"), {
        cause: pgError("invalid byte sequence for encoding \"UTF8\"", "22021"),
      }),
    );
    const msg = describeDbError("cell bulk insert", err);
    expect(msg).toContain("invalid byte sequence");
    expect(msg).toContain("22021");
  });

  it("falls back to a plain Error's message when there is no driver code", () => {
    expect(describeDbError("row insert", new Error("boom"))).toBe("boom");
  });

  it("never returns a bare query dump when no driver error is present", () => {
    // A DrizzleQueryError with no usable cause: we must not echo the SQL.
    const msg = describeDbError("cell bulk insert", drizzleError(undefined));
    expect(msg).not.toContain("Failed query:");
    expect(msg).toBe("cell bulk insert failed");
  });

  it("uses the op fallback for a non-Error cause", () => {
    expect(describeDbError("row list", "nope")).toBe("row list failed");
  });

  it("clamps a runaway driver message so telemetry stays readable", () => {
    const huge = "x".repeat(5000);
    const msg = describeDbError("cell insert", drizzleError(pgError(huge, "XX000")));
    expect(msg.length).toBeLessThan(600);
    expect(msg.endsWith("…")).toBe(true);
  });

  it("does not loop on a cyclic cause chain", () => {
    const a = new Error("a");
    const b = new Error("b");
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a;
    // Just needs to terminate and return the deepest reachable message.
    expect(describeDbError("row list", a)).toBe("b");
  });
});
