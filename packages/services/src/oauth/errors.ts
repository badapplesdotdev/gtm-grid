/**
 * Error vocabulary for the shared OAuth core (TRI: oauth-adapter).
 *
 * The token-endpoint path reuses the EXISTING `crm/errors.ts` tags rather than
 * minting a parallel set. That is deliberate, not laziness: those tags are
 * already provider-neutral by construction — each carries `provider` as a
 * DISPLAY string ("Attio", "HubSpot", "Slack"), and `crm/error-copy.ts` +
 * `isTransientCrmError` already map every tag to user copy and to the retry
 * policy. A second, structurally identical union would have to be threaded
 * through both of those, for no behavioural gain.
 *
 * The wart is the `Crm*` prefix on tags that now also describe Slack. Renaming
 * the union to `OAuthError` touches `error-copy.ts`, `isTransientCrmError`, and
 * every `catchTag` in the sync loop, so it is deliberately OUT of scope here and
 * tracked as a follow-up. Tags are load-bearing (tests and copy match on them);
 * changing them is a behaviour change, and steps 01–04 are a pure refactor.
 */

import type {
  CrmAuthRevoked,
  CrmNetworkError,
  CrmServerError,
  CrmSyncError,
} from "../crm/errors.js";

/**
 * Everything the shared token endpoint path can fail with, EXCLUDING the
 * per-provider "OAuth app not configured" error — that stays provider-specific
 * (`AttioOAuthNotConfigured`, `HubspotOAuthNotConfigured`, …) because the web
 * routes match on its exact tag to render the setup page, and is threaded
 * through the core as the `E` type parameter of {@link OAuthCoreSpec}.
 *
 * Grouping, mirroring how callers react:
 * - `CrmNetworkError` / `CrmServerError` → transient, retried with backoff.
 * - `CrmAuthRevoked`                     → the grant was refused; for a code
 *   exchange the code was bad/expired, for a refresh the connection is dead.
 * - `CrmSyncError`                       → the response parsed but carried no
 *   usable token (a protocol violation by the provider).
 */
export type OAuthProtocolError =
  | CrmAuthRevoked
  | CrmNetworkError
  | CrmServerError
  | CrmSyncError;
