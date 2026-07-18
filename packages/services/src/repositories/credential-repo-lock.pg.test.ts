/**
 * `CredentialRepo.withTryRefreshLock` against a REAL Postgres engine
 * (in-process PGlite), not a fake.
 *
 * WHAT THIS PROVES, and why a fake cannot:
 *   - `pg_try_advisory_xact_lock(hashtextextended($1, 0))` is REAL Postgres. A
 *     typo (`hashtext` — which exists but takes different args — or
 *     `pg_advisory_try_xact_lock`, which does not exist) fails here and nowhere
 *     else. The in-memory repo's Set-based mutex would happily pass.
 *   - The result SHAPE matches what `readAcquired` reads. It looks for
 *     `rows[0].acquired === true` and FAILS CLOSED on anything else — so if the
 *     driver returned, say, `{ pg_try_advisory_xact_lock: true }`, every lock
 *     would silently read as "someone else holds it" and Slack would NEVER
 *     refresh. That is a silent, total failure a mock cannot surface.
 *   - The lock is genuinely released at COMMIT (xact scope), so a second
 *     acquisition succeeds rather than deadlocking forever.
 *   - The typed error channel survives the Runtime.runPromiseExit round trip
 *     through `db.transaction`.
 *
 * WHAT THIS CANNOT PROVE — stated plainly rather than implied:
 *   PGlite is SINGLE-CONNECTION. Postgres advisory locks are re-entrant within a
 *   session, and PGlite serialises queries, so two "concurrent" transactions
 *   here cannot contend — both would acquire. Cross-instance MUTUAL EXCLUSION,
 *   the reason this lock exists, is therefore only provable against a real
 *   multi-connection Postgres (plan step 16, manual). Nothing in this file
 *   should be read as evidence of it.
 */

import { PGlite } from "@electric-sql/pglite";
import { schema } from "@gtmgrid/db";
import { drizzle } from "drizzle-orm/pglite";
import { Data, Effect, Exit, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DbClient } from "../db-client.js";
import { CredentialRepo, CredentialRepoLive } from "./credential-repo.js";

const pg = new PGlite();
const db = drizzle(pg, { schema });
const layer = CredentialRepoLive.pipe(Layer.provide(Layer.succeed(DbClient, db)));

const run = <A, E>(program: Effect.Effect<A, E, CredentialRepo>) =>
  Effect.runPromiseExit(program.pipe(Effect.provide(layer)));

class BoomError extends Data.TaggedError("BoomError")<{ readonly why: string }> {}

const takeLock = <A, E>(lockKey: string, onAcquired: Effect.Effect<A, E>, onBusy: Effect.Effect<A, E>) =>
  Effect.flatMap(CredentialRepo, (r) => r.withTryRefreshLock({ lockKey, onAcquired, onBusy }));

/**
 * Pay PGlite's WASM boot HERE, not inside the first test.
 *
 * Booting an entire Postgres takes ~1.5s idle and considerably longer when the
 * full suite is running in parallel — comfortably past vitest's 5s default. Left
 * lazy, the first `it` in this file is flaky by construction, and the failure
 * ("Test timed out") looks nothing like its cause.
 */
beforeAll(async () => {
  await pg.query("select 1");
}, 60_000);

afterAll(async () => {
  await pg.close();
});

describe("withTryRefreshLock on real Postgres", () => {
  it("executes the lock SQL and runs onAcquired — i.e. the function name and args are REAL", async () => {
    const exit = await run(takeLock("ws1:slack", Effect.succeed("acquired"), Effect.succeed("busy")));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toBe("acquired");
  });

  it("RELEASES at commit — a second acquisition of the same key succeeds", async () => {
    // If the lock leaked (e.g. session-scoped `pg_advisory_lock` with no
    // matching unlock), this second call would read as busy forever and Slack
    // would never refresh again on this instance.
    await run(takeLock("ws1:slack", Effect.succeed("first"), Effect.succeed("busy")));
    const exit = await run(takeLock("ws1:slack", Effect.succeed("second"), Effect.succeed("busy")));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toBe("second");
  });

  it("hashes DIFFERENT keys to different locks", async () => {
    const a = await run(takeLock("ws1:slack", Effect.succeed("a"), Effect.succeed("busy")));
    const b = await run(takeLock("ws2:slack", Effect.succeed("b"), Effect.succeed("busy")));
    expect(Exit.isSuccess(a) && a.value).toBe("a");
    expect(Exit.isSuccess(b) && b.value).toBe("b");
  });

  it("accepts a key with characters that would break naive SQL interpolation", async () => {
    // The key is a bound parameter, not string-concatenated. If it were
    // interpolated, this would be a syntax error at best.
    const exit = await run(
      takeLock("oauth-refresh:ws';drop table credentials;--:slack", Effect.succeed("safe"), Effect.succeed("busy")),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toBe("safe");
  });

  it("PROPAGATES the inner effect's TYPED failure through the transaction boundary", async () => {
    // The reason the impl uses Runtime.runPromiseExit rather than runPromise: a
    // rejected promise would be caught by tryPromise's `catch` and flattened
    // into CredentialRepoError, erasing BoomError entirely.
    const exit = await run(
      takeLock("ws1:boom", Effect.fail(new BoomError({ why: "inner" })), Effect.succeed("busy")),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("BoomError");
    expect(JSON.stringify(exit)).not.toContain("CredentialRepoError");
  });

  it("a failure inside the lock still releases it (the transaction ends either way)", async () => {
    await run(takeLock("ws1:after-fail", Effect.fail(new BoomError({ why: "x" })), Effect.succeed("busy")));
    const exit = await run(takeLock("ws1:after-fail", Effect.succeed("reacquired"), Effect.succeed("busy")));
    expect(Exit.isSuccess(exit) && exit.value).toBe("reacquired");
  });
});
