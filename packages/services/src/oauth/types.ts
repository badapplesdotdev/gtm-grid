/**
 * Pure types for the OAuth adapter (TRI: oauth-adapter). Data and total
 * functions only — no Effect services, no env reads, no I/O.
 *
 * The centrepiece is {@link RefreshPolicy}. Before this, each provider's token
 * lifecycle lived in a DOC COMMENT and was re-implemented per call site:
 *
 *   attio-auth.ts:  "Attio's public docs leave the token lifecycle ambiguous
 *                    (expiring + refresh vs long-lived), so AttioTokens carries
 *                    OPTIONAL refresh/expiry and every consumer treats
 *                    refresh-on-401 as the primary trigger."
 *   hubspot-auth.ts: "Unlike Attio, HubSpot's token lifecycle is DOCUMENTED …
 *                    so expiresAtMs is always set and proactive refresh is the
 *                    primary path, with refresh-on-401 as the backstop."
 *
 * Prose a human must read and hand-honour is not a contract. Slack forces the
 * issue: its refresh tokens are SINGLE-USE and only two tokens may be live at
 * once, so "just refresh when it looks stale" is actively destructive under the
 * concurrency a grid produces. Encoding the lifecycle as data lets one shared
 * `OAuthTokenService` interpret it and lets the type system enumerate the arms.
 */

import type { Effect } from "effect";
import type { OAuthProtocolError } from "./errors.js";

/** Claims bound into an OAuth `state` token. */
export interface OAuthStateClaims {
  readonly workspaceId: string;
  readonly userId: string;
}

/**
 * The shape every provider's "OAuth app not configured" error shares.
 *
 * Each provider keeps its own TAG (`AttioOAuthNotConfigured`,
 * `HubspotOAuthNotConfigured`, …) because the web routes match on the exact tag
 * to render the setup page — but the payload is identical, so constraining `E`
 * to this lets shared code narrow with `"missing" in e` and handle every
 * provider in ONE arm instead of one arm per provider.
 */
export interface OAuthNotConfiguredError {
  readonly _tag: string;
  /** The env var name that was absent, e.g. "ATTIO_CLIENT_ID". */
  readonly missing: string;
}

/** Tokens for one connection. Optional fields: not every provider reports expiry/refresh. */
export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Epoch ms the access token expires, when the provider reports `expires_in`. */
  readonly expiresAtMs?: number;
  /** Provider extras persisted in the same envelope (Slack: botUserId, teamId, teamName). */
  readonly extra?: Readonly<Record<string, string>>;
}

/**
 * When and how a provider's access token must be renewed.
 *
 * - `None`      — no refresh token is ever issued; the access token is the
 *                 whole grant. Re-auth is the only recovery.
 * - `Proactive` — refresh before `expiresAtMs`, with `skewMs` of headroom.
 *                 Refresh tokens are reusable, so a redundant refresh is
 *                 harmless and racing writers are benign. (Attio, HubSpot.)
 *
 *                 A provider that does not RELIABLY report expiry — Attio — is
 *                 still `Proactive`: `needsRefresh` already declines to refresh
 *                 when `expiresAtMs` is absent, so "fall through to the 401
 *                 backstop" falls out of the DATA rather than needing its own
 *                 policy arm. An earlier draft gave Attio a separate `Reactive`
 *                 arm; that was a misreading of `attio-auth.ts`'s doc comment,
 *                 and it silently disabled the proactive refresh that Attio
 *                 tokens WITH an expiry have always had.
 * - `Rotating`  — `Proactive`, PLUS the refresh token is single-use and the
 *                 provider caps how many tokens may be live. A redundant
 *                 refresh is therefore NOT harmless: it revokes a token another
 *                 in-flight request is still using. Callers MUST serialize
 *                 refresh per connection. (Slack.)
 *
 * `Rotating` is deliberately distinct from `Proactive` rather than a boolean
 * flag on it: the difference isn't a tweak to the same behaviour, it's a hard
 * requirement for mutual exclusion that the caller has to honour, and an
 * exhaustive `switch` should force that decision at every call site.
 */
export type RefreshPolicy =
  | { readonly _tag: "None" }
  | { readonly _tag: "Proactive"; readonly skewMs: number }
  | { readonly _tag: "Rotating"; readonly skewMs: number };

/**
 * Default headroom before expiry. Unchanged from `crm-connection-service.ts`'s
 * `REFRESH_SKEW_MS`, so HubSpot's timing is preserved exactly by this refactor.
 */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Constructors, so call sites read as intent rather than as object literals. */
export const RefreshPolicy = {
  None: { _tag: "None" } as const satisfies RefreshPolicy,
  Proactive: (skewMs: number = REFRESH_SKEW_MS): RefreshPolicy => ({ _tag: "Proactive", skewMs }),
  Rotating: (skewMs: number = REFRESH_SKEW_MS): RefreshPolicy => ({ _tag: "Rotating", skewMs }),
} as const;

/**
 * Whether refresh under this policy must hold an exclusive per-connection lock.
 *
 * Only `Rotating`. This is the single predicate that turns Slack's single-use
 * refresh tokens into a concrete requirement on the token service, instead of a
 * caveat someone has to remember.
 */
export const requiresSerializedRefresh = (policy: RefreshPolicy): boolean => policy._tag === "Rotating";

/**
 * Whether `tokens` should be proactively refreshed under `policy`.
 *
 * Three ways this is deliberately conservative, each of which would otherwise
 * cause a needless refresh — and under `Rotating`, a needless refresh destroys a
 * live token:
 * - `None` never refreshes ahead of time by definition.
 * - No `refreshToken` → nothing to refresh WITH, so the answer is no regardless
 *   of expiry; the caller re-auths.
 * - No `expiresAtMs` → the provider never told us when it expires, so we cannot
 *   know it's stale. Fall through to the 401 backstop rather than guess. This is
 *   exactly Attio's documented ambiguity, now expressed as DATA rather than as a
 *   separate policy arm.
 */
export const needsRefresh = (tokens: OAuthTokens, policy: RefreshPolicy, now: number = Date.now()): boolean => {
  if (policy._tag === "None") return false;
  if (tokens.refreshToken === undefined) return false;
  if (tokens.expiresAtMs === undefined) return false;
  return tokens.expiresAtMs < now + policy.skewMs;
};

/**
 * The provider-specific data the shared core needs. `E` is the provider's
 * "OAuth app not configured" tagged error — kept per-provider because the web
 * routes match on its exact tag to decide whether to render the setup page.
 */
export interface OAuthCoreSpec<E extends OAuthNotConfiguredError> {
  /**
   * Stable provider id. Doubles as the credential slot, so it MUST match the
   * connector id — and it is part of the SIGNED state payload.
   *
   * Lives on the CORE spec, not just {@link OAuthProviderSpec}, because state
   * binding is a PROTOCOL concern: without it `mintState`/`verifyState` cannot
   * tell which handshake a state belongs to, so every provider's state verified
   * on every other provider's callback for the full 15-minute TTL.
   */
  readonly id: string;
  /** DISPLAY name, used verbatim in error copy ("Attio", "HubSpot", "Slack"). */
  readonly displayName: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  /** Omitted → no `scope` param is sent at all (Attio's authorize URL carries none). */
  readonly scopes?: readonly string[];
  /** How to join `scopes`. HubSpot wants " ", Slack wants ",". Ignored when scopes is unset. */
  readonly scopeSeparator?: string;
  readonly clientIdEnv: string;
  readonly clientSecretEnv: string;
  /** Provider override for the state signing key; falls back to BETTER_AUTH_SECRET. */
  readonly stateSecretEnv: string;
  /** Appended to SITE_URL to form the redirect URI. */
  readonly redirectPath: string;
  /** Builds the provider's not-configured error for a missing env var name. */
  readonly notConfigured: (missing: string) => E;
  /**
   * Override the token-response parse. Receives the RAW body because deviant
   * providers need the untouched payload: Slack nests the bot token under
   * `authed_user` on exchange, returns a flat shape on refresh, and signals
   * failure with `ok:false` on an HTTP *200*. Defaults to the RFC 6749 shape.
   */
  readonly parseTokens?: (raw: unknown, kind: TokenRequestKind) => Effect.Effect<OAuthTokens, OAuthProtocolError>;
}

/** Which grant produced a token response — some providers answer in different shapes. */
export type TokenRequestKind = "exchange" | "refresh";

/** A full provider definition: protocol mechanics + lifecycle + identity. */
export interface OAuthProviderSpec<E extends OAuthNotConfiguredError> extends OAuthCoreSpec<E> {
  /** The `_tag` of the error `notConfigured` builds; web routes match on it. */
  readonly notConfiguredTag: string;
  /** When and how this provider's tokens must be renewed. */
  readonly refreshPolicy: RefreshPolicy;
}
