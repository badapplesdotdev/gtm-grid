/**
 * `CrmAuthRegistry` — provider → token refresh (TRI: crm-sync). The one
 * OAuth-protocol capability the CONNECTION layer needs (proactive refresh at
 * session mint); the full per-provider auth surfaces (authorize URL, state,
 * code exchange) stay on `AttioAuth`/`HubspotAuth` for the web routes.
 *
 * "OAuth not configured" maps to {@link CrmAuthRevoked} here — from a running
 * sync's perspective an unconfigured provider IS a dead connection.
 */

import { Effect } from "effect";
import { CrmAuthRevoked, type CrmError } from "../crm/errors.js";
import { CRM_DISPLAY_NAMES, type CrmProvider, type CrmTokens } from "./crm-client.js";
import { AttioAuth } from "./attio-auth.js";
import { HubspotAuth } from "./hubspot-auth.js";

export class CrmAuthRegistry extends Effect.Service<CrmAuthRegistry>()("CrmAuthRegistry", {
  effect: Effect.gen(function* () {
    const attio = yield* AttioAuth;
    const hubspot = yield* HubspotAuth;
    return {
      refresh: (provider: CrmProvider, refreshToken: string): Effect.Effect<CrmTokens, CrmError> =>
        provider === "hubspot"
          ? hubspot.refresh(refreshToken).pipe(
              Effect.mapError((e) =>
                e._tag === "HubspotOAuthNotConfigured"
                  ? new CrmAuthRevoked({
                      provider: CRM_DISPLAY_NAMES.hubspot,
                      detail: `OAuth not configured: ${e.missing}`,
                    })
                  : e,
              ),
            )
          : attio.refresh(refreshToken).pipe(
              Effect.mapError((e) =>
                e._tag === "AttioOAuthNotConfigured"
                  ? new CrmAuthRevoked({
                      provider: CRM_DISPLAY_NAMES.attio,
                      detail: `OAuth not configured: ${e.missing}`,
                    })
                  : e,
              ),
            ),
    } as const;
  }),
  dependencies: [],
}) {}
