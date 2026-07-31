/**
 * `CredentialRepo`'s ACCOUNT key against a REAL Postgres engine (in-process
 * PGlite), and the real migration that creates its constraints.
 *
 * WHAT THIS PROVES, and why the in-memory layer cannot:
 *
 * `credentialRepoLayer` is a JS array with a `matchesKey` predicate that has
 * always compared `accountId`. `CredentialRepoLive` is SQL, and its `remove`
 * shipped in this branch WITHOUT an `account_id` predicate. Every in-memory test
 * passed. Against Postgres, `disconnect(ws, "T_A")` deleted every team the
 * workspace had connected — and the legacy-healing path, which writes a row
 * under its real team id and then removes the `""` row, deleted the row it had
 * just written, silently destroying a working Slack install on first read after
 * deploy. That class of divergence is structurally invisible to a fake, which is
 * the entire reason this file exists.
 *
 * It also runs migration 0020 VERBATIM, read off disk rather than restated here:
 *   - the two PARTIAL unique indexes really do reject a duplicate SHARED row.
 *     A plain unique index over the same columns would NOT, because
 *     `owner_user_id` is NULL for every workspace-scope row and Postgres treats
 *     NULLs as distinct — the exact trap the partial predicates exist to avoid,
 *     and one no ORM-level test can detect.
 *   - the dedupe DELETE collapses pre-existing duplicates, so `CREATE UNIQUE
 *     INDEX` does not abort the deploy on a database that already lost the
 *     upsert race. If that statement were wrong, the migration would fail in
 *     production and nowhere else.
 *
 * WHAT THIS CANNOT PROVE — stated plainly rather than implied:
 *   PGlite is SINGLE-CONNECTION and serialises queries, so two genuinely
 *   concurrent `upsert` calls cannot race here. What is proved is that the
 *   ON CONFLICT target resolves against the real indexes and that a second write
 *   on the same key UPDATEs rather than INSERTs. True concurrent-writer
 *   behaviour still rests on the unique index, which IS proved below.
 */

import { PGlite } from "@electric-sql/pglite";
import { schema } from "@gtmgrid/db";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { Effect, Exit, Layer, Option } from "effect";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DbClient } from "../db-client.js";
import { CredentialRepo, CredentialRepoLive } from "./credential-repo.js";

const pg = new PGlite();
const db = drizzle(pg, { schema });
const layer = CredentialRepoLive.pipe(Layer.provide(Layer.succeed(DbClient, db)));

const run = <A, E>(program: Effect.Effect<A, E, CredentialRepo>) =>
  Effect.runPromise(program.pipe(Effect.provide(layer)));

const WS = "11111111-1111-1111-1111-111111111111";
const WS2 = "22222222-2222-2222-2222-222222222222";
const SLACK = "slack";

/**
 * The PRE-0020 `credentials` schema — deliberately the state a real database is
 * in when this migration runs: NO `account_id`, and carrying the non-unique
 * `credentials_by_workspace_extension_owner` index that 0020 drops.
 *
 * Hand-written because replaying the full migration chain would drag in every
 * table the app has ever had. Everything 0020 itself does — adding the column,
 * deduping, swapping the indexes — is executed from the real file below, which
 * is the part under test.
 */
// One statement per entry: PGlite executes through the extended protocol, which
// rejects multiple commands in a single prepared statement.
const CREATE_TABLE: readonly string[] = [
  `create table credentials (
    id uuid primary key default gen_random_uuid(),
    workspace_id uuid not null,
    extension_id text not null,
    scope text not null,
    owner_user_id text,
    name text not null,
    secrets_enc text not null,
    created_at bigint not null
  )`,
  `create index "credentials_by_workspace" on credentials (workspace_id)`,
  `create index "credentials_by_workspace_extension" on credentials (workspace_id, extension_id)`,
  `create index "credentials_by_workspace_extension_owner"
     on credentials (workspace_id, extension_id, scope, owner_user_id)`,
];

/**
 * Migration 0020's statements, READ OFF DISK. If someone edits the migration,
 * this test follows it — restating the SQL inline would let the two drift and
 * turn a green test into a false negative on the thing it exists to guard.
 */
const migrationStatements = (): readonly string[] => {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, "../../../db/migrations/0020_smart_talkback.sql");
  return readFileSync(file, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    // Only the statements that touch `credentials`. The migration also adds
    // `columns.account_id`, and that table does not exist in this fixture.
    .filter((s) => /"credentials"/i.test(s));
};

/** Insert against the PRE-migration shape (no `account_id` column yet). */
const seedLegacy = (over: {
  readonly workspaceId?: string;
  readonly secretsEnc?: string;
  readonly createdAt?: number;
}) =>
  db.execute(sql`
    insert into credentials
      (workspace_id, extension_id, scope, owner_user_id, name, secrets_enc, created_at)
    values (
      ${over.workspaceId ?? WS}::uuid,
      ${SLACK},
      ${"workspace"},
      ${null},
      ${"Slack"},
      ${over.secretsEnc ?? "enc"},
      ${over.createdAt ?? 1}
    )
  `);

const seed = (over: {
  readonly workspaceId?: string;
  readonly accountId?: string;
  readonly scope?: string;
  readonly ownerUserId?: string | null;
  readonly secretsEnc?: string;
  readonly createdAt?: number;
}) =>
  db.execute(sql`
    insert into credentials
      (workspace_id, extension_id, account_id, scope, owner_user_id, name, secrets_enc, created_at)
    values (
      ${over.workspaceId ?? WS}::uuid,
      ${SLACK},
      ${over.accountId ?? ""},
      ${over.scope ?? "workspace"},
      ${over.ownerUserId ?? null},
      ${"Slack"},
      ${over.secretsEnc ?? "enc"},
      ${over.createdAt ?? 1}
    )
  `);

const rowCount = async (): Promise<number> => {
  const res = await db.execute(sql`select count(*)::int as n from credentials`);
  const rows = Array.isArray(res) ? res : (Reflect.get(res, "rows") ?? []);
  return Number(Reflect.get(rows[0] ?? {}, "n") ?? 0);
};

beforeAll(async () => {
  // Pay PGlite's WASM boot HERE, not inside the first test — it is ~1.5s idle
  // and far more under a parallel suite, well past vitest's default.
  await pg.query("select 1");
  for (const statement of CREATE_TABLE) await db.execute(sql.raw(statement));
}, 60_000);

afterAll(async () => {
  await pg.close();
});

describe("migration 0020 — dedupe then constrain, on real Postgres", () => {
  it("DEDUPES pre-existing duplicates and then creates the unique indexes", async () => {
    // Two rows on the SAME key — exactly what the old select-then-insert upsert
    // could leave behind. Creating the unique index without dedupe first would
    // abort here, taking the whole deploy with it.
    await seedLegacy({ createdAt: 100, secretsEnc: "older" });
    await seedLegacy({ createdAt: 200, secretsEnc: "newer" });
    expect(await rowCount()).toBe(2);

    for (const statement of migrationStatements()) {
      await db.execute(sql.raw(statement));
    }

    expect(await rowCount()).toBe(1);
    const res = await db.execute(sql`select secrets_enc from credentials`);
    const rows = Array.isArray(res) ? res : (Reflect.get(res, "rows") ?? []);
    // The NEWEST survives — see the migration comment on why that is the chosen
    // side of a genuinely ambiguous call.
    expect(Reflect.get(rows[0] ?? {}, "secrets_enc")).toBe("newer");
  });

  it("the partial unique index REJECTS a second shared row on the same key", async () => {
    // The assertion the whole design rests on. A plain unique index over
    // (workspace, extension, account, scope, owner) would ACCEPT this, because
    // `owner_user_id` is NULL here and Postgres treats NULLs as distinct.
    await expect(seed({ createdAt: 300 })).rejects.toThrow();
  });

  it("still allows the same key at a DIFFERENT account", async () => {
    await seed({ accountId: "T_EU", createdAt: 400 });
    expect(await rowCount()).toBe(2);
  });

  it("still allows a PERSONAL row alongside the shared one", async () => {
    // Personal rows are constrained by the other partial index, keyed on a
    // non-null owner — they must not collide with the shared row.
    await seed({ scope: "personal", ownerUserId: "u1", createdAt: 500 });
    expect(await rowCount()).toBe(3);
  });
});

describe("CredentialRepo account key on real Postgres", () => {
  it("upsert on the SAME account updates in place rather than inserting", async () => {
    const before = await rowCount();
    await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.upsert({
          workspaceId: WS,
          extensionId: SLACK,
          accountId: "T_EU",
          scope: "workspace",
          ownerUserId: null,
          name: "Slack — Acme EU",
          secretsEnc: "rotated",
        }),
      ),
    );
    expect(await rowCount()).toBe(before);

    const found = await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.findForAccess({
          workspaceId: WS,
          extensionId: SLACK,
          accountId: "T_EU",
          scope: "workspace",
          ownerUserId: null,
        }),
      ),
    );
    expect(Option.isSome(found)).toBe(true);
    if (Option.isSome(found)) expect(found.value.secretsEnc).toBe("rotated");
  });

  it("upsert on a NEW account inserts a second row — connecting a second team", async () => {
    const before = await rowCount();
    await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.upsert({
          workspaceId: WS,
          extensionId: SLACK,
          accountId: "T_APAC",
          scope: "workspace",
          ownerUserId: null,
          name: "Slack — Acme APAC",
          secretsEnc: "apac",
        }),
      ),
    );
    expect(await rowCount()).toBe(before + 1);
  });

  it("remove is SCOPED TO THE ACCOUNT — the regression this file exists for", async () => {
    // Shipped without the `account_id` predicate, this deleted every connected
    // team. The in-memory layer could not see it.
    const before = await rowCount();
    const removed = await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.remove({
          workspaceId: WS,
          extensionId: SLACK,
          accountId: "T_APAC",
          scope: "workspace",
          ownerUserId: null,
        }),
      ),
    );
    expect(removed).toBe(true);
    expect(await rowCount()).toBe(before - 1);

    // T_EU must still be there.
    const survivor = await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.findForAccess({
          workspaceId: WS,
          extensionId: SLACK,
          accountId: "T_EU",
          scope: "workspace",
          ownerUserId: null,
        }),
      ),
    );
    expect(Option.isSome(survivor)).toBe(true);
  });

  it("removing the SOLE-ACCOUNT row leaves the team-keyed rows alone", async () => {
    // The legacy-healing sequence: write under the real team id, then delete the
    // `""` row. With an unscoped delete this removed the row just written.
    const before = await rowCount();
    const removed = await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.remove({
          workspaceId: WS,
          extensionId: SLACK,
          scope: "workspace",
          ownerUserId: null,
        }),
      ),
    );
    expect(removed).toBe(true);
    expect(await rowCount()).toBe(before - 1);

    const survivor = await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.findForAccess({
          workspaceId: WS,
          extensionId: SLACK,
          accountId: "T_EU",
          scope: "workspace",
          ownerUserId: null,
        }),
      ),
    );
    expect(Option.isSome(survivor)).toBe(true);
  });

  it("findSharedAccounts returns every account, oldest first, and no personal rows", async () => {
    await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.upsert({
          workspaceId: WS,
          extensionId: SLACK,
          accountId: "T_LATER",
          scope: "workspace",
          ownerUserId: null,
          name: "Slack — Later",
          secretsEnc: "later",
        }),
      ),
    );
    const accounts = await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.findSharedAccounts({ workspaceId: WS, extensionId: SLACK }),
      ),
    );
    // `u1`'s personal row must NOT appear — the worker path must never be able
    // to reach a member's personal credential.
    expect(accounts.every((a) => a.ownerUserId === null)).toBe(true);
    expect(accounts.map((a) => a.accountId)).toContain("T_EU");
    expect(accounts.map((a) => a.accountId)).toContain("T_LATER");
    const created = accounts.map((a) => a.createdAt);
    expect([...created].sort((x, y) => x - y)).toEqual(created);
  });

  it("scopes every read to the workspace", async () => {
    await seed({ workspaceId: WS2, accountId: "T_OTHER", createdAt: 900 });
    const accounts = await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.findSharedAccounts({ workspaceId: WS, extensionId: SLACK }),
      ),
    );
    expect(accounts.map((a) => a.accountId)).not.toContain("T_OTHER");
  });
});
