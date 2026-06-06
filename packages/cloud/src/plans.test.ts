/**
 * Tests for the paid-plan catalog (C27).
 *
 * Pure functions, so these are plain assertions (no Effect runtime needed).
 * Outcome-focused per docs/effect-conventions.md: assert the catalog matches the
 * Autumn plans, that unknown plan ids are rejected, that each valid id resolves
 * to the right display name, and that the active-plan derivation picks the
 * highest paid tier.
 */

import { describe, expect, it } from "vitest";
import {
  ALL_PAID_PLAN_IDS,
  ANNUAL_PAID_PLAN_IDS,
  baseTierOf,
  derivePaidPlanId,
  FREE_PLAN,
  isBasePaidPlanId,
  isPaidPlanId,
  PAID_PLAN_IDS,
  PAID_PLANS,
  PLAN_BILLING_IDS,
  PLAN_CATALOG,
  perSeatUsdFor,
  planName,
  resolvePlanId,
  TEAM_PLAN_ID,
  type BillingCycle,
  type PaidPlanId,
} from "./plans.js";

describe("PAID_PLAN_IDS + PLAN_CATALOG (single source of truth)", () => {
  it("lists exactly team, business, unlimited in upsell order", () => {
    expect(PAID_PLAN_IDS).toEqual(["team", "business", "unlimited"]);
  });

  it("keeps the team plan as the default upsell", () => {
    expect(TEAM_PLAN_ID).toBe("team");
    expect(PAID_PLAN_IDS[0]).toBe(TEAM_PLAN_ID);
  });

  it("matches the Autumn plan prices (team $20 / business $40 / unlimited $99)", () => {
    expect(PLAN_CATALOG.team.perSeatUsd).toBe(20);
    expect(PLAN_CATALOG.business.perSeatUsd).toBe(40);
    expect(PLAN_CATALOG.unlimited.perSeatUsd).toBe(99);
  });

  it("marks team/business as metered and unlimited as unlimited cloud actions", () => {
    expect(PLAN_CATALOG.team.cloudActions).toBe("metered");
    expect(PLAN_CATALOG.business.cloudActions).toBe("metered");
    expect(PLAN_CATALOG.unlimited.cloudActions).toBe("unlimited");
  });

  it("carries human names + a tagline per plan", () => {
    expect(PLAN_CATALOG.team.name).toBe("Team");
    expect(PLAN_CATALOG.business.name).toBe("Business");
    expect(PLAN_CATALOG.unlimited.name).toBe("Unlimited");
    for (const plan of PAID_PLANS) {
      expect(plan.tagline.length).toBeGreaterThan(0);
    }
  });

  it("PAID_PLANS mirrors the catalog in upsell order", () => {
    expect(PAID_PLANS.map((p) => p.id)).toEqual([
      "team",
      "business",
      "unlimited",
    ]);
  });
});

describe("isPaidPlanId (checkout validation)", () => {
  it("accepts every catalog plan id", () => {
    for (const id of PAID_PLAN_IDS) {
      expect(isPaidPlanId(id)).toBe(true);
    }
  });

  it("accepts every annual variant id (annual checkout)", () => {
    for (const id of ANNUAL_PAID_PLAN_IDS) {
      expect(isPaidPlanId(id)).toBe(true);
    }
  });

  it("rejects unknown / forged plan ids", () => {
    expect(isPaidPlanId("free")).toBe(false);
    expect(isPaidPlanId("enterprise")).toBe(false);
    expect(isPaidPlanId("")).toBe(false);
    expect(isPaidPlanId("TEAM")).toBe(false);
    expect(isPaidPlanId("team_yearly")).toBe(false);
  });
});

describe("annual plan ids + (tier,billing) → planId mapping", () => {
  it("lists the three annual variants in upsell order", () => {
    expect(ANNUAL_PAID_PLAN_IDS).toEqual([
      "team_annual",
      "business_annual",
      "unlimited_annual",
    ]);
  });

  it("ALL_PAID_PLAN_IDS is the base tiers plus their annual variants", () => {
    expect(ALL_PAID_PLAN_IDS).toEqual([
      "team",
      "business",
      "unlimited",
      "team_annual",
      "business_annual",
      "unlimited_annual",
    ]);
  });

  it("resolvePlanId maps monthly to the base id and annual to the _annual id", () => {
    expect(resolvePlanId("team", "monthly")).toBe("team");
    expect(resolvePlanId("team", "annual")).toBe("team_annual");
    expect(resolvePlanId("business", "monthly")).toBe("business");
    expect(resolvePlanId("business", "annual")).toBe("business_annual");
    expect(resolvePlanId("unlimited", "monthly")).toBe("unlimited");
    expect(resolvePlanId("unlimited", "annual")).toBe("unlimited_annual");
  });

  it("every resolved plan id validates as a paid plan", () => {
    const tiers: PaidPlanId[] = ["team", "business", "unlimited"];
    const cycles: BillingCycle[] = ["monthly", "annual"];
    for (const tier of tiers) {
      for (const cycle of cycles) {
        expect(isPaidPlanId(resolvePlanId(tier, cycle))).toBe(true);
      }
    }
  });

  it("PLAN_BILLING_IDS agrees with resolvePlanId", () => {
    for (const tier of PAID_PLAN_IDS) {
      expect(PLAN_BILLING_IDS[tier].monthly).toBe(resolvePlanId(tier, "monthly"));
      expect(PLAN_BILLING_IDS[tier].annual).toBe(resolvePlanId(tier, "annual"));
    }
  });
});

describe("perSeatUsdFor (annual = 2 months free)", () => {
  it("returns the monthly catalog price for monthly billing", () => {
    expect(perSeatUsdFor("team", "monthly")).toBe(20);
    expect(perSeatUsdFor("business", "monthly")).toBe(40);
    expect(perSeatUsdFor("unlimited", "monthly")).toBe(99);
  });

  it("returns the 10/12 monthly-equivalent for annual billing", () => {
    // 2 months free → round(monthly × 10 / 12).
    expect(perSeatUsdFor("team", "annual")).toBe(Math.round((20 * 10) / 12));
    expect(perSeatUsdFor("business", "annual")).toBe(Math.round((40 * 10) / 12));
    expect(perSeatUsdFor("unlimited", "annual")).toBe(
      Math.round((99 * 10) / 12),
    );
  });
});

describe("baseTierOf + isBasePaidPlanId (tier from any plan id)", () => {
  it("maps a base id to itself", () => {
    expect(baseTierOf("team")).toBe("team");
    expect(baseTierOf("unlimited")).toBe("unlimited");
  });

  it("maps an annual variant to its base tier", () => {
    expect(baseTierOf("team_annual")).toBe("team");
    expect(baseTierOf("business_annual")).toBe("business");
    expect(baseTierOf("unlimited_annual")).toBe("unlimited");
  });

  it("returns null for non-paid / unknown ids", () => {
    expect(baseTierOf("free")).toBeNull();
    expect(baseTierOf("enterprise")).toBeNull();
  });

  it("isBasePaidPlanId only accepts the monthly base tiers", () => {
    expect(isBasePaidPlanId("team")).toBe(true);
    expect(isBasePaidPlanId("team_annual")).toBe(false);
    expect(isBasePaidPlanId("free")).toBe(false);
  });
});

describe("FREE_PLAN (local-first card)", () => {
  it("is a $0 'free' tier with real local-first bullets", () => {
    expect(FREE_PLAN.id).toBe("free");
    expect(FREE_PLAN.perSeatUsd).toBe(0);
    expect(FREE_PLAN.features.length).toBeGreaterThan(0);
    // free is NOT an attachable paid plan.
    expect(isPaidPlanId("free")).toBe(false);
  });
});

describe("real feature bullets (no invented enterprise copy)", () => {
  it("never claims SSO/SAML/audit/version-history we do not have", () => {
    const banned = /sso|saml|audit|version history/i;
    for (const plan of PAID_PLANS) {
      for (const feature of plan.features) {
        expect(feature).not.toMatch(banned);
      }
    }
  });

  it("gives each paid tier at least one differentiator", () => {
    for (const plan of PAID_PLANS) {
      expect(plan.features.length).toBeGreaterThan(0);
    }
  });
});

describe("planName (badge label)", () => {
  it("renders Free for a null plan id", () => {
    expect(planName(null)).toBe("Free");
  });

  it("renders the catalog name for each paid plan", () => {
    expect(planName("team")).toBe("Team");
    expect(planName("business")).toBe("Business");
    expect(planName("unlimited")).toBe("Unlimited");
  });

  it("falls back to the raw id for an unknown non-null plan", () => {
    // A future/renamed Autumn plan still shows something, not a misleading Free.
    expect(planName("enterprise")).toBe("enterprise");
  });
});

describe("derivePaidPlanId (current plan from active subscriptions)", () => {
  it("returns null when only the free plan is active", () => {
    expect(derivePaidPlanId(["free"])).toBeNull();
    expect(derivePaidPlanId([])).toBeNull();
  });

  it("returns the paid plan when one is active alongside free", () => {
    expect(derivePaidPlanId(["free", "team"])).toBe("team");
    expect(derivePaidPlanId(["free", "business"])).toBe("business");
    expect(derivePaidPlanId(["free", "unlimited"])).toBe("unlimited");
  });

  it("picks the HIGHEST paid tier when multiple are active", () => {
    expect(derivePaidPlanId(["free", "team", "unlimited"])).toBe("unlimited");
    expect(derivePaidPlanId(["business", "team"])).toBe("business");
  });

  it("ignores unknown plan ids", () => {
    expect(derivePaidPlanId(["free", "enterprise"])).toBeNull();
  });

  it("derives the tier from an annual subscription", () => {
    expect(derivePaidPlanId(["free", "business_annual"])).toBe("business");
    expect(derivePaidPlanId(["unlimited_annual"])).toBe("unlimited");
  });

  it("planName names the tier for an annual subscription", () => {
    expect(planName("team_annual")).toBe("Team");
    expect(planName("unlimited_annual")).toBe("Unlimited");
  });
});
