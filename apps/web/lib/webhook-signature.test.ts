/**
 * The inbound-webhook auth gate (`signatureCheckPasses`) — signature auth is
 * OPT-IN per webhook:
 *   - no signing secret → unsigned posts pass (the token URL is the credential)
 *   - a signing secret → the X-GTMGrid-Signature HMAC MUST verify
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signatureCheckPasses } from "./webhook-signature";

const SECRET = "whsec_test_secret";
const BODY = '{"Email":"a@b.co"}';
const sign = (body: string, secret: string) =>
  createHmac("sha256", secret).update(body).digest("hex");

describe("signatureCheckPasses", () => {
  it("passes unsigned posts when the webhook has NOT opted in to auth", () => {
    expect(signatureCheckPasses(BODY, null, null)).toBe(true);
    expect(signatureCheckPasses(BODY, null, "")).toBe(true);
    // A stray signature header on an unauthenticated webhook is ignored.
    expect(signatureCheckPasses(BODY, "deadbeef", null)).toBe(true);
  });

  it("requires a valid signature once a secret is set", () => {
    expect(signatureCheckPasses(BODY, sign(BODY, SECRET), SECRET)).toBe(true);
    expect(signatureCheckPasses(BODY, null, SECRET)).toBe(false);
    expect(signatureCheckPasses(BODY, "wrong", SECRET)).toBe(false);
    expect(signatureCheckPasses(BODY, sign(BODY, "other_secret"), SECRET)).toBe(false);
    // Signed over different bytes → reject.
    expect(signatureCheckPasses('{"Email":"x@y.co"}', sign(BODY, SECRET), SECRET)).toBe(false);
  });
});
