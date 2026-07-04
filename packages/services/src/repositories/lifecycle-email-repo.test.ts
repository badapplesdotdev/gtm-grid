/**
 * Tests for the in-memory {@link lifecycleEmailRepoLayer} — the Test Layer the
 * offline suites (and TestLayer composition) rely on, so its semantics must
 * mirror the Drizzle Live layer exactly: once-only claims keyed on
 * (user, template, dedupeKey), release re-opening a claim, pref merges, and the
 * last-active touch. No live database.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  LifecycleEmailRepo,
  lifecycleEmailRepoLayer,
} from "./lifecycle-email-repo.js";

const USERS = [
  {
    id: "user_1",
    email: "olive@acme.com",
    name: "Olive Owner",
    emailPrefs: { digest: false },
  },
  { id: "user_2", email: "sam@acme.com" },
] as const;

const run = <A>(
  program: (repo: Effect.Effect.Success<typeof LifecycleEmailRepo>) => Effect.Effect<A, unknown>,
  seed = { users: USERS },
) =>
  Effect.runPromise(
    Effect.flatMap(LifecycleEmailRepo, program).pipe(
      Effect.provide(lifecycleEmailRepoLayer(seed)),
    ),
  );

const CLAIM = {
  userId: "user_1",
  workspaceId: null,
  template: "weekly-digest",
  dedupeKey: "2026-W27",
};

describe("getRecipient", () => {
  it("returns the seeded profile with prefs and null lastActiveAt", async () => {
    const r = await run((repo) => repo.getRecipient("user_1"));
    expect(r).toEqual({
      id: "user_1",
      email: "olive@acme.com",
      name: "Olive Owner",
      emailPrefs: { digest: false },
      lastActiveAt: null,
    });
  });

  it("defaults name to null and prefs to {} when unseeded", async () => {
    const r = await run((repo) => repo.getRecipient("user_2"));
    expect(r).toEqual({
      id: "user_2",
      email: "sam@acme.com",
      name: null,
      emailPrefs: {},
      lastActiveAt: null,
    });
  });

  it("returns null for an unknown user", async () => {
    expect(await run((repo) => repo.getRecipient("ghost"))).toBeNull();
  });
});

describe("recordSendOnce / releaseSend", () => {
  it("first claim wins, repeat claim loses", async () => {
    const [first, second] = await run((repo) =>
      Effect.all([repo.recordSendOnce(CLAIM), repo.recordSendOnce(CLAIM)]),
    );
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("claims are scoped per (user, template, dedupeKey) — varying any part claims fresh", async () => {
    const results = await run((repo) =>
      Effect.all([
        repo.recordSendOnce(CLAIM),
        repo.recordSendOnce({ ...CLAIM, userId: "user_2" }),
        repo.recordSendOnce({ ...CLAIM, template: "dormant" }),
        repo.recordSendOnce({ ...CLAIM, dedupeKey: "2026-W28" }),
      ]),
    );
    expect(results).toEqual([true, true, true, true]);
  });

  it("release re-opens exactly the released claim (the failed-send retry path)", async () => {
    const results = await run((repo) =>
      Effect.gen(function* () {
        const first = yield* repo.recordSendOnce(CLAIM);
        yield* repo.releaseSend(CLAIM);
        const reclaimed = yield* repo.recordSendOnce(CLAIM);
        const repeat = yield* repo.recordSendOnce(CLAIM);
        return [first, reclaimed, repeat];
      }),
    );
    expect(results).toEqual([true, true, false]);
  });
});

describe("setEmailPref / touchLastActive", () => {
  it("merges a category into prefs without clobbering others", async () => {
    const r = await run((repo) =>
      Effect.gen(function* () {
        yield* repo.setEmailPref("user_1", "status", false);
        return yield* repo.getRecipient("user_1");
      }),
    );
    expect(r?.emailPrefs).toEqual({ digest: false, status: false });
  });

  it("re-enabling a category flips it back on", async () => {
    const r = await run((repo) =>
      Effect.gen(function* () {
        yield* repo.setEmailPref("user_1", "digest", true);
        return yield* repo.getRecipient("user_1");
      }),
    );
    expect(r?.emailPrefs).toEqual({ digest: true });
  });

  it("touchLastActive stamps a recent Date", async () => {
    const before = Date.now();
    const r = await run((repo) =>
      Effect.gen(function* () {
        yield* repo.touchLastActive("user_1");
        return yield* repo.getRecipient("user_1");
      }),
    );
    expect(r?.lastActiveAt).toBeInstanceOf(Date);
    expect((r?.lastActiveAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });
});
