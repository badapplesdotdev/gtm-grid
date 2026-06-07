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
 */

import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
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
