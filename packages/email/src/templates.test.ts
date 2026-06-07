import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emailEnabled,
  inviteEmail,
  passwordResetEmail,
  sendEmail,
  verificationEmail,
  welcomeEmail,
} from "./templates.js";

/**
 * These tests assert the ported email seam (TRI-3244) WITHOUT a network call:
 *   - `emailEnabled()` is driven purely by AUTH_RESEND_KEY presence,
 *   - `sendEmail` no-ops (no throw) when the key is unset,
 *   - the OTP templates carry the code, the 15-minute window, and the inline
 *     CID brand icons.
 */

const ORIGINAL_KEY = process.env.AUTH_RESEND_KEY;

beforeEach(() => {
  delete process.env.AUTH_RESEND_KEY;
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.AUTH_RESEND_KEY;
  else process.env.AUTH_RESEND_KEY = ORIGINAL_KEY;
});

describe("emailEnabled gating", () => {
  it("is false when AUTH_RESEND_KEY is unset", () => {
    expect(emailEnabled()).toBe(false);
  });

  it("is true when AUTH_RESEND_KEY is present", () => {
    process.env.AUTH_RESEND_KEY = "re_test_key";
    expect(emailEnabled()).toBe(true);
  });
});

describe("sendEmail without a key", () => {
  it("no-ops (resolves without throwing) when AUTH_RESEND_KEY is unset", async () => {
    await expect(
      sendEmail({
        to: "user@example.com",
        subject: "test",
        html: "<p>hi</p>",
        text: "hi",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("verificationEmail template", () => {
  const email = verificationEmail("user@example.com", "123456");

  it("addresses the recipient and carries the code", () => {
    expect(email.to).toBe("user@example.com");
    // The HTML groups the digits in threes for readability (separated by a
    // non-breaking space in the design); assert the grouped digits regardless of
    // the exact separator, and the plain code in the text part.
    expect(email.html).toMatch(/123\s456/);
    expect(email.text).toContain("123456");
  });

  it("states the 15-minute expiry", () => {
    expect(email.html).toContain("15 minutes");
    expect(email.text).toContain("15 minutes");
  });

  it("references the inline CID brand icons", () => {
    expect(email.html).toContain("cid:gg-icon-white");
    expect(email.html).toContain("cid:gg-icon-color");
  });
});

describe("passwordResetEmail template", () => {
  const email = passwordResetEmail("user@example.com", "654321");

  it("carries the reset code and 15-minute window", () => {
    expect(email.html).toMatch(/654\s321/);
    expect(email.html).toContain("15 minutes");
    expect(email.subject.toLowerCase()).toContain("reset");
  });
});

describe("invite + welcome templates", () => {
  it("invite carries the accept URL", () => {
    const email = inviteEmail({
      to: "invitee@example.com",
      workspaceName: "Acme",
      inviterName: "Dana",
      acceptUrl: "https://gtmgrid.dev/invite/abc",
    });
    expect(email.html).toContain("https://gtmgrid.dev/invite/abc");
    expect(email.text).toContain("https://gtmgrid.dev/invite/abc");
  });

  it("welcome renders the open-app CTA", () => {
    const email = welcomeEmail({ to: "user@example.com" });
    expect(email.subject.toLowerCase()).toContain("welcome");
    expect(email.html).toContain("open GTM Grid");
  });
});
