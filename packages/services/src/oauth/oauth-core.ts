/**
 * `oauth-core` — the OAuth 2.0 protocol mechanics, once (TRI: oauth-adapter).
 *
 * `attio-auth.ts` and `hubspot-auth.ts` were ~95% byte-identical: `sign`,
 * `stateSecret`, `mintState`, `verifyState`, `env`, `tokenRequest` and
 * `isConfigured` differed only by two URLs, two env var names, the redirect
 * path, the display name, and whether a `scope` param was sent. Everything here
 * is that shared body, parameterised by an {@link OAuthCoreSpec}. A new provider
 * is a spec, not a copy.
 *
 * Scope is deliberately narrow: PROTOCOL only. Token STORAGE belongs to
 * `CrmConnectionService`; HTTP calls carrying a token belong to the per-provider
 * clients; token LIFECYCLE (when to refresh) is `RefreshPolicy` in `adapter.ts`.
 *
 * The state token format is load-bearing: a minted state has a 15-minute TTL, so
 * any format change breaks every IN-FLIGHT handshake at deploy — the user sees
 * the "link expired, try again" page and clicks Connect once more. That is the
 * known, bounded, self-healing cost of changing it, and it must be a deliberate
 * decision. `oauth-core.test.ts` pins the format against a fixture computed
 * independently of this implementation, so drift cannot happen by accident.
 *
 * It has been changed ONCE, deliberately:
 *   v1  `workspaceId\nuserId\nts`
 *   v2  `provider\nworkspaceId\nuserId\nts`  — see {@link mintState}
 * v2 exists because v1 was not bound to a provider, and every provider's state
 * secret falls back to the same `BETTER_AUTH_SECRET`, so ANY provider's state
 * verified on EVERY provider's callback. v1 states are rejected outright rather
 * than accepted for compatibility: a transition window would have kept the hole
 * open for exactly as long as it was worth exploiting, to spare a 15-minute
 * retry-once blip.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { Effect } from "effect";
import { CrmAuthRevoked, CrmNetworkError, CrmServerError, CrmSyncError } from "../crm/errors.js";
import type { OAuthProtocolError } from "./errors.js";
import type {
  OAuthCoreSpec,
  OAuthNotConfiguredError,
  OAuthStateClaims,
  OAuthTokens,
  TokenRequestKind,
} from "./types.js";

/** How long a minted `state` stays verifiable. Unchanged from the per-provider originals. */
export const STATE_TTL_MS = 15 * 60 * 1000;

/** Fallback when `SITE_URL` is unset, matching the pre-refactor default. */
const DEFAULT_SITE_URL = "https://www.gtmgrid.dev";

const sign = (payload: string, key: string): string =>
  createHmac("sha256", key).update(payload).digest("base64url");

/**
 * Env is read at CALL time, never hoisted to layer construction — the existing
 * tests stub env vars per-case and expect each call to observe the current
 * value.
 */
const stateSecret = <E extends OAuthNotConfiguredError>(spec: OAuthCoreSpec<E>): string | null =>
  process.env[spec.stateSecretEnv] ?? process.env.BETTER_AUTH_SECRET ?? null;

/** Resolve client credentials + redirect URI, failing closed when unconfigured. */
export const resolveEnv = <E extends OAuthNotConfiguredError>(spec: OAuthCoreSpec<E>) =>
  Effect.gen(function* () {
    const clientId = process.env[spec.clientIdEnv] ?? "";
    const clientSecret = process.env[spec.clientSecretEnv] ?? "";
    if (!clientId) return yield* Effect.fail(spec.notConfigured(spec.clientIdEnv));
    if (!clientSecret) return yield* Effect.fail(spec.notConfigured(spec.clientSecretEnv));
    const site = process.env.SITE_URL ?? DEFAULT_SITE_URL;
    return { clientId, clientSecret, redirectUri: `${site}${spec.redirectPath}` };
  });

/** Whether the provider's OAuth app env is configured (drives UI affordances). */
export const isConfigured = <E extends OAuthNotConfiguredError>(spec: OAuthCoreSpec<E>) =>
  Effect.sync(() => Boolean(process.env[spec.clientIdEnv] && process.env[spec.clientSecretEnv]));

/**
 * Mint the signed OAuth state for `(provider, workspaceId, userId)`; null when no
 * signing secret exists — callers render "not configured" rather than ever
 * emitting an UNSIGNED state, which would defeat the CSRF gate entirely.
 *
 * The PROVIDER ID IS IN THE PAYLOAD, and that is the point. Without it the
 * payload was `workspaceId\nuserId\nts`, and since every provider's
 * `stateSecretEnv` falls back to the same `BETTER_AUTH_SECRET`, a state minted
 * for an Attio handshake verified on the Slack and HubSpot callbacks — and vice
 * versa — for the full 15-minute TTL. These callbacks deliberately require NO
 * browser session (the desktop opens them with `openExternal`, which carries no
 * cookie), so the state is the entire trust boundary; it should not also be a
 * skeleton key across every other handshake.
 */
export const mintState = <E extends OAuthNotConfiguredError>(spec: OAuthCoreSpec<E>, claims: OAuthStateClaims) =>
  Effect.sync((): string | null => {
    const key = stateSecret(spec);
    if (!key) return null;
    const payload = `${spec.id}\n${claims.workspaceId}\n${claims.userId}\n${Date.now()}`;
    return `${Buffer.from(payload, "utf8").toString("base64url")}.${sign(payload, key)}`;
  });

/**
 * Verify a state token (provider + signature + TTL); null on ANY mismatch — a
 * single null-vs-throw surface keeps callers from distinguishing "forged" from
 * "expired" from "wrong provider", which is not information an attacker should
 * get.
 *
 * The provider check is belt AND braces: a cross-provider state already fails
 * here on the field compare, and would ALSO fail the MAC if the two providers
 * had distinct `stateSecretEnv` values set. The field compare is what holds when
 * they both fall back to `BETTER_AUTH_SECRET`, which is the default deployment.
 */
export const verifyState = <E extends OAuthNotConfiguredError>(spec: OAuthCoreSpec<E>, token: string) =>
  Effect.sync((): OAuthStateClaims | null => {
    const key = stateSecret(spec);
    if (!key) return null;
    const [body, mac] = token.split(".");
    if (!body || !mac) return null;
    const payload = Buffer.from(body, "base64url").toString("utf8");
    const expected = sign(payload, key);
    const macBuf = Buffer.from(mac);
    const expBuf = Buffer.from(expected);
    // Length-check FIRST: timingSafeEqual throws on a length mismatch.
    if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf)) return null;
    const [provider, workspaceId, userId, issuedAt] = payload.split("\n");
    if (!provider || !workspaceId || !userId || !issuedAt) return null;
    // A state minted for another provider's handshake is not valid here, even
    // though it is genuinely signed by us.
    if (provider !== spec.id) return null;
    const ts = Number(issuedAt);
    if (!Number.isFinite(ts) || Date.now() - ts > STATE_TTL_MS) return null;
    return { workspaceId, userId };
  });

/** The provider's authorize URL for a signed state. */
export const authorizeUrl = <E extends OAuthNotConfiguredError>(spec: OAuthCoreSpec<E>, state: string) =>
  Effect.gen(function* () {
    const { clientId, redirectUri } = yield* resolveEnv(spec);
    const url = new URL(spec.authorizeUrl);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    if (spec.scopes && spec.scopes.length > 0) {
      url.searchParams.set("scope", spec.scopes.join(spec.scopeSeparator ?? " "));
    }
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    return url.toString();
  });

interface TokenResponse {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
}

/**
 * Narrow an untrusted JSON body to the RFC 6749 fields we use.
 *
 * `res.json()` is `unknown`; the pre-refactor code reached for
 * `as Promise<TokenResponse>`, which is a lie the compiler can't check — a
 * provider returning `{"access_token": 123}` would have flowed a number into a
 * string-typed token and been stored. This is total instead: anything that
 * isn't the right primitive type is simply absent, so a malformed response
 * fails loudly as `CrmSyncError` rather than silently persisting garbage.
 */
const readTokenResponse = (raw: unknown): TokenResponse => {
  if (typeof raw !== "object" || raw === null) return {};
  const accessToken = Reflect.get(raw, "access_token");
  const refreshToken = Reflect.get(raw, "refresh_token");
  const expiresIn = Reflect.get(raw, "expires_in");
  return {
    ...(typeof accessToken === "string" ? { access_token: accessToken } : {}),
    ...(typeof refreshToken === "string" ? { refresh_token: refreshToken } : {}),
    ...(typeof expiresIn === "number" ? { expires_in: expiresIn } : {}),
  };
};

/**
 * Default parse of a token response: the plain RFC 6749 shape.
 *
 * Takes the RAW body rather than a pre-narrowed struct, because providers that
 * deviate need the untouched payload — Slack nests the bot token under
 * `authed_user` on exchange, returns a flat shape on refresh, and signals
 * failure with `ok:false` on an HTTP *200*. Those override this via
 * `parseTokens` on their spec (step 05).
 */
export const parseStandardTokens = (raw: unknown, displayName: string) =>
  Effect.gen(function* () {
    const body = readTokenResponse(raw);
    const accessToken = body.access_token ?? "";
    if (!accessToken) {
      return yield* Effect.fail(new CrmSyncError({ message: `${displayName} token response had no access_token` }));
    }
    const tokens: OAuthTokens = {
      accessToken,
      ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
      ...(typeof body.expires_in === "number" ? { expiresAtMs: Date.now() + body.expires_in * 1000 } : {}),
    };
    return tokens;
  });

/**
 * POST the token endpoint with form-encoded `params`, merged over the client
 * credentials + redirect URI.
 *
 * `redirect_uri` is sent on EVERY call, including refreshes. It is redundant per
 * RFC 6749 for a refresh grant, but Slack silently routes to the first
 * configured redirect URL when the param is absent and several are registered —
 * so sending it always is cheaper than remembering which providers need it.
 *
 * Grant refusals (4xx) are {@link CrmAuthRevoked}: for a code exchange that
 * means the code was bad/expired; for a refresh it means the connection is dead.
 *
 * `kind` is threaded through to `spec.parseTokens` because the same endpoint can
 * answer in different shapes per grant — Slack's `oauth.v2.access` nests the bot
 * token on exchange but returns it flat on refresh.
 */
export const tokenRequest = <E extends OAuthNotConfiguredError>(
  spec: OAuthCoreSpec<E>,
  params: Record<string, string>,
  kind: TokenRequestKind = "exchange",
): Effect.Effect<OAuthTokens, E | OAuthProtocolError> =>
  Effect.gen(function* () {
    const { clientId, clientSecret, redirectUri } = yield* resolveEnv(spec);
    const provider = spec.displayName;
    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(spec.tokenUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            ...params,
          }).toString(),
        }),
      catch: (cause) => new CrmNetworkError({ provider, cause }),
    });
    if (res.status >= 500) return yield* Effect.fail(new CrmServerError({ provider, status: res.status }));
    if (!res.ok) {
      const detail = yield* Effect.tryPromise({
        try: () => res.text(),
        catch: () => new CrmNetworkError({ provider, cause: "unreadable token error body" }),
      }).pipe(Effect.orElseSucceed(() => ""));
      return yield* Effect.fail(new CrmAuthRevoked({ provider, detail: detail.slice(0, 500) }));
    }
    const raw = yield* Effect.tryPromise({
      try: () => res.json(),
      catch: (cause) => new CrmNetworkError({ provider, cause }),
    });
    // NOTE: a provider that signals failure with HTTP 200 (Slack: `ok:false`)
    // reaches here on the SUCCESS path — detecting that is parseTokens' job.
    return yield* spec.parseTokens
      ? spec.parseTokens(raw, kind)
      : parseStandardTokens(raw, provider);
  });
