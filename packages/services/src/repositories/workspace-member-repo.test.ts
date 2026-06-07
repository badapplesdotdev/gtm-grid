/**
 * Unit tests for the in-memory {@link WorkspaceMemberRepo} Layer
 * ({@link workspaceMemberRepoLayer}) — every method, NO live database.
 *
 * The in-memory Layer is exercised exactly as the live Drizzle Layer would be
 * (same Effect surface), so these prove the repo behaviour the WorkspaceService
 * relies on: per-user/per-workspace reads, grouped counts, idempotency lookup,
 * and writes observable by later reads in the same instance.
 */

import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
  type MemberWithUser,
  WorkspaceMemberRepo,
  workspaceMemberRepoLayer,
} from "./workspace-member-repo.js";

const WS_A = "aaaa";
const WS_B = "bbbb";

const rows: readonly MemberWithUser[] = [
  {
    id: "m1",
    workspaceId: WS_A,
    userId: "u1",
    role: "owner",
    createdAt: 1,
    name: "One",
    email: "one@example.com",
  },
  {
    id: "m2",
    workspaceId: WS_A,
    userId: "u2",
    role: "member",
    createdAt: 2,
    name: null,
    email: null,
  },
  {
    id: "m3",
    workspaceId: WS_B,
    userId: "u1",
    role: "admin",
    createdAt: 3,
    name: "One",
    email: "one@example.com",
  },
];

const run = <A, E>(
  fixture: readonly MemberWithUser[],
  use: (repo: typeof WorkspaceMemberRepo.Service) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const repo = yield* WorkspaceMemberRepo;
      return yield* use(repo);
    }).pipe(Effect.provide(workspaceMemberRepoLayer(fixture))),
  );

describe("workspaceMemberRepoLayer", () => {
  it("listByUser returns the user's memberships across workspaces", async () => {
    const result = await run(rows, (r) => r.listByUser("u1"));
    expect(result.map((m) => m.workspaceId).sort()).toEqual([WS_A, WS_B]);
  });

  it("listByWorkspace returns the roster with name/email", async () => {
    const result = await run(rows, (r) => r.listByWorkspace(WS_A));
    expect(result).toHaveLength(2);
    expect(result.find((m) => m.id === "m1")?.email).toBe("one@example.com");
  });

  it("countByWorkspaceIds groups counts per id", async () => {
    const result = await run(rows, (r) =>
      r.countByWorkspaceIds([WS_A, WS_B, "missing"]),
    );
    expect(result.get(WS_A)).toBe(2);
    expect(result.get(WS_B)).toBe(1);
    expect(result.get("missing")).toBeUndefined();
  });

  it("countByWorkspace returns the single-workspace count", async () => {
    expect(await run(rows, (r) => r.countByWorkspace(WS_A))).toBe(2);
    expect(await run(rows, (r) => r.countByWorkspace("nope"))).toBe(0);
  });

  it("findByWorkspaceUser finds the membership (the idempotency check)", async () => {
    const some = await run(rows, (r) => r.findByWorkspaceUser(WS_A, "u2"));
    expect(Option.isSome(some)).toBe(true);
    const none = await run(rows, (r) => r.findByWorkspaceUser(WS_A, "ghost"));
    expect(Option.isNone(none)).toBe(true);
  });

  it("insert is observable by a later read in the same instance", async () => {
    const result = await run([], (r) =>
      Effect.gen(function* () {
        const id = yield* r.insert({
          workspaceId: WS_A,
          userId: "new",
          role: "member",
          createdAt: 9,
        });
        const count = yield* r.countByWorkspace(WS_A);
        const found = yield* r.findByWorkspaceUser(WS_A, "new");
        return { id, count, found };
      }),
    );
    expect(result.count).toBe(1);
    expect(Option.isSome(result.found)).toBe(true);
    expect(result.id).toBeTruthy();
  });
});
