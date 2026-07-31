/**
 * `GoogleAuth` — the OAuth handshake with Google.
 *
 * The contrast with `slack-auth.ts` is the point: Slack needed ~150 lines of
 * `parseSlackTokens` because it deviates three ways (`ok:false` on HTTP 200, two
 * response shapes, single-use rotation). Google is vanilla RFC 6749 — a 400 with
 * `{"error": "invalid_grant"}`, one response shape, reusable refresh tokens — so
 * there is NO `parseTokens` here and `parseStandardTokens` handles it. This file
 * is data.
 *
 * Three Google-specific facts are load-bearing, and each is a silent failure if
 * missed:
 *
 * 1. **`access_type=offline` + `prompt=consent`.** Google issues a
 *    `refresh_token` only when `access_type=offline` is sent, and only on the
 *    FIRST consent for a given user+client unless `prompt=consent` re-forces the
 *    dialog. Without both, a connection silently degrades to a 1-hour access
 *    token with nothing to refresh — and it fails an hour later, far from the
 *    cause. These ride on {@link OAuthCoreSpec.extraAuthorizeParams}.
 *
 * 2. **Refresh responses omit `refresh_token`.** Google returns only a new
 *    access token on refresh. That is handled upstream: `OAuthTokenService`'s
 *    merge keeps the OLD refresh token when a provider rotates without returning
 *    a new one, so no special-casing is needed here — but it is the reason the
 *    policy is `Proactive` and not `Rotating`. Google's refresh tokens are
 *    REUSABLE, so a redundant refresh is harmless and needs no advisory lock.
 *
 * 3. **`drive.file` is a deliberate scope choice, not a starting point.** It is
 *    NON-SENSITIVE, so it needs no Google verification review and no annual CASA
 *    security assessment. The cost is real and permanent: we cannot list a
 *    user's spreadsheets, so the user MUST select files through the Google
 *    Picker, which then grants per-file access that persists. Widening to
 *    `spreadsheets` or `drive.readonly` would let us build our own picker but
 *    puts the app into RESTRICTED-scope territory — weeks of verification, plus
 *    a paid third-party security assessment above 100 users. Do not widen this
 *    list casually.
 *
 * The provider id is `google`, NOT `googlesheets`: one Google grant is meant to
 * serve every Google connector (Sheets today; Docs, Drive and Gmail later). That
 * sharing is what `credentialSlot` in the engine manifest exists for.
 */

import { Data, Effect } from "effect";
import { makeAdapter } from "../oauth/adapter.js";
import { RefreshPolicy, REFRESH_SKEW_MS, type OAuthProviderSpec, type OAuthStateClaims } from "../oauth/types.js";

/** Claims bound into an OAuth `state` token. Alias of the shared shape. */
export type GoogleOAuthState = OAuthStateClaims;

/** Raised when the OAuth env (client id/secret) is not configured. */
export class GoogleOAuthNotConfigured extends Data.TaggedError("GoogleOAuthNotConfigured")<{
  readonly missing: string;
}> {}

/** DISPLAY name, used verbatim in error copy. */
const PROVIDER = "Google";

/**
 * The credential slot every Google connector reads. Exported so the connection
 * service, the `OAUTH_SLOTS` registry and the connector manifests all name the
 * SAME string — a mismatch hands the connector an empty credential at run time,
 * with no error until the first 401.
 */
export const GOOGLE_CONNECTION_SLOT = "google";

/**
 * v1 scopes.
 *
 * `drive.file` is the one that does the work: enough to read and write any
 * spreadsheet the user PICKS (the Sheets API honours a `drive.file` grant for
 * those files), and deliberately not enough to enumerate their Drive — which is
 * why the Picker is mandatory rather than a convenience.
 *
 * `openid` + `email` are added for one reason: without them we cannot name the
 * connected account. Users routinely have a personal and a work Google account
 * signed in simultaneously, and a card that says "Connected to Google" with no
 * address gives them no way to notice they authorised the wrong one — a failure
 * that surfaces much later as "why can't it see my spreadsheet?".
 *
 * Both are NON-SENSITIVE in Google's classification, so they do not pull the app
 * into the restricted-scope verification review or the annual CASA security
 * assessment. That property is the whole reason this list is what it is; see the
 * file header before adding anything, and treat `spreadsheets` or `drive.readonly`
 * as a product decision with a multi-week compliance cost attached, not a tweak.
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "openid",
  "email",
] as const;

/** Where the connected account's email is read from, once, at callback time. */
export const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

/**
 * Google access tokens live 1 hour. The shared 5-minute default skew is a good
 * fit at that lifetime (Slack needed 30 because its tokens live 12h and a long
 * grid run could straddle the window), so this uses the default rather than
 * inventing a Google-specific constant.
 */
export const GOOGLE_REFRESH_SKEW_MS = REFRESH_SKEW_MS;

/** Everything provider-specific about Google, as data. */
export const GOOGLE_SPEC: OAuthProviderSpec<GoogleOAuthNotConfigured> = {
  // Doubles as the credential slot; every Google connector points here.
  id: GOOGLE_CONNECTION_SLOT,
  displayName: PROVIDER,
  notConfiguredTag: "GoogleOAuthNotConfigured",
  // Proactive, NOT Rotating: Google's refresh tokens are reusable, so concurrent
  // refreshes are benign and no per-connection lock is required.
  refreshPolicy: RefreshPolicy.Proactive(GOOGLE_REFRESH_SKEW_MS),
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: GOOGLE_SCOPES,
  scopeSeparator: " ",
  // Without BOTH of these Google never issues a refresh token — see header (1).
  extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
  clientIdEnv: "GOOGLE_CLIENT_ID",
  clientSecretEnv: "GOOGLE_CLIENT_SECRET",
  stateSecretEnv: "GOOGLE_OAUTH_SECRET",
  redirectPath: "/api/oauth/google/callback",
  notConfigured: (missing) => new GoogleOAuthNotConfigured({ missing }),
  // No parseTokens — parseStandardTokens covers the RFC 6749 shape Google returns.
};

/** The Google adapter. Usable without the Effect service (no requirements). */
export const GOOGLE_ADAPTER = makeAdapter(GOOGLE_SPEC);

/**
 * Service wrapper, mirroring `SlackAuth`/`AttioAuth`/`HubspotAuth`: an
 * `Effect.Service` so `GoogleAuth` can join the `AppServices` union and be
 * resolved from the runtime like its siblings; the adapter underneath does the
 * work.
 */
export class GoogleAuth extends Effect.Service<GoogleAuth>()("GoogleAuth", {
  effect: Effect.succeed(GOOGLE_ADAPTER),
  dependencies: [],
}) {}
