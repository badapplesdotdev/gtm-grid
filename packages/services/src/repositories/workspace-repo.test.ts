/**
 * Unit tests for the in-memory {@link WorkspaceRepo} Layer
 * ({@link workspaceRepoLayer}) — the W2 methods, NO live database.
 *
 * Covers `findManyByIds` (the batched `me` read), `insert` (observable by a
 * later read), `findCustomerData` (org name + owner email join) and `findUser`.
 */

import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  type Workspace,
  WorkspaceRepo,
  type WorkspaceUser,
  workspaceRepoLayer,
} from "./workspace-repo.js";

const workspaces: readonly Workspace[] = [
  { id: "w1", name: "Alpha", ownerId: "u1" },
  { id: "w2", name: "Beta", ownerId: "u2" },
];
const users: readonly WorkspaceUser[] = [
  { id: "u1", name: "Una", email: "una@example.com" },
];

const run = <A, E>(use: (r: typeof WorkspaceRepo.Service) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const repo = yield* WorkspaceRepo;
      return yield* use(repo);
    }).pipe(Effect.provide(workspaceRepoLayer(workspaces, users))),
  );

describe("workspaceRepoLayer", () => {
  it("findManyByIds returns only the requested workspaces", async () => {
    const result = await run((r) => r.findManyByIds(["w1", "missing"]));
    expect(result.map((w) => w.id)).toEqual(["w1"]);
  });

  it("findManyByIds returns [] for an empty id list", async () => {
    expect(await run((r) => r.findManyByIds([]))).toEqual([]);
  });

  it("insert is observable by a later findById", async () => {
    const result = await run((r) =>
      Effect.gen(function* () {
        const id = yield* r.insert({
          name: "Gamma",
          ownerId: "u9",
          createdAt: 1,
        });
        return yield* r.findById(id);
      }),
    );
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) expect(result.value.name).toBe("Gamma");
  });

  it("findCustomerData joins the owner's email", async () => {
    expect(await run((r) => r.findCustomerData("w1"))).toEqual({
      name: "Alpha",
      email: "una@example.com",
    });
  });

  it("findCustomerData returns nulls for an unknown workspace", async () => {
    expect(await run((r) => r.findCustomerData("ghost"))).toEqual({
      name: null,
      email: null,
    });
  });

  it("findUser returns the profile, or None when missing", async () => {
    const some = await run((r) => r.findUser("u1"));
    expect(Option.isSome(some)).toBe(true);
    const none = await run((r) => r.findUser("ghost"));
    expect(Option.isNone(none)).toBe(true);
  });
});
