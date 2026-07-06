/**
 * `/open` — the HTTPS → `gtmgrid://` bounce page email CTAs land on.
 *
 * Email clients block custom-scheme links (`gtmgrid://…` anchors are stripped
 * or dead in Gmail/Outlook), so lifecycle emails link here instead:
 *
 *   https://www.gtmgrid.dev/open?to=table/<id>&workspace=<wsId>
 *
 * This route validates `to` against the WHITELISTED destination grammar (never
 * reflect arbitrary input into a protocol URL), then serves a tiny static page
 * that immediately attempts the `gtmgrid://open/<to>` redirect and shows two
 * affordances for when the protocol doesn't fire: "Open gtm grid" (retry) and
 * "Download for desktop" (app not installed). No framework chrome, no JS beyond
 * the redirect — it must render instantly from a cold email click.
 *
 * The destination grammar mirrors packages/desktop/src/cloud/deepLinkNav.ts —
 * keep the two in sync when adding destinations.
 */

import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** Whitelisted in-app destinations (mirror deepLinkNav.ts). */
const DEST_RE =
  /^(table\/[0-9a-f-]{36}|new-table|settings\/ai-providers|invite|members|billing|crm-connected)$/;
const WORKSPACE_RE = /^[0-9a-f-]{36}$/;
/** The CRM slug carried on a `crm-connected` bounce (lowercase letters only). */
const PROVIDER_RE = /^[a-z]+$/;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function GET(req: NextRequest): Response {
  const rawTo = req.nextUrl.searchParams.get("to") ?? "";
  const rawWs = req.nextUrl.searchParams.get("workspace") ?? "";
  const rawProvider = req.nextUrl.searchParams.get("provider") ?? "";
  const dest = DEST_RE.test(rawTo) ? rawTo : "";
  const ws = dest && WORKSPACE_RE.test(rawWs) ? rawWs : "";
  // The provider is only meaningful for the crm-connected bounce.
  const provider = dest === "crm-connected" && PROVIDER_RE.test(rawProvider) ? rawProvider : "";
  const query = [ws && `workspace=${ws}`, provider && `provider=${provider}`].filter(Boolean).join("&");
  const deepLink = `gtmgrid://open${dest ? `/${dest}` : ""}${query ? `?${query}` : ""}`;
  const safeLink = escapeHtml(deepLink);

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Opening gtm grid…</title></head>
<body style="margin:0;background:#f8f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="max-width:440px;margin:96px auto;background:#fff;border:1px solid #e4e4ea;border-radius:12px;padding:36px 40px;text-align:center;">
<div style="font-weight:700;font-size:18px;letter-spacing:-0.03em;color:#1f2937;">gtm grid</div>
<h1 style="margin:18px 0 0;font-size:20px;font-weight:600;letter-spacing:-0.02em;color:#111118;">Opening the app…</h1>
<p style="margin:10px 0 0;font-size:14px;line-height:1.6;color:#5a5a6e;">If nothing happens, the app may not be running or installed.</p>
<p style="margin:24px 0 0;">
<a href="${safeLink}" style="display:inline-block;background:#136d34;color:#fff;font-weight:600;font-size:14px;text-decoration:none;padding:11px 22px;border-radius:6px;">Open gtm grid</a>
</p>
<p style="margin:14px 0 0;font-size:13px;"><a href="/download" style="color:#5a5a6e;text-decoration:none;">Download for desktop →</a></p>
</div>
<script>location.href=${JSON.stringify(deepLink)};</script>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
