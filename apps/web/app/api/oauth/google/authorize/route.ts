/**
 * `GET /api/oauth/google/authorize?workspace=<uuid>` — the START of the Google
 * OAuth handshake.
 *
 * Identical in shape to the Slack authorize route: require a Better Auth
 * session, verify the user is a MEMBER of `?workspace`, mint a signed 15-minute
 * `state` (the CSRF defense the callback checks), then 302 to Google.
 *
 * The provider is `google`, not `googlesheets` — ONE grant serves every Google
 * connector, so there is exactly one authorize route no matter how many Google
 * connectors ship.
 *
 * REDIRECT URI: this path must be registered verbatim in the Google Cloud
 * console's OAuth client (Authorised redirect URIs). Google is strict here —
 * unlike Slack it will refuse the request outright with `redirect_uri_mismatch`
 * rather than silently picking the first configured URL, so a mismatch fails
 * loudly at consent time.
 */

import { getAuth, getSessionUserId } from "@gtmgrid/auth";
import { appLayer } from "@gtmgrid/services";
import { ManagedRuntime } from "effect";
import type { NextRequest } from "next/server";
import { authorizeResponse, siteOrigin } from "../../../../../lib/crm/crm-authorize";
import { GOOGLE_OAUTH } from "../../../../../lib/crm/oauth-providers";

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
      oauth: GOOGLE_OAUTH,
      userId,
      workspaceId,
      siteUrl: siteOrigin(),
      returnTo: req.url,
    });
  } finally {
    await rt.dispose();
  }
}
