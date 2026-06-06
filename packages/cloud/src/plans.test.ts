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
  derivePaidPlanId,
  isPaidPlanId,
  PAID_PLAN_IDS,
  PAID_PLANS,
  PLAN_CATALOG,
  planName,
  TEAM_PLAN_ID,
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

  it("rejects unknown / forged plan ids", () => {
    expect(isPaidPlanId("free")).toBe(false);
    expect(isPaidPlanId("enterprise")).toBe(false);
    expect(isPaidPlanId("")).toBe(false);
    expect(isPaidPlanId("TEAM")).toBe(false);
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
});
