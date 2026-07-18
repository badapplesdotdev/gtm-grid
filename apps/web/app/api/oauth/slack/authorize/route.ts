/**
 * `GET /api/oauth/slack/authorize?workspace=<uuid>` — the START of the Slack
 * OAuth handshake (TRI: slack).
 *
 * Identical in shape to the CRM authorize routes (see
 * `app/api/crm/attio/authorize/route.ts`): require a Better Auth session,
 * verify the user is a MEMBER of `?workspace`, mint a signed 15-minute `state`
 * (the CSRF defense the callback checks), then 302 to Slack.
 *
 * Lives under `/api/oauth/` rather than `/api/crm/` because Slack is not a CRM —
 * it has no sync bindings and no source objects. The provider-agnostic core in
 * `lib/crm/crm-authorize.ts` is shared regardless.
 *
 * REDIRECT URI: this path must be registered verbatim in the Slack app's OAuth
 * settings. Slack silently routes to the FIRST configured redirect URL when the
 * `redirect_uri` param is absent and several are registered — `oauth-core`
 * therefore sends it on every call, including the token exchange.
 */

import { getAuth, getSessionUserId } from "@gtmgrid/auth";
import { appLayer } from "@gtmgrid/services";
import { ManagedRuntime } from "effect";
import type { NextRequest } from "next/server";
import { authorizeResponse, siteOrigin } from "../../../../../lib/crm/crm-authorize";
import { SLACK_OAUTH } from "../../../../../lib/crm/oauth-providers";

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
      oauth: SLACK_OAUTH,
      userId,
      workspaceId,
      siteUrl: siteOrigin(),
      returnTo: req.url,
    });
  } finally {
    await rt.dispose();
  }
}
