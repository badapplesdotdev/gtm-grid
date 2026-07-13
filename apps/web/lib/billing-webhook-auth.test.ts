import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  extractCustomerId,
  lifecycleBillingEmissions,
  revenueEventForPlan,
  verifyWebhookSignature,
} from "./billing-webhook-auth";

// A real Svix `whsec_` secret is `whsec_<base64key>`. Use a fixed test key.
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const MSG_ID = "msg_test_1";
const NOW_S = 1_750_000_000;
const NOW_MS = NOW_S * 1000;

/** Sign exactly as Svix / Standard Webhooks does, for the happy-path tests. */
function sign(secret: string, id: string, ts: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return `v1,${sig}`;
}

function svixHeaders(id: string, ts: number, signature: string): Headers {
  return new Headers({
    "svix-id": id,
    "svix-timestamp": String(ts),
    "svix-signature": signature,
  });
}

describe("verifyWebhookSignature (Svix / Standard Webhooks)", () => {
  const body = JSON.stringify({ object: "event", customer_id: "ws_1" });

  it("accepts a correctly-signed delivery", () => {
    const headers = svixHeaders(MSG_ID, NOW_S, sign(SECRET, MSG_ID, NOW_S, body));
    expect(verifyWebhookSignature(body, headers, SECRET, NOW_MS)).toBe(true);
  });

  it("accepts the `webhook-` header prefix too (enterprise)", () => {
    const headers = new Headers({
      "webhook-id": MSG_ID,
      "webhook-timestamp": String(NOW_S),
      "webhook-signature": sign(SECRET, MSG_ID, NOW_S, body),
    });
    expect(verifyWebhookSignature(body, headers, SECRET, NOW_MS)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const headers = svixHeaders(MSG_ID, NOW_S, sign(SECRET, MSG_ID, NOW_S, body));
    expect(verifyWebhookSignature(body + " ", headers, SECRET, NOW_MS)).toBe(false);
  });

  it("rejects a wrong signing secret", () => {
    const headers = svixHeaders(MSG_ID, NOW_S, sign(SECRET, MSG_ID, NOW_S, body));
    expect(
      verifyWebhookSignature(body, headers, "whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAA", NOW_MS),
    ).toBe(false);
  });

  it("rejects a stale timestamp (replay protection, > 5 min)", () => {
    const oldTs = NOW_S - 1000;
    const headers = svixHeaders(MSG_ID, oldTs, sign(SECRET, MSG_ID, oldTs, body));
    expect(verifyWebhookSignature(body, headers, SECRET, NOW_MS)).toBe(false);
  });

  it("rejects missing signature headers", () => {
    expect(verifyWebhookSignature(body, new Headers(), SECRET, NOW_MS)).toBe(false);
  });

  it("fails closed when the secret is UNSET", () => {
    const headers = svixHeaders(MSG_ID, NOW_S, sign(SECRET, MSG_ID, NOW_S, body));
    expect(verifyWebhookSignature(body, headers, undefined, NOW_MS)).toBe(false);
  });

  it("rejects a non-v1 signature token", () => {
    const sig = sign(SECRET, MSG_ID, NOW_S, body).replace("v1,", "v0,");
    expect(verifyWebhookSignature(body, svixHeaders(MSG_ID, NOW_S, sig), SECRET, NOW_MS)).toBe(false);
  });
});

describe("extractCustomerId", () => {
  it("reads top-level customer_id (the real billing.updated shape)", () => {
    expect(extractCustomerId({ object: "event", customer_id: "ws_42" })).toBe("ws_42");
  });
  it("reads alternate locations (customerId / workspaceId / nested / customer.id)", () => {
    expect(extractCustomerId({ customerId: "a" })).toBe("a");
    expect(extractCustomerId({ workspaceId: "b" })).toBe("b");
    expect(extractCustomerId({ data: { customer_id: "c" } })).toBe("c");
    expect(extractCustomerId({ customer: { id: "d" } })).toBe("d");
  });
  it("returns null when no customer id is present or payload is not an object", () => {
    expect(extractCustomerId({ object: "event" })).toBeNull();
    expect(extractCustomerId(null)).toBeNull();
    expect(extractCustomerId("nope")).toBeNull();
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

/**
 * The pure emission rule behind the two billing lifecycle emails (#20 receipt,
 * #17 dunning). The route just maps over the result, so pinning it here pins the
 * webhook's whole email-triggering behaviour — including the deliberate `==`
 * null semantics for a `previousPlanId` that is absent (non-webhook sync).
 */
describe("lifecycleBillingEmissions — first-subscription (started)", () => {
  it("null → paid emits subscription.started with the plan id", () => {
    const out = lifecycleBillingEmissions(
      { id: "business", previousPlanId: null },
      { type: "billing.updated" },
    );
    expect(out).toEqual([{ event: "billing/subscription.started", planId: "business" }]);
  });

  it("paid → paid (an upgrade/renewal, not a first sub) emits nothing", () => {
    expect(
      lifecycleBillingEmissions(
        { id: "business", previousPlanId: "starter" },
        { type: "billing.updated" },
      ),
    ).toEqual([]);
  });

  it("null → null (still free) emits nothing", () => {
    expect(
      lifecycleBillingEmissions({ id: null, previousPlanId: null }, {}),
    ).toEqual([]);
  });

  it("paid → null (a cancel, handled elsewhere) emits nothing", () => {
    expect(
      lifecycleBillingEmissions({ id: null, previousPlanId: "business" }, {}),
    ).toEqual([]);
  });

  it("an ABSENT previousPlanId (non-webhook SyncedPlan) is `== null`, so a first paid sync still fires", () => {
    // `undefined == null` is true — the deliberate loose-equality the route relies
    // on so a first paid sync from a path that omits previousPlanId still emails.
    const out = lifecycleBillingEmissions({ id: "business" }, {});
    expect(out).toEqual([{ event: "billing/subscription.started", planId: "business" }]);
  });
});

describe("lifecycleBillingEmissions — payment failure (failed)", () => {
  const paid = { id: "business", previousPlanId: "business" } as const;

  it("type exactly `payment_failed` emits payment.failed", () => {
    expect(lifecycleBillingEmissions(paid, { type: "payment_failed" })).toEqual([
      { event: "billing/payment.failed", planId: "business" },
    ]);
  });

  it("a `.past_due` suffix (e.g. subscription.past_due) emits payment.failed", () => {
    expect(
      lifecycleBillingEmissions(paid, { type: "subscription.past_due" }),
    ).toEqual([{ event: "billing/payment.failed", planId: "business" }]);
  });

  it("carries planId null when the reconciled plan is free/lapsed", () => {
    expect(
      lifecycleBillingEmissions(
        { id: null, previousPlanId: "business" },
        { type: "payment_failed" },
      ),
    ).toEqual([{ event: "billing/payment.failed", planId: null }]);
  });

  it("an unrelated type (billing.updated) emits nothing", () => {
    expect(lifecycleBillingEmissions(paid, { type: "billing.updated" })).toEqual([]);
  });

  it("a missing or non-string type emits nothing", () => {
    expect(lifecycleBillingEmissions(paid, {})).toEqual([]);
    expect(lifecycleBillingEmissions(paid, { type: 42 })).toEqual([]);
    expect(lifecycleBillingEmissions(paid, null)).toEqual([]);
    expect(lifecycleBillingEmissions(paid, "not-an-object")).toEqual([]);
  });
});

describe("lifecycleBillingEmissions — both triggers co-emit", () => {
  it("a FIRST paid sync whose payload also reports a failure emits started AND failed", () => {
    const out = lifecycleBillingEmissions(
      { id: "business", previousPlanId: null },
      { type: "payment_failed" },
    );
    expect(out).toEqual([
      { event: "billing/subscription.started", planId: "business" },
      { event: "billing/payment.failed", planId: "business" },
    ]);
  });
});
