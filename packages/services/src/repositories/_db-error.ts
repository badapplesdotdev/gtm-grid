/**
 * `describeDbError` — turn a repository failure into a message that names the
 * ACTUAL database reason instead of a query dump.
 *
 * Drizzle wraps every driver failure in a `DrizzleQueryError` whose `.message`
 * is the full parameterized SQL it tried to run — for a bulk `insert into cells
 * ... values (default, $1..$8), (default, $9..$16), ...` that string runs to
 * thousands of bind-parameter placeholders. The real Postgres reason (the
 * message + SQLSTATE code, e.g. `unsupported Unicode escape sequence (22P05)`
 * when a NUL byte reaches a `jsonb` column) lives on the wrapped error's
 * `.cause`, NOT in `.message`. Recording `.message` alone therefore captures a
 * useless query dump that a telemetry string cap can even truncate before the
 * reason would have appeared.
 *
 * This walks the `.cause` chain to the underlying postgres-js error (identified
 * by its string SQLSTATE `.code`) and reports ITS message + code + detail, so
 * the failure is debuggable. When no driver error is found it falls back to the
 * deepest `Error`'s message (never the SQL dump), and finally to `${op} failed`.
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

/** The `.cause` chain, outermost first, bounded so a cyclic cause can't loop. */
const causeChain = (cause: unknown, max = 8): readonly unknown[] => {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = cause;
  while (current != null && chain.length < max && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = isRecord(current) ? current["cause"] : undefined;
  }
  return chain;
};

/** A non-empty string field on a record, or `undefined`. */
const str = (rec: Record<string, unknown>, key: string): string | undefined => {
  const v = rec[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
};

/**
 * Cap so the surfaced message can never itself become a giant string — even a
 * driver `detail` can echo the offending row. Keeps telemetry readable.
 */
const MAX_LEN = 500;
const clamp = (s: string): string =>
  s.length > MAX_LEN ? `${s.slice(0, MAX_LEN)}…` : s;

export const describeDbError = (op: string, cause: unknown): string => {
  const chain = causeChain(cause);

  // The postgres-js driver error carries the real reason + a 5-char SQLSTATE.
  const driver = chain.find(
    (e): e is Record<string, unknown> =>
      isRecord(e) &&
      typeof e["code"] === "string" &&
      typeof e["message"] === "string",
  );
  if (driver !== undefined) {
    const message = str(driver, "message") ?? `${op} failed`;
    const code = str(driver, "code");
    const detail = str(driver, "detail");
    return clamp(
      `${op} failed: ${message}${code ? ` (${code})` : ""}${
        detail ? ` — ${detail}` : ""
      }`,
    );
  }

  // No driver error: use the deepest Error's message, but never the Drizzle SQL
  // dump (its message starts with "Failed query:").
  const errors = chain.filter((e): e is Error => e instanceof Error);
  for (let i = errors.length - 1; i >= 0; i--) {
    const m = errors[i]?.message;
    if (m !== undefined && m.length > 0 && !m.startsWith("Failed query:")) {
      return clamp(m);
    }
  }
  return `${op} failed`;
};
