/**
 * Per-provider OAuth adapters for the shared route cores (TRI: crm-sync).
 * `crm-authorize.ts` / `crm-callback.ts` are provider-agnostic — everything
 * provider-specific lives here, so a new provider is one more adapter + two thin
 * routes.
 *
 * The protocol half comes straight from `@gtmgrid/services`' `OAuthAdapter`,
 * which is `R = never`, so `mintState`/`verifyState`/`authorizeUrl`/`exchangeCode`
 * are passed through rather than re-wrapped per provider per method.
 *
 * What remains here is the part that is genuinely NOT protocol:
 * {@link OAuthRouteAdapter.persistConnection} — identify the account we just
 * connected to, store the tokens, and do whatever un-pausing that provider
 * needs. That step used to be inlined in `crm-callback.ts` against
 * `CrmConnectionService` + `CrmBindingRepo`, which silently made the "provider
 * agnostic" core CRM-only: Slack has no sync bindings to un-pause and no CRM
 * client to identify with. Handing the whole step to the adapter is what lets
 * one callback core serve a CRM and a plain connector.
 */

import {
  ATTIO_ADAPTER,
  AttioClient,
  type AppServices,
  CrmBindingRepo,
  CrmConnectionService,
  type CrmProvider,
  type CrmSession,
  GOOGLE_ADAPTER,
  GOOGLE_USERINFO_URL,
  GoogleConnectionService,
  HUBSPOT_ADAPTER,
  HubspotClient,
  type OAuthAdapter,
  type OAuthNotConfiguredError,
  type OAuthTokens,
  SLACK_ADAPTER,
  SlackConnectionService,
} from "@gtmgrid/services";
import { CrmSyncError } from "@gtmgrid/services";
import { Effect } from "effect";
import { captureServer } from "../posthog-server";

export interface CrmOAuthClaims {
  readonly workspaceId: string;
  readonly userId: string;
}

/** What `persistConnection` receives once the code has been exchanged. */
export interface PersistConnectionArgs {
  readonly workspaceId: string;
  readonly userId: string;
  /** Resolved display name of the connecting user; "" when unknown. */
  readonly connectedByName: string;
  readonly tokens: OAuthTokens;
}

export interface OAuthRouteAdapter {
  /**
   * User-facing product name for page copy ("Attio", "HubSpot", "Slack").
   *
   * There is deliberately NO `provider: string` id field. It existed, documented
   * as "used in copy and analytics", and was read exactly once — in a destructure
   * that never used the value. Copy comes from `displayName`, analytics from
   * `captureConnected`, the authorize URL from `authorizePath`, and the id is
   * already the `OAUTH_ADAPTERS` key. A dead field on an interface built for
   * extension is worse than a dead import: the next provider fills it in.
   */
  readonly displayName: string;
  /** The auth service's not-configured error tag (drives the setup page). */
  readonly notConfiguredTag: string;
  /** This provider's authorize route, for the "try again" link on error pages. */
  readonly authorizePath: string;
  /** Deep link fired by the success page to hand back to the desktop app. */
  readonly connectedDeepLink: string;
  /**
   * Where the success page's "Open GTM Grid" button points when the browser
   * does NOT hand off the `gtmgrid://` protocol — the only path where that
   * button matters.
   *
   * REQUIRED, deliberately not defaulted to the CRM route: a default is how the
   * Slack success page ended up sending users to `/open?to=crm-connected`. A new
   * provider must state where it goes.
   */
  readonly connectedFallbackHref: string;
  /** Whether this provider's OAuth app env is configured (drives UI affordances). */
  readonly isConfigured: () => Effect.Effect<boolean, never, AppServices>;
  readonly mintState: (claims: CrmOAuthClaims) => Effect.Effect<string | null, never, AppServices>;
  readonly verifyState: (token: string) => Effect.Effect<CrmOAuthClaims | null, never, AppServices>;
  readonly authorizeUrl: (state: string) => Effect.Effect<string, unknown, AppServices>;
  readonly exchangeCode: (code: string) => Effect.Effect<OAuthTokens, unknown, AppServices>;
  /**
   * Identify + store the connection. Returns the connected ACCOUNT's display
   * name (an Attio/HubSpot workspace, a Slack team) for the success page, or ""
   * when the provider doesn't name one.
   */
  readonly persistConnection: (args: PersistConnectionArgs) => Effect.Effect<string, unknown, AppServices>;
  /**
   * Emit this provider's "connected" analytics event.
   *
   * On the ADAPTER rather than in the callback core because the event map is
   * typed per-event: a single parameterised `captureServer(name, …)` would lose
   * that. It also keeps the core free of a `provider === "slack" ? … : …`
   * branch — the shape this whole refactor removed.
   */
  readonly captureConnected: (args: { readonly userId: string; readonly workspaceId: string }) => void;
}

/** @deprecated Use {@link OAuthRouteAdapter}; kept so existing imports keep compiling. */
export type CrmOAuthAdapter = OAuthRouteAdapter;

/** Lift a protocol adapter into the route-layer shape. */
const routeAdapter = <E extends OAuthNotConfiguredError>(
  adapter: OAuthAdapter<E>,
  rest: Pick<OAuthRouteAdapter, "authorizePath" | "connectedDeepLink" | "connectedFallbackHref" | "persistConnection" | "captureConnected">,
): OAuthRouteAdapter => ({
  displayName: adapter.displayName,
  notConfiguredTag: adapter.notConfiguredTag,
  isConfigured: adapter.isConfigured,
  mintState: adapter.mintState,
  verifyState: adapter.verifyState,
  authorizeUrl: adapter.authorizeUrl,
  exchangeCode: adapter.exchangeCode,
  ...rest,
});

/** Identify + store + un-pause, for a CRM provider. */
const crmPersist =
  (provider: CrmProvider, identifySelf: (session: CrmSession) => Effect.Effect<
    { readonly workspaceId: string; readonly workspaceName: string },
    unknown,
    AppServices
  >) =>
  (args: PersistConnectionArgs): Effect.Effect<string, unknown, AppServices> =>
    Effect.gen(function* () {
      const connection = yield* CrmConnectionService;
      const bindings = yield* CrmBindingRepo;
      // A throwaway session: `identifySelf` only needs a token, and persisting a
      // rotation mid-identify would be pointless — we store the tokens below.
      const session: CrmSession = {
        workspaceId: args.workspaceId,
        tokens: args.tokens,
        persist: () => Effect.void,
      };
      const self = yield* identifySelf(session);
      yield* connection.saveConnection({
        workspaceId: args.workspaceId,
        provider,
        tokens: args.tokens,
        meta: {
          connectedByUserId: args.userId,
          connectedByName: args.connectedByName,
          crmWorkspaceId: self.workspaceId,
          crmWorkspaceName: self.workspaceName,
        },
      });
      // Reconnecting resolves a revoked-auth pause (NOT source_gone — a deleted
      // source isn't fixed by re-authing).
      yield* bindings.clearPause({ workspaceId: args.workspaceId, provider, reason: "auth_revoked" });
      return self.workspaceName;
    });

export const ATTIO_OAUTH: OAuthRouteAdapter = routeAdapter(ATTIO_ADAPTER, {
  authorizePath: "/api/crm/attio/authorize",
  connectedDeepLink: "gtmgrid://open/crm-connected",
  connectedFallbackHref: "/open?to=crm-connected",
  persistConnection: crmPersist("attio", (session) =>
    Effect.flatMap(AttioClient, (c) => c.identifySelf(session)),
  ),
  captureConnected: ({ userId, workspaceId }) =>
    captureServer("crm_connected", {
      distinctId: userId,
      properties: { provider: "attio", workspace_id: workspaceId },
      groups: { workspace: workspaceId },
    }),
});

export const HUBSPOT_OAUTH: OAuthRouteAdapter = routeAdapter(HUBSPOT_ADAPTER, {
  authorizePath: "/api/crm/hubspot/authorize",
  connectedDeepLink: "gtmgrid://open/crm-connected",
  connectedFallbackHref: "/open?to=crm-connected",
  persistConnection: crmPersist("hubspot", (session) =>
    Effect.flatMap(HubspotClient, (c) => c.identifySelf(session)),
  ),
  captureConnected: ({ userId, workspaceId }) =>
    captureServer("crm_connected", {
      distinctId: userId,
      properties: { provider: "hubspot", workspace_id: workspaceId },
      groups: { workspace: workspaceId },
    }),
});

/**
 * Slack. Note how much SMALLER this is than a CRM: no bindings to un-pause, no
 * sync client to identify with. `oauth.v2.access` already returns the team id +
 * name (carried on `tokens.extra` by `SLACK_SPEC.parseTokens`), so there is no
 * second identify round trip either.
 */
export const SLACK_OAUTH: OAuthRouteAdapter = routeAdapter(SLACK_ADAPTER, {
  authorizePath: "/api/oauth/slack/authorize",
  /**
   * Focus the app, don't navigate. `crm-connected` exists so an OPEN CRM wizard
   * can skip its 2s poll and advance immediately; Slack has no wizard — its
   * OAuthConnectCard polls and converges on its own. A `slack-connected`
   * destination would have to be added to THREE allowlists (app/open's DEST_RE,
   * deepLinkNav's DeepLinkTarget, App.tsx's switch) to do nothing extra, and
   * until it was in all three the link was simply dead.
   */
  connectedDeepLink: "gtmgrid://open",
  connectedFallbackHref: "/open",
  persistConnection: (args) =>
    Effect.gen(function* () {
      const connection = yield* SlackConnectionService;
      const extra = args.tokens.extra ?? {};
      const teamName = extra.teamName ?? "";
      yield* connection.saveConnection({
        workspaceId: args.workspaceId,
        tokens: args.tokens,
        meta: {
          connectedByUserId: args.userId,
          connectedByName: args.connectedByName,
          teamId: extra.teamId ?? "",
          teamName,
          botUserId: extra.botUserId ?? "",
        },
      });
      return teamName;
    }),
  captureConnected: ({ userId, workspaceId }) =>
    captureServer("slack_connected", {
      distinctId: userId,
      properties: { workspace_id: workspaceId },
      groups: { workspace: workspaceId },
    }),
});

/**
 * Read the connected Google account's email.
 *
 * A best-effort side quest, deliberately: a failure returns "" and the
 * connection still saves. The alternative — failing the callback — would throw
 * away a successfully exchanged grant (and burn the one-time code) over a
 * cosmetic label, forcing the user through consent again for nothing.
 *
 * `email` is not vanity. Users routinely have a personal and a work Google
 * account signed in at once, and a card reading "Connected to Google" with no
 * address gives them no way to notice they authorised the wrong one — which
 * surfaces much later as "why can't it see my spreadsheet?".
 */
const googleAccountEmail = (accessToken: string): Effect.Effect<string> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(GOOGLE_USERINFO_URL, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return "";
      const body: unknown = await res.json();
      const email = typeof body === "object" && body !== null ? Reflect.get(body, "email") : undefined;
      return typeof email === "string" ? email : "";
    },
    catch: () => new CrmSyncError({ message: "google userinfo failed" }),
  }).pipe(Effect.orElseSucceed(() => ""));

/**
 * Google. Smaller than a CRM for the same reasons as Slack, with one difference:
 * the grant alone is not enough to DO anything.
 *
 * Under `drive.file` no spreadsheet is readable until the user selects it in the
 * Google Picker, so a freshly connected workspace legitimately reaches zero
 * files. Picking is therefore NOT chained onto this callback — it is a separate,
 * repeatable action from the connect card, which also lets a user add sheets
 * later without re-running consent.
 *
 * `pickedFiles` starts EMPTY on every fresh consent. A new grant does not
 * guarantee the previous per-file authorisations carry across it, so restoring
 * an old list would advertise access we may no longer hold.
 */
export const GOOGLE_OAUTH: OAuthRouteAdapter = routeAdapter(GOOGLE_ADAPTER, {
  authorizePath: "/api/oauth/google/authorize",
  // Focus the app; the connect card's poll converges on its own. Same reasoning
  // as Slack — a bespoke deep-link target would need three allowlist entries to
  // do nothing extra.
  connectedDeepLink: "gtmgrid://open",
  connectedFallbackHref: "/open",
  persistConnection: (args) =>
    Effect.gen(function* () {
      const connection = yield* GoogleConnectionService;
      const googleEmail = yield* googleAccountEmail(args.tokens.accessToken);
      yield* connection.saveConnection({
        workspaceId: args.workspaceId,
        tokens: args.tokens,
        meta: {
          connectedByUserId: args.userId,
          connectedByName: args.connectedByName,
          googleEmail,
          pickedFiles: [],
        },
      });
      // The success page names the account, which is the only identity Google
      // gives us without a second, more-privileged scope.
      return googleEmail;
    }),
  captureConnected: ({ userId, workspaceId }) =>
    captureServer("google_connected", {
      distinctId: userId,
      properties: { workspace_id: workspaceId },
      groups: { workspace: workspaceId },
    }),
});

/**
 * Provider → adapter. A `Record`, not a ternary.
 *
 * The previous `provider === "hubspot" ? HUBSPOT_OAUTH : ATTIO_OAUTH` routed
 * EVERY non-hubspot value to Attio, so a typo'd or newly-added provider silently
 * ran the Attio handshake instead of failing.
 */
export const OAUTH_ADAPTERS: Readonly<Record<string, OAuthRouteAdapter>> = {
  attio: ATTIO_OAUTH,
  hubspot: HUBSPOT_OAUTH,
  slack: SLACK_OAUTH,
  google: GOOGLE_OAUTH,
};

/** The CRM subset, for callers whose provider is a `CrmProvider`. */
export const oauthAdapterFor = (provider: CrmProvider): OAuthRouteAdapter => OAUTH_ADAPTERS[provider];


/**
 * Mint a state and build the provider's authorize URL, as ONE step.
 *
 * The desktop needs this because its auth is bearer-based: an `openExternal`
 * browser navigation carries no gtmgrid.dev cookie, so the web authorize
 * route's session gate would dead-end the flow. The signed state IS the trust
 * for the callback; the browser needs no session at all.
 *
 * This replaces two ~20-line `Effect.gen` blocks in the tRPC router that
 * differed only by which service they resolved and which literal tag they
 * caught. The not-configured error is narrowed by `"missing" in e` rather than
 * by a literal `catchTag`, since the tag is per-provider data here — every
 * provider's not-configured error shares that payload and no other OAuth error
 * carries the key.
 */
export const authorizeUrlWithState = (
  adapter: OAuthRouteAdapter,
  claims: CrmOAuthClaims,
): Effect.Effect<string, CrmSyncError, AppServices> =>
  Effect.gen(function* () {
    const state = yield* adapter.mintState(claims);
    if (state === null) {
      return yield* Effect.fail(
        new CrmSyncError({ message: "OAuth state signing unavailable (no BETTER_AUTH_SECRET)" }),
      );
    }
    return yield* adapter.authorizeUrl(state).pipe(
      Effect.mapError((e) =>
        typeof e === "object" && e !== null && "missing" in e
          ? new CrmSyncError({
              message: `${adapter.displayName} OAuth env missing: ${String(Reflect.get(e, "missing"))}`,
            })
          : new CrmSyncError({ message: `Could not build the ${adapter.displayName} authorize URL`, cause: e }),
      ),
    );
  });
