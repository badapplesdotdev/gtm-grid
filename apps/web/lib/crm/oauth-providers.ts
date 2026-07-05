/**
 * Per-provider OAuth adapters for the shared route cores (TRI: crm-sync).
 * `crm-authorize.ts` / `crm-callback.ts` are provider-agnostic — everything
 * provider-specific (which auth service, which client, which copy name, which
 * not-configured tag) lives here, so a new CRM is one more adapter + two thin
 * routes.
 */

import {
  type AppServices,
  AttioAuth,
  AttioClient,
  type CrmProvider,
  type CrmSession,
  type CrmTokens,
  HubspotAuth,
  HubspotClient,
} from "@gtmgrid/services";
import { Effect } from "effect";

export interface CrmOAuthClaims {
  readonly workspaceId: string;
  readonly userId: string;
}

export interface CrmOAuthAdapter {
  readonly provider: CrmProvider;
  /** User-facing product name for page copy ("Attio", "HubSpot"). */
  readonly displayName: string;
  /** The auth service's not-configured error tag (drives the setup page). */
  readonly notConfiguredTag: string;
  readonly mintState: (claims: CrmOAuthClaims) => Effect.Effect<string | null, never, AppServices>;
  readonly verifyState: (token: string) => Effect.Effect<CrmOAuthClaims | null, never, AppServices>;
  readonly authorizeUrl: (state: string) => Effect.Effect<string, unknown, AppServices>;
  readonly exchangeCode: (code: string) => Effect.Effect<CrmTokens, unknown, AppServices>;
  readonly identifySelf: (
    session: CrmSession,
  ) => Effect.Effect<{ readonly workspaceId: string; readonly workspaceName: string }, unknown, AppServices>;
}

export const ATTIO_OAUTH: CrmOAuthAdapter = {
  provider: "attio",
  displayName: "Attio",
  notConfiguredTag: "AttioOAuthNotConfigured",
  mintState: (claims) => Effect.flatMap(AttioAuth, (a) => a.mintState(claims)),
  verifyState: (token) => Effect.flatMap(AttioAuth, (a) => a.verifyState(token)),
  authorizeUrl: (state) => Effect.flatMap(AttioAuth, (a) => a.authorizeUrl(state)),
  exchangeCode: (code) => Effect.flatMap(AttioAuth, (a) => a.exchangeCode(code)),
  identifySelf: (session) => Effect.flatMap(AttioClient, (c) => c.identifySelf(session)),
};

export const HUBSPOT_OAUTH: CrmOAuthAdapter = {
  provider: "hubspot",
  displayName: "HubSpot",
  notConfiguredTag: "HubspotOAuthNotConfigured",
  mintState: (claims) => Effect.flatMap(HubspotAuth, (a) => a.mintState(claims)),
  verifyState: (token) => Effect.flatMap(HubspotAuth, (a) => a.verifyState(token)),
  authorizeUrl: (state) => Effect.flatMap(HubspotAuth, (a) => a.authorizeUrl(state)),
  exchangeCode: (code) => Effect.flatMap(HubspotAuth, (a) => a.exchangeCode(code)),
  identifySelf: (session) => Effect.flatMap(HubspotClient, (c) => c.identifySelf(session)),
};

export const oauthAdapterFor = (provider: CrmProvider): CrmOAuthAdapter =>
  provider === "hubspot" ? HUBSPOT_OAUTH : ATTIO_OAUTH;
