/**
 * Transactional email (Resend) — the single outbound-email seam for the cloud
 * backend, with the branded templates from the Claude Design "Email Series"
 * handoff (gtm-grid/project/emails/*).
 *
 * Ported from convex/email.ts for the Postgres/Better Auth cloud tier (TRI-3244):
 * the Resend-talking code is identical; only the brand-icon import path changed
 * (./assets.js). Better Auth's email-OTP + reset hooks call {@link sendEmail}
 * with {@link verificationEmail} / {@link passwordResetEmail}; the workspace
 * invite + welcome builders stay here too so there is ONE outbound-email seam.
 *
 * Flows that send mail: account email VERIFICATION + PASSWORD RESET (Better
 * Auth's email-OTP plugin via packages/auth/src/server.ts) and workspace
 * INVITES. They all funnel through {@link sendEmail} so there is one place that
 * talks to Resend and one set of templates.
 *
 * DESIGN: table-based, email-client-safe HTML — a dark header bar with the real
 * BRAND ICON (inline, see {@link BRAND_ATTACHMENTS}) + wordmark + an uppercase
 * section tag, a white 600px body card, the official brand GREEN palette (CTA
 * `color-700` #136D34 / hover `color-800` #0B411F, per the GTM Grid brand pack
 * DESIGN.md by Anymark), a dark monospace OTP block (JetBrains Mono), and a footer
 * with the brand mark + tagline.
 *
 * ADAPTATION: the design's verify/reset emails assume a magic-LINK; our flows
 * are OTP-CODE based (the user types the code in the app), so those two lead with
 * the design's dark code block instead of a link button. Invites keep a real
 * accept-link CTA. The Resend SDK is isomorphic (fetch), so this module runs in
 * Convex's DEFAULT runtime — no `"use node"`.
 *
 * GATING: email is OPT-IN. With `AUTH_RESEND_KEY` unset, {@link sendEmail} no-ops
 * (logs a warning) so sign-up still works (no verification) and invites still
 * create a pending row whose link the UI surfaces as a copyable fallback.
 */

import { Resend as ResendAPI } from "resend";
import { ICON_COLOR_B64, ICON_WHITE_B64 } from "./assets.js";

/** Product name used in subjects + template chrome. */
const APP_NAME = "GTM Grid";

/**
 * The single brand accent for emails — brand GREEN, per the Anymark brand kit
 * (/DESIGN.md). CTA buttons use white text on the accent, so ACCENT resolves to
 * `color-700` (#136D34), the brand's `button-primary` background, which clears
 * WCAG AA against white; hover deepens to `color-800` (#0B411F).
 */
const ACCENT = "#136D34";
/** Hover/darker accent for the CTA (brand color-800). */
const ACCENT_HOVER = "#0B411F";
/** Accent ink used on light tints (brand color-700). */
const ACCENT_INK = "#136D34";

// Neutral palette (design tokens).
const INK = "#111118";
const INK_2 = "#5a5a6e";
const INK_3 = "#9696a8";
const BORDER = "#e4e4ea";
const HAIRLINE = "#f3f3f7";
const HEADER_BG = "#0d0d0f";
const PAGE_BG = "#e8eaf1";

const SANS =
  "'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'JetBrains Mono','SF Mono',Menlo,Consolas,monospace";

/** CID ids for the inline brand icons (referenced as `cid:<id>` in the HTML). */
const CID_ICON_WHITE = "gg-icon-white";
const CID_ICON_COLOR = "gg-icon-color";

/**
 * The real GTM Grid brand icon, attached INLINE (CID) to every email so the mark
 * renders with NO external hosting. Remote `<img src="https://…">` images need a
 * public host and are blocked-by-default in many clients (they broke earlier
 * because gtmgrid.dev wasn't serving them); a CID attachment travels WITH the
 * message. White icon for the dark header, brand-color icon for the light footer.
 * Bytes come from the brand pack via convex/emailAssets.ts.
 */
const BRAND_ATTACHMENTS = [
  {
    filename: "gtm-grid-icon.png",
    content: ICON_WHITE_B64,
    inlineContentId: CID_ICON_WHITE,
  },
  {
    filename: "gtm-grid-icon-color.png",
    content: ICON_COLOR_B64,
    inlineContentId: CID_ICON_COLOR,
  },
];

/** An inline brand-icon `<img>` referencing one of the CID attachments. */
function brandIcon(cid: string, size: number): string {
  return `<img src="cid:${cid}" width="${size}" height="${size}" alt="" style="display:inline-block;vertical-align:middle;border:0;" />`;
}

/**
 * The verified sending identity. Defaults to Resend's shared onboarding sender
 * so the flow works the moment a key is set, before a custom domain is verified.
 * Override with `RESEND_FROM` (e.g. `"GTM Grid <no-reply@gtmgrid.dev>"`).
 */
function fromAddress(): string {
  return process.env.RESEND_FROM ?? "GTM Grid <onboarding@resend.dev>";
}

/**
 * Whether real email sending is configured on this deployment. Derived purely
 * from `AUTH_RESEND_KEY` presence — exposed so callers (and the public
 * `enabledProviders` query) can branch UI on whether email will be delivered.
 */
export function emailEnabled(): boolean {
  return Boolean(process.env.AUTH_RESEND_KEY);
}

/** A fully-rendered message ready to hand to Resend. */
export interface OutboundEmail {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /**
   * Extra SMTP headers (e.g. `List-Unsubscribe` +
   * `List-Unsubscribe-Post: List-Unsubscribe=One-Click` on lifecycle sends so
   * inbox providers surface their native unsubscribe affordance).
   */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Resend `Idempotency-Key`. Closes the delivered-but-errored ambiguity
   * window: if our call times out AFTER Resend actually sent, the lifecycle
   * guard releases its claim and the retry re-sends — with the same key Resend
   * recognises the repeat and does NOT deliver twice. Lifecycle sends pass
   * `user:template:dedupeKey`; transactional callers may omit it.
   */
  readonly idempotencyKey?: string;
}

/**
 * Send one transactional email via Resend. No-ops (logs a warning) when
 * `AUTH_RESEND_KEY` is unset; throws on a real Resend API error so the caller
 * (e.g. the invite action) can surface it.
 */
export async function sendEmail(email: OutboundEmail): Promise<void> {
  const key = process.env.AUTH_RESEND_KEY;
  if (!key) {
    console.warn(
      `[email] AUTH_RESEND_KEY not set — skipping "${email.subject}" to ${email.to}`,
    );
    return;
  }
  const resend = new ResendAPI(key);
  const { error } = await resend.emails.send(
    {
      from: fromAddress(),
      to: [email.to],
      subject: email.subject,
      html: email.html,
      text: email.text,
      headers: email.headers ? { ...email.headers } : undefined,
      // The brand icon ships inline (CID) so it renders with no external hosting.
      attachments: BRAND_ATTACHMENTS,
    },
    email.idempotencyKey ? { idempotencyKey: email.idempotencyKey } : undefined,
  );
  if (error) {
    throw new Error(`Resend failed to send "${email.subject}": ${error.message}`);
  }
}

// ─── Template primitives (table-based, email-safe) ───────────────────────────

/** Minimal HTML-escape for interpolated user-controlled strings. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A `.px` body row: white card cell with side borders + standard padding. */
function bodyRow(inner: string, padding = "38px 36px 8px"): string {
  return `<tr><td class="px" style="background:#ffffff;border-left:1px solid ${BORDER};border-right:1px solid ${BORDER};padding:${padding};">${inner}</td></tr>`;
}

/** The green CTA button (design: green pill, white label, soft shadow). */
function ctaButton(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td bgcolor="${ACCENT}" style="border-radius:6px;box-shadow:0 1px 3px rgba(31,157,87,0.35);">
      <a class="btn" href="${href}" style="display:inline-block;padding:12px 24px;font-family:${SANS};font-size:14px;font-weight:600;color:#ffffff;border-radius:6px;">${escapeHtml(label)}</a>
    </td></tr></table>`;
}

/** The dark monospace OTP block (design: #0d0d0f, JetBrains Mono, wide tracking). */
function codeBlock(code: string): string {
  // Group the digits in threes for readability, mirroring the design ("418 902").
  const spaced = code.replace(/(\d{3})(?=\d)/g, "$1 ");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="background:${HEADER_BG};border-radius:8px;"><tr>
    <td style="padding:16px 26px;font-family:${MONO};font-size:30px;font-weight:600;letter-spacing:0.22em;color:#ffffff;">${spaced}</td>
  </tr></table>`;
}

/**
 * Wrap body rows in the shared shell: hidden preheader, dark header bar (wordmark
 * + uppercase tag), the body rows, and the branded footer. `footerNote` is the
 * optional muted "sent to …" line.
 */
function shell(opts: {
  title: string;
  preheader: string;
  tag: string;
  bodyRows: string;
  footerNote?: string;
}): string {
  const { title, preheader, tag, bodyRows, footerNote } = opts;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light" />
<title>${escapeHtml(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
  body { margin:0; padding:0; background:${PAGE_BG}; -webkit-font-smoothing:antialiased; }
  a { text-decoration:none; }
  .btn:hover { background:${ACCENT_HOVER} !important; }
  .lnk:hover { color:${ACCENT_HOVER} !important; }
  @media (max-width:620px){
    .container { width:100% !important; }
    .px { padding-left:24px !important; padding-right:24px !important; }
  }
</style>
</head>
<body>
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${PAGE_BG};">${escapeHtml(preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE_BG};">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">

      <!-- header -->
      <tr>
        <td style="background:${HEADER_BG};border-radius:12px 12px 0 0;padding:18px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td align="left" style="vertical-align:middle;">
              ${brandIcon(CID_ICON_WHITE, 26)}
              <span style="display:inline-block;vertical-align:middle;margin-left:8px;font-family:${SANS};font-size:16px;font-weight:700;letter-spacing:-0.02em;color:#ffffff;">${APP_NAME}</span>
            </td>
            <td align="right" style="vertical-align:middle;font-family:${SANS};font-size:10.5px;font-weight:600;letter-spacing:0.12em;color:#6f6f82;text-transform:uppercase;">${escapeHtml(tag)}</td>
          </tr></table>
        </td>
      </tr>

      ${bodyRows}

      <!-- footer -->
      <tr>
        <td style="background:#ffffff;border:1px solid ${BORDER};border-top:none;border-radius:0 0 12px 12px;padding:24px 36px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="padding-bottom:12px;border-bottom:1px solid ${HAIRLINE};">
              ${brandIcon(CID_ICON_COLOR, 20)}
              <span style="display:inline-block;vertical-align:middle;margin-left:8px;font-family:${SANS};font-size:13px;font-weight:700;letter-spacing:-0.02em;color:${INK_2};">${APP_NAME}</span>
            </td></tr>
            <tr><td style="padding-top:14px;font-family:${SANS};font-size:11.5px;line-height:1.6;color:${INK_3};">
              a local-first, programmable spreadsheet for go-to-market teams.<br />
              <a class="lnk" href="https://gtmgrid.dev/help" style="color:${INK_2};font-weight:500;">Help</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a class="lnk" href="https://gtmgrid.dev/docs" style="color:${INK_2};font-weight:500;">Docs</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a class="lnk" href="https://gtmgrid.dev/account" style="color:${INK_2};font-weight:500;">Account settings</a>
              ${footerNote ? `<div style="margin-top:10px;color:#b6b6c4;">${escapeHtml(footerNote)}</div>` : ""}
            </td></tr>
          </table>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ─── Templates ───────────────────────────────────────────────────────────────

/** Email-verification OTP sent on sign-up (code-based; "Verify" tag). */
export function verificationEmail(to: string, code: string): OutboundEmail {
  const bodyRows =
    bodyRow(
      `<h1 style="margin:0 0 14px;font-family:${SANS};font-size:25px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:${INK};">confirm your email</h1>
       <p style="margin:0;font-family:${SANS};font-size:15px;line-height:1.6;color:${INK_2};">one more step to finish setting up your ${APP_NAME} account. enter this code to confirm <strong style="color:${INK};font-weight:600;">${escapeHtml(to)}</strong> and start building grids.</p>`,
      "38px 36px 8px",
    ) +
    bodyRow(
      `<p style="margin:0 0 10px;font-family:${SANS};font-size:12.5px;line-height:1.5;color:${INK_3};">enter this code in the app:</p>
       ${codeBlock(code)}
       <p style="margin:12px 0 0;font-family:${MONO};font-size:11.5px;color:${INK_3};">code expires in 15 minutes</p>`,
      "22px 36px 6px",
    ) +
    bodyRow(
      `<p style="margin:0;font-family:${SANS};font-size:12.5px;line-height:1.55;color:${INK_3};">didn't create a ${APP_NAME} account? you can safely ignore this email.</p>`,
      "22px 36px 34px",
    );
  return {
    to,
    subject: `confirm your email — ${APP_NAME}`,
    html: shell({
      title: `confirm your email — ${APP_NAME}`,
      preheader: `confirm your email to finish setting up ${APP_NAME}. code ${code}.`,
      tag: "Verify",
      bodyRows,
    }),
    text: `Your ${APP_NAME} verification code is ${code}. It expires in 15 minutes. Didn't create an account? Ignore this email.`,
  };
}

/** Password-reset OTP sent on "forgot password" (code-based; "Security" tag). */
export function passwordResetEmail(to: string, code: string): OutboundEmail {
  const bodyRows =
    bodyRow(
      `<h1 style="margin:0 0 14px;font-family:${SANS};font-size:25px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:${INK};">reset your password</h1>
       <p style="margin:0;font-family:${SANS};font-size:15px;line-height:1.6;color:${INK_2};">we got a request to reset the password for your ${APP_NAME} account. enter this code in the app to choose a new one — it expires in <strong style="color:${INK};font-weight:600;">15 minutes</strong>.</p>`,
      "38px 36px 8px",
    ) +
    bodyRow(
      `<p style="margin:0 0 10px;font-family:${SANS};font-size:12.5px;line-height:1.5;color:${INK_3};">your reset code:</p>
       ${codeBlock(code)}`,
      "18px 36px 6px",
    ) +
    bodyRow(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8f8fa;border:1px solid ${BORDER};border-radius:8px;"><tr>
         <td style="padding:14px 16px;font-family:${SANS};font-size:12.5px;line-height:1.55;color:${INK_2};">
           <strong style="color:${INK};font-weight:600;">didn't request this?</strong> you can safely ignore this email — your password won't change until you enter the code above.
         </td></tr></table>`,
      "18px 36px 34px",
    );
  return {
    to,
    subject: `reset your password — ${APP_NAME}`,
    html: shell({
      title: `reset your password — ${APP_NAME}`,
      preheader: `reset your ${APP_NAME} password — this code expires in 15 minutes.`,
      tag: "Security",
      bodyRows,
      footerNote: `sent to ${to} because a reset was requested for your account.`,
    }),
    text: `Your ${APP_NAME} password reset code is ${code}. It expires in 15 minutes. Didn't request it? Ignore this email.`,
  };
}

/** Initials for the inviter avatar chip (max 2 letters). */
function initials(name: string | null, email: string): string {
  const src = (name ?? email).trim();
  const parts = src.split(/\s+/).filter(Boolean);
  const letters =
    parts.length >= 2
      ? parts[0][0] + parts[1][0]
      : src.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2);
  return (letters || "?").toUpperCase();
}

/** Workspace invite with an accept-link CTA + inviter chip ("Workspace" tag). */
export function inviteEmail(opts: {
  to: string;
  workspaceName: string;
  inviterName: string | null;
  inviterEmail?: string | null;
  acceptUrl: string;
}): OutboundEmail {
  const ws = escapeHtml(opts.workspaceName);
  const inviter = opts.inviterName ? escapeHtml(opts.inviterName) : "A teammate";
  const inviterEmail = opts.inviterEmail ?? null;
  const avatar = initials(opts.inviterName, inviterEmail ?? opts.to);

  const inviterRow = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:18px;"><tr>
      <td style="vertical-align:middle;">
        <div style="width:38px;height:38px;border-radius:50%;background:${ACCENT};text-align:center;font-family:${SANS};font-size:14px;font-weight:600;color:#ffffff;line-height:38px;">${escapeHtml(avatar)}</div>
      </td>
      <td style="vertical-align:middle;padding-left:12px;font-family:${SANS};">
        <div style="font-size:14px;font-weight:600;color:${INK};line-height:1.3;">${inviter}</div>
        ${inviterEmail ? `<div style="font-size:12.5px;color:${INK_3};line-height:1.3;">${escapeHtml(inviterEmail)}</div>` : ""}
      </td>
    </tr></table>`;

  const bodyRows =
    bodyRow(
      `<h1 style="margin:0 0 16px;font-family:${SANS};font-size:25px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:${INK};">you're invited to ${ws}</h1>
       ${inviterRow}
       <p style="margin:0;font-family:${SANS};font-size:15px;line-height:1.6;color:${INK_2};">${inviter} invited you to collaborate on the <strong style="color:${INK};font-weight:600;">${ws}</strong> workspace — build tables, point columns at connectors, and run enrichment together.</p>`,
      "38px 36px 6px",
    ) +
    bodyRow(
      `${ctaButton(opts.acceptUrl, "accept invite")}
       <p style="margin:14px 0 0;font-family:${MONO};font-size:11.5px;color:${INK_3};">invite expires in 7 days</p>`,
      "22px 36px 6px",
    ) +
    bodyRow(
      `<p style="margin:0 0 8px;font-family:${SANS};font-size:12.5px;line-height:1.5;color:${INK_3};">or paste this link into your browser:</p>
       <div style="font-family:${MONO};font-size:12px;line-height:1.5;color:${ACCENT_INK};background:${HAIRLINE};border:1px solid ${BORDER};border-radius:6px;padding:10px 12px;word-break:break-all;">${escapeHtml(opts.acceptUrl)}</div>`,
      "8px 36px 34px",
    );

  return {
    to: opts.to,
    subject: `${opts.inviterName ? `${opts.inviterName} invited you` : "You're invited"} to ${opts.workspaceName} on ${APP_NAME}`,
    html: shell({
      title: `you're invited — ${APP_NAME}`,
      preheader: `${inviter} invited you to the ${opts.workspaceName} workspace on ${APP_NAME}.`,
      tag: "Workspace",
      bodyRows,
      footerNote: `this invite was sent to ${opts.to}. if you weren't expecting it, you can ignore it.`,
    }),
    text: `${inviter} invited you to join ${opts.workspaceName} on ${APP_NAME}. Accept here: ${opts.acceptUrl} (expires in 7 days).`,
  };
}

/**
 * Trial-ending reminder. Sent by the scheduled trial-reminder job at the "soon"
 * (a few days left) and "last day" milestones so the owner adds a card before the
 * cloud tier locks. The CTA opens the app, where the upgrade/checkout lives.
 */
export function trialEndingEmail(opts: {
  to: string;
  workspaceName: string;
  daysLeft: number;
  appUrl: string;
}): OutboundEmail {
  const ws = escapeHtml(opts.workspaceName);
  const when =
    opts.daysLeft <= 0
      ? "today"
      : opts.daysLeft === 1
        ? "tomorrow"
        : `in ${opts.daysLeft} days`;
  const headline =
    opts.daysLeft <= 0
      ? `Your ${APP_NAME} trial ends today`
      : `Your ${APP_NAME} trial ends ${when}`;
  const bodyRows =
    bodyRow(
      `<h1 style="margin:0 0 16px;font-family:${SANS};font-size:25px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:${INK};">${headline}</h1>
       <p style="margin:0;font-family:${SANS};font-size:15px;line-height:1.6;color:${INK_2};">The <strong style="color:${INK};font-weight:600;">${ws}</strong> workspace's free trial ends ${when}. Add a card to keep cloud sync, realtime multiplayer and shared credentials. Your data stays safe either way — local tables keep working free.</p>`,
      "38px 36px 6px",
    ) +
    bodyRow(
      `${ctaButton(opts.appUrl, "upgrade to keep cloud")}`,
      "22px 36px 34px",
    );
  return {
    to: opts.to,
    subject:
      opts.daysLeft <= 0
        ? `Your ${opts.workspaceName} trial ends today`
        : `Your ${opts.workspaceName} trial ends ${when}`,
    html: shell({
      title: `trial ending — ${APP_NAME}`,
      preheader: `The ${opts.workspaceName} workspace trial ends ${when} — upgrade to keep cloud features.`,
      tag: "Billing",
      bodyRows,
      footerNote: `this reminder was sent to ${opts.to}. local features always stay free.`,
    }),
    text: `Your ${opts.workspaceName} trial on ${APP_NAME} ends ${when}. Upgrade to keep cloud features: ${opts.appUrl}`,
  };
}

/**
 * Trial-STARTED welcome. Sent once when a brand-new workspace's free Team trial
 * begins (on workspace creation), so the owner knows the cloud tier is unlocked
 * and for how long. Same branded shell as the other emails; "Trial" tag. The CTA
 * opens the app.
 */
export function trialWelcomeEmail(opts: {
  to: string;
  workspaceName: string;
  appUrl: string;
  trialDays?: number;
}): OutboundEmail {
  const ws = escapeHtml(opts.workspaceName);
  const days = opts.trialDays ?? 7;
  const bodyRows =
    bodyRow(
      `<h1 style="margin:0 0 16px;font-family:${SANS};font-size:25px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:${INK};">your free trial is live</h1>
       <p style="margin:0;font-family:${SANS};font-size:15px;line-height:1.6;color:${INK_2};">The <strong style="color:${INK};font-weight:600;">${ws}</strong> workspace is on a <strong style="color:${INK};font-weight:600;">${days}-day Team trial</strong> — cloud tables, realtime multiplayer and shared credentials are unlocked. No card needed to start; add one any time to keep them after the trial. Local tables are always free.</p>`,
      "38px 36px 6px",
    ) +
    bodyRow(
      `${ctaButton(opts.appUrl, "open GTM Grid")}`,
      "22px 36px 34px",
    );
  return {
    to: opts.to,
    subject: `Your ${days}-day ${APP_NAME} trial is live`,
    html: shell({
      title: `your trial is live — ${APP_NAME}`,
      preheader: `${opts.workspaceName} is on a ${days}-day Team trial — cloud features are unlocked.`,
      tag: "Trial",
      bodyRows,
      footerNote: `sent to ${opts.to} because you created the ${opts.workspaceName} workspace.`,
    }),
    text: `Your ${opts.workspaceName} workspace on ${APP_NAME} is on a ${days}-day Team trial — cloud tables, realtime sync and shared credentials are unlocked. Add a card any time to keep them: ${opts.appUrl}`,
  };
}

/**
 * Trial-ENDED notice. Sent once the free trial has lapsed and the cloud tier has
 * locked, so the owner knows their data is safe and how to restore cloud access.
 * Same branded shell; "Billing" tag. The CTA opens the app's upgrade/checkout.
 */
export function trialExpiredEmail(opts: {
  to: string;
  workspaceName: string;
  appUrl: string;
}): OutboundEmail {
  const ws = escapeHtml(opts.workspaceName);
  const bodyRows =
    bodyRow(
      `<h1 style="margin:0 0 16px;font-family:${SANS};font-size:25px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:${INK};">Your ${APP_NAME} trial has ended</h1>
       <p style="margin:0;font-family:${SANS};font-size:15px;line-height:1.6;color:${INK_2};">The <strong style="color:${INK};font-weight:600;">${ws}</strong> workspace's free trial is over, so cloud tables, realtime sync and shared credentials are now locked. <strong style="color:${INK};font-weight:600;">Your data is safe</strong> — upgrade to unlock cloud again. Local tables keep working free.</p>`,
      "38px 36px 6px",
    ) +
    bodyRow(
      `${ctaButton(opts.appUrl, "upgrade to unlock cloud")}`,
      "22px 36px 34px",
    );
  return {
    to: opts.to,
    subject: `Your ${opts.workspaceName} trial has ended`,
    html: shell({
      title: `trial ended — ${APP_NAME}`,
      preheader: `The ${opts.workspaceName} trial has ended — upgrade to unlock cloud features again.`,
      tag: "Billing",
      bodyRows,
      footerNote: `sent to ${opts.to}. your data is safe; local features always stay free.`,
    }),
    text: `Your ${opts.workspaceName} trial on ${APP_NAME} has ended — cloud features are locked but your data is safe. Upgrade to unlock cloud again: ${opts.appUrl}`,
  };
}

/**
 * Welcome email (the design's 3-step "every column is a function" onboarding).
 * Builder is ready for wiring (e.g. on first workspace creation); not yet sent
 * by any trigger. "Welcome" tag.
 */
export function welcomeEmail(opts: { to: string; appUrl?: string }): OutboundEmail {
  const appUrl = opts.appUrl ?? "https://gtmgrid.dev";
  const step = (n: number, title: string, body: string): string =>
    `<tr>
       <td style="vertical-align:top;width:34px;padding-bottom:18px;">
         <div style="width:26px;height:26px;border-radius:6px;background:#e9f9f0;border:1px solid #bfead4;text-align:center;line-height:26px;font-family:${MONO};font-size:12px;font-weight:600;color:${ACCENT_INK};">${n}</div>
       </td>
       <td style="vertical-align:top;padding:0 0 18px 12px;font-family:${SANS};">
         <div style="font-size:14px;font-weight:600;color:${INK};line-height:1.4;">${title}</div>
         <div style="font-size:13px;color:${INK_2};line-height:1.5;">${body}</div>
       </td>
     </tr>`;
  const chip = (t: string): string =>
    `<span style="font-family:${MONO};font-size:11.5px;color:${INK};background:${HAIRLINE};border:1px solid ${BORDER};border-radius:4px;padding:1px 5px;">${escapeHtml(t)}</span>`;

  const bodyRows =
    bodyRow(
      `<h1 style="margin:0 0 14px;font-family:${SANS};font-size:25px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:${INK};">welcome to ${APP_NAME}</h1>
       <p style="margin:0;font-family:${SANS};font-size:15px;line-height:1.6;color:${INK_2};">it's a spreadsheet where <strong style="color:${INK};font-weight:600;">every column is a function</strong> — a manual value, an AI prompt, or a connector call. template the inputs, hit run, and watch rows fill. here's the 60-second version:</p>`,
      "38px 36px 6px",
    ) +
    bodyRow(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
         ${step(1, "create a table", `hit ${chip("New table")} and drop in your leads, companies, or posts.`)}
         ${step(2, "add a function column", `point it at a connector or an AI prompt, templating inputs with <span style="font-family:${MONO};font-size:11.5px;color:${ACCENT_INK};">{{Company}}</span>.`)}
         ${step(3, "run it", `hit <span style="font-family:${MONO};font-size:11.5px;color:#ffffff;background:${ACCENT};border-radius:4px;padding:1px 6px;">Run</span> and cells fill <span style="font-family:${MONO};font-size:11.5px;color:${INK_3};">pending → running → done</span>. execution stays local.`)}
       </table>`,
      "24px 36px 6px",
    ) +
    bodyRow(ctaButton(appUrl, "open GTM Grid"), "26px 36px 34px");

  return {
    to: opts.to,
    subject: `welcome to ${APP_NAME}`,
    html: shell({
      title: `welcome to ${APP_NAME}`,
      preheader: `welcome to ${APP_NAME} — every column is a function. here's how to fill your first grid.`,
      tag: "Welcome",
      bodyRows,
    }),
    text: `Welcome to ${APP_NAME}. Every column is a function: a manual value, an AI prompt, or a connector call. 1) create a table 2) add a function column (template inputs with {{Company}}) 3) hit Run. Open ${APP_NAME}: ${appUrl}`,
  };
}
