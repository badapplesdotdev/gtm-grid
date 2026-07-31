/**
 * Unit tests for every {@link CredentialRepo} method, exercised against the
 * in-memory {@link credentialRepoLayer} — NO live database.
 *
 * The repo is the raw table adapter (no authz / no ownership rules — those live
 * in CredentialService), so these tests assert pure data behaviour:
 *   - `listMetadata` returns metadata and NEVER exposes `secretsEnc`.
 *   - `findForAccess` matches the (workspace, extension, scope, owner) key,
 *     distinguishing personal owners and shared (null-owner) rows.
 *   - `findSharedForWorker` only ever returns shared workspace-scope rows.
 *   - `upsert` inserts a new row and rotates an existing one in place.
 *   - `accountId` is part of the owner key, so one workspace can hold SEVERAL
 *     accounts on one connector (Slack teams) without them overwriting one
 *     another, and `findSharedAccounts` lists them oldest-first.
 */

import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_DEFAULT,
  type CredentialRow,
  CredentialRepo,
  credentialRepoLayer,
} from "./credential-repo.js";

const WS = "11111111-1111-1111-1111-111111111111";
const ENC = (label: string) => `enc(${label})`;

const sharedRow: CredentialRow = {
  id: "c_shared",
  workspaceId: WS,
  extensionId: "ai:openai",
  accountId: ACCOUNT_DEFAULT,
  scope: "workspace",
  name: "OpenAI (team)",
  ownerUserId: null,
  secretsEnc: ENC("shared"),
  createdAt: 1,
};
const aliceRow: CredentialRow = {
  id: "c_alice",
  workspaceId: WS,
  extensionId: "ai:openai",
  accountId: ACCOUNT_DEFAULT,
  scope: "personal",
  name: "OpenAI (Alice)",
  ownerUserId: "user_alice",
  secretsEnc: ENC("alice"),
  createdAt: 2,
};
const bobRow: CredentialRow = {
  id: "c_bob",
  workspaceId: WS,
  extensionId: "ai:openai",
  accountId: ACCOUNT_DEFAULT,
  scope: "personal",
  name: "OpenAI (Bob)",
  ownerUserId: "user_bob",
  secretsEnc: ENC("bob"),
  createdAt: 3,
};

const seed = [sharedRow, aliceRow, bobRow] as const;

const run = <A, E>(
  program: Effect.Effect<A, E, CredentialRepo>,
  rows: readonly CredentialRow[] = seed,
) => Effect.runPromise(program.pipe(Effect.provide(credentialRepoLayer(rows))));

describe("CredentialRepo.listMetadata", () => {
  it("returns one metadata row per credential, NEVER secretsEnc", async () => {
    const rows = await run(
      Effect.flatMap(CredentialRepo, (r) => r.listMetadata(WS)),
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).not.toHaveProperty("secretsEnc");
    }
    expect(rows.map((r) => r.id).sort()).toEqual([
      "c_alice",
      "c_bob",
      "c_shared",
    ]);
  });

  it("returns no rows for a different workspace", async () => {
    const rows = await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.listMetadata("99999999-9999-9999-9999-999999999999"),
      ),
    );
    expect(rows).toEqual([]);
  });
});

describe("CredentialRepo.findForAccess", () => {
  it("returns the shared row including ciphertext on a null-owner key", async () => {
    const found = await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.findForAccess({
          workspaceId: WS,
          extensionId: "ai:openai",
          scope: "workspace",
          ownerUserId: null,
        }),
      ),
    );
    expect(Option.isSome(found)).toBe(true);
    if (Option.isSome(found)) expect(found.value.secretsEnc).toBe(ENC("shared"));
  });

  it("returns the caller's OWN personal row, not another member's", async () => {
    const found = await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.findForAccess({
          workspaceId: WS,
          extensionId: "ai:openai",
          scope: "personal",
          ownerUserId: "user_alice",
        }),
      ),
    );
    expect(Option.isSome(found)).toBe(true);
    if (Option.isSome(found)) {
      expect(found.value.id).toBe("c_alice");
      expect(found.value.secretsEnc).toBe(ENC("alice"));
    }
  });

  it("returns None when no row matches the owner key", async () => {
    const found = await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.findForAccess({
          workspaceId: WS,
          extensionId: "ai:openai",
          scope: "personal",
          ownerUserId: "user_carol",
        }),
      ),
    );
    expect(Option.isNone(found)).toBe(true);
  });
});

describe("CredentialRepo.findSharedForWorker", () => {
  it("returns only the shared workspace-scope row", async () => {
    const found = await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.findSharedForWorker({ workspaceId: WS, extensionId: "ai:openai" }),
      ),
    );
    expect(Option.isSome(found)).toBe(true);
    if (Option.isSome(found)) {
      expect(found.value.id).toBe("c_shared");
      expect(found.value.scope).toBe("workspace");
      expect(found.value.ownerUserId).toBeNull();
    }
  });

  it("returns None when only personal rows exist (never a member's key)", async () => {
    const found = await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.findSharedForWorker({ workspaceId: WS, extensionId: "ai:openai" }),
      ),
      [aliceRow, bobRow],
    );
    expect(Option.isNone(found)).toBe(true);
  });
});

describe("CredentialRepo.upsert", () => {
  it("inserts a new row when no owner-key match exists", async () => {
    const id = await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.upsert({
          workspaceId: WS,
          extensionId: "ai:anthropic",
          scope: "workspace",
          ownerUserId: null,
          name: "Anthropic",
          secretsEnc: ENC("new"),
        }),
      ),
      [],
    );
    expect(id).toBeTruthy();
  });

  it("rotates an existing row in place (same id, new ciphertext)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CredentialRepo;
        const id = yield* repo.upsert({
          workspaceId: WS,
          extensionId: "ai:openai",
          scope: "personal",
          ownerUserId: "user_alice",
          name: "OpenAI (Alice, rotated)",
          secretsEnc: ENC("alice-v2"),
        });
        const row = yield* repo.findForAccess({
          workspaceId: WS,
          extensionId: "ai:openai",
          scope: "personal",
          ownerUserId: "user_alice",
        });
        return { id, row };
      }),
    );
    expect(result.id).toBe("c_alice");
    expect(Option.isSome(result.row)).toBe(true);
    if (Option.isSome(result.row)) {
      expect(result.row.value.secretsEnc).toBe(ENC("alice-v2"));
      expect(result.row.value.name).toBe("OpenAI (Alice, rotated)");
    }
  });
});

describe("CredentialRepo.remove (in-memory contract)", () => {
  const WS = "11111111-1111-1111-1111-111111111111";
  const row = (over: Partial<CredentialRow> = {}): CredentialRow => ({
    id: "cred_1",
    workspaceId: WS,
    extensionId: "attio-crm",
    accountId: ACCOUNT_DEFAULT,
    scope: "workspace",
    name: "Attio",
    ownerUserId: null,
    secretsEnc: "ciphertext",
    createdAt: 1,
    ...over,
  });

  it("deletes the matching workspace-scope row and reports true", async () => {
    const layer = credentialRepoLayer([row()]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CredentialRepo;
        const removed = yield* repo.remove({ workspaceId: WS, extensionId: "attio-crm", scope: "workspace", ownerUserId: null });
        const after = yield* repo.findSharedForWorker({ workspaceId: WS, extensionId: "attio-crm" });
        return { removed, stillThere: after._tag === "Some" };
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual({ removed: true, stillThere: false });
  });

  it("is a no-op (false) when nothing matches, and never touches other slots", async () => {
    const layer = credentialRepoLayer([row({ extensionId: "attio" })]); // the API-key slot
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CredentialRepo;
        const removed = yield* repo.remove({ workspaceId: WS, extensionId: "attio-crm", scope: "workspace", ownerUserId: null });
        const apiKeyRow = yield* repo.findSharedForWorker({ workspaceId: WS, extensionId: "attio" });
        return { removed, apiKeySurvives: apiKeyRow._tag === "Some" };
      }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual({ removed: false, apiKeySurvives: true });
  });
});

// ── MULTI-ACCOUNT: `accountId` as part of the owner key ──────────────────────
//
// One workspace may connect SEVERAL accounts on one connector — the motivating
// case is installing the Slack app into more than one Slack team, each install
// carrying its own token pair. The discriminator is the `account_id` COLUMN, so
// every key-shaped method has to carry it or two teams collapse onto one row.

const SLACK = "slack";
/** Team A, connected first. */
const teamARow: CredentialRow = {
  id: "c_team_a",
  workspaceId: WS,
  extensionId: SLACK,
  accountId: "T_A",
  scope: "workspace",
  name: "Slack — Acme",
  ownerUserId: null,
  secretsEnc: ENC("team-a"),
  createdAt: 10,
};
/** Team B, connected second — the row the old single-row upsert destroyed. */
const teamBRow: CredentialRow = {
  id: "c_team_b",
  workspaceId: WS,
  extensionId: SLACK,
  accountId: "T_B",
  scope: "workspace",
  name: "Slack — Acme EU",
  ownerUserId: null,
  secretsEnc: ENC("team-b"),
  createdAt: 20,
};

describe("CredentialRepo.upsert keyed on accountId", () => {
  it("connecting a SECOND account INSERTS a row instead of overwriting the first", async () => {
    // THE HEADLINE BUG. Before `accountId` joined the owner key, both connects
    // matched the same (workspace, extension, scope, owner) key, so the second
    // one rotated the first's ciphertext away — member B's connect silently
    // revoked member A's team, and there was no row left to notice it from.
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CredentialRepo;
        const idA = yield* repo.upsert({
          workspaceId: WS,
          extensionId: SLACK,
          accountId: "T_A",
          scope: "workspace",
          ownerUserId: null,
          name: "Slack — Acme",
          secretsEnc: ENC("team-a"),
        });
        const idB = yield* repo.upsert({
          workspaceId: WS,
          extensionId: SLACK,
          accountId: "T_B",
          scope: "workspace",
          ownerUserId: null,
          name: "Slack — Acme EU",
          secretsEnc: ENC("team-b"),
        });
        const accounts = yield* repo.findSharedAccounts({
          workspaceId: WS,
          extensionId: SLACK,
        });
        return { idA, idB, accounts };
      }),
      [],
    );
    expect(result.idA).not.toBe(result.idB);
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts.map((a) => a.accountId)).toEqual(["T_A", "T_B"]);
    // Team A's ciphertext is still team A's — it was not rotated to B's.
    expect(result.accounts.map((a) => a.secretsEnc)).toEqual([
      ENC("team-a"),
      ENC("team-b"),
    ]);
  });

  it("re-connecting the SAME account rotates that row in place, leaving the other alone", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CredentialRepo;
        const id = yield* repo.upsert({
          workspaceId: WS,
          extensionId: SLACK,
          accountId: "T_A",
          scope: "workspace",
          ownerUserId: null,
          name: "Slack — Acme",
          secretsEnc: ENC("team-a-v2"),
        });
        const accounts = yield* repo.findSharedAccounts({
          workspaceId: WS,
          extensionId: SLACK,
        });
        return { id, accounts };
      }),
      [teamARow, teamBRow],
    );
    expect(result.id).toBe("c_team_a");
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts.map((a) => a.secretsEnc)).toEqual([
      ENC("team-a-v2"),
      ENC("team-b"),
    ]);
  });

  it("treats an OMITTED accountId as the sole-account key, distinct from a named team", async () => {
    // The ~20 single-account call sites pass nothing; that must land on `""`,
    // the column default, and must NOT collide with a Slack team's row.
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CredentialRepo;
        yield* repo.upsert({
          workspaceId: WS,
          extensionId: SLACK,
          scope: "workspace",
          ownerUserId: null,
          name: "Slack",
          secretsEnc: ENC("legacy"),
        });
        return yield* repo.findSharedAccounts({
          workspaceId: WS,
          extensionId: SLACK,
        });
      }),
      [teamARow],
    );
    expect(result.map((a) => a.accountId).sort()).toEqual([
      ACCOUNT_DEFAULT,
      "T_A",
    ]);
  });
});

describe("CredentialRepo.findSharedAccounts", () => {
  it("returns every shared account for the connector, OLDEST FIRST", async () => {
    // The order is load-bearing: `SlackConnectionService`'s "exactly one
    // connection ⇒ use it" fallback reads element 0, and the UI lists in the
    // same order. Left to the planner it would drift between deploys.
    const accounts = await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.findSharedAccounts({ workspaceId: WS, extensionId: SLACK }),
      ),
      [teamBRow, teamARow],
    );
    expect(accounts.map((a) => a.accountId)).toEqual(["T_A", "T_B"]);
  });

  it("includes ciphertext (it is the worker's read path, not the UI's)", async () => {
    const accounts = await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.findSharedAccounts({ workspaceId: WS, extensionId: SLACK }),
      ),
      [teamARow],
    );
    expect(accounts[0].secretsEnc).toBe(ENC("team-a"));
  });

  it("NEVER returns a member's personal row, only shared ones", async () => {
    const accounts = await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.findSharedAccounts({ workspaceId: WS, extensionId: "ai:openai" }),
      ),
      [aliceRow, bobRow],
    );
    expect(accounts).toEqual([]);
  });

  it("returns an empty list for a connector with nothing connected", async () => {
    const accounts = await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.findSharedAccounts({ workspaceId: WS, extensionId: SLACK }),
      ),
      [],
    );
    expect(accounts).toEqual([]);
  });
});

describe("CredentialRepo reads narrowed by accountId", () => {
  it("findSharedForWorker returns the NAMED account's row, not the first one", async () => {
    const found = await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.findSharedForWorker({
          workspaceId: WS,
          extensionId: SLACK,
          accountId: "T_B",
        }),
      ),
      [teamARow, teamBRow],
    );
    expect(Option.isSome(found)).toBe(true);
    if (Option.isSome(found)) {
      expect(found.value.id).toBe("c_team_b");
      expect(found.value.secretsEnc).toBe(ENC("team-b"));
    }
  });

  it("findSharedForWorker with NO accountId misses team rows entirely", async () => {
    // Not a wildcard: an omitted account means `""`, which no connected team
    // occupies. A caller that wants a team must name it.
    const found = await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.findSharedForWorker({ workspaceId: WS, extensionId: SLACK }),
      ),
      [teamARow, teamBRow],
    );
    expect(Option.isNone(found)).toBe(true);
  });

  it("findForAccess distinguishes two accounts under the same owner key", async () => {
    const found = await run(
      Effect.flatMap(CredentialRepo, (r) =>
        r.findForAccess({
          workspaceId: WS,
          extensionId: SLACK,
          accountId: "T_A",
          scope: "workspace",
          ownerUserId: null,
        }),
      ),
      [teamARow, teamBRow],
    );
    expect(Option.isSome(found)).toBe(true);
    if (Option.isSome(found)) expect(found.value.secretsEnc).toBe(ENC("team-a"));
  });
});

describe("CredentialRepo.remove narrowed by accountId", () => {
  it("removes ONLY the named account and leaves the other connected", async () => {
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CredentialRepo;
        const removed = yield* repo.remove({
          workspaceId: WS,
          extensionId: SLACK,
          accountId: "T_A",
          scope: "workspace",
          ownerUserId: null,
        });
        const left = yield* repo.findSharedAccounts({
          workspaceId: WS,
          extensionId: SLACK,
        });
        return { removed, left: left.map((a) => a.accountId) };
      }),
      [teamARow, teamBRow],
    );
    expect(result).toEqual({ removed: true, left: ["T_B"] });
  });

  it("removing the sole-account key does NOT delete a team's row", async () => {
    // The legacy-healing path in SlackConnectionService deletes exactly the
    // `""` row right after re-writing its contents under the real team id. If
    // this key were treated as a wildcard, healing would delete what it just
    // wrote and the connection would vanish on first read.
    const result = await run(
      Effect.gen(function* () {
        const repo = yield* CredentialRepo;
        const removed = yield* repo.remove({
          workspaceId: WS,
          extensionId: SLACK,
          accountId: ACCOUNT_DEFAULT,
          scope: "workspace",
          ownerUserId: null,
        });
        const left = yield* repo.findSharedAccounts({
          workspaceId: WS,
          extensionId: SLACK,
        });
        return { removed, left: left.map((a) => a.accountId) };
      }),
      [teamARow],
    );
    expect(result).toEqual({ removed: false, left: ["T_A"] });
  });
});

describe("CredentialRepo.listMetadata exposes accountId", () => {
  it("carries the account discriminator but STILL never the ciphertext", async () => {
    const rows = await run(
      Effect.flatMap(CredentialRepo, (r) => r.listMetadata(WS)),
      [teamARow, teamBRow],
    );
    expect(rows.map((r) => r.accountId).sort()).toEqual(["T_A", "T_B"]);
    for (const row of rows) expect(row).not.toHaveProperty("secretsEnc");
  });
});
