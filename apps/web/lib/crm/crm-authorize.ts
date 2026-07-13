/**
 * A CRM OAuth handshake's FIRST leg (TRI: crm-sync), provider-agnostic —
 * everything provider-specific arrives via a {@link CrmOAuthAdapter}. Lives
 * outside the route files because Next.js route modules may only export route
 * handlers — `authorizeResponse` is the offline-testable core each provider's
 * `GET` wraps (mirrors `lib/invite-preview.ts`).
 */

import { type AppServices, MembershipService } from "@gtmgrid/services";
import type { CrmOAuthAdapter } from "./oauth-providers";
import { Cause, Effect, Exit, type ManagedRuntime } from "effect";
import { resolveSiteUrl } from "../site-url";
import { crmOAuthPage, htmlResponse } from "./oauth-html";

/** A workspace id is a uuid (mirrors `/open`'s `WORKSPACE_RE`). */
const WORKSPACE_RE = /^[0-9a-f-]{36}$/;

type ServicesRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>;

/** 302 to `location` (absolute URL). */
function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

/** The site origin, with the same production default the lifecycle emails use. */
export function siteOrigin(): string {
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

/** The page shown when the provider's OAuth app has no client id/secret configured. */
function notConfiguredPage(name: string): Response {
  return htmlResponse(
    crmOAuthPage({
      title: `${name} isn't set up yet — gtm grid`,
      heading: `${name} isn't set up yet`,
      message: `Connecting ${name} isn't available on this deployment yet. Please reach out to your GTM Grid admin, then try again.`,
    }),
    503,
  );
}

/**
 * A CRM OAuth handshake's first leg as a `Response`, given a resolved
 * `userId` (or `null` when signed out), a services `runtime`, and the
 * provider's adapter. Testable offline: pass a `TestLayer` runtime and a
 * chosen `userId`.
 */
export async function authorizeResponse(params: {
  readonly runtime: ServicesRuntime;
  readonly oauth: CrmOAuthAdapter;
  readonly userId: string | null;
  readonly workspaceId: string;
  readonly siteUrl: string;
  /** The full URL of this request, echoed as `returnTo` on the sign-in bounce. */
  readonly returnTo: string;
}): Promise<Response> {
  const name = params.oauth.displayName;
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
        message: `Go back to GTM Grid and start connecting ${name} again from your workspace settings.`,
      }),
      400,
    );
  }

  const userId = params.userId;
  const exit = await params.runtime.runPromiseExit(
    Effect.gen(function* () {
      const membership = yield* MembershipService;
      yield* membership.requireMember(params.workspaceId);
      const state = yield* params.oauth.mintState({ workspaceId: params.workspaceId, userId });
      // No signing secret ⇒ treat as unconfigured (same page as a missing app).
      if (state === null) return { kind: "unconfigured" as const };
      const url = yield* params.oauth.authorizeUrl(state);
      return { kind: "ok" as const, url };
    }),
  );

  if (Exit.isSuccess(exit)) {
    return exit.value.kind === "ok" ? redirect(exit.value.url) : notConfiguredPage(name);
  }

  const tag = failureTag(exit);
  if (tag === params.oauth.notConfiguredTag) return notConfiguredPage(name);
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
      heading: `We couldn't start the ${name} connection`,
      message: `Something went wrong on our end. Go back to GTM Grid and try connecting ${name} again in a moment.`,
    }),
    500,
  );
}
