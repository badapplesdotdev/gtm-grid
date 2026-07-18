/**
 * `CrmAuthRegistry` — provider → token refresh (TRI: crm-sync). The one
 * OAuth-protocol capability the CONNECTION layer needs (proactive refresh at
 * session mint); the full per-provider auth surfaces (authorize URL, state,
 * code exchange) stay on the adapters for the web routes.
 *
 * "OAuth not configured" maps to {@link CrmAuthRevoked} here — from a running
 * sync's perspective an unconfigured provider IS a dead connection.
 *
 * This used to be a `provider === "hubspot" ? … : …` ternary wrapping two
 * byte-identical `mapError` blocks. It is now a map plus ONE arm: the adapter
 * carries its own `displayName`, so the copy comes from data rather than from a
 * branch, and a fourth provider is a map entry rather than another else-if.
 */

import { Effect } from "effect";
import { CrmAuthRevoked, type CrmError } from "../crm/errors.js";
import type { OAuthAdapter } from "../oauth/adapter.js";
import type { OAuthNotConfiguredError, OAuthTokens, RefreshPolicy } from "../oauth/types.js";
import { type CrmProvider, type CrmTokens } from "./crm-client.js";
import { AttioAuth } from "./attio-auth.js";
import { HubspotAuth } from "./hubspot-auth.js";

/**
 * Refresh via `adapter`, translating its not-configured error into a dead
 * connection.
 *
 * The adapter is widened to `OAuthAdapter<OAuthNotConfiguredError>` (safe: `E`
 * is covariant, appearing only in the error channel) so that inside this
 * function the failure is a CONCRETE union and `"missing" in e` narrows it. That
 * is what collapses per-provider arms into one: every provider's
 * not-configured error shares the `missing` payload, and no other
 * `OAuthProtocolError` has that key.
 */
const refreshOrRevoked = (
  adapter: OAuthAdapter<OAuthNotConfiguredError>,
  refreshToken: string,
): Effect.Effect<OAuthTokens, CrmError> =>
  adapter.refresh(refreshToken).pipe(
    Effect.mapError((e): CrmError =>
      "missing" in e
        ? new CrmAuthRevoked({
            provider: adapter.displayName,
            detail: `OAuth not configured: ${e.missing}`,
          })
        : e,
    ),
  );

export class CrmAuthRegistry extends Effect.Service<CrmAuthRegistry>()("CrmAuthRegistry", {
  effect: Effect.gen(function* () {
    const attio = yield* AttioAuth;
    const hubspot = yield* HubspotAuth;

    /**
     * A map, not a ternary. The old `oauthAdapterFor` sent ANY provider that
     * wasn't "hubspot" to Attio, so a typo'd id silently ran the wrong
     * handshake; `Record<CrmProvider, …>` makes the compiler enumerate the
     * providers instead.
     */
    const adapters: Record<CrmProvider, OAuthAdapter<OAuthNotConfiguredError>> = { attio, hubspot };

    return {
      refresh: (provider: CrmProvider, refreshToken: string): Effect.Effect<CrmTokens, CrmError> =>
        refreshOrRevoked(adapters[provider], refreshToken),
      /**
       * The provider's token lifecycle, as data. The connection layer needs this
       * to decide WHETHER to refresh (and whether that refresh must be
       * serialized) without knowing which provider it is holding.
       */
      policyFor: (provider: CrmProvider): RefreshPolicy => adapters[provider].refreshPolicy,
    } as const;
  }),
  dependencies: [],
}) {}
