/**
 * `ExtensionService` unit tests — OFFLINE against in-memory Test Layers.
 * Covers member-gated list, the (workspaceId, extensionId) UPSERT (install vs
 * update-in-place), and non-member rejection.
 */

import {
  identityLayer as cloudIdentityLayer,
  memberRepoLayer as cloudMemberRepoLayer,
  type Membership,
  MembershipService,
} from "@gtmgrid/cloud";
import { Cause, Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  type Extension,
  extensionRepoLayer,
} from "../repositories/extension-repo.js";
import { ExtensionService } from "./extension-service.js";

const WS = "ws-1";
const memberships: readonly Membership[] = [
  { workspaceId: WS, userId: "member", role: "member" },
];

function harness(opts: {
  extensions?: Extension[];
  currentUserId?: string | null;
}) {
  const repo = extensionRepoLayer(opts.extensions ?? []);
  const membership = MembershipService.Default.pipe(
    Layer.provide(cloudIdentityLayer(opts.currentUserId ?? "member")),
    Layer.provide(cloudMemberRepoLayer(memberships)),
  );
  const layer = ExtensionService.Default.pipe(
    Layer.provide(repo),
    Layer.provide(membership),
  );
  const run = <A, E>(program: Effect.Effect<A, E, ExtensionService>) =>
    Effect.runPromiseExit(program.pipe(Effect.provide(layer)));
  return { run };
}

const svc = Effect.gen(function* () {
  return yield* ExtensionService;
});

describe("ExtensionService.listExtensions", () => {
  it("lists a workspace's extensions for a member", async () => {
    const exts: Extension[] = [
      {
        id: "e1",
        workspaceId: WS,
        extensionId: "apollo",
        name: "Apollo",
        category: null,
        manifest: {},
      },
    ];
    const { run } = harness({ extensions: exts });
    const exit = await run(
      svc.pipe(Effect.flatMap((s) => s.listExtensions(WS))),
    );
    expect(Exit.isSuccess(exit) && exit.value.length).toBe(1);
  });

  it("rejects a non-member", async () => {
    const { run } = harness({ currentUserId: "stranger" });
    const exit = await run(
      svc.pipe(Effect.flatMap((s) => s.listExtensions(WS))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const f = Cause.failureOption(exit.cause);
      expect(f._tag === "Some" && f.value._tag).toBe("NotAMemberError");
    }
  });
});

describe("ExtensionService.saveExtension", () => {
  it("installs a new extension", async () => {
    const exts: Extension[] = [];
    const { run } = harness({ extensions: exts });
    await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.saveExtension({
            workspaceId: WS,
            extensionId: "apollo",
            name: "Apollo",
            manifest: { v: 1 },
          }),
        ),
      ),
    );
    expect(exts).toHaveLength(1);
    expect(exts[0].extensionId).toBe("apollo");
  });

  it("UPDATES in place on re-save (no duplicate)", async () => {
    const exts: Extension[] = [
      {
        id: "e1",
        workspaceId: WS,
        extensionId: "apollo",
        name: "Old",
        category: null,
        manifest: { v: 1 },
      },
    ];
    const { run } = harness({ extensions: exts });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.saveExtension({
            workspaceId: WS,
            extensionId: "apollo",
            name: "New",
            manifest: { v: 2 },
          }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit) && exit.value).toBe("e1");
    expect(exts).toHaveLength(1);
    expect(exts[0].name).toBe("New");
    expect(exts[0].manifest).toEqual({ v: 2 });
  });
});
