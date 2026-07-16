/**
 * `ShareRepo` (Drizzle-backed) against a REAL Postgres engine (in-process
 * PGlite). Exercises the storage contract the share flow depends on: a token is
 * uniquely addressable, revoke disables the row (without deleting it), and a
 * table's shares list newest-first. The `table_shares_by_token` unique index is
 * mirrored so a duplicate token fails at the DB, not silently.
 */

import { PGlite } from "@electric-sql/pglite";
import { schema } from "@gtmgrid/db";
import { drizzle } from "drizzle-orm/pglite";
import { Effect, Layer, Option } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DbClient } from "../db-client.js";
import { ShareRepo, ShareRepoLive } from "./share-repo.js";

const WS = "11111111-1111-1111-1111-111111111111";
const TABLE = "22222222-2222-2222-2222-222222222222";

const pg = new PGlite();
const db = drizzle(pg, { schema });
const layer = ShareRepoLive.pipe(Layer.provide(Layer.succeed(DbClient, db)));
const run = <A, E>(program: Effect.Effect<A, E, ShareRepo>) =>
  Effect.runPromise(program.pipe(Effect.provide(layer)));

const snapshot = { version: 1, table: { name: "T" }, columns: [], rows: 0, cells: [] };
const newShare = (token: string, over: Partial<Parameters<ShareRepo["Type"]["insert"]>[0]> = {}) => ({
  workspaceId: WS, tableId: TABLE, token, name: "Share", snapshot,
  snapshotVersion: 1, enabled: true, expiresAt: null, createdBy: null, createdAt: Date.now(), ...over,
});

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE table_shares (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id uuid NOT NULL,
      table_id uuid,
      token text NOT NULL,
      name text,
      snapshot jsonb NOT NULL,
      snapshot_version integer NOT NULL,
      enabled boolean NOT NULL,
      expires_at bigint,
      created_by text,
      created_at bigint NOT NULL,
      revoked_at bigint,
      CONSTRAINT table_shares_by_token UNIQUE (token)
    );
  `);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec("DELETE FROM table_shares;");
});

describe("ShareRepo (real Postgres)", () => {
  it("inserts a share and resolves it by token", async () => {
    const created = await run(Effect.flatMap(ShareRepo, (r) => r.insert(newShare("tok-1"))));
    expect(created.token).toBe("tok-1");
    expect(created.enabled).toBe(true);

    const found = await run(Effect.flatMap(ShareRepo, (r) => r.findByToken("tok-1")));
    expect(Option.isSome(found)).toBe(true);
    if (Option.isSome(found)) expect(found.value.id).toBe(created.id);

    const missing = await run(Effect.flatMap(ShareRepo, (r) => r.findByToken("nope")));
    expect(Option.isNone(missing)).toBe(true);
  });

  it("enforces token uniqueness at the database", async () => {
    await run(Effect.flatMap(ShareRepo, (r) => r.insert(newShare("dup"))));
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(ShareRepo, (r) => r.insert(newShare("dup"))).pipe(Effect.provide(layer)),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("revoke disables the row without deleting it", async () => {
    const created = await run(Effect.flatMap(ShareRepo, (r) => r.insert(newShare("tok-revoke"))));
    await run(Effect.flatMap(ShareRepo, (r) => r.revoke(created.id, 12345)));

    const found = await run(Effect.flatMap(ShareRepo, (r) => r.findByToken("tok-revoke")));
    expect(Option.isSome(found)).toBe(true);
    if (Option.isSome(found)) {
      expect(found.value.enabled).toBe(false);
      expect(found.value.revokedAt).toBe(12345);
    }
  });

  it("lists a table's shares newest-first", async () => {
    await run(Effect.flatMap(ShareRepo, (r) => r.insert(newShare("old", { createdAt: 100 }))));
    await run(Effect.flatMap(ShareRepo, (r) => r.insert(newShare("new", { createdAt: 200 }))));
    const list = await run(Effect.flatMap(ShareRepo, (r) => r.listByTable(TABLE)));
    expect(list.map((s) => s.token)).toEqual(["new", "old"]);
  });
});
