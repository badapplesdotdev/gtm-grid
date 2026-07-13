/**
 * The CRM error → user-copy mapping. The core invariant: NOTHING technical
 * leaks to end users — no HTTP statuses, no error tags, no stack fragments —
 * and every message pairs "what happened" with a next step. Parametrized over
 * provider display names: copy must name the RIGHT product for every CRM.
 */

import { describe, expect, it } from "vitest";
import { crmErrorCopy } from "./error-copy.js";
import {
  CrmAuthRevoked,
  CrmNetworkError,
  CrmRateLimitError,
  CrmRequestError,
  CrmSchemaDriftError,
  CrmServerError,
  CrmSourceGoneError,
  CrmConnectionMissing,
  CrmSyncError,
  RowCapReached,
  type CrmError,
} from "./errors.js";

const PROVIDERS = ["Attio", "HubSpot"] as const;

const everyError = (provider: string): ReadonlyArray<CrmError> => [
  new CrmRateLimitError({ provider, retryAfterMs: 30_000 }),
  new CrmServerError({ provider, status: 503 }),
  new CrmNetworkError({ provider, cause: new Error("ECONNRESET") }),
  new CrmAuthRevoked({ provider, detail: "invalid_grant" }),
  new CrmConnectionMissing({ provider }),
  new CrmSchemaDriftError({ provider, missingAttrs: ["Twitter", "Region"] }),
  new CrmSourceGoneError({ provider, sourceLabel: "MQLs — Q3" }),
  new CrmRequestError({ provider, status: 400, detail: "filter invalid" }),
  new RowCapReached({ cap: 10_000 }),
  new CrmSyncError({ message: "boom", cause: new TypeError("x is undefined") }),
];

describe.each(PROVIDERS)("crmErrorCopy (%s) — no technical leakage, ever", (provider) => {
  it.each(everyError(provider).map((e) => [e._tag, e] as const))("%s copy is user-safe", (_tag, e) => {
    const { copy } = crmErrorCopy(e);
    // No HTTP status codes or error tags.
    expect(copy).not.toMatch(/\b(4\d\d|5\d\d)\b/);
    expect(copy).not.toContain("_tag");
    expect(copy).not.toMatch(/Crm(RateLimit|Server|Network|Auth|SchemaDrift|SourceGone|Request)Error/);
    // No stack/exception vocabulary (word-bounded: "Reconnect" contains "econn").
    expect(copy).not.toMatch(/undefined|\bnull\b|exception|stack trace|\bECONN|invalid_grant|TypeError/);
    // Reads like a sentence: starts with a capital, number, or quoted name; ends with punctuation.
    expect(copy).toMatch(/^[A-Z0-9"]/);
    expect(copy).toMatch(/\.$/);
  });

  it("provider-facing copy names THIS provider and never the other one", () => {
    const other = provider === "Attio" ? "HubSpot" : "Attio";
    for (const e of everyError(provider)) {
      const { copy } = crmErrorCopy(e);
      expect(copy).not.toContain(other);
      // Provider-neutral copy (row cap, catch-all) and the drift summary
      // (which reads as a field list) don't name the product.
      if (e._tag !== "RowCapReached" && e._tag !== "CrmSyncError" && e._tag !== "CrmSchemaDriftError") {
        expect(copy).toContain(provider);
      }
    }
  });

  it("every copy tells the user what happens next (an action or an assurance)", () => {
    for (const e of everyError(provider)) {
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
    for (const e of everyError("Attio").slice(0, 3)) {
      const p = crmErrorCopy(e);
      expect(p.status).toBe("warn");
      expect(p.pause).toBeUndefined();
    }
  });

  it("auth failures pause the binding for reconnect", () => {
    expect(crmErrorCopy(new CrmAuthRevoked({ provider: "Attio" }))).toMatchObject({ status: "failed", pause: "auth_revoked" });
    expect(crmErrorCopy(new CrmConnectionMissing({ provider: "Attio" }))).toMatchObject({ status: "failed", pause: "auth_revoked" });
  });

  it("a vanished source pauses with source_gone and names the source", () => {
    const p = crmErrorCopy(new CrmSourceGoneError({ provider: "Attio", sourceLabel: "Strategic Accounts" }));
    expect(p).toMatchObject({ status: "failed", pause: "source_gone" });
    expect(p.copy).toContain("Strategic Accounts");
  });

  it("schema drift is partial and lists the dropped fields", () => {
    const p = crmErrorCopy(new CrmSchemaDriftError({ provider: "Attio", missingAttrs: ["Twitter", "Region"] }));
    expect(p.status).toBe("partial");
    expect(p.copy).toContain("Twitter, Region");
    expect(p.copy).toContain("2 fields");
  });

  it("schema drift uses singular grammar for one field", () => {
    const p = crmErrorCopy(new CrmSchemaDriftError({ provider: "Attio", missingAttrs: ["Twitter"] }));
    expect(p.copy).toContain("1 field could not be mapped and was skipped");
  });

  it("long drift lists are summarized, not dumped", () => {
    const p = crmErrorCopy(new CrmSchemaDriftError({ provider: "Attio", missingAttrs: ["A", "B", "C", "D", "E"] }));
    expect(p.copy).toContain("A, B, C and 2 more");
  });

  it("a 403 explains SCOPES, pauses for reconnect, and never shows the code", () => {
    const p = crmErrorCopy(new CrmRequestError({ provider: "HubSpot", status: 403, detail: "missing scope" }));
    expect(p.status).toBe("failed");
    expect(p.pause).toBe("auth_revoked"); // lights the Reconnect banner
    expect(p.copy).toContain("read access");
    expect(p.copy).toContain("Reconnect HubSpot");
    expect(p.copy).not.toMatch(/\b403\b/);
  });

  it("row cap is partial and formats the cap for humans", () => {
    const p = crmErrorCopy(new RowCapReached({ cap: 10_000 }));
    expect(p.status).toBe("partial");
    expect(p.copy).toContain("10,000");
  });
});
