/**
 * Workspace settings — members + seats + invite/upgrade (T10), plain React.
 *
 * Renders the members roster for the active workspace, the seats used/limit
 * badge, and an "Invite member" action. The invite path is gated on seats by the
 * Convex `inviteMember` action (Autumn, T6): when the workspace is over its limit
 * the action returns an Autumn checkout URL instead of adding anyone — this
 * component opens that URL in the system browser and shows an upgrade modal
 * (reusing the existing `.overlay` / `.modal` patterns from App.tsx).
 *
 * Following the repo convention, this file is presentation + event wiring only.
 * The invite/upgrade LOGIC (session guard, branch on the action result, open the
 * checkout URL) lives in the Effect service in ./invite.ts and is unit-tested
 * there. The roster + seat usage come from the reactive `listMembers` query, so
 * an invite by any member appears live.
 *
 * Entirely gated on a configured Convex deployment + a signed-in workspace: when
 * either is absent it renders nothing, so the local-only app is untouched.
 */

import { useCallback, useMemo, useState } from "react";
import { useAction, useConvexAuth } from "convex/react";
import { Effect, Layer } from "effect";
import { type BillingCycle, resolvePlanId } from "@gtmgrid/cloud";
import { PlanGrid, BillingToggle } from "./onboarding/PlanGrid";
import type { SelectablePlan } from "./onboarding/flow-logic";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { cloudEnabled } from "./convex";
import { useMembers } from "./auth";
import {
  InviteError,
  InviteRunner,
  InviteService,
  InviteServiceLive,
  UrlOpenerLive,
  runInvite,
  type InviteActionResult,
  type InviteInput,
} from "./invite";
import {
  CheckoutError,
  CheckoutRunner,
  CheckoutService,
  CheckoutServiceLive,
  runCheckout,
  type CheckoutActionResult,
} from "./checkout";

interface WorkspaceSettingsProps {
  /** The active workspace to manage, or `null` when none is selected. */
  workspaceId: Id<"workspaces"> | null;
  /** The active workspace's display name (for the header). */
  workspaceName: string | null;
  /** Close the settings panel. */
  onClose: () => void;
}

/**
 * The workspace settings panel: members list, seats, invite + upgrade modal.
 * Returns `null` (renders nothing) when cloud is off or no workspace is active,
 * so the local-only path is unaffected.
 */
export function WorkspaceSettings(props: WorkspaceSettingsProps) {
  const { workspaceId, workspaceName, onClose } = props;
  const { isAuthenticated } = useConvexAuth();
  const members = useMembers(workspaceId);

  // The Convex `inviteMember` action, wrapped as the Effect `InviteRunner` port.
  const inviteAction = useAction(api.workspaces.inviteMember);

  // Compose the Live invite Layer once: the React-bound runner + system-browser
  // opener feeding the orchestration. `useMemo` keeps it stable across renders.
  const inviteLayer = useMemo<Layer.Layer<InviteService>>(
    () =>
      InviteServiceLive.pipe(
        Layer.provide(
          Layer.succeed(InviteRunner, {
            invite: (input: InviteInput) =>
              Effect.tryPromise({
                try: () =>
                  inviteAction({
                    workspaceId: input.workspaceId as Id<"workspaces">,
                    userId: input.userId,
                    role: input.role,
                  }) as Promise<InviteActionResult>,
                catch: (cause) =>
                  new InviteError({
                    message:
                      cause instanceof Error ? cause.message : "Invite failed.",
                    cause,
                  }),
              }),
          }),
        ),
        Layer.provide(UrlOpenerLive),
      ),
    [inviteAction],
  );

  // The Convex `billing.checkout` action, wrapped as the Effect `CheckoutRunner`
  // port. Composes with the shared system-browser opener (UrlOpenerLive).
  const checkoutAction = useAction(api.billing.checkout);
  const checkoutLayer = useMemo<Layer.Layer<CheckoutService>>(
    () =>
      CheckoutServiceLive.pipe(
        Layer.provide(
          Layer.succeed(CheckoutRunner, {
            checkout: (args) =>
              Effect.tryPromise({
                try: () =>
                  checkoutAction({
                    workspaceId: args.workspaceId as Id<"workspaces">,
                    planId: args.planId,
                  }) as Promise<CheckoutActionResult>,
                catch: (cause) =>
                  new CheckoutError({
                    message:
                      cause instanceof Error
                        ? cause.message
                        : "Checkout failed.",
                    cause,
                  }),
              }),
          }),
        ),
        Layer.provide(UrlOpenerLive),
      ),
    [checkoutAction],
  );

  const [inviteUserId, setInviteUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When true, the plan-selection upgrade modal is shown.
  const [showUpgrade, setShowUpgrade] = useState(false);

  const submitInvite = useCallback(async () => {
    const userId = inviteUserId.trim();
    if (!userId || busy || workspaceId === null) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await runInvite(
        isAuthenticated,
        { workspaceId, userId, role: "member" },
        inviteLayer,
      );
      if (outcome.status === "checkout") {
        // Over the seat limit: present the plan-selection upgrade modal so the
        // user can choose team / business / unlimited (C27), rather than only
        // opening the default team checkout.
        setShowUpgrade(true);
      } else {
        // Added: clear the field; the roster updates live via the query.
        setInviteUserId("");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invite failed.");
    } finally {
      setBusy(false);
    }
  }, [inviteUserId, busy, workspaceId, isAuthenticated, inviteLayer]);

  // Start checkout for a chosen plan (C27): calls the billing action with the
  // planId and opens the returned Autumn URL in the system browser. Errors
  // surface in the modal; the modal stays open so a fallback link is available.
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  // Selected tier + billing cycle in the upgrade modal (default to the
  // recommended Business tier, monthly).
  const [selectedPlan, setSelectedPlan] = useState<SelectablePlan>("business");
  const [billing, setBilling] = useState<BillingCycle>("monthly");
  const startUpgrade = useCallback(async () => {
    if (workspaceId === null || upgrading) return;
    // Free is not a checkout target; the modal's CTA is disabled for it.
    if (selectedPlan === "free") return;
    setUpgrading(true);
    setUpgradeError(null);
    try {
      // Resolve the concrete Autumn plan id from (tier, billing) via the shared
      // catalog mapping — the same single-sourced resolution onboarding uses.
      const planId = resolvePlanId(selectedPlan, billing);
      await runCheckout(isAuthenticated, { workspaceId, planId }, checkoutLayer);
    } catch (e) {
      setUpgradeError(e instanceof Error ? e.message : "Checkout failed.");
    } finally {
      setUpgrading(false);
    }
  }, [
    workspaceId,
    isAuthenticated,
    checkoutLayer,
    upgrading,
    selectedPlan,
    billing,
  ]);

  if (!cloudEnabled || workspaceId === null) return null;

  const used = members?.seatUsage.used ?? null;
  const limit = members?.seatUsage.limit ?? null;
  const seatsLabel =
    used === null ? "…" : limit === null ? `${used}` : `${used} / ${limit}`;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 520 }}>
        <div className="modal-header">
          <span className="modal-title">
            {workspaceName ? `${workspaceName} · Members` : "Workspace members"}
          </span>
          <span className="free-badge" title="Seats used / limit">
            {seatsLabel} {used === 1 ? "seat" : "seats"}
          </span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-body">
          {/* Members roster (reactive). */}
          <div className="form-row">
            <label className="form-label">Members</label>
            {members === undefined ? (
              <div className="skeleton-row">
                <div className="shimmer skeleton-bar" style={{ width: "60%", height: 13 }} />
              </div>
            ) : members.members.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-3)" }}>No members yet</div>
            ) : (
              <ul className="ws-member-list">
                {members.members.map((m) => (
                  <li key={m._id} className="ws-member-row">
                    <span className="ws-member-name">
                      {m.name ?? m.email ?? m.userId}
                    </span>
                    <span className="ws-member-role">{m.role}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Invite action. The over-limit path opens the upgrade modal. */}
          <div className="form-row">
            <label className="form-label">Invite member</label>
            <div className="ws-invite-row">
              <input
                className="form-input"
                placeholder="User id to add"
                value={inviteUserId}
                onChange={(e) => setInviteUserId(e.target.value)}
                disabled={busy}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitInvite();
                }}
              />
              <button
                className="btn btn-primary"
                onClick={submitInvite}
                disabled={busy || !inviteUserId.trim()}
              >
                {busy ? "Inviting…" : "Invite"}
              </button>
            </div>
            {error && (
              <div className="account-menu-error" role="alert">
                {error}
              </div>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onClose}>
            Done
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              setUpgradeError(null);
              setShowUpgrade(true);
            }}
          >
            Upgrade plan
          </button>
        </div>
      </div>

      {/* Plan-selection upgrade modal (C27) — shown when an invite exceeds the
          seat limit OR via the explicit "Upgrade plan" button. Presents the paid
          plans from the shared PLAN_CATALOG; choosing one starts checkout for
          that plan and opens the Autumn URL in the system browser. */}
      {showUpgrade && (
        <UpgradeModal
          selectedPlan={selectedPlan}
          billing={billing}
          upgrading={upgrading}
          error={upgradeError}
          onSelectPlan={setSelectedPlan}
          onBilling={setBilling}
          onConfirm={startUpgrade}
          onClose={() => {
            setShowUpgrade(false);
            setUpgradeError(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * The plan-selection upgrade modal (C27/C28). Renders the SHARED {@link PlanGrid}
 * (the same card the onboarding plan step uses — no duplication) with a
 * monthly/annual toggle. Choosing a paid tier + Continue resolves the (tier,
 * billing) → Autumn plan id and starts checkout (the Stripe/Autumn hosted URL
 * opens in the system browser). Free is shown as the "stay local" option but is
 * not a checkout target. Reuses the existing `.overlay` / `.modal` / `.btn`
 * styles and scopes the cards under `.gtm-onboarding` so the shared CSS applies.
 */
function UpgradeModal(props: {
  selectedPlan: SelectablePlan;
  billing: BillingCycle;
  upgrading: boolean;
  error: string | null;
  onSelectPlan: (plan: SelectablePlan) => void;
  onBilling: (billing: BillingCycle) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const {
    selectedPlan,
    billing,
    upgrading,
    error,
    onSelectPlan,
    onBilling,
    onConfirm,
    onClose,
  } = props;
  const isFree = selectedPlan === "free";
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal gtm-onboarding-modal" style={{ width: 900, maxWidth: "94vw" }}>
        <div className="modal-header">
          <span className="modal-title">Choose a plan</span>
          <BillingToggle billing={billing} onChange={onBilling} />
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body gtm-onboarding">
          <p style={{ margin: "0 0 14px", fontSize: 13, color: "var(--text-2)" }}>
            Per-seat, for your whole team. Checkout opens in your browser;
            complete it to unlock cloud sync, multiplayer and more cloud actions.
          </p>
          <PlanGrid
            billing={billing}
            selected={selectedPlan}
            onSelect={onSelectPlan}
          />
          {error && (
            <div className="account-menu-error" role="alert" style={{ marginTop: 12 }}>
              {error}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onClose}>
            Close
          </button>
          <button
            className="btn btn-primary"
            onClick={onConfirm}
            disabled={isFree || upgrading}
            title={isFree ? "Free needs no checkout" : undefined}
          >
            {upgrading
              ? "Opening checkout…"
              : isFree
                ? "Free — no checkout"
                : "Continue to checkout"}
          </button>
        </div>
      </div>
    </div>
  );
}
