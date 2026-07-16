/**
 * `AttioAuth` — the OAuth 2.0 handshake with Attio (TRI: crm-sync).
 *
 * The protocol mechanics now live in `oauth/oauth-core.ts`; this file is the
 * Attio-specific DATA plus the service wrapper that keeps `AttioAuth` in the
 * `AppServices` union. Token STORAGE belongs to {@link CrmConnectionService};
 * HTTP calls with a token belong to {@link AttioClient}.
 *
 * Attio's public docs leave the token lifecycle ambiguous (expiring + refresh vs
 * long-lived) and it frequently omits `expires_in`.
 *
 * That ambiguity is honoured by DATA, not by a policy arm: the lifecycle is
 * {@link RefreshPolicy.Proactive} — the same as HubSpot, and exactly what the
 * pre-refactor `CrmConnectionService` did for every provider — while
 * `needsRefresh` declines to refresh a token that carries no `expiresAtMs`. So
 * an Attio token WITHOUT an expiry falls through to the client's 401 backstop,
 * and one WITH an expiry still refreshes up front, which is the behaviour
 * `crm-connection-service.test.ts` has always pinned.
 */

import { Data, Effect } from "effect";
import { makeAdapter } from "../oauth/adapter.js";
import {
  REFRESH_SKEW_MS,
  RefreshPolicy,
  type OAuthProviderSpec,
  type OAuthStateClaims,
  type OAuthTokens,
} from "../oauth/types.js";

/**
 * Tokens for one workspace's Attio connection.
 *
 * Structurally identical to {@link OAuthTokens} (and to `CrmTokens`) — it was a
 * third copy of the same three fields. Kept as an alias so existing call sites
 * (`attio-client.ts`, its tests) keep reading naturally.
 */
export type AttioTokens = OAuthTokens;

/** Claims bound into an OAuth `state` token. Alias of the shared shape. */
export type AttioOAuthState = OAuthStateClaims;

/** Raised when the OAuth env (client id/secret) is not configured. */
export class AttioOAuthNotConfigured extends Data.TaggedError("AttioOAuthNotConfigured")<{
  readonly missing: string;
}> {}

/**
 * Everything provider-specific about Attio, as data.
 *
 * Note the absence of `scopes`: Attio's authorize URL carries no `scope` param
 * at all, which the core expresses by simply omitting the field rather than by
 * a special case.
 */
export const ATTIO_SPEC: OAuthProviderSpec<AttioOAuthNotConfigured> = {
  id: "attio",
  displayName: "Attio",
  notConfiguredTag: "AttioOAuthNotConfigured",
  refreshPolicy: RefreshPolicy.Proactive(REFRESH_SKEW_MS),
  authorizeUrl: "https://app.attio.com/authorize",
  tokenUrl: "https://app.attio.com/oauth/token",
  clientIdEnv: "ATTIO_CLIENT_ID",
  clientSecretEnv: "ATTIO_CLIENT_SECRET",
  stateSecretEnv: "ATTIO_OAUTH_SECRET",
  redirectPath: "/api/crm/attio/callback",
  notConfigured: (missing) => new AttioOAuthNotConfigured({ missing }),
};

/** The Attio adapter. Usable without the Effect service (no requirements). */
export const ATTIO_ADAPTER = makeAdapter(ATTIO_SPEC);

/**
 * Service wrapper. `AttioAuth` stays a `Effect.Service` because it is part of
 * the `AppServices` union and every existing call site resolves it from the
 * runtime; the adapter underneath is what actually does the work.
 */
export class AttioAuth extends Effect.Service<AttioAuth>()("AttioAuth", {
  effect: Effect.succeed(ATTIO_ADAPTER),
  dependencies: [],
}) {}
