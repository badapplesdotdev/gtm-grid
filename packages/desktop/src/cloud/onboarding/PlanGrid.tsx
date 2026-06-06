/**
 * Shared plan grid + plan card (C28) — plain React presentation.
 *
 * The pricing card the design specifies, rendered from OUR real plan catalog
 * (`@gtmgrid/cloud`: Free + Team $20 + Business $40 [recommended] + Unlimited
 * $99, per seat). Used by BOTH:
 *   - the onboarding "Plan select" step (packages/desktop/src/cloud/onboarding),
 *   - the in-app upgrade modal (WorkspaceSettings.tsx),
 * so the card markup + styles live in ONE place (no duplication).
 *
 * Pure presentation: the parent owns selection + billing state and the
 * per-seat/total math (via the shared `perSeatUsdFor`); this renders the cards
 * and the monthly/annual toggle and reports clicks. Feature bullets come from the
 * catalog, so they describe REAL differentiators only.
 */

import {
  type BillingCycle,
  FREE_PLAN,
  PAID_PLANS,
  perSeatUsdFor,
} from "@gtmgrid/cloud";
import type { SelectablePlan } from "./flow-logic.js";
import { Check } from "./icons.js";
import "./onboarding.css";

/** The plan-card content the grid renders: the free tier + every paid tier. */
interface PlanCardModel {
  readonly id: SelectablePlan;
  readonly name: string;
  readonly tagline: string;
  readonly features: readonly string[];
  /** Monthly per-seat price in whole dollars (0 for free). */
  readonly perSeatUsd: number;
  /** Business is highlighted as the recommended tier. */
  readonly recommended: boolean;
}

/**
 * Build the ordered card list (free first, then paid tiers in upsell order) for a
 * billing cycle. Per-seat prices come from the shared catalog so the annual math
 * (2 months free) is single-sourced.
 */
function cardModels(billing: BillingCycle): readonly PlanCardModel[] {
  const free: PlanCardModel = {
    id: FREE_PLAN.id,
    name: FREE_PLAN.name,
    tagline: FREE_PLAN.tagline,
    features: FREE_PLAN.features,
    perSeatUsd: 0,
    recommended: false,
  };
  const paid = PAID_PLANS.map((plan): PlanCardModel => ({
    id: plan.id,
    name: plan.name,
    tagline: plan.tagline,
    features: plan.features,
    perSeatUsd: perSeatUsdFor(plan.id, billing),
    recommended: plan.id === "business",
  }));
  return [free, ...paid];
}

/** The monthly/annual segmented toggle (annual = 2 months free). */
export function BillingToggle(props: {
  billing: BillingCycle;
  onChange: (billing: BillingCycle) => void;
}) {
  const { billing, onChange } = props;
  return (
    <div className="ob-billing-toggle">
      <button
        type="button"
        className={`ob-bt-opt${billing === "monthly" ? " active" : ""}`}
        onClick={() => onChange("monthly")}
      >
        Monthly
      </button>
      <button
        type="button"
        className={`ob-bt-opt${billing === "annual" ? " active" : ""}`}
        onClick={() => onChange("annual")}
      >
        Annual <span className="ob-bt-save">2 months free</span>
      </button>
    </div>
  );
}

/** A single plan card. */
function PlanCard(props: {
  model: PlanCardModel;
  billing: BillingCycle;
  selected: boolean;
  /** The plan id the workspace is currently ON (renders "Current plan"). */
  current: boolean;
  onSelect: (id: SelectablePlan) => void;
}) {
  const { model, billing, selected, current, onSelect } = props;
  const isFree = model.perSeatUsd === 0;
  return (
    <div
      className={`ob-plan-card${selected ? " selected" : ""}${
        model.recommended ? " recommended" : ""
      }`}
      onClick={() => onSelect(model.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(model.id);
        }
      }}
    >
      {model.recommended && <span className="ob-plan-badge">Recommended</span>}
      <div className="ob-plan-name">{model.name}</div>
      <div className="ob-plan-tagline">{model.tagline}</div>

      <div className="ob-plan-price-row">
        <span className="ob-plan-price">${model.perSeatUsd}</span>
        {!isFree && (
          <span className="ob-plan-per">
            /seat
            <br />
            /mo
          </span>
        )}
      </div>
      <div className="ob-plan-billed">
        {isFree
          ? "No card, ever"
          : billing === "annual"
            ? "billed annually"
            : "billed monthly"}
      </div>

      <button type="button" className={`ob-plan-cta${selected ? " on" : ""}`}>
        {current ? (
          "Current plan"
        ) : selected ? (
          <span className="ob-cta-on">
            <Check s={13} /> Selected
          </span>
        ) : isFree ? (
          "Stay on Free"
        ) : (
          `Choose ${model.name}`
        )}
      </button>

      <ul className="ob-plan-feats">
        {model.features.map((f) => (
          <li key={f}>
            <span className="ob-feat-ico">
              <Check s={12} />
            </span>
            {f}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The 4-up plan grid (Free + Team + Business + Unlimited) the design specifies,
 * shared between onboarding + the upgrade modal. The parent owns the selected
 * plan + billing cycle; `currentPlan` (if any) renders that card's CTA as
 * "Current plan".
 */
export function PlanGrid(props: {
  billing: BillingCycle;
  selected: SelectablePlan;
  /** The plan the workspace is currently on (upgrade context), or null. */
  currentPlan?: SelectablePlan | null;
  /** Whether to render the Free card (onboarding shows it; upgrade may hide it). */
  includeFree?: boolean;
  onSelect: (id: SelectablePlan) => void;
}) {
  const { billing, selected, currentPlan = null, includeFree = true, onSelect } =
    props;
  const models = cardModels(billing).filter(
    (m) => includeFree || m.id !== "free",
  );
  return (
    <div className="ob-plan-grid">
      {models.map((m) => (
        <PlanCard
          key={m.id}
          model={m}
          billing={billing}
          selected={selected === m.id}
          current={currentPlan === m.id}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
