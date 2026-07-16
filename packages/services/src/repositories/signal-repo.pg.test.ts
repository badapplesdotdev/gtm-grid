/**
 * `SignalRepo.listDuePage` against a REAL Postgres engine (in-process PGlite), not
 * the in-memory Test Layer. The due filter is a parameterised SQL `CASE` whose
 * result type Postgres must resolve at execution time; a mocked/in-memory path
 * (and SQLite) never type-checks that expression, so the cron's
 * `poll-trigify-signals` failure — `Error: Failed query`, every hourly tick since
 * the `ELSE NULL` change — slipped through the offline suite entirely.
 *
 * This suite exercises the exact `listDuePage` SQL on Postgres so an untyped
 * `CASE` (all-NULL/all-unknown branches Postgres can't unify against the
 * `bigint last_synced_at` comparison) fails the test instead of prod.
 */

import { PGlite } from "@electric-sql/pglite";
import { schema } from "@gtmgrid/db";
import { drizzle } from "drizzle-orm/pglite";
import { Effect, Exit, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DbClient } from "../db-client.js";
import { SignalRepo, SignalRepoLive } from "./signal-repo.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

// A fixed workspace/table id — no FK tables exist in this isolated schema, so the
// columns are plain uuids here (the listDuePage query touches only signal_bindings).
const WS = "11111111-1111-1111-1111-111111111111";
const TBL = "22222222-2222-2222-2222-222222222222";

type SeedBinding = {
  readonly id: string;
  readonly schedule: string;
  readonly enabled: boolean;
  readonly lastSyncedAt: number | null;
  readonly createdAt: number;
};

const pg = new PGlite();
const db = drizzle(pg, { schema });
const layer = SignalRepoLive.pipe(Layer.provide(Layer.succeed(DbClient, db)));

const run = <A, E>(program: Effect.Effect<A, E, SignalRepo>) =>
  Effect.runPromiseExit(program.pipe(Effect.provide(layer)));

const seed = (bindings: readonly SeedBinding[]) =>
  db.insert(schema.signalBindings).values(
    bindings.map((b) => ({
      id: b.id,
      workspaceId: WS,
      tableId: TBL,
      sourceId: "linkedin-posts",
      label: "LinkedIn Posts",
      kind: "search",
      searchId: "srch-1",
      config: {},
      schedule: b.schedule,
      columns: [],
      seen: [],
      lastSyncedAt: b.lastSyncedAt,
      lastError: null,
      rowsPulled: 0,
      enabled: b.enabled,
      createdAt: b.createdAt,
    })),
  );

beforeAll(async () => {
  // Mirror the `signal_bindings` columns the due query reads. No FK references —
  // this table stands alone, which is all listDuePage needs.
  await pg.exec(`
    CREATE TABLE signal_bindings (
      id uuid PRIMARY KEY,
      workspace_id uuid NOT NULL,
      table_id uuid NOT NULL,
      source_id text NOT NULL,
      label text NOT NULL,
      kind text NOT NULL,
      search_id text,
      config jsonb NOT NULL,
      schedule text NOT NULL,
      columns jsonb NOT NULL,
      seen jsonb,
      last_synced_at bigint,
      last_error text,
      rows_pulled integer,
      enabled boolean NOT NULL,
      created_at bigint NOT NULL
    );
  `);
}, 30_000);

afterAll(async () => {
  await pg.close();
});

describe("SignalRepo.listDuePage (real Postgres — untyped-CASE regression)", () => {
  it("resolves the parameterised due CASE on Postgres for mixed schedules", async () => {
    // The regression guard: with mixed hourly/daily/weekly/manual schedules the
    // due `CASE` carries a bound param in every non-NULL branch. If those params
    // are untyped, Postgres cannot unify the CASE result with the bigint
    // `last_synced_at` comparison and the whole query fails — which is exactly
    // what broke the hourly cron. A successful Exit here proves the cast holds.
    await seed([
      { id: "00000000-0000-0000-0000-000000000001", schedule: "hourly", enabled: true, lastSyncedAt: null, createdAt: 1 }, // never synced → due
      { id: "00000000-0000-0000-0000-000000000002", schedule: "hourly", enabled: true, lastSyncedAt: NOW - 2 * HOUR, createdAt: 2 }, // 2h ago → due
      { id: "00000000-0000-0000-0000-000000000003", schedule: "hourly", enabled: true, lastSyncedAt: NOW - 30 * 60 * 1000, createdAt: 3 }, // 30m ago → not due
      { id: "00000000-0000-0000-0000-000000000004", schedule: "daily", enabled: true, lastSyncedAt: NOW - 2 * DAY, createdAt: 4 }, // 2d ago → due
      { id: "00000000-0000-0000-0000-000000000005", schedule: "daily", enabled: true, lastSyncedAt: NOW - 2 * HOUR, createdAt: 5 }, // 2h ago, daily → not due
      { id: "00000000-0000-0000-0000-000000000006", schedule: "weekly", enabled: true, lastSyncedAt: NOW - 8 * DAY, createdAt: 6 }, // 8d ago → due
      { id: "00000000-0000-0000-0000-000000000007", schedule: "manual", enabled: true, lastSyncedAt: null, createdAt: 7 }, // manual → never due
      { id: "00000000-0000-0000-0000-000000000008", schedule: "hourly", enabled: false, lastSyncedAt: null, createdAt: 8 }, // disabled → not due
    ]);

    const exit = await run(
      Effect.flatMap(SignalRepo, (r) => r.listDuePage({ now: NOW, limit: 100, cursor: null })),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.items.map((i) => i.id)).toEqual([
        "00000000-0000-0000-0000-000000000001",
        "00000000-0000-0000-0000-000000000002",
        "00000000-0000-0000-0000-000000000004",
        "00000000-0000-0000-0000-000000000006",
      ]);
      expect(exit.value.nextCursor).toBeNull();
    }
  });

  it("paginates the due set via the keyset cursor on Postgres", async () => {
    const page1 = await run(
      Effect.flatMap(SignalRepo, (r) => r.listDuePage({ now: NOW, limit: 2, cursor: null })),
    );
    expect(Exit.isSuccess(page1)).toBe(true);
    if (!Exit.isSuccess(page1)) return;
    expect(page1.value.items.map((i) => i.id)).toEqual([
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000002",
    ]);
    expect(page1.value.nextCursor).not.toBeNull();

    const page2 = await run(
      Effect.flatMap(SignalRepo, (r) => r.listDuePage({ now: NOW, limit: 2, cursor: page1.value.nextCursor })),
    );
    expect(Exit.isSuccess(page2) && page2.value.items.map((i) => i.id)).toEqual([
      "00000000-0000-0000-0000-000000000004",
      "00000000-0000-0000-0000-000000000006",
    ]);
    if (Exit.isSuccess(page2)) expect(page2.value.nextCursor).toBeNull();
  });
});
