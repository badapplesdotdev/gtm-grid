/**
 * Invite-accept landing page — `/invite/<token>`.
 *
 * Where invited users land when they click the accept link in their invite email.
 * That link is minted server-side by `acceptUrlFor()` in convex/invitations.ts as
 * `${SITE_URL}/invite/<token>`.
 *
 * The web app has no Convex client (we don't ship the `convex` npm package here),
 * so this server component previews the invitation over Convex's HTTP query API:
 *
 *   POST ${CONVEX_URL}/api/query
 *   { "path": "invitations:getInvitationByToken", "args": { "token": "<token>" },
 *     "format": "json" }
 *
 * The PUBLIC query `invitations:getInvitationByToken` returns either
 *   { valid: false }
 * or
 *   { valid: true, workspaceName, email, role, invitedByName }.
 *
 * Acceptance itself happens in the desktop app (it owns auth + the membership
 * mutation), so this page is a hand-off: a primary deep link into the app
 * (`gtmgrid://invite/<token>`) plus a copyable code fallback. We render three
 * states — valid, invalid/expired, and a graceful "couldn't load" state when the
 * backend is unreachable or CONVEX_URL is unset (we still surface the deep link
 * and code so the flow isn't a dead end).
 *
 * Next 15: `params` is a Promise and must be awaited.
 */

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

/** Shape of a successful `getInvitationByToken` preview. */
type ValidInvitation = {
  valid: true;
  workspaceName: string;
  email: string;
  role: "owner" | "admin" | "member";
  invitedByName: string | null;
};

/** Either the invite is valid, or it isn't (expired/revoked/unknown token). */
type InvitationPreview = ValidInvitation | { valid: false };

/**
 * Outcome of the server-side preview fetch:
 *  - `ok`        → we have a definitive preview from the backend
 *  - `unavailable` → CONVEX_URL missing or the request failed; degrade gracefully
 */
type PreviewResult =
  | { kind: "ok"; preview: InvitationPreview }
  | { kind: "unavailable" };

/** Fetch the invitation preview via the Convex HTTP query API. */
async function fetchInvitation(token: string): Promise<PreviewResult> {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) return { kind: "unavailable" };

  try {
    const res = await fetch(`${convexUrl.replace(/\/$/, "")}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "invitations:getInvitationByToken",
        args: { token },
        format: "json",
      }),
      cache: "no-store",
    });
    if (!res.ok) return { kind: "unavailable" };

    const body = (await res.json()) as {
      status?: string;
      value?: InvitationPreview;
    };
    if (body.status !== "success" || body.value === undefined) {
      return { kind: "unavailable" };
    }
    return { kind: "ok", preview: body.value };
  } catch {
    return { kind: "unavailable" };
  }
}

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
  const result = await fetchInvitation(token);

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
