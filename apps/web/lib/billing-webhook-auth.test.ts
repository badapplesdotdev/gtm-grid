import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAuthorizedBillingWebhook, revenueEventForPlan } from "./billing-webhook-auth";

const SECRET = "awh_secret_value";

function req(auth?: string | null): Request {
  const headers: Record<string, string> = {};
  if (auth != null) headers.Authorization = auth;
  return new Request("https://app.gtmgrid.test/api/billing/webhook", { method: "POST", headers });
}

describe("isAuthorizedBillingWebhook", () => {
  beforeEach(() => {
    process.env.AUTUMN_WEBHOOK_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.AUTUMN_WEBHOOK_SECRET;
  });

  it("accepts the correct bearer", () => {
    expect(isAuthorizedBillingWebhook(req(`Bearer ${SECRET}`))).toBe(true);
  });

  it("rejects a missing Authorization header", () => {
    expect(isAuthorizedBillingWebhook(req(null))).toBe(false);
  });

  it("rejects a wrong secret", () => {
    expect(isAuthorizedBillingWebhook(req("Bearer not-the-secret"))).toBe(false);
  });

  it("rejects a non-Bearer scheme", () => {
    expect(isAuthorizedBillingWebhook(req(`Basic ${SECRET}`))).toBe(false);
  });

  it("fails closed when AUTUMN_WEBHOOK_SECRET is UNSET (rejects even a bearer)", () => {
    delete process.env.AUTUMN_WEBHOOK_SECRET;
    expect(isAuthorizedBillingWebhook(req(`Bearer ${SECRET}`))).toBe(false);
  });

  it("rejects a bearer that is a prefix of the secret (length-checked)", () => {
    expect(isAuthorizedBillingWebhook(req(`Bearer ${SECRET.slice(0, -1)}`))).toBe(false);
  });
});

describe("revenueEventForPlan", () => {
  it("maps a paid plan id to subscription_changed", () => {
    expect(revenueEventForPlan("business")).toBe("subscription_changed");
  });
  it("maps null (Free / cancelled) to subscription_canceled", () => {
    expect(revenueEventForPlan(null)).toBe("subscription_canceled");
  });
});
