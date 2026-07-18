/**
 * `HubspotAuth` — the OAuth 2.0 handshake with HubSpot (TRI: crm-sync).
 *
 * The protocol mechanics now live in `oauth/oauth-core.ts`; this file is the
 * HubSpot-specific DATA plus the service wrapper that keeps `HubspotAuth` in the
 * `AppServices` union. Token STORAGE belongs to {@link CrmConnectionService};
 * HTTP calls with a token belong to {@link HubspotClient}.
 *
 * Unlike Attio, HubSpot's token lifecycle is DOCUMENTED: access tokens expire
 * (~30 minutes, `expires_in` always returned) and the refresh token is
 * long-lived. That used to be a doc comment; it is now
 * {@link RefreshPolicy.Proactive} — refresh ahead of expiry, with the 401 as the
 * backstop. Proactive rather than Rotating because HubSpot's refresh tokens are
 * REUSABLE: a redundant refresh is harmless, so no locking is required.
 */

import { Data, Effect } from "effect";
import { makeAdapter } from "../oauth/adapter.js";
import {
  REFRESH_SKEW_MS,
  RefreshPolicy,
  type OAuthProviderSpec,
  type OAuthStateClaims,
} from "../oauth/types.js";

/** Claims bound into an OAuth `state` token. Alias of the shared shape. */
export type HubspotOAuthState = OAuthStateClaims;

/** Raised when the OAuth env (client id/secret) is not configured. */
export class HubspotOAuthNotConfigured extends Data.TaggedError("HubspotOAuthNotConfigured")<{
  readonly missing: string;
}> {}

/**
 * Scopes for v1: OAuth identity + read-only contacts, companies, lists, and
 * owner names. Must stay in lockstep with the app definition's requiredScopes
 * (integrations/hubspot-app/src/app/app-hsmeta.json) — HubSpot rejects an
 * authorize URL whose `scope` param doesn't cover the app's required scopes.
 */
export const HUBSPOT_SCOPES = [
  "oauth",
  "crm.objects.contacts.read",
  "crm.objects.companies.read",
  "crm.lists.read",
  "crm.objects.owners.read",
] as const;

/** Everything provider-specific about HubSpot, as data. */
export const HUBSPOT_SPEC: OAuthProviderSpec<HubspotOAuthNotConfigured> = {
  id: "hubspot",
  displayName: "HubSpot",
  notConfiguredTag: "HubspotOAuthNotConfigured",
  refreshPolicy: RefreshPolicy.Proactive(REFRESH_SKEW_MS),
  authorizeUrl: "https://app.hubspot.com/oauth/authorize",
  tokenUrl: "https://api.hubapi.com/oauth/v1/token",
  scopes: HUBSPOT_SCOPES,
  scopeSeparator: " ",
  clientIdEnv: "HUBSPOT_CLIENT_ID",
  clientSecretEnv: "HUBSPOT_CLIENT_SECRET",
  stateSecretEnv: "HUBSPOT_OAUTH_SECRET",
  redirectPath: "/api/crm/hubspot/callback",
  notConfigured: (missing) => new HubspotOAuthNotConfigured({ missing }),
};

/** The HubSpot adapter. Usable without the Effect service (no requirements). */
export const HUBSPOT_ADAPTER = makeAdapter(HUBSPOT_SPEC);

/**
 * Service wrapper. `HubspotAuth` stays a `Effect.Service` because it is part of
 * the `AppServices` union and every existing call site resolves it from the
 * runtime; the adapter underneath is what actually does the work.
 */
export class HubspotAuth extends Effect.Service<HubspotAuth>()("HubspotAuth", {
  effect: Effect.succeed(HUBSPOT_ADAPTER),
  dependencies: [],
}) {}
