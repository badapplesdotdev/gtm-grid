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

  const [inviteUserId, setInviteUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // When set, the upgrade modal is shown with this checkout URL (already opened).
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);

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
        // Over the seat limit: the URL was opened in the system browser; show
        // the upgrade modal too (with a manual open fallback).
        setCheckoutUrl(outcome.checkoutUrl);
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
        </div>
      </div>

      {/* Upgrade modal — shown when an invite exceeds the seat limit. The Autumn
          checkout URL was already opened in the system browser; this offers a
          manual "Open checkout" fallback. Reuses the existing modal patterns. */}
      {checkoutUrl !== null && (
        <UpgradeModal
          checkoutUrl={checkoutUrl}
          onClose={() => setCheckoutUrl(null)}
        />
      )}
    </div>
  );
}

/** The upgrade modal opened when a workspace is over its seat limit. */
function UpgradeModal(props: { checkoutUrl: string; onClose: () => void }) {
  const { checkoutUrl, onClose } = props;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 420 }}>
        <div className="modal-header">
          <span className="modal-title">Upgrade to add more seats</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <p style={{ margin: 0, fontSize: 13, color: "var(--text-2)" }}>
            This workspace is at its seat limit. Checkout opened in your browser —
            complete it to unlock the seat, then invite again.
          </p>
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onClose}>
            Close
          </button>
          <a
            className="btn btn-primary"
            href={checkoutUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open checkout
          </a>
        </div>
      </div>
    </div>
  );
}
