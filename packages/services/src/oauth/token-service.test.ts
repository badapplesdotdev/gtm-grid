/**
 * freshTokens: RefreshPolicy interpretation.
 *
 * SCOPE NOTE — these cover POLICY SELECTION only, with an in-process fake lock.
 * They deliberately do NOT claim to prove the advisory lock works: the lock
 * exists to coordinate across Vercel instances, and a fake in one process cannot
 * model that. An in-process fake would pass happily while
 * `pg_try_advisory_xact_lock` is completely broken. The real proof is the
 * integration test against live Postgres (plan step 14).
 *
 * What IS provable here: given a lock that behaves, does the policy logic make
 * the right calls — and critically, does the winner RE-READ before refreshing.
 */

import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import { CrmAuthRevoked, CrmNetworkError, type CrmError } from "../crm/errors.js";
import { freshTokens, type FreshTokensDeps } from "./token-service.js";
import { REFRESH_SKEW_MS, RefreshPolicy, type OAuthTokens } from "./types.js";

const NOW = Date.now();
const STALE = NOW - 1;
const FRESH = NOW + 60 * 60 * 1000;

const failureTag = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>): string => {
  if (Exit.isSuccess(exit)) return "none";
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure) ? failure.value._tag : "unknown";
};

interface Harness {
  readonly deps: FreshTokensDeps;
  readonly calls: { refresh: number; persist: number; reread: number; acquired: number; busy: number };
  readonly persisted: OAuthTokens[];
}

const harness = (over: {
  policy: RefreshPolicy;
  refresh?: (rt: string) => Effect.Effect<OAuthTokens, CrmError>;
  reread?: Effect.Effect<OAuthTokens | null, CrmError>;
  /** Force the lock to be already held (someone else is refreshing). */
  lockBusy?: boolean;
}): Harness => {
  const calls = { refresh: 0, persist: 0, reread: 0, acquired: 0, busy: 0 };
  const persisted: OAuthTokens[] = [];
  const deps: FreshTokensDeps = {
    policy: over.policy,
    provider: "TestProvider",
    lockKey: "ws_1:test",
    reread: Effect.suspend(() => {
      calls.reread++;
      return over.reread ?? Effect.succeed<OAuthTokens | null>({ accessToken: "at", refreshToken: "rt", expiresAtMs: STALE });
    }),
    refresh: (rt) =>
      Effect.suspend(() => {
        calls.refresh++;
        return over.refresh ? over.refresh(rt) : Effect.succeed<OAuthTokens>({ accessToken: "at_new", refreshToken: "rt_new", expiresAtMs: FRESH });
      }),
    persist: (t) =>
      Effect.sync(() => {
        calls.persist++;
        persisted.push(t);
      }),
    withTryLock: (args) =>
      Effect.suspend(() => {
        if (over.lockBusy) {
          calls.busy++;
          return args.onBusy;
        }
        calls.acquired++;
        return args.onAcquired;
      }),
  };
  return { deps, calls, persisted };
};

const run = (t: OAuthTokens, h: Harness) => Effect.runPromise(freshTokens(t, h.deps));

describe("policy selection", () => {
  it("None never refreshes, even when expired", async () => {
    const h = harness({ policy: RefreshPolicy.None });
    const out = await run({ accessToken: "at", refreshToken: "rt", expiresAtMs: STALE }, h);
    expect(out.accessToken).toBe("at");
    expect(h.calls.refresh).toBe(0);
  });

  it("Proactive refreshes a stale token and takes NO lock (reusable refresh tokens)", async () => {
    const h = harness({ policy: RefreshPolicy.Proactive(REFRESH_SKEW_MS) });
    const out = await run({ accessToken: "at", refreshToken: "rt", expiresAtMs: STALE }, h);
    expect(out.accessToken).toBe("at_new");
    expect(h.calls.refresh).toBe(1);
    expect(h.calls.persist).toBe(1);
    // A lock would be pure cost when a redundant refresh is harmless.
    expect(h.calls.acquired + h.calls.busy).toBe(0);
  });

  it("Proactive leaves a fresh token alone", async () => {
    const h = harness({ policy: RefreshPolicy.Proactive(REFRESH_SKEW_MS) });
    const out = await run({ accessToken: "at", refreshToken: "rt", expiresAtMs: FRESH }, h);
    expect(out.accessToken).toBe("at");
    expect(h.calls.refresh).toBe(0);
  });

  it("Rotating TAKES the lock before refreshing", async () => {
    const h = harness({ policy: RefreshPolicy.Rotating(30 * 60_000) });
    const out = await run({ accessToken: "at", refreshToken: "rt", expiresAtMs: STALE }, h);
    expect(out.accessToken).toBe("at_new");
    expect(h.calls.acquired).toBe(1);
    expect(h.calls.refresh).toBe(1);
  });
});

describe("Rotating — the single-use token protections", () => {
  it("RE-READS inside the lock and does NOT refresh when the winner already did", async () => {
    // The scenario this exists for: we check staleness, block on the lock while
    // another instance refreshes, then acquire. Without the re-read we would
    // burn a SECOND single-use refresh and revoke the token just minted.
    const h = harness({
      policy: RefreshPolicy.Rotating(30 * 60_000),
      reread: Effect.succeed({ accessToken: "at_from_winner", refreshToken: "rt2", expiresAtMs: FRESH }),
    });
    const out = await run({ accessToken: "at_stale", refreshToken: "rt", expiresAtMs: STALE }, h);
    expect(h.calls.reread).toBe(1);
    expect(h.calls.refresh).toBe(0); // <- the whole point
    expect(out.accessToken).toBe("at_from_winner");
  });

  it("losing the lock returns the stored token immediately — the skew IS the grace period", async () => {
    const h = harness({ policy: RefreshPolicy.Rotating(30 * 60_000), lockBusy: true });
    const out = await run({ accessToken: "at_stored", refreshToken: "rt", expiresAtMs: STALE }, h);
    expect(h.calls.busy).toBe(1);
    expect(h.calls.refresh).toBe(0);
    expect(h.calls.reread).toBe(0);
    // No waiting, no blocking: a max:2 pool must not stall behind a network call.
    expect(out.accessToken).toBe("at_stored");
  });

  it("re-reads STALE tokens and does refresh (the winner's normal path)", async () => {
    const h = harness({
      policy: RefreshPolicy.Rotating(30 * 60_000),
      reread: Effect.succeed({ accessToken: "at", refreshToken: "rt_current", expiresAtMs: STALE }),
    });
    await run({ accessToken: "at", refreshToken: "rt_old", expiresAtMs: STALE }, h);
    expect(h.calls.refresh).toBe(1);
  });
});

describe("failure handling (semantics preserved from CrmConnectionService.freshTokens)", () => {
  it("a refresh REFUSAL propagates — the connection is dead", async () => {
    const h = harness({
      policy: RefreshPolicy.Proactive(REFRESH_SKEW_MS),
      refresh: () => Effect.fail(new CrmAuthRevoked({ provider: "TestProvider", detail: "invalid_grant" })),
    });
    const exit = await Effect.runPromiseExit(
      freshTokens({ accessToken: "at", refreshToken: "rt", expiresAtMs: STALE }, h.deps),
    );
    expect(failureTag(exit)).toBe("CrmAuthRevoked");
  });

  it("a TRANSIENT failure falls back to the stored token — the 401 backstop covers it", async () => {
    const h = harness({
      policy: RefreshPolicy.Proactive(REFRESH_SKEW_MS),
      refresh: () => Effect.fail(new CrmNetworkError({ provider: "TestProvider", cause: "ECONNRESET" })),
    });
    const out = await run({ accessToken: "at_stored", refreshToken: "rt", expiresAtMs: STALE }, h);
    expect(out.accessToken).toBe("at_stored");
    expect(h.calls.persist).toBe(0);
  });
});

describe("merge", () => {
  it("PRESERVES the old refresh token when the provider omits a new one", async () => {
    // Slack may rotate the access token without returning a new refresh token.
    // Dropping it would strand the connection with no way to refresh again.
    const h = harness({
      policy: RefreshPolicy.Proactive(REFRESH_SKEW_MS),
      refresh: () => Effect.succeed({ accessToken: "at_new", expiresAtMs: FRESH }),
    });
    const out = await run({ accessToken: "at", refreshToken: "rt_keepme", expiresAtMs: STALE }, h);
    expect(out.refreshToken).toBe("rt_keepme");
    expect(out.accessToken).toBe("at_new");
  });

  it("a provider-supplied new refresh token WINS over the old one", async () => {
    const h = harness({ policy: RefreshPolicy.Proactive(REFRESH_SKEW_MS) });
    const out = await run({ accessToken: "at", refreshToken: "rt_old", expiresAtMs: STALE }, h);
    expect(out.refreshToken).toBe("rt_new");
  });

  it("carries provider extras (Slack teamId/botUserId) across a refresh that omits them", async () => {
    const h = harness({
      policy: RefreshPolicy.Rotating(30 * 60_000),
      reread: Effect.succeed({
        accessToken: "at",
        refreshToken: "rt",
        expiresAtMs: STALE,
        extra: { teamId: "T123", botUserId: "U456" },
      }),
      refresh: () => Effect.succeed({ accessToken: "at_new", refreshToken: "rt_new", expiresAtMs: FRESH }),
    });
    const out = await run({ accessToken: "at", refreshToken: "rt", expiresAtMs: STALE }, h);
    expect(out.extra).toEqual({ teamId: "T123", botUserId: "U456" });
  });
});
