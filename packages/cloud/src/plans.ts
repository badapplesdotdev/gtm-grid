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

import { TEAM_PLAN_ID } from "./seats.js";

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
}

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
  },
  business: {
    id: "business",
    name: "Business",
    perSeatUsd: 40,
    cloudActions: "metered",
    tagline: "More included cloud actions and a lower overage rate.",
  },
  unlimited: {
    id: "unlimited",
    name: "Unlimited",
    perSeatUsd: 99,
    cloudActions: "unlimited",
    tagline: "Unlimited cloud actions — no overage, ever.",
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
export function isPaidPlanId(id: string): id is PaidPlanId {
  // `.some` keeps the comparison cast-free (each element narrows to PaidPlanId,
  // compared against the wider `string` input).
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
  return isPaidPlanId(planId) ? PLAN_CATALOG[planId].name : planId;
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
  const active = new Set(activePlanIds);
  // Walk highest tier → lowest so a customer on multiple tiers surfaces the top.
  for (let i = PAID_PLAN_IDS.length - 1; i >= 0; i--) {
    const id = PAID_PLAN_IDS[i];
    if (active.has(id)) return id;
  }
  return null;
}
