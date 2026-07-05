/**
 * `GET /api/crm/hubspot/authorize?workspace=<uuid>` — the START of the HubSpot
 * OAuth handshake (TRI: crm-sync).
 *
 * The desktop app opens this URL in the system browser. We:
 *   1. require a Better Auth session — the connection is attributed to a real
 *      user. No session ⇒ 302 to sign-in carrying a `returnTo` back to here.
 *   2. verify that user is a MEMBER of `?workspace` (MembershipService) — you
 *      can only connect a CRM to a workspace you belong to.
 *   3. mint a signed `state` (binds workspace+user, 15-min TTL — the CSRF
 *      defense the callback checks) and 302 to HubSpot's authorize URL.
 *
 * When the HubSpot OAuth app isn't configured (no client id/secret) we render a
 * short human message rather than redirecting into a broken handshake. Every
 * non-redirect outcome is a plain-English page — never an HTTP code or trace.
 *
 * The provider-agnostic core lives in `lib/crm/crm-authorize.ts` (Next.js
 * route modules may only export route handlers); this file owns only the HTTP
 * concerns: session resolution, the live runtime, and its disposal.
 */

import { getAuth, getSessionUserId } from "@gtmgrid/auth";
import { appLayer } from "@gtmgrid/services";
import { ManagedRuntime } from "effect";
import type { NextRequest } from "next/server";
import { authorizeResponse, siteOrigin } from "../../../../../lib/crm/crm-authorize";
import { HUBSPOT_OAUTH } from "../../../../../lib/crm/oauth-providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const workspaceId = req.nextUrl.searchParams.get("workspace") ?? "";
  const auth = await getAuth();
  const userId = await getSessionUserId(auth, req.headers);
  const { db } = await import("@gtmgrid/db/client");
  const rt = ManagedRuntime.make(appLayer({ db, userId }));
  try {
    return await authorizeResponse({
      runtime: rt,
      oauth: HUBSPOT_OAUTH,
      userId,
      workspaceId,
      siteUrl: siteOrigin(),
      returnTo: req.url,
    });
  } finally {
    await rt.dispose();
  }
}
