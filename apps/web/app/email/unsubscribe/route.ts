/**
 * Lifecycle-email unsubscribe endpoint (`/email/unsubscribe?token=…`).
 *
 * Session-free by design: the token (HMAC over userId+category, see
 * lib/lifecycle-email/unsubscribe-token.ts) is the authorization. Two verbs:
 *   - GET  — the footer link. Flips the category off and renders a tiny branded
 *     confirmation page (no JS, no framework chrome).
 *   - POST — RFC 8058 one-click (`List-Unsubscribe-Post`); inbox providers call
 *     this directly. Same flip, 200 with empty body.
 *
 * Idempotent: repeating a click keeps the category off and re-renders the same
 * confirmation. An invalid/garbled token is a 400 with no detail (don't oracle).
 */

import { appLayer, LifecycleEmailRepo } from "@gtmgrid/services";
import { Effect, ManagedRuntime } from "effect";
import type { NextRequest } from "next/server";
import { captureServer } from "../../../lib/posthog-server";
import { verifyUnsubscribeToken } from "../../../lib/lifecycle-email/unsubscribe-token";

export const dynamic = "force-dynamic";

async function applyUnsubscribe(
  token: string | null,
): Promise<{ ok: boolean; category?: string }> {
  if (!token) return { ok: false };
  const claims = verifyUnsubscribeToken(token);
  if (!claims) return { ok: false };
  const { db } = await import("@gtmgrid/db/client");
  const runtime = ManagedRuntime.make(appLayer({ db, userId: null }));
  try {
    await runtime.runPromise(
      Effect.flatMap(LifecycleEmailRepo, (r) =>
        r.setEmailPref(claims.userId, claims.category, false),
      ),
    );
  } finally {
    await runtime.dispose();
  }
  captureServer("lifecycle_email_unsubscribed", {
    distinctId: claims.userId,
    properties: { category: claims.category },
  });
  return { ok: true, category: claims.category };
}

const LABELS: Record<string, string> = {
  activation: "getting-started tips",
  status: "run & signal updates",
  digest: "the weekly digest",
};

export async function GET(req: NextRequest): Promise<Response> {
  const result = await applyUnsubscribe(req.nextUrl.searchParams.get("token"));
  if (!result.ok) return new Response("Invalid unsubscribe link.", { status: 400 });
  const label = LABELS[result.category ?? ""] ?? "these emails";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Unsubscribed — gtm grid</title></head>
<body style="margin:0;background:#f8f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="max-width:480px;margin:96px auto;background:#fff;border:1px solid #e4e4ea;border-radius:12px;padding:36px 40px;">
<div style="font-weight:700;font-size:18px;letter-spacing:-0.03em;color:#1f2937;">gtm grid</div>
<h1 style="margin:18px 0 0;font-size:21px;font-weight:600;letter-spacing:-0.02em;color:#111118;">You're unsubscribed.</h1>
<p style="margin:12px 0 0;font-size:14.5px;line-height:1.6;color:#5a5a6e;">We won't send you ${label} anymore. Transactional email (receipts, security codes) still arrives.</p>
<p style="margin:16px 0 0;font-size:13px;color:#9696a8;">Changed your mind? Flip it back in the app under Settings → Notifications.</p>
</div></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** RFC 8058 one-click unsubscribe (no body inspection needed). */
export async function POST(req: NextRequest): Promise<Response> {
  const result = await applyUnsubscribe(req.nextUrl.searchParams.get("token"));
  return new Response(null, { status: result.ok ? 200 : 400 });
}
