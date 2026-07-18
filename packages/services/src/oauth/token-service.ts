/**
 * `freshTokens` — interpret a {@link RefreshPolicy} (TRI: oauth-adapter).
 *
 * The one place that decides WHETHER to refresh, and whether that refresh must
 * be exclusive. Everything provider-specific arrives as data (the policy) or as
 * injected callbacks, so this file has no HTTP, no DB, and no service
 * dependencies — which is what lets it be unit-tested directly.
 *
 * Semantics are preserved exactly from the pre-refactor
 * `CrmConnectionService.freshTokens`:
 *   - a refresh REFUSAL (CrmAuthRevoked) propagates — the connection is dead
 *     and the binding should pause;
 *   - anything TRANSIENT logs and falls back to the stored token, because the
 *     client's refresh-on-401 is the backstop and failing the whole sync over a
 *     blip would be worse;
 *   - the merge keeps the OLD refresh token when the provider rotates without
 *     returning a new one.
 *
 * What is new is `Rotating`. Slack's refresh tokens are single-use with at most
 * two live at a time, so two concurrent column runs that both refresh revoke
 * each other's token mid-run. The refresh CALL must therefore be mutually
 * exclusive — a compare-and-swap on the write is too late, because the damage is
 * the HTTP request itself.
 *
 * The lock is TRY-only (see `CredentialRepo.withTryRefreshLock`). Losing it is
 * not an error and is not worth waiting for: the token that looked stale is
 * still valid for the whole skew window, so the loser just uses it. The skew IS
 * the grace period. That is what keeps a `max: 2` pooled instance from stalling
 * behind a network call.
 */

import { Effect } from "effect";
import { CrmServerError, type CrmError } from "../crm/errors.js";
import { needsRefresh, requiresSerializedRefresh, type OAuthTokens, type RefreshPolicy } from "./types.js";

/**
 * How long a single refresh may take before we give up and use the stored
 * token. Bounds how long the winner can hold a pooled connection: the lock is a
 * transaction, and the pool is `max: 2` per instance, so an unbounded refresh
 * against a hung provider could starve the instance.
 */
export const REFRESH_TIMEOUT_MS = 10_000;

/** Everything `freshTokens` needs from the outside world. All injected, so this stays pure. */
export interface FreshTokensDeps {
  /** The provider's lifecycle, as data. */
  readonly policy: RefreshPolicy;
  /** Provider display name, for log annotation only. */
  readonly provider: string;
  /** Key identifying THIS connection's lock. Must be stable across instances. */
  readonly lockKey: string;
  /**
   * Re-read the currently stored tokens. Called INSIDE the lock: winning says
   * nothing about whether the work still needs doing — another instance may
   * have refreshed between our staleness check and our acquiring the lock.
   */
  readonly reread: Effect.Effect<OAuthTokens | null, CrmError>;
  /** Exchange a refresh token for a new pair. */
  readonly refresh: (refreshToken: string) => Effect.Effect<OAuthTokens, CrmError>;
  /** Persist merged tokens. Must never fail the caller — a persist failure only costs a re-refresh. */
  readonly persist: (tokens: OAuthTokens) => Effect.Effect<void, never>;
  /** Run `onAcquired` under an exclusive non-blocking lock, else `onBusy`. */
  readonly withTryLock: (args: {
    readonly lockKey: string;
    readonly onAcquired: Effect.Effect<OAuthTokens, CrmError>;
    readonly onBusy: Effect.Effect<OAuthTokens, CrmError>;
  }) => Effect.Effect<OAuthTokens, CrmError>;
}

/**
 * Merge refreshed tokens over the current ones.
 *
 * `refreshToken` first so a provider-supplied new one WINS, but the old one
 * survives when the provider rotates the access token without returning a new
 * refresh token (Slack may do exactly that). Dropping it would strand the
 * connection with no way to refresh again.
 */
const merge = (current: OAuthTokens, refreshed: OAuthTokens): OAuthTokens => ({
  ...(current.refreshToken !== undefined ? { refreshToken: current.refreshToken } : {}),
  ...(current.extra !== undefined ? { extra: current.extra } : {}),
  ...refreshed,
});

/** Refresh + persist, mapping a transient failure to "keep using what we have". */
const refreshAndPersist = (
  current: OAuthTokens,
  refreshToken: string,
  deps: FreshTokensDeps,
): Effect.Effect<OAuthTokens, CrmError> =>
  deps.refresh(refreshToken).pipe(
    // A hung provider must not hold a pooled connection open: under Rotating
    // this runs inside the lock transaction, and the pool is max:2 per instance.
    // 504 => transient => falls through to the stored-token path below.
    Effect.timeoutFail({
      duration: REFRESH_TIMEOUT_MS,
      onTimeout: () => new CrmServerError({ provider: deps.provider, status: 504 }),
    }),
    Effect.map((refreshed) => merge(current, refreshed)),
    Effect.tap((merged) => deps.persist(merged)),
    Effect.catchAll((e) =>
      e._tag === "CrmAuthRevoked"
        ? // The grant was refused: the connection is dead. Propagate so the
          // binding pauses rather than retrying forever against a dead token.
          Effect.fail(e)
        : Effect.logWarning("oauth proactive refresh failed; using stored token").pipe(
            Effect.annotateLogs({ provider: deps.provider, error: e._tag }),
            Effect.as(current),
          ),
    ),
  );

/**
 * Return tokens safe to use now, refreshing first if the policy says to.
 *
 * `stored` is what the caller already read; `deps.reread` is used only inside
 * the lock.
 */
export const freshTokens = (
  stored: OAuthTokens,
  deps: FreshTokensDeps,
): Effect.Effect<OAuthTokens, CrmError> => {
  if (!needsRefresh(stored, deps.policy)) return Effect.succeed(stored);
  const refreshToken = stored.refreshToken;
  // needsRefresh already guarantees this, but the compiler doesn't know.
  if (refreshToken === undefined) return Effect.succeed(stored);

  if (!requiresSerializedRefresh(deps.policy)) {
    // Reusable refresh tokens: a redundant refresh is harmless, so racing
    // writers are benign and a lock would be pure cost.
    return refreshAndPersist(stored, refreshToken, deps);
  }

  return deps.withTryLock({
    lockKey: deps.lockKey,
    onAcquired: Effect.gen(function* () {
      // Re-read INSIDE the lock. Winning the lock says nothing about whether the
      // work still needs doing — without this, the queued winner burns a SECOND
      // single-use refresh immediately after the first one succeeded.
      const current = yield* deps.reread;
      if (current === null) return stored;
      if (!needsRefresh(current, deps.policy)) return current;
      const currentRefresh = current.refreshToken;
      if (currentRefresh === undefined) return current;
      return yield* refreshAndPersist(current, currentRefresh, deps);
    }),
    // Someone else is refreshing. Do NOT wait: `stored` is inside its skew
    // window and therefore still valid, so using it is correct and instant.
    onBusy: Effect.succeed(stored),
  });
};
