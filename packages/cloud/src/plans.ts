/**
 * Paid-plan catalog — the single source of truth for the team / business /
 * unlimited tiers (C27).
 *
 * Autumn is the billing source of truth (the plans below were created there:
 * team $20 + $0.50/1k overage, business $40 + $0.40/1k, unlimited $99 no
 * overage). This module mirrors ONLY the plan IDENTITY + display metadata the
 * app needs to (a) validate a chosen plan before attaching it, (b) render the
 * upgrade options, and (c) name the workspace's current plan in the UI. It does
 * NOT re-encode pricing rules that live in Autumn — `perSeatUsd` here is purely
 * for display and must match the Autumn plan price.
 *
 * Like the rest of @gtmgrid/cloud this is PURE (no Convex, no SDK) and
 * unit-tested. The Autumn plan ids ({@link PAID_PLAN_IDS}) ARE the Autumn
 * product ids the checkout `attach` call uses, so the catalog and the billing
 * backend share one set of identifiers.
 */

/**
 * Whether a paid plan's CLOUD-actions are metered (a per-1k overage applies once
 * the included allotment is used) or unlimited. Surfaced in the upgrade UI as
 * the "overage vs. unlimited" note.
 */
export type CloudActionsMode = "metered" | "unlimited";

/**
 * Display metadata for one paid plan. `perSeatUsd` is the monthly per-seat price
 * shown in the UI (must match the Autumn plan); `cloudActions` distinguishes the
 * metered tiers (team/business) from the unlimited tier; `tagline` is a short
 * one-liner for the upgrade card.
 */
export interface PlanDisplay {
  /** The Autumn product id — also what checkout `attach` uses. */
  readonly id: PaidPlanId;
  /** Human-readable plan name (e.g. "Team"). */
  readonly name: string;
  /** Monthly price per seat in whole US dollars (display only). */
  readonly perSeatUsd: number;
  /** Whether cloud-actions are metered (overage) or unlimited on this plan. */
  readonly cloudActions: CloudActionsMode;
  /** Short marketing one-liner for the upgrade option. */
  readonly tagline: string;
  /**
   * REAL feature differentiators for this tier (rendered as the card bullets in
   * the onboarding plan step + the in-app upgrade modal). Describe only what we
   * actually ship — cloud sync, realtime multiplayer, shared workspace
   * credentials, the cloud-actions allowance/overage, per-seat seats — NOT
   * SSO/SAML/audit-log/version-history we do not have.
   */
  readonly features: readonly string[];
}

/**
 * Display metadata for the FREE (local-first, solo) tier. Free is NOT a paid plan
 * id (no Autumn `attach`, no checkout) so it lives outside {@link PLAN_CATALOG};
 * the onboarding/upgrade UIs render it alongside the paid cards as the "stay
 * local" option. Bullets describe the real local-first product.
 */
export interface FreePlanDisplay {
  readonly id: "free";
  readonly name: string;
  readonly perSeatUsd: 0;
  readonly tagline: string;
  readonly features: readonly string[];
}

/** The free tier card content (local & solo, forever — no card, no checkout). */
export const FREE_PLAN: FreePlanDisplay = {
  id: "free",
  name: "Free",
  perSeatUsd: 0,
  tagline: "Local & solo, forever",
  features: [
    "100% local & offline execution",
    "Unlimited rows, tables & functions",
    "Bring-your-own AI key",
    "Every connector, on your machine",
  ],
} as const;

/**
 * The paid plan ids, in upsell order (cheapest first). These ARE the Autumn
 * product ids the checkout `attach` call validates against and uses — the single
 * allow-list for "what plan can a workspace buy". `TEAM_PLAN_ID` (the default
 * upsell from the seat gate) is the first of these.
 */
export const PAID_PLAN_IDS = ["team", "business", "unlimited"] as const;

/** A valid paid plan id. Anything outside this set is rejected at checkout. */
export type PaidPlanId = (typeof PAID_PLAN_IDS)[number];

/**
 * The billing cycle a buyer picks at checkout. Monthly is the default; annual
 * trades a 12-month commitment for "2 months free" (10× the monthly per-seat
 * price) and maps to a SEPARATE Autumn plan id (the `_annual` variant).
 */
export type BillingCycle = "monthly" | "annual";

/**
 * The annual Autumn plan ids, one per paid tier, in the same upsell order as
 * {@link PAID_PLAN_IDS}. These are DISTINCT Autumn products (already created):
 * `team_annual` $200/yr, `business_annual` $400/yr, `unlimited_annual` $990/yr
 * — i.e. 10× the monthly per-seat price (2 months free). Attaching one bills the
 * customer annually instead of monthly for the same tier.
 */
export const ANNUAL_PAID_PLAN_IDS = [
  "team_annual",
  "business_annual",
  "unlimited_annual",
] as const;

/** A valid ANNUAL paid plan id. */
export type AnnualPaidPlanId = (typeof ANNUAL_PAID_PLAN_IDS)[number];

/**
 * Every plan id the checkout `attach` call may legitimately receive: the monthly
 * tiers + their annual variants. This is the FULL allow-list the checkout path
 * validates against ({@link isPaidPlanId}) so an annual selection is accepted
 * while a forged/unknown id is still rejected. The base {@link PAID_PLAN_IDS}
 * stays the catalog/upsell list used for display + plan derivation.
 */
export const ALL_PAID_PLAN_IDS = [
  ...PAID_PLAN_IDS,
  ...ANNUAL_PAID_PLAN_IDS,
] as const;

/** Any attachable paid plan id (monthly or annual). */
export type AnyPaidPlanId = (typeof ALL_PAID_PLAN_IDS)[number];

/**
 * The (tier, billing) → Autumn plan id mapping — the SINGLE source of truth that
 * resolves a chosen base tier + billing cycle to the concrete Autumn product id
 * the checkout `attach` call uses. Monthly cycles map to the base id
 * (team/business/unlimited); annual cycles map to the `_annual` variant. Keyed by
 * base tier so the onboarding/upgrade UI never re-derives the id string.
 */
export const PLAN_BILLING_IDS: {
  readonly [K in PaidPlanId]: { readonly [C in BillingCycle]: AnyPaidPlanId };
} = {
  team: { monthly: "team", annual: "team_annual" },
  business: { monthly: "business", annual: "business_annual" },
  unlimited: { monthly: "unlimited", annual: "unlimited_annual" },
} as const;

/**
 * Resolve a chosen base tier + billing cycle to the concrete Autumn plan id the
 * checkout action attaches. The single mapping the onboarding plan step + the
 * in-app upgrade modal both call so the monthly/annual id derivation lives in one
 * tested place.
 */
export function resolvePlanId(
  tier: PaidPlanId,
  billing: BillingCycle,
): AnyPaidPlanId {
  return PLAN_BILLING_IDS[tier][billing];
}

/**
 * The per-seat monthly-equivalent price to DISPLAY for a tier on a billing cycle.
 * Annual = 2 months free → `round(monthly × 10 / 12)` per seat/mo (the headline
 * number on the annual card). Pure + tested so the UI never re-implements the
 * annual math.
 */
export function perSeatUsdFor(tier: PaidPlanId, billing: BillingCycle): number {
  const monthly = PLAN_CATALOG[tier].perSeatUsd;
  return billing === "annual" ? Math.round((monthly * 10) / 12) : monthly;
}

/**
 * The catalog: display metadata per paid plan, keyed by id. Prices mirror the
 * Autumn plans (team $20, business $40, unlimited $99). team/business meter
 * cloud-actions (overage); unlimited does not.
 */
export const PLAN_CATALOG: { readonly [K in PaidPlanId]: PlanDisplay } = {
  team: {
    id: "team",
    name: "Team",
    perSeatUsd: 20,
    cloudActions: "metered",
    tagline: "For small teams getting started with shared cloud grids.",
    features: [
      "Cloud sync & realtime multiplayer",
      "Shared workspace credentials",
      "Monthly cloud-actions allowance, then overage",
      "Per-seat seats",
    ],
  },
  business: {
    id: "business",
    name: "Business",
    perSeatUsd: 40,
    cloudActions: "metered",
    tagline: "More included cloud actions and a lower overage rate.",
    features: [
      "Larger monthly cloud-actions allowance",
      "Lower per-action overage rate",
      "Shared workspace credentials",
      "Per-seat seats",
    ],
  },
  unlimited: {
    id: "unlimited",
    name: "Unlimited",
    perSeatUsd: 99,
    cloudActions: "unlimited",
    tagline: "Unlimited cloud actions — no overage, ever.",
    features: [
      "Unlimited cloud actions — no overage",
      "Cloud sync & realtime multiplayer",
      "Shared workspace credentials",
      "Per-seat seats",
    ],
  },
} as const;

/** Re-export the default upsell plan so the catalog is one import for callers. */
export { TEAM_PLAN_ID } from "./seats.js";

/**
 * The ordered list of paid plans for rendering the upgrade options (cheapest
 * first). A convenience derived from {@link PAID_PLAN_IDS} + {@link PLAN_CATALOG}
 * so the UI never re-declares the order.
 */
export const PAID_PLANS: readonly PlanDisplay[] = PAID_PLAN_IDS.map(
  (id) => PLAN_CATALOG[id],
);

/**
 * Type guard: is `id` a known paid plan id? The single validation used by the
 * checkout path (service + Convex action) to reject an unknown/forged plan
 * before any Autumn `attach`. Narrows to {@link PaidPlanId} on success.
 */
export function isPaidPlanId(id: string): id is AnyPaidPlanId {
  // `.some` keeps the comparison cast-free (each element narrows to AnyPaidPlanId,
  // compared against the wider `string` input). Accepts BOTH the monthly base
  // tiers AND their annual variants, since both are legitimate `attach` targets.
  return ALL_PAID_PLAN_IDS.some((paid) => paid === id);
}

/**
 * Type guard for the BASE (monthly) catalog tiers only — the keys of
 * {@link PLAN_CATALOG}. Distinct from {@link isPaidPlanId} (which also accepts the
 * annual variants): this narrows to a {@link PaidPlanId} that can index the
 * catalog for display name / price lookups. Used by {@link planName} and
 * {@link derivePaidPlanId}, which describe the workspace's TIER, not its cycle.
 */
export function isBasePaidPlanId(id: string): id is PaidPlanId {
  return PAID_PLAN_IDS.some((paid) => paid === id);
}

/**
 * The human-readable name for ANY plan id the `me` query might surface:
 *   - a known PAID plan → its catalog name ("Team" / "Business" / "Unlimited"),
 *   - `null` (no paid subscription) → "Free",
 *   - an unknown non-null id → that id verbatim (so a future/renamed Autumn plan
 *     still shows *something* rather than a misleading "Free").
 *
 * Pure so the badge label has one tested home shared by backend + UI.
 */
export function planName(planId: string | null): string {
  if (planId === null) return "Free";
  if (isBasePaidPlanId(planId)) return PLAN_CATALOG[planId].name;
  // An annual variant ("team_annual" …) names the same TIER as its base.
  const base = baseTierOf(planId);
  if (base !== null) return PLAN_CATALOG[base].name;
  return planId;
}

/**
 * The base tier id for any attachable plan id: a base id maps to itself, an
 * annual variant maps to its tier (`team_annual` → `team`), anything else →
 * `null`. Lets the tier-oriented helpers ({@link planName},
 * {@link derivePaidPlanId}) treat an annual subscription as its underlying tier.
 */
export function baseTierOf(planId: string): PaidPlanId | null {
  if (isBasePaidPlanId(planId)) return planId;
  for (const tier of PAID_PLAN_IDS) {
    if (PLAN_BILLING_IDS[tier].annual === planId) return tier;
  }
  return null;
}

/**
 * Derive the workspace's active PAID plan id from the plan ids Autumn reports for
 * the customer's active subscriptions (`customers.get(...).subscriptions`). The
 * customer always has the auto-enabled `free` plan; we want the highest paid
 * tier they hold, so we pick the LAST paid id in upsell order
 * ({@link PAID_PLAN_IDS}) that appears in `activePlanIds`.
 *
 * Returns `null` when no paid plan is active (i.e. free tier), which
 * {@link planName} renders as "Free". Pure: the Convex layer feeds it the ids it
 * read from Autumn (no HTTP here).
 */
export function derivePaidPlanId(
  activePlanIds: readonly string[],
): PaidPlanId | null {
  // Reduce every active id to its base tier first, so an ANNUAL subscription
  // ("business_annual") counts as its tier ("business") rather than being missed.
  const activeTiers = new Set(
    activePlanIds
      .map((id) => baseTierOf(id))
      .filter((t): t is PaidPlanId => t !== null),
  );
  // Walk highest tier → lowest so a customer on multiple tiers surfaces the top.
  for (let i = PAID_PLAN_IDS.length - 1; i >= 0; i--) {
    const id = PAID_PLAN_IDS[i];
    if (activeTiers.has(id)) return id;
  }
  return null;
}
