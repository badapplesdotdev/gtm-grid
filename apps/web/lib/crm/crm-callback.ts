/**
 * A CRM OAuth handshake's SECOND leg (TRI: crm-sync), provider-agnostic —
 * everything provider-specific arrives via a {@link CrmOAuthAdapter}. Lives
 * outside the route files because Next.js route modules may only export route
 * handlers — `callbackResponse` is the offline-testable core each provider's
 * `GET` wraps.
 */

import {
  type AppServices,
  type CrmSession,
  CrmBindingRepo,
  CrmConnectionService,
  WorkspaceRepo,
} from "@gtmgrid/services";
import { Effect, Exit, type ManagedRuntime, Option } from "effect";
import { captureServer } from "../posthog-server";
import { type CrmPageLink, crmOAuthPage, htmlResponse } from "./oauth-html";
import type { CrmOAuthAdapter } from "./oauth-providers";

type ServicesRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>;

/** The signed-in browser user, resolved from the Better Auth session (for the
 *  connection's display name); `null` when the cookie is gone. */
export interface CallbackSessionUser {
  readonly id: string;
  readonly name: string | null;
  readonly email: string;
}

/** The connection's display name: the signed-in user's name/email, but only when
 *  they ARE the user the state was minted for; otherwise blank (cosmetic only). */
function displayName(sessionUser: CallbackSessionUser | null, stateUserId: string): string {
  if (sessionUser === null || sessionUser.id !== stateUserId) return "";
  return sessionUser.name && sessionUser.name.trim() !== "" ? sessionUser.name : sessionUser.email;
}

/** Retry link back into the provider's authorize route for a known workspace. */
function retryLink(provider: string, workspaceId: string): CrmPageLink {
  return {
    href: `/api/crm/${provider}/authorize?workspace=${encodeURIComponent(workspaceId)}`,
    label: "Try connecting again",
  };
}

function canceledPage(name: string, retry: CrmPageLink | undefined): Response {
  return htmlResponse(
    crmOAuthPage({
      title: "Connection canceled — gtm grid",
      heading: "You canceled the connection",
      message: `No problem — nothing was connected. You can start the ${name} connection again whenever you're ready.`,
      primary: retry,
    }),
    200,
  );
}

function expiredPage(): Response {
  return htmlResponse(
    crmOAuthPage({
      title: "Link expired — gtm grid",
      heading: "This connection link expired",
      message: "This connection link expired — go back to the app and try again.",
    }),
    400,
  );
}

function failurePage(name: string, retry: CrmPageLink): Response {
  return htmlResponse(
    crmOAuthPage({
      title: "Couldn't finish — gtm grid",
      heading: `We couldn't finish connecting ${name}`,
      message: `${name} didn't complete the connection. This is usually temporary — please try again in a moment.`,
      primary: retry,
    }),
    502,
  );
}

function successPage(name: string, crmWorkspaceName: string): Response {
  const named = crmWorkspaceName.trim() !== "";
  return htmlResponse(
    crmOAuthPage({
      title: `${name} connected — gtm grid`,
      heading: named ? `Connected to ${crmWorkspaceName}` : `${name} connected`,
      message: `${name} connected — returning to GTM Grid…`,
      // Fires the deep link instantly (same mechanism as /open); the CTA is the
      // fallback when the browser doesn't hand off to the app.
      redirectTo: "gtmgrid://open/crm-connected",
      primary: { href: "/open?to=crm-connected", label: "Open GTM Grid" },
    }),
    200,
  );
}

/**
 * Complete a CRM OAuth handshake as a `Response`, given a built `runtime`,
 * the provider's adapter, and the resolved browser session user. Testable
 * offline: pass a `TestLayer` runtime + a stubbed `fetch` for the token and
 * identify calls.
 */
export async function callbackResponse(params: {
  readonly runtime: ServicesRuntime;
  readonly oauth: CrmOAuthAdapter;
  readonly code: string;
  readonly state: string;
  readonly error: string | null;
  readonly sessionUser: CallbackSessionUser | null;
}): Promise<Response> {
  const { provider, displayName: name } = params.oauth;
  const verify = (token: string) => params.runtime.runPromise(params.oauth.verifyState(token));

  // 1. The user declined on the provider's consent screen.
  if (params.error !== null && params.error !== "") {
    const claims = params.state !== "" ? await verify(params.state) : null;
    return canceledPage(name, claims ? retryLink(provider, claims.workspaceId) : undefined);
  }

  // 2. CSRF/expiry gate — an invalid or aged state never exchanges a code.
  const claims = params.state !== "" ? await verify(params.state) : null;
  if (claims === null) return expiredPage();

  if (params.code === "") return failurePage(name, retryLink(provider, claims.workspaceId));

  const connectedByName = displayName(params.sessionUser, claims.userId);

  // 3. Exchange → identify → persist → un-pause, all against the same runtime.
  const exit = await params.runtime.runPromiseExit(
    Effect.gen(function* () {
      const connection = yield* CrmConnectionService;
      const bindings = yield* CrmBindingRepo;
      const workspaces = yield* WorkspaceRepo;

      // Desktop-initiated flows land here WITHOUT a browser session (the state
      // was minted through the desktop's authenticated tRPC call) — resolve the
      // display name from the state's user id so "connected by …" still renders.
      const nameFromDb =
        connectedByName === ""
          ? yield* workspaces.findUser(claims.userId).pipe(
              Effect.map((u) =>
                Option.match(u, {
                  onNone: () => "",
                  onSome: (user) => (user.name && user.name.trim() !== "" ? user.name : (user.email ?? "")),
                }),
              ),
              Effect.orElseSucceed(() => ""),
            )
          : connectedByName;

      const tokens = yield* params.oauth.exchangeCode(params.code);
      const session: CrmSession = {
        workspaceId: claims.workspaceId,
        tokens,
        persist: () => Effect.void,
      };
      const self = yield* params.oauth.identifySelf(session);
      yield* connection.saveConnection({
        workspaceId: claims.workspaceId,
        provider,
        tokens,
        meta: {
          connectedByUserId: claims.userId,
          connectedByName: nameFromDb,
          crmWorkspaceId: self.workspaceId,
          crmWorkspaceName: self.workspaceName,
        },
      });
      // Reconnecting resolves a revoked-auth pause (NOT source_gone — a deleted
      // source isn't fixed by re-authing).
      yield* bindings.clearPause({ workspaceId: claims.workspaceId, provider, reason: "auth_revoked" });
      return self.workspaceName;
    }),
  );

  // Any failure (a bad/expired code, a provider outage, a persist defect)
  // becomes a retry page — defects are already routed to Error Tracking by the
  // host `reportError` sink wired into `appLayer`.
  if (Exit.isFailure(exit)) return failurePage(name, retryLink(provider, claims.workspaceId));

  // 4. Success → analytics + the bounce-into-app page.
  captureServer("crm_connected", {
    distinctId: claims.userId,
    properties: { provider, workspace_id: claims.workspaceId },
    groups: { workspace: claims.workspaceId },
  });
  return successPage(name, exit.value);
}
