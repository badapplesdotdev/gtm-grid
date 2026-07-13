/**
 * The branded HTML shell shared by the Attio OAuth routes' human-facing pages
 * (`app/api/crm/attio/{authorize,callback}/route.ts`).
 *
 * These routes are hit in a real browser during the OAuth handshake, so every
 * outcome — success, cancellation, an expired link, an unconfigured app — must
 * render a small, self-contained page in plain English (NEVER an HTTP code or a
 * stack trace). The chrome mirrors the `/open` bounce page and the lifecycle
 * unsubscribe page: no framework, no external assets, one optional redirect
 * script that fires instantly from a cold click.
 */

/** Minimal HTML escape for any value interpolated into markup or an href. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A call-to-action / fallback link rendered on a CRM OAuth page. */
export interface CrmPageLink {
  readonly href: string;
  readonly label: string;
}

/**
 * Render one CRM OAuth page. `primary` is the green CTA, `secondary` a quieter
 * text link beneath it, and `redirectTo` (when set) is fired immediately by a
 * script tag — the success page uses it to bounce into the desktop app the same
 * way `/open` does. All link hrefs are escaped; callers pass already-validated
 * values (never raw query input) into `redirectTo`.
 */
export function crmOAuthPage(opts: {
  readonly title: string;
  readonly heading: string;
  readonly message: string;
  readonly primary?: CrmPageLink;
  readonly secondary?: CrmPageLink;
  readonly redirectTo?: string;
}): string {
  const primary = opts.primary
    ? `<p style="margin:24px 0 0;"><a href="${escapeHtml(opts.primary.href)}" style="display:inline-block;background:#136d34;color:#fff;font-weight:600;font-size:14px;text-decoration:none;padding:11px 22px;border-radius:6px;">${escapeHtml(opts.primary.label)}</a></p>`
    : "";
  const secondary = opts.secondary
    ? `<p style="margin:14px 0 0;font-size:13px;"><a href="${escapeHtml(opts.secondary.href)}" style="color:#5a5a6e;text-decoration:none;">${escapeHtml(opts.secondary.label)}</a></p>`
    : "";
  const script = opts.redirectTo ? `<script>location.href=${JSON.stringify(opts.redirectTo)};</script>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(opts.title)}</title></head>
<body style="margin:0;background:#f8f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="max-width:440px;margin:96px auto;background:#fff;border:1px solid #e4e4ea;border-radius:12px;padding:36px 40px;text-align:center;">
<div style="font-weight:700;font-size:18px;letter-spacing:-0.03em;color:#1f2937;">gtm grid</div>
<h1 style="margin:18px 0 0;font-size:20px;font-weight:600;letter-spacing:-0.02em;color:#111118;">${escapeHtml(opts.heading)}</h1>
<p style="margin:10px 0 0;font-size:14px;line-height:1.6;color:#5a5a6e;">${escapeHtml(opts.message)}</p>
${primary}
${secondary}
</div>
${script}
</body></html>`;
}

/** Standard HTML `Response` with the given status. */
export function htmlResponse(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
