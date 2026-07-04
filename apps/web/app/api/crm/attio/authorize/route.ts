/**
 * `GET /api/crm/attio/authorize?workspace=<uuid>` — the START of the Attio
 * OAuth handshake (TRI: crm-sync).
 *
 * The desktop app opens this URL in the system browser. We:
 *   1. require a Better Auth session — the connection is attributed to a real
 *      user. No session ⇒ 302 to sign-in carrying a `returnTo` back to here.
 *   2. verify that user is a MEMBER of `?workspace` (MembershipService) — you
 *      can only connect a CRM to a workspace you belong to.
 *   3. mint a signed `state` (binds workspace+user, 15-min TTL — the CSRF
 *      defense the callback checks) and 302 to Attio's authorize URL.
 *
 * When the Attio OAuth app isn't configured (no client id/secret) we render a
 * short human message rather than redirecting into a broken handshake. Every
 * non-redirect outcome is a plain-English page — never an HTTP code or trace.
 *
 * The service-touching logic lives in {@link authorizeResponse}, which takes an
 * already-built runtime + resolved session so it unit-tests offline against a
 * `TestLayer` (mirrors `lib/invite-preview.ts`). The `GET` handler owns only the
 * HTTP concerns: session resolution, the live runtime, and its disposal.
 */

import { getAuth, getSessionUserId } from "@gtmgrid/auth";
import { type AppServices, AttioAuth, appLayer, MembershipService } from "@gtmgrid/services";
import { Cause, Effect, Exit, ManagedRuntime } from "effect";
import type { NextRequest } from "next/server";
import { resolveSiteUrl } from "../../../../../lib/site-url";
import { crmOAuthPage, htmlResponse } from "../../../../../lib/crm/oauth-html";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A workspace id is a uuid (mirrors `/open`'s `WORKSPACE_RE`). */
const WORKSPACE_RE = /^[0-9a-f-]{36}$/;

type ServicesRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>;

/** 302 to `location` (absolute URL). */
function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

/** The site origin, with the same production default the lifecycle emails use. */
function siteOrigin(): string {
  try {
    return resolveSiteUrl();
  } catch {
    return "https://www.gtmgrid.dev";
  }
}

/** Read a typed Effect failure's `_tag`, or `undefined` for a defect/success. */
function failureTag<E>(exit: Exit.Exit<unknown, E>): string | undefined {
  if (Exit.isSuccess(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "None") return undefined;
  const value = failure.value;
  return typeof value === "object" && value !== null && "_tag" in value && typeof value._tag === "string"
    ? value._tag
    : undefined;
}

/** The page shown when the Attio OAuth app has no client id/secret configured. */
function notConfiguredPage(): Response {
  return htmlResponse(
    crmOAuthPage({
      title: "Attio isn't set up yet — gtm grid",
      heading: "Attio isn't set up yet",
      message:
        "Connecting Attio isn't available on this deployment yet. Please reach out to your GTM Grid admin, then try again.",
    }),
    503,
  );
}

/**
 * The Attio OAuth handshake's first leg as a `Response`, given a resolved
 * `userId` (or `null` when signed out) and a services `runtime`. Testable
 * offline: pass a `TestLayer` runtime and a chosen `userId`.
 */
export async function authorizeResponse(params: {
  readonly runtime: ServicesRuntime;
  readonly userId: string | null;
  readonly workspaceId: string;
  readonly siteUrl: string;
  /** The full URL of this request, echoed as `returnTo` on the sign-in bounce. */
  readonly returnTo: string;
}): Promise<Response> {
  // Signed out → bounce to sign-in, preserving where to come back to. apps/web
  // has no first-party sign-in page yet (auth is desktop-owned), so this points
  // at the site root carrying `returnTo`; see the file header / integration note.
  if (params.userId === null) {
    return redirect(`${params.siteUrl}/?returnTo=${encodeURIComponent(params.returnTo)}`);
  }
  if (!WORKSPACE_RE.test(params.workspaceId)) {
    return htmlResponse(
      crmOAuthPage({
        title: "That link looks wrong — gtm grid",
        heading: "That connection link looks wrong",
        message: "Go back to GTM Grid and start connecting Attio again from your workspace settings.",
      }),
      400,
    );
  }

  const userId = params.userId;
  const exit = await params.runtime.runPromiseExit(
    Effect.gen(function* () {
      const membership = yield* MembershipService;
      yield* membership.requireMember(params.workspaceId);
      const auth = yield* AttioAuth;
      const state = yield* auth.mintState({ workspaceId: params.workspaceId, userId });
      // No signing secret ⇒ treat as unconfigured (same page as a missing app).
      if (state === null) return { kind: "unconfigured" as const };
      const url = yield* auth.authorizeUrl(state);
      return { kind: "ok" as const, url };
    }),
  );

  if (Exit.isSuccess(exit)) {
    return exit.value.kind === "ok" ? redirect(exit.value.url) : notConfiguredPage();
  }

  const tag = failureTag(exit);
  if (tag === "AttioOAuthNotConfigured") return notConfiguredPage();
  if (tag === "NotAMemberError" || tag === "UnauthenticatedError") {
    return htmlResponse(
      crmOAuthPage({
        title: "You can't connect this workspace — gtm grid",
        heading: "You can't connect this workspace",
        message:
          "You're not a member of the workspace this link points to. Switch to a workspace you belong to in GTM Grid and try again.",
      }),
      403,
    );
  }
  return htmlResponse(
    crmOAuthPage({
      title: "Something went wrong — gtm grid",
      heading: "We couldn't start the Attio connection",
      message: "Something went wrong on our end. Go back to GTM Grid and try connecting Attio again in a moment.",
    }),
    500,
  );
}

export async function GET(req: NextRequest): Promise<Response> {
  const workspaceId = req.nextUrl.searchParams.get("workspace") ?? "";
  const auth = await getAuth();
  const userId = await getSessionUserId(auth, req.headers);
  const { db } = await import("@gtmgrid/db/client");
  const rt = ManagedRuntime.make(appLayer({ db, userId }));
  try {
    return await authorizeResponse({
      runtime: rt,
      userId,
      workspaceId,
      siteUrl: siteOrigin(),
      returnTo: req.url,
    });
  } finally {
    await rt.dispose();
  }
}
