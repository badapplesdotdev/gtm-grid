/**
 * The CRM error → user-copy mapping. The core invariant: NOTHING technical
 * leaks to end users — no HTTP statuses, no error tags, no stack fragments —
 * and every message pairs "what happened" with a next step.
 */

import { describe, expect, it } from "vitest";
import { crmErrorCopy } from "./error-copy.js";
import {
  AttioAuthRevoked,
  AttioNetworkError,
  AttioRateLimitError,
  AttioRequestError,
  AttioSchemaDriftError,
  AttioServerError,
  AttioSourceGoneError,
  CrmConnectionMissing,
  CrmSyncError,
  RowCapReached,
  type CrmError,
} from "./errors.js";

const EVERY_ERROR: ReadonlyArray<CrmError> = [
  new AttioRateLimitError({ retryAfterMs: 30_000 }),
  new AttioServerError({ status: 503 }),
  new AttioNetworkError({ cause: new Error("ECONNRESET") }),
  new AttioAuthRevoked({ detail: "invalid_grant" }),
  new CrmConnectionMissing(),
  new AttioSchemaDriftError({ missingAttrs: ["Twitter", "Region"] }),
  new AttioSourceGoneError({ sourceLabel: "MQLs — Q3" }),
  new AttioRequestError({ status: 400, detail: "filter invalid" }),
  new RowCapReached({ cap: 10_000 }),
  new CrmSyncError({ message: "boom", cause: new TypeError("x is undefined") }),
];

describe("crmErrorCopy — no technical leakage, ever", () => {
  it.each(EVERY_ERROR.map((e) => [e._tag, e] as const))("%s copy is user-safe", (_tag, e) => {
    const { copy } = crmErrorCopy(e);
    // No HTTP status codes or error tags.
    expect(copy).not.toMatch(/\b(4\d\d|5\d\d)\b/);
    expect(copy).not.toContain("_tag");
    expect(copy).not.toMatch(/Attio(RateLimit|Server|Network|Auth|SchemaDrift|SourceGone|Request)Error/);
    // No stack/exception vocabulary (word-bounded: "Reconnect" contains "econn").
    expect(copy).not.toMatch(/undefined|\bnull\b|exception|stack trace|\bECONN|invalid_grant|TypeError/);
    // Reads like a sentence: starts with a capital, number, or quoted name; ends with punctuation.
    expect(copy).toMatch(/^[A-Z0-9"]/);
    expect(copy).toMatch(/\.$/);
  });

  it("every copy tells the user what happens next (an action or an assurance)", () => {
    for (const e of EVERY_ERROR) {
      const { copy } = crmErrorCopy(e);
      expect(
        /We'll|we'll|will try again|Reconnect|Connect|Pick a new source|Adjust the source or filters|Add filters|upgrade|Everything else synced/.test(
          copy,
        ),
      ).toBe(true);
    }
  });
});

describe("crmErrorCopy — status + pause semantics", () => {
  it("transient errors degrade to warn and never pause", () => {
    for (const e of EVERY_ERROR.slice(0, 3)) {
      const p = crmErrorCopy(e);
      expect(p.status).toBe("warn");
      expect(p.pause).toBeUndefined();
    }
  });

  it("auth failures pause the binding for reconnect", () => {
    expect(crmErrorCopy(new AttioAuthRevoked({}))).toMatchObject({ status: "failed", pause: "auth_revoked" });
    expect(crmErrorCopy(new CrmConnectionMissing())).toMatchObject({ status: "failed", pause: "auth_revoked" });
  });

  it("a vanished source pauses with source_gone and names the source", () => {
    const p = crmErrorCopy(new AttioSourceGoneError({ sourceLabel: "Strategic Accounts" }));
    expect(p).toMatchObject({ status: "failed", pause: "source_gone" });
    expect(p.copy).toContain("Strategic Accounts");
  });

  it("schema drift is partial and lists the dropped fields", () => {
    const p = crmErrorCopy(new AttioSchemaDriftError({ missingAttrs: ["Twitter", "Region"] }));
    expect(p.status).toBe("partial");
    expect(p.copy).toContain("Twitter, Region");
    expect(p.copy).toContain("2 fields");
  });

  it("schema drift uses singular grammar for one field", () => {
    const p = crmErrorCopy(new AttioSchemaDriftError({ missingAttrs: ["Twitter"] }));
    expect(p.copy).toContain("1 field could not be mapped and was skipped");
  });

  it("long drift lists are summarized, not dumped", () => {
    const p = crmErrorCopy(new AttioSchemaDriftError({ missingAttrs: ["A", "B", "C", "D", "E"] }));
    expect(p.copy).toContain("A, B, C and 2 more");
  });

  it("row cap is partial and formats the cap for humans", () => {
    const p = crmErrorCopy(new RowCapReached({ cap: 10_000 }));
    expect(p.status).toBe("partial");
    expect(p.copy).toContain("10,000");
  });
});
