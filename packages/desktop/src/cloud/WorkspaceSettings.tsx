/**
 * Workspace settings — members + seats + invite/upgrade (T10), plain React.
 *
 * Renders the members roster for the active workspace, the seats used/limit
 * badge, an invite-by-EMAIL action, and the list of pending invitations. The
 * invite path is gated on seats by the Convex `invitations.inviteByEmail` action
 * (Autumn, T6): when the workspace is over its limit the action returns an Autumn
 * checkout URL instead of inviting anyone — this component opens that URL in the
 * system browser and shows an upgrade modal (reusing the existing `.overlay` /
 * `.modal` patterns from App.tsx). On success a PENDING invite is created; the
 * pending list (copy accept link / revoke) updates live via `listInvitations`.
 *
 * Following the repo convention, this file is presentation + event wiring only.
 * The invite/upgrade LOGIC (session guard, branch on the action result, open the
 * checkout URL) lives in the Effect service in ./invite.ts and is unit-tested
 * there. The roster + seat usage come from the reactive `listMembers` query, and
 * the pending invites from the reactive `listInvitations` query, so an invite or
 * revoke by any member appears live.
 *
 * Entirely gated on a configured Convex deployment + a signed-in workspace: when
 * either is absent it renders nothing, so the local-only app is untouched.
 */

import { useCallback, useState } from "react";
import { type BillingCycle, resolvePlanId } from "@gtmgrid/cloud";
import { Dialog, DialogContent } from "../components/ui/dialog";
import { PlanGrid, BillingToggle } from "./onboarding/PlanGrid";
import type { SelectablePlan } from "./onboarding/flow-logic";
import type { Id } from "./ids";
import { apiClient, cloudEnabled, queryClient } from "./client";
import { useActiveWorkspace, useAuthState, useMe, useMembers } from "./auth";
import { runInvite, useInviteLayer } from "./invite";
import {
  usePendingInvitations,
  useRevokeInvitation,
} from "./useWorkspaceInvitations";
import { runCheckout, useCheckoutLayer } from "./checkout";

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
  // Auth state via the strangler-branched hook (Better Auth on the NEW path,
  // Convex on the legacy path). Used to guard the billing checkout below.
  const { isAuthenticated } = useAuthState();
  const members = useMembers(workspaceId);

  // The Live invite orchestration Layer, STRANGLER-branched on the cloud path
  // (tRPC `invitations.invite` on the NEW path, the Convex action on the legacy
  // path), composed with the shared system-browser opener. The
  // invited/already_member/checkout branch is identical across transports.
  const inviteLayer = useInviteLayer();

  // Pending invitations (reactive): drives the copy-link / revoke list, and
  // updates when an invite is created or revoked. STRANGLER-branched (tRPC
  // `invitations.list` on the NEW path, the Convex query on the legacy path).
  const pendingInvites = usePendingInvitations(workspaceId);
  const revokeInvitation = useRevokeInvitation(workspaceId);

  // The billing `checkout` orchestration Layer, strangler-branched on the cloud
  // path (tRPC `billing.checkout` on the NEW path, the Convex action on the
  // legacy path), composed with the shared system-browser opener.
  const checkoutLayer = useCheckoutLayer();

  const [inviteEmail, setInviteEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A brief, non-error confirmation under the invite row (e.g. "Invite sent…").
  const [notice, setNotice] = useState<string | null>(null);
  // When true, the plan-selection upgrade modal is shown.
  const [showUpgrade, setShowUpgrade] = useState(false);

  // ── Danger zone: workspace deletion ──────────────────────────────────────
  // The active workspace + the full workspaces list (so we can switch to
  // another one after a successful delete, reusing the same setActiveWorkspaceId
  // the AccountBar switcher uses).
  const me = useMe();
  const { setActiveWorkspaceId } = useActiveWorkspace(me ?? null);
  const [showDelete, setShowDelete] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const submitDelete = useCallback(async () => {
    if (workspaceId === null || deleting) return;
    // Require the workspace name typed exactly to enable the confirm button.
    if (workspaceName !== null && deleteConfirm.trim() !== workspaceName) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiClient.workspaces.deleteWorkspace.mutate({ workspaceId });
      // Invalidate `me` so the workspace list refetches (the deleted workspace
      // disappears). Switch the active workspace to another one (or let the
      // store fall back to null when none remain) before closing the panel.
      const remaining = (me?.workspaces ?? []).filter((w) => w._id !== workspaceId);
      if (remaining.length > 0) setActiveWorkspaceId(remaining[0]._id);
      await queryClient.invalidateQueries({ queryKey: ["workspaces", "me"] });
      // Also drop any workspace-scoped queries (members, invitations) so stale
      // data for the deleted workspace doesn't linger.
      await queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === "workspaces" && query.queryKey[1] !== "me",
      });
      setDeleteConfirm("");
      setShowDelete(false);
      onClose();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Could not delete workspace.");
    } finally {
      setDeleting(false);
    }
  }, [workspaceId, workspaceName, deleting, deleteConfirm, me, setActiveWorkspaceId, onClose]);

  // Seat-cost confirmation: an invite consumes a paid seat, so before sending we
  // preview the new bill (Autumn) and hold the invite until the user approves the
  // new price. Null when no confirmation is pending.
  const [pendingInvite, setPendingInvite] = useState<{
    email: string;
    seats: number;
    total: number;
    currency: string;
  } | null>(null);

  const submitInvite = useCallback(async () => {
    const email = inviteEmail.trim();
    if (!email || busy || workspaceId === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // Show the projected new price first; the actual invite runs on confirm.
      const preview = await apiClient!.billing.previewSeatChange.query({
        workspaceId,
      });
      setPendingInvite({ email, ...preview });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't price this invite.");
    } finally {
      setBusy(false);
    }
  }, [inviteEmail, busy, workspaceId]);

  const confirmInvite = useCallback(async () => {
    if (!pendingInvite || workspaceId === null || busy) return;
    const email = pendingInvite.email;
    setPendingInvite(null);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const outcome = await runInvite(
        isAuthenticated,
        { workspaceId, email, role: "member" },
        inviteLayer,
      );
      if (outcome.status === "checkout") {
        // Over the seat limit: present the plan-selection upgrade modal so the
        // user can choose team / business / unlimited (C27), rather than only
        // opening the default team checkout.
        setShowUpgrade(true);
      } else if (outcome.status === "already_member") {
        // No-op on the backend; tell the user and leave the field as-is.
        setNotice(`${outcome.email} is already a member.`);
      } else {
        // Invited: clear the field; the pending list updates live via the query.
        setInviteEmail("");
        setNotice(
          outcome.emailSent
            ? `Invite sent to ${outcome.email}.`
            : `Invite created for ${outcome.email}. Email isn't configured — copy the accept link from the pending list below.`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invite failed.");
    } finally {
      setBusy(false);
    }
  }, [pendingInvite, busy, workspaceId, isAuthenticated, inviteLayer]);

  // Copy an accept link to the clipboard (best-effort) for the pending list.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyAcceptLink = useCallback(
    async (id: string, acceptUrl: string) => {
      try {
        await navigator.clipboard.writeText(acceptUrl);
        setCopiedId(id);
        // Reset the "Copied" label shortly after.
        window.setTimeout(() => {
          setCopiedId((prev) => (prev === id ? null : prev));
        }, 1500);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not copy the link.");
      }
    },
    [],
  );

  // Revoke a pending invite; the list updates via the query/cache invalidation.
  const revoke = useCallback(
    async (invitationId: string) => {
      setError(null);
      try {
        await revokeInvitation(invitationId);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not revoke the invite.");
      }
    },
    [revokeInvitation],
  );

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
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="modal" srTitle="Workspace members" style={{ width: 520 }}>
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

          {/* Invite by email. The over-limit path opens the upgrade modal. */}
          <div className="form-row">
            <label className="form-label">Invite member</label>
            <div className="ws-invite-row">
              <input
                className="form-input"
                type="email"
                placeholder="teammate@company.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                disabled={busy}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitInvite();
                }}
              />
              <button
                className="btn btn-primary"
                onClick={submitInvite}
                disabled={busy || !inviteEmail.trim()}
              >
                {busy ? "Inviting…" : "Invite"}
              </button>
            </div>
            {notice && (
              <div style={{ fontSize: 12, color: "var(--text-3)", padding: "0 2px" }}>
                {notice}
              </div>
            )}
            {error && (
              <div className="account-menu-error" role="alert">
                {error}
              </div>
            )}
          </div>

          {/* Pending invitations (reactive): copy the accept link or revoke. */}
          <div className="form-row">
            <label className="form-label">Pending invitations</label>
            {pendingInvites === undefined ? (
              <div className="skeleton-row">
                <div className="shimmer skeleton-bar" style={{ width: "60%", height: 13 }} />
              </div>
            ) : pendingInvites.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-3)" }}>
                No pending invitations
              </div>
            ) : (
              <ul className="ws-member-list">
                {pendingInvites.map((inv) => (
                  <li key={inv.id} className="ws-member-row">
                    <span className="ws-member-name">{inv.email}</span>
                    <span className="ws-member-role">{inv.role}</span>
                    <button
                      className="btn btn-outline"
                      onClick={() => void copyAcceptLink(inv.id, inv.acceptUrl)}
                    >
                      {copiedId === inv.id ? "Copied" : "Copy link"}
                    </button>
                    <button
                      className="btn btn-outline"
                      onClick={() => void revoke(inv.id)}
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Danger zone: permanent workspace deletion. Owner-only server-side;
              requires typing the workspace name to enable the confirm button. */}
          <div className="form-row" style={{ borderTop: "1px solid var(--border-2)", paddingTop: 16, marginTop: 8 }}>
            <label className="form-label" style={{ color: "var(--danger)" }}>Danger zone</label>
            <div style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 8, lineHeight: 1.5 }}>
              Permanently delete this workspace and all of its projects, tables,
              credentials, and share links. This cancels the billing subscription
              and cannot be undone.
            </div>
            <button
              className="btn btn-danger"
              onClick={() => { setDeleteError(null); setShowDelete(true); }}
              disabled={deleting}
            >
              Delete workspace…
            </button>
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

      {showDelete && (
        <Dialog open onOpenChange={(o) => { if (!o) { setShowDelete(false); setDeleteConfirm(""); setDeleteError(null); } }}>
          <DialogContent className="modal" srTitle="Delete workspace" style={{ width: 440 }}>
            <div className="modal-header">
              <span className="modal-title">Delete workspace</span>
              <button className="modal-close" onClick={() => { setShowDelete(false); setDeleteConfirm(""); setDeleteError(null); }} aria-label="Close">×</button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.5, margin: "0 0 12px" }}>
                This permanently deletes <strong style={{ color: "var(--text)" }}>{workspaceName ?? "this workspace"}</strong> and
                all of its projects, tables, credentials, and share links. The billing
                subscription is cancelled immediately. This can&apos;t be undone.
              </p>
              <p style={{ fontSize: 13, color: "var(--text-2)", margin: "0 0 8px" }}>
                Type the workspace name to confirm:
              </p>
              <input
                className="form-input"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                placeholder={workspaceName ?? "workspace name"}
                autoFocus
                disabled={deleting}
                onKeyDown={(e) => { if (e.key === "Enter") void submitDelete(); }}
              />
              {deleteError && (
                <div className="account-menu-error" role="alert" style={{ marginTop: 8 }}>
                  {deleteError}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => { setShowDelete(false); setDeleteConfirm(""); setDeleteError(null); }} disabled={deleting}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={() => void submitDelete()}
                disabled={deleting || (workspaceName !== null && deleteConfirm.trim() !== workspaceName)}
              >
                {deleting ? "Deleting…" : "Delete workspace"}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}

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

      {pendingInvite && (
        <Dialog open onOpenChange={(o) => { if (!o) setPendingInvite(null); }}>
          <DialogContent className="modal" srTitle="Add a seat?" style={{ width: 420 }}>
            <div className="modal-header">
              <h3>Add a seat?</h3>
            </div>
            <div className="modal-body">
              <p style={{ margin: "0 0 12px", lineHeight: 1.55 }}>
                Inviting <strong>{pendingInvite.email}</strong> adds a seat to{" "}
                <strong>{workspaceName ?? "this workspace"}</strong>. Your
                subscription becomes:
              </p>
              <div className="seat-price">
                <span className="seat-price__amount">
                  {formatPrice(pendingInvite.total, pendingInvite.currency)}
                </span>
                <span className="seat-price__unit">
                  /mo · {pendingInvite.seats} seat
                  {pendingInvite.seats === 1 ? "" : "s"}
                </span>
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-ghost"
                onClick={() => setPendingInvite(null)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="btn btn--primary"
                onClick={() => void confirmInvite()}
                disabled={busy}
              >
                Confirm &amp; invite
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </DialogContent>
    </Dialog>
  );
}

/** Format a recurring price like `$60` / `€60` from an amount + ISO currency. */
function formatPrice(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
      maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount} ${currency.toUpperCase()}`;
  }
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
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="modal gtm-onboarding-modal" srTitle="Choose a plan" style={{ width: 900, maxWidth: "94vw" }}>
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
      </DialogContent>
    </Dialog>
  );
}
