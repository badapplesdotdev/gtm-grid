/**
 * `SlackAuth` — the OAuth handshake with Slack (TRI: oauth-adapter).
 *
 * The protocol mechanics live in `oauth/oauth-core.ts`; this file is the
 * Slack-specific DATA plus the service wrapper. Attio and HubSpot are vanilla
 * OAuth 2.0 and need nothing but a spec — Slack is the first provider that
 * DEVIATES, and every deviation is quarantined in {@link parseSlackTokens}:
 *
 * 1. `oauth.v2.access` answers HTTP **200** with `{"ok": false, "error": "…"}`
 *    for nearly every failure. `tokenRequest` only reaches `parseTokens` on the
 *    HTTP success path, so detecting `ok:false` is OURS to do — miss it and a
 *    refusal is indistinguishable from a successful exchange.
 * 2. The same endpoint answers in TWO shapes. On code exchange the bot token is
 *    at the ROOT (`access_token`, `token_type: "bot"`, `bot_user_id`, `team`)
 *    and the USER token is nested under `authed_user`; on refresh the response
 *    is flat. Hence `TokenRequestKind`.
 * 3. With rotation enabled the access token expires in 12h (`expires_in:
 *    43200`), is prefixed `xoxe.xoxb-`, and the refresh token (`xoxe-1-`) is
 *    SINGLE-USE — which is why the policy is {@link RefreshPolicy.Rotating} and
 *    not `Proactive`: a redundant refresh revokes a token another in-flight
 *    request is still holding, so `OAuthTokenService` must serialize refreshes
 *    per connection.
 *
 * v1 uses the BOT token only. Rotation issues bot and user refresh tokens
 * separately, so keeping the user token would mean two single-use rotation
 * chains (and two locks) per connection — a real doubling of the concurrency
 * surface, bought for `search.messages` alone, a legacy API we don't call. A
 * user-token-only response is therefore a hard error, not a silent half-connect.
 */

import { Data, Effect } from "effect";
import { CrmAuthRevoked, CrmServerError, CrmSyncError } from "../crm/errors.js";
import { makeAdapter } from "../oauth/adapter.js";
import type { OAuthProtocolError } from "../oauth/errors.js";
import {
  RefreshPolicy,
  type OAuthProviderSpec,
  type OAuthStateClaims,
  type OAuthTokens,
  type TokenRequestKind,
} from "../oauth/types.js";

/** Claims bound into an OAuth `state` token. Alias of the shared shape. */
export type SlackOAuthState = OAuthStateClaims;

/** Raised when the OAuth env (client id/secret) is not configured. */
export class SlackOAuthNotConfigured extends Data.TaggedError("SlackOAuthNotConfigured")<{
  readonly missing: string;
}> {}

/** DISPLAY name, used verbatim in error copy. */
const PROVIDER = "Slack";

/**
 * Slack's access tokens live 12h under rotation, so the 5-minute default skew is
 * too tight to be comfortable: a grid run that starts inside the window would
 * carry a token that dies mid-run. 30 minutes of headroom costs one extra
 * refresh per token lifetime and removes that class of failure.
 */
export const SLACK_REFRESH_SKEW_MS = 30 * 60 * 1000;

/**
 * Bot scopes for v1: post messages, enumerate conversations so a user can pick a
 * channel, and resolve user ids/emails so a grid row can be addressed to a
 * person. Comma-separated on the wire (`scopeSeparator: ","`) — Slack is the
 * odd one out here; HubSpot wants spaces.
 */
export const SLACK_SCOPES = [
  "chat:write",
  "chat:write.public",
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
  "users:read",
  "users:read.email",
] as const;

// ── Total readers over an untrusted body ──────────────────────────────────────
//
// House pattern (see `readTokenResponse` in oauth-core.ts): `res.json()` is
// `unknown`, and an `as` cast is a lie the compiler cannot check. Anything that
// isn't the expected primitive is simply ABSENT, so a malformed response fails
// loudly rather than persisting garbage that resurfaces later as a baffling 401.

const readProp = (raw: unknown, key: string): unknown =>
  typeof raw === "object" && raw !== null ? Reflect.get(raw, key) : undefined;

const readString = (raw: unknown, key: string): string | undefined => {
  const value = readProp(raw, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const readNumber = (raw: unknown, key: string): number | undefined => {
  const value = readProp(raw, key);
  return typeof value === "number" ? value : undefined;
};

/** Slack signals success with a literal `ok: true`; anything else is a failure. */
const isOk = (raw: unknown): boolean => readProp(raw, "ok") === true;

// ── Error taxonomy ────────────────────────────────────────────────────────────
//
// Deliberately mapped onto the EXISTING `crm/errors.ts` tags rather than a
// parallel Slack set — see `oauth/errors.ts`: those tags already carry
// `provider` as a display string, and `crm/error-copy.ts` + `isTransientCrmError`
// already map every tag to user copy and to the retry policy. A structurally
// identical second union would have to be threaded through both for no gain.

/** The grant is dead; only a fresh install/re-auth recovers. */
const SLACK_REAUTH_ERRORS: ReadonlySet<string> = new Set([
  "invalid_auth",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "invalid_grant_type",
  "bad_client_secret",
  "invalid_code",
  "invalid_refresh_token",
]);

/**
 * Worth retrying. The status is synthetic — Slack reports these on a 200, so
 * there is no real HTTP status to carry — chosen to match what the same
 * condition would have been over vanilla HTTP.
 */
const SLACK_TRANSIENT_STATUS: Readonly<Record<string, number>> = {
  ratelimited: 429,
  service_unavailable: 503,
  internal_error: 500,
  request_timeout: 504,
  fatal_error: 500,
};

/**
 * Classify Slack's `error` string.
 *
 * Transient errors become `CrmServerError` rather than `CrmRateLimitError`,
 * INCLUDING `ratelimited`. Not a preference: `parseTokens` is typed to
 * `OAuthProtocolError`, whose union is `CrmAuthRevoked | CrmNetworkError |
 * CrmServerError | CrmSyncError` — `CrmRateLimitError` is not a member. Both
 * tags are transient under `isTransientCrmError`, so the retry behaviour callers
 * actually depend on is identical; the only loss is `retryAfterMs`, which Slack
 * doesn't give us on a 200-with-`ok:false` anyway. Widening the union is a
 * cross-file change and is left as a follow-up.
 *
 * Everything unrecognised is `CrmSyncError` naming the Slack code, so an
 * unmapped error (`missing_scope`, `bad_redirect_uri`, …) surfaces its cause
 * instead of being mistaken for a revoked grant and silently disconnecting a
 * workspace that just needs a scope added.
 */
const classifySlackError = (code: string, kind: TokenRequestKind): OAuthProtocolError => {
  if (SLACK_REAUTH_ERRORS.has(code)) return new CrmAuthRevoked({ provider: PROVIDER, detail: code });
  const status = SLACK_TRANSIENT_STATUS[code];
  if (status !== undefined) return new CrmServerError({ provider: PROVIDER, status });
  return new CrmSyncError({ message: `${PROVIDER} token ${kind} failed: ${code}` });
};

/**
 * Team/bot identity, persisted alongside the tokens so callers can name the
 * workspace and address the bot without a second API call.
 *
 * Reads BOTH shapes (nested `team: {id, name}` on exchange, flat `team_id` /
 * `team_name` on refresh) regardless of `kind`, rather than switching: the two
 * are disjoint key sets, so accepting either is unambiguous, and a tolerant read
 * means a shape drift on one grant can't silently blank the identity we already
 * hold. `kind` stays load-bearing for the token itself, where the shapes overlap
 * and a wrong guess would pick the WRONG token.
 */
const readExtra = (raw: unknown): Record<string, string> => {
  const team = readProp(raw, "team");
  const teamId = readString(team, "id") ?? readString(raw, "team_id");
  const teamName = readString(team, "name") ?? readString(raw, "team_name");
  const botUserId = readString(raw, "bot_user_id");
  return {
    ...(teamId ? { teamId } : {}),
    ...(teamName ? { teamName } : {}),
    ...(botUserId ? { botUserId } : {}),
  };
};

/**
 * Parse `oauth.v2.access`. Total, pure, `R = never`.
 *
 * Order matters: the `ok` gate runs FIRST, before any token read. `tokenRequest`
 * has already decided this response is a success by HTTP status, so this is the
 * only place an `ok:false` can be caught — and a body like
 * `{"ok": false, "error": "invalid_code"}` has no `access_token`, so reading
 * first would report the misleading "no access_token" instead of Slack's actual
 * reason.
 */
export const parseSlackTokens = (
  raw: unknown,
  kind: TokenRequestKind,
): Effect.Effect<OAuthTokens, OAuthProtocolError> =>
  Effect.gen(function* () {
    if (!isOk(raw)) {
      const code = readString(raw, "error");
      return yield* Effect.fail(
        code === undefined
          ? new CrmSyncError({ message: `${PROVIDER} token ${kind} response was not ok and named no error` })
          : classifySlackError(code, kind),
      );
    }

    // The ROOT token is the BOT token; `authed_user.access_token` is the user
    // token, which v1 drops. Reading the root is what makes `token_type: "bot"`
    // true of what we store.
    const accessToken = readString(raw, "access_token");
    if (accessToken === undefined) {
      const userToken = readString(readProp(raw, "authed_user"), "access_token");
      return yield* Effect.fail(
        new CrmSyncError({
          message:
            userToken === undefined
              ? `${PROVIDER} token ${kind} response had no access_token`
              : `${PROVIDER} token ${kind} returned only a user token; GTM Grid requires a bot token (reinstall with bot scopes)`,
        }),
      );
    }

    const refreshToken = readString(raw, "refresh_token");
    const expiresIn = readNumber(raw, "expires_in");
    const extra = readExtra(raw);
    const tokens: OAuthTokens = {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(expiresIn !== undefined ? { expiresAtMs: Date.now() + expiresIn * 1000 } : {}),
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    };
    return tokens;
  });

/** Everything provider-specific about Slack, as data. */
export const SLACK_SPEC: OAuthProviderSpec<SlackOAuthNotConfigured> = {
  // Bare "slack", NOT "slack-crm": this doubles as the credential slot and the
  // engine resolves credentials by CONNECTOR id, so any decoration here silently
  // hands the connector an empty credential at run time.
  id: "slack",
  displayName: PROVIDER,
  notConfiguredTag: "SlackOAuthNotConfigured",
  refreshPolicy: RefreshPolicy.Rotating(SLACK_REFRESH_SKEW_MS),
  authorizeUrl: "https://slack.com/oauth/v2/authorize",
  tokenUrl: "https://slack.com/api/oauth.v2.access",
  scopes: SLACK_SCOPES,
  scopeSeparator: ",",
  clientIdEnv: "SLACK_CLIENT_ID",
  clientSecretEnv: "SLACK_CLIENT_SECRET",
  stateSecretEnv: "SLACK_OAUTH_SECRET",
  redirectPath: "/api/oauth/slack/callback",
  notConfigured: (missing) => new SlackOAuthNotConfigured({ missing }),
  parseTokens: parseSlackTokens,
};

/** The Slack adapter. Usable without the Effect service (no requirements). */
export const SLACK_ADAPTER = makeAdapter(SLACK_SPEC);

/**
 * Service wrapper, mirroring `AttioAuth`/`HubspotAuth`: a `Effect.Service` so
 * `SlackAuth` can join the `AppServices` union and be resolved from the runtime
 * like its siblings; the adapter underneath does the work.
 */
export class SlackAuth extends Effect.Service<SlackAuth>()("SlackAuth", {
  effect: Effect.succeed(SLACK_ADAPTER),
  dependencies: [],
}) {}
