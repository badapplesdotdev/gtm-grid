/**
 * `HubspotAuth` — the OAuth 2.0 handshake with HubSpot (TRI: crm-sync). Pure
 * protocol, mirroring {@link AttioAuth}: build the authorize URL, mint/verify
 * the signed `state` parameter, exchange an authorization code, refresh an
 * access token. Token STORAGE belongs to {@link CrmConnectionService}; HTTP
 * calls with a token belong to {@link HubspotClient}.
 *
 * State tokens are HMAC-signed (BETTER_AUTH_SECRET, `HUBSPOT_OAUTH_SECRET`
 * override) binding `(workspaceId, userId, issuedAt)` with a 15-minute TTL —
 * the CSRF defense for the callback.
 *
 * Unlike Attio, HubSpot's token lifecycle is DOCUMENTED: access tokens expire
 * (~30 minutes, `expires_in` always returned) and the refresh token is
 * long-lived — so `expiresAtMs` is always set and proactive refresh
 * (CrmConnectionService.sessionFrom) is the primary path, with refresh-on-401
 * as the backstop.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { Data, Effect } from "effect";
import { CrmAuthRevoked, CrmNetworkError, CrmServerError, CrmSyncError } from "../crm/errors.js";
import type { CrmTokens } from "./crm-client.js";

/** Claims bound into an OAuth `state` token. */
export interface HubspotOAuthState {
  readonly workspaceId: string;
  readonly userId: string;
}

/** Raised when the OAuth env (client id/secret) is not configured. */
export class HubspotOAuthNotConfigured extends Data.TaggedError("HubspotOAuthNotConfigured")<{
  readonly missing: string;
}> {}

const AUTHORIZE_URL = "https://app.hubspot.com/oauth/authorize";
const TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";
const STATE_TTL_MS = 15 * 60 * 1000;

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

const stateSecret = (): string | null =>
  process.env.HUBSPOT_OAUTH_SECRET ?? process.env.BETTER_AUTH_SECRET ?? null;

const sign = (payload: string, key: string): string =>
  createHmac("sha256", key).update(payload).digest("base64url");

interface TokenResponse {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
}

export class HubspotAuth extends Effect.Service<HubspotAuth>()("HubspotAuth", {
  effect: Effect.gen(function* () {
    const env = () =>
      Effect.gen(function* () {
        const clientId = process.env.HUBSPOT_CLIENT_ID ?? "";
        const clientSecret = process.env.HUBSPOT_CLIENT_SECRET ?? "";
        if (!clientId) return yield* Effect.fail(new HubspotOAuthNotConfigured({ missing: "HUBSPOT_CLIENT_ID" }));
        if (!clientSecret)
          return yield* Effect.fail(new HubspotOAuthNotConfigured({ missing: "HUBSPOT_CLIENT_SECRET" }));
        const site = process.env.SITE_URL ?? "https://www.gtmgrid.dev";
        return { clientId, clientSecret, redirectUri: `${site}/api/crm/hubspot/callback` };
      });

    /**
     * POST the token endpoint with form-encoded `params`. Grant refusals
     * (4xx) are {@link CrmAuthRevoked} — for a code exchange that means the
     * code was bad/expired; for a refresh it means the connection is dead.
     */
    const tokenRequest = (params: Record<string, string>) =>
      Effect.gen(function* () {
        const { clientId, clientSecret, redirectUri } = yield* env();
        const res = yield* Effect.tryPromise({
          try: () =>
            fetch(TOKEN_URL, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectUri,
                ...params,
              }).toString(),
            }),
          catch: (cause) => new CrmNetworkError({ provider: "HubSpot", cause }),
        });
        if (res.status >= 500) return yield* Effect.fail(new CrmServerError({ provider: "HubSpot", status: res.status }));
        if (!res.ok) {
          const detail = yield* Effect.tryPromise({ try: () => res.text(), catch: () => new CrmNetworkError({ provider: "HubSpot", cause: "unreadable token error body" }) }).pipe(
            Effect.orElseSucceed(() => ""),
          );
          return yield* Effect.fail(new CrmAuthRevoked({ provider: "HubSpot", detail: detail.slice(0, 500) }));
        }
        const body = yield* Effect.tryPromise({
          try: () => res.json() as Promise<TokenResponse>,
          catch: (cause) => new CrmNetworkError({ provider: "HubSpot", cause }),
        });
        const accessToken = body.access_token ?? "";
        if (!accessToken) {
          return yield* Effect.fail(new CrmSyncError({ message: "HubSpot token response had no access_token" }));
        }
        const tokens: CrmTokens = {
          accessToken,
          ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
          ...(typeof body.expires_in === "number"
            ? { expiresAtMs: Date.now() + body.expires_in * 1000 }
            : {}),
        };
        return tokens;
      });

    return {
      /** Whether the HubSpot OAuth app env is configured (drives UI affordances). */
      isConfigured: () => Effect.sync(() => Boolean(process.env.HUBSPOT_CLIENT_ID && process.env.HUBSPOT_CLIENT_SECRET)),

      /** The HubSpot authorize URL for a signed state (space-separated scopes). */
      authorizeUrl: (state: string) =>
        Effect.gen(function* () {
          const { clientId, redirectUri } = yield* env();
          const url = new URL(AUTHORIZE_URL);
          url.searchParams.set("client_id", clientId);
          url.searchParams.set("redirect_uri", redirectUri);
          url.searchParams.set("scope", HUBSPOT_SCOPES.join(" "));
          url.searchParams.set("response_type", "code");
          url.searchParams.set("state", state);
          return url.toString();
        }),

      /** Mint the signed OAuth state for `(workspaceId, userId)`; null when unsigned. */
      mintState: (claims: HubspotOAuthState) =>
        Effect.sync(() => {
          const key = stateSecret();
          if (!key) return null;
          const payload = `${claims.workspaceId}\n${claims.userId}\n${Date.now()}`;
          return `${Buffer.from(payload, "utf8").toString("base64url")}.${sign(payload, key)}`;
        }),

      /** Verify a state token (signature + TTL); null on any mismatch. */
      verifyState: (token: string) =>
        Effect.sync((): HubspotOAuthState | null => {
          const key = stateSecret();
          if (!key) return null;
          const [body, mac] = token.split(".");
          if (!body || !mac) return null;
          const payload = Buffer.from(body, "base64url").toString("utf8");
          const expected = sign(payload, key);
          const macBuf = Buffer.from(mac);
          const expBuf = Buffer.from(expected);
          if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf)) return null;
          const [workspaceId, userId, issuedAt] = payload.split("\n");
          if (!workspaceId || !userId || !issuedAt) return null;
          const ts = Number(issuedAt);
          if (!Number.isFinite(ts) || Date.now() - ts > STATE_TTL_MS) return null;
          return { workspaceId, userId };
        }),

      /** Exchange an authorization code for tokens. */
      exchangeCode: (code: string) => tokenRequest({ grant_type: "authorization_code", code }),

      /** Refresh an access token. Refusal = the connection is dead (CrmAuthRevoked). */
      refresh: (refreshToken: string) =>
        tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }),
    } as const;
  }),
  dependencies: [],
}) {}
