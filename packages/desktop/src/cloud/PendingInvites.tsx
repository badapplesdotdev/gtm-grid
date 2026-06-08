/**
 * Pending-invitation banner — the in-app ACCEPT surface for workspace invites.
 *
 * An owner/admin invites by email (convex/invitations.ts `inviteByEmail`), which
 * creates a pending invite + emails an accept link. This banner is how the
 * invitee accepts WITHOUT any deep-link plumbing: once signed in with the
 * invited email, `myPendingInvitations` (matched on their email) surfaces every
 * waiting invite here with an Accept button. It also auto-accepts an invite
 * token passed via the URL (`?invite=<token>` or `#invite=<token>`) — the path a
 * web landing page / email link uses — so the same component covers both.
 *
 * Renders nothing when cloud is off, the user is signed out, or there is nothing
 * to accept, so the local-first / signed-out app is completely unaffected.
 */

import { useCallback, useEffect, useState } from "react";
import type { Id } from "./ids";
import { cloudEnabled } from "./client";
import {
  clearPendingInviteToken,
  getPendingInviteToken,
} from "./pendingInvite";
import {
  useAcceptInvitation,
  useMyPendingInvitations,
} from "./useWorkspaceInvitations";

interface PendingInvitesProps {
  /** Called with the joined workspace id + name after a successful accept. */
  onAccepted: (
    workspaceId: Id<"workspaces">,
    workspaceName: string | null,
  ) => void;
}

/**
 * The accept banner. Lists email-matched pending invites and auto-accepts a URL
 * token. Self-gates on cloud being enabled + the user being signed in (the query
 * is `skip`ped otherwise), so it issues zero Convex calls in the local app.
 */
export function PendingInvites({ onAccepted }: PendingInvitesProps) {
  // Reactive waiting-invites read + accept, STRANGLER-branched on the cloud path
  // (tRPC `invitations.myPending`/`accept` on the NEW path, the Convex
  // query/action on the legacy path). Both normalize to one UI shape.
  const invites = useMyPendingInvitations();
  const acceptInvite = useAcceptInvitation();

  const [busyToken, setBusyToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Invites the user dismissed this session (hidden without accepting).
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  // A token captured from a `gtmgrid://invite/<token>` deep link or `?invite=`
  // URL (see pendingInvite.ts). Read once via lazy init — no mount effect needed
  // — and auto-accepted once the user is authenticated; cleared on success, not
  // on read, so a failed/abandoned accept can be retried.
  const [urlToken] = useState<string | null>(getPendingInviteToken);
  const [urlTokenHandled, setUrlTokenHandled] = useState(false);

  const accept = useCallback(
    async (token: string) => {
      if (busyToken !== null) return;
      setBusyToken(token);
      setError(null);
      try {
        const res = await acceptInvite(token);
        if (res.status === "accepted") {
          clearPendingInviteToken();
          const name =
            (invites ?? []).find((i) => i.token === token)?.workspaceName ??
            null;
          onAccepted(res.workspaceId as Id<"workspaces">, name);
        } else if (res.status === "wrong_account") {
          setError(
            `This invite was sent to ${res.invitedEmail}. Sign in with that email to accept it.`,
          );
        } else if (res.status === "seat_limit") {
          setError(
            "This workspace is at its seat limit. Ask an admin to upgrade, then try again.",
          );
        } else {
          setError("This invitation is no longer valid or has expired.");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not accept the invite.");
      } finally {
        setBusyToken(null);
      }
    },
    [busyToken, acceptInvite, onAccepted, invites],
  );

  // Auto-accept a URL-supplied token once (after the user is authenticated, i.e.
  // the query has resolved to an array rather than `undefined`).
  useEffect(() => {
    if (urlToken === null || urlTokenHandled || invites === undefined) return;
    setUrlTokenHandled(true);
    void accept(urlToken);
  }, [urlToken, urlTokenHandled, invites, accept]);

  if (!cloudEnabled) return null;
  const visible = (invites ?? []).filter((i) => !dismissed.has(i.token));
  if (visible.length === 0 && error === null) return null;

  return (
    <div className="pending-invites">
      {error && (
        <div className="pending-invite-row" role="alert">
          <span className="pending-invite-text">{error}</span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setError(null)}
          >
            Dismiss
          </button>
        </div>
      )}
      {visible.map((inv) => (
        <div className="pending-invite-row" key={inv.id}>
          <span className="pending-invite-text">
            {inv.invitedByName ? `${inv.invitedByName} invited you` : "You've been invited"}{" "}
            to join <strong>{inv.workspaceName}</strong>
            {inv.role !== "member" ? ` as ${inv.role}` : ""}.
          </span>
          <button
            className="btn btn-primary btn-sm"
            disabled={busyToken !== null}
            onClick={() => void accept(inv.token)}
          >
            {busyToken === inv.token ? "Joining…" : "Accept"}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={busyToken !== null}
            onClick={() =>
              setDismissed((prev) => new Set(prev).add(inv.token))
            }
          >
            Later
          </button>
        </div>
      ))}
    </div>
  );
}
