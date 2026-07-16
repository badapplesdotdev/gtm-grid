/**
 * `GET /api/oauth/slack/callback?code=…&state=…` — the END of the Slack OAuth
 * handshake (TRI: slack). Slack redirects the browser here.
 *
 * Flow: `?error=access_denied` → friendly cancel page; invalid/expired state →
 * 400 plain-English page (the CSRF gate, checked BEFORE any code exchange);
 * otherwise exchange the code, persist the encrypted connection at the `slack`
 * credential slot, capture `crm_connected`, and bounce into the app via
 * `gtmgrid://open/slack-connected`.
 *
 * NO BROWSER SESSION IS REQUIRED. The desktop opens the authorize URL with
 * `openExternal`, so the system browser carries no gtmgrid.dev cookie — the
 * SIGNED STATE is the trust boundary, exactly as for the CRM callbacks. The
 * session, when present, only supplies the "connected by …" display name.
 *
 * The provider-agnostic core lives in `lib/crm/crm-callback.ts` (Next.js route
 * modules may only export route handlers); this file owns only HTTP concerns:
 * session resolution, the live runtime, and its disposal.
 */

import { getAuth, resolveSession } from "@gtmgrid/auth";
import { appLayer } from "@gtmgrid/services";
import { ManagedRuntime } from "effect";
import type { NextRequest } from "next/server";
import { callbackResponse, type CallbackSessionUser } from "../../../../../lib/crm/crm-callback";
import { SLACK_OAUTH } from "../../../../../lib/crm/oauth-providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const code = req.nextUrl.searchParams.get("code") ?? "";
  const state = req.nextUrl.searchParams.get("state") ?? "";
  const error = req.nextUrl.searchParams.get("error");

  const auth = await getAuth();
  const session = await resolveSession(auth, req.headers);
  const sessionUser: CallbackSessionUser | null = session
    ? { id: session.user.id, name: session.user.name ?? null, email: session.user.email }
    : null;

  const { db } = await import("@gtmgrid/db/client");
  const rt = ManagedRuntime.make(appLayer({ db, userId: sessionUser?.id ?? null }));
  try {
    return await callbackResponse({ runtime: rt, oauth: SLACK_OAUTH, code, state, error, sessionUser });
  } finally {
    await rt.dispose();
  }
}
