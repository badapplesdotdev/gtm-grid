/**
 * Invite-accept landing page — `/invite/<token>`.
 *
 * Where invited users land when they click the accept link in their invite email.
 * That link is minted server-side as `${SITE_URL}/invite/<token>`.
 *
 * The PUBLIC `getInvitationByToken` preview returns either
 *   { valid: false }
 * or
 *   { valid: true, workspaceName, email, role, invitedByName }.
 *
 * Acceptance itself happens in the desktop app (it owns auth + the membership
 * mutation), so this page is a hand-off: a primary deep link into the app
 * (`gtmgrid://invite/<token>`) plus a copyable code fallback. We render three
 * states — valid, invalid/expired, and a graceful "couldn't load" state when the
 * backend is unreachable (we still surface the deep link and code so the flow
 * isn't a dead end).
 *
 * Data source (TRI-3256): this previews the invitation via
 * `loadInvitationPreview` (`apps/web/lib/invite-preview.ts`), which runs the
 * PUBLIC `InvitationService.getInvitationByToken` Effect directly in-process
 * against the live `appLayer` (Drizzle over `@gtmgrid/db`), with `userId: null` —
 * the token IS the capability, so no auth is required. That is the same Effect
 * the public tRPC `invitations.getByToken` procedure runs; calling the service
 * avoids a needless HTTP hop from the server component back into our own API.
 *
 * Next 15: `params` is a Promise and must be awaited.
 */

import type { InvitationPreview } from "@gtmgrid/services";
import { loadInvitationPreview } from "../../../lib/invite-preview";
import { CopyCode } from "./CopyCode";

/** Brand wordmark — mirrors the marketing header (app/page.tsx). */
function Wordmark() {
  return (
    <span className="wordmark">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="wordmark__mark" src="/brand/icon.png" alt="" width={16} height={16} aria-hidden="true" />
      GTM Grid
    </span>
  );
}

/** The successful branch of the public {@link InvitationPreview}. */
type ValidInvitation = Extract<InvitationPreview, { valid: true }>;

/** Human-readable role label for the invited member. */
function roleLabel(role: ValidInvitation["role"]): string {
  if (role === "owner") return "owner";
  if (role === "admin") return "admin";
  return "member";
}

/** The deep-link / code hand-off shared by every non-fatal state. */
function HandOff({ token }: { token: string }) {
  return (
    <>
      <a className="btn btn--primary invite-card__cta" href={`gtmgrid://invite/${token}`}>
        Open in GTM Grid
      </a>

      <div className="invite-fallback">
        <p className="invite-fallback__lead">
          Don&apos;t have the app open? Open GTM Grid, go to the invite prompt,
          and paste this code.
        </p>
        <CopyCode code={token} />
      </div>
    </>
  );
}

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await loadInvitationPreview(token);

  const preview = result.kind === "ok" ? result.preview : null;
  const valid = preview?.valid === true ? preview : null;

  return (
    <div className="invite-page">
      <header className="site-header">
        <div className="container site-header__inner">
          <Wordmark />
        </div>
      </header>

      <main className="invite-main">
        <div className="invite-card">
          {valid ? (
            <>
              <span className="eyebrow">workspace invitation</span>
              <h1 className="invite-card__title">
                Join {valid.workspaceName} on{" "}
                <span className="accent">GTM Grid</span>
              </h1>
              <p className="invite-card__who">
                {valid.invitedByName
                  ? `${valid.invitedByName} invited you`
                  : "You've been invited"}{" "}
                as <span className="invite-card__role">{roleLabel(valid.role)}</span>.
              </p>
              <p className="invite-card__email">
                Invitation sent to <code>{valid.email}</code>
              </p>

              <HandOff token={token} />

              <p className="invite-card__note">
                You must sign in with <code>{valid.email}</code> to accept this
                invitation.
              </p>
            </>
          ) : result.kind === "unavailable" ? (
            <>
              <span className="eyebrow">workspace invitation</span>
              <h1 className="invite-card__title">
                You&apos;ve been invited to <span className="accent">GTM Grid</span>
              </h1>
              <p className="invite-card__who">
                We couldn&apos;t load the invitation details right now — but your
                link still works.
              </p>

              <HandOff token={token} />

              <p className="invite-card__note">
                Sign in with the email this invite was sent to in order to accept.
              </p>
            </>
          ) : (
            <>
              <span className="eyebrow">workspace invitation</span>
              <h1 className="invite-card__title">Invitation unavailable</h1>
              <p className="invite-card__who">
                This invitation is no longer valid or has expired.
              </p>
              <p className="invite-card__note">
                Ask whoever invited you to send a fresh invite, then open the new
                link.
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
