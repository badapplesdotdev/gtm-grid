/**
 * `OAuthAdapter` — one provider's complete OAuth surface, built from a spec
 * (TRI: oauth-adapter).
 *
 * The seam this replaces existed only half-way. `apps/web/lib/crm/oauth-providers.ts`
 * abstracted the WEB ROUTE layer (`CrmOAuthAdapter`), but every other consumer
 * still branched on the provider by hand — `oauthAdapterFor`'s ternary,
 * `CrmAuthRegistry`'s duplicated mapError arms, and two `connectionStatus` /
 * `authorizeUrl` blocks in the tRPC router. Adding a third provider meant
 * touching five places and hoping you found them all. `makeAdapter` + a registry
 * map means a provider is one spec.
 *
 * Deliberately `R = never`: an adapter is protocol mechanics over env + fetch,
 * nothing more. Anything needing services — `identifySelf` (which needs the
 * provider's HTTP client) or token STORAGE — composes on top rather than
 * leaking a requirement into every call site. That is what lets the same adapter
 * serve the web routes, the sync loop, and the token service unchanged.
 */

import { Effect } from "effect";
import type { OAuthProtocolError } from "./errors.js";
import { authorizeUrl, isConfigured, mintState, tokenRequest, verifyState } from "./oauth-core.js";
import type {
  OAuthNotConfiguredError,
  OAuthProviderSpec,
  OAuthStateClaims,
  OAuthTokens,
  RefreshPolicy,
} from "./types.js";

/**
 * The uniform provider surface. `E` is the provider's not-configured error.
 *
 * Method names match the pre-refactor `AttioAuth`/`HubspotAuth` services on
 * purpose, so migrating them (step 03) is a re-implementation rather than a
 * rename cascade across their call sites and tests.
 */
export interface OAuthAdapter<E extends OAuthNotConfiguredError> {
  /** Stable id; doubles as the credential slot, so it MUST match the connector id. */
  readonly id: string;
  /** User-facing product name for page copy ("Attio", "HubSpot", "Slack"). */
  readonly displayName: string;
  /** The `_tag` of this provider's not-configured error (drives the setup page). */
  readonly notConfiguredTag: string;
  /** When and how this provider's tokens must be renewed. Data, not prose. */
  readonly refreshPolicy: RefreshPolicy;
  /** Whether the OAuth app env is configured (drives UI affordances). */
  readonly isConfigured: () => Effect.Effect<boolean>;
  /** Mint the signed OAuth state; null when no signing secret exists. */
  readonly mintState: (claims: OAuthStateClaims) => Effect.Effect<string | null>;
  /** Verify a state token (signature + TTL); null on any mismatch. */
  readonly verifyState: (token: string) => Effect.Effect<OAuthStateClaims | null>;
  /** The provider's authorize URL for a signed state. */
  readonly authorizeUrl: (state: string) => Effect.Effect<string, E>;
  /** Exchange an authorization code for tokens. */
  readonly exchangeCode: (code: string) => Effect.Effect<OAuthTokens, E | OAuthProtocolError>;
  /** Refresh an access token. Refusal = the connection is dead (CrmAuthRevoked). */
  readonly refresh: (refreshToken: string) => Effect.Effect<OAuthTokens, E | OAuthProtocolError>;
}

/** Build a provider's adapter from its spec. Pure: no services, no I/O until called. */
export const makeAdapter = <E extends OAuthNotConfiguredError>(spec: OAuthProviderSpec<E>): OAuthAdapter<E> => ({
  id: spec.id,
  displayName: spec.displayName,
  notConfiguredTag: spec.notConfiguredTag,
  refreshPolicy: spec.refreshPolicy,
  isConfigured: () => isConfigured(spec),
  mintState: (claims) => mintState(spec, claims),
  verifyState: (token) => verifyState(spec, token),
  authorizeUrl: (state) => authorizeUrl(spec, state),
  exchangeCode: (code) => tokenRequest(spec, { grant_type: "authorization_code", code }, "exchange"),
  refresh: (refreshToken) =>
    tokenRequest(spec, { grant_type: "refresh_token", refresh_token: refreshToken }, "refresh"),
});

/**
 * Look an adapter up by provider id.
 *
 * A `Record` rather than the `provider === "hubspot" ? … : …` ternary it
 * replaces: a ternary silently routes an UNKNOWN provider to whichever branch
 * happens to be the fallback (`oauthAdapterFor` sent anything not "hubspot" to
 * Attio, so a typo'd provider would have run the Attio handshake), whereas a
 * map's miss is `undefined` and the caller must decide.
 */
export const adapterFor = <E extends OAuthNotConfiguredError>(
  registry: Readonly<Record<string, OAuthAdapter<E>>>,
  provider: string,
): OAuthAdapter<E> | undefined => registry[provider];
