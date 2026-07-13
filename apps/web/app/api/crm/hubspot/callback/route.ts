/**
 * `GET /api/crm/hubspot/callback?code=…&state=…` — the END of the HubSpot OAuth
 * handshake (TRI: crm-sync). HubSpot redirects the browser here.
 *
 * Flow: `?error=access_denied` → friendly cancel page; invalid/expired state →
 * 400 plain-English page (the CSRF gate); otherwise exchange the code, identify
 * the HubSpot workspace, persist the encrypted connection, clear auth_revoked
 * pauses, capture `crm_connected`, and bounce into the app via
 * `gtmgrid://open/crm-connected`.
 *
 * The provider-agnostic core lives in `lib/crm/crm-callback.ts` (Next.js
 * route modules may only export route handlers); this file owns only HTTP
 * concerns: session resolution, the live runtime, and its disposal.
 */

import { getAuth, resolveSession } from "@gtmgrid/auth";
import { appLayer } from "@gtmgrid/services";
import { ManagedRuntime } from "effect";
import type { NextRequest } from "next/server";
import { callbackResponse, type CallbackSessionUser } from "../../../../../lib/crm/crm-callback";
import { HUBSPOT_OAUTH } from "../../../../../lib/crm/oauth-providers";

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
    return await callbackResponse({ runtime: rt, oauth: HUBSPOT_OAUTH, code, state, error, sessionUser });
  } finally {
    await rt.dispose();
  }
}
