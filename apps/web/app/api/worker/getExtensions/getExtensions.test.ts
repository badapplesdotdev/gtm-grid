/**
 * `getExtensions` handler unit tests — OFFLINE against in-memory Test Layers.
 *
 * Covers the three scenarios the dual-auth handler must handle:
 *   1. Worker-secret path (userId: null) — reads ExtensionRepo directly,
 *      skips membership check. Returns manifests for any workspace.
 *   2. Workspace member — ExtensionService.listExtensions asserts membership,
 *      returns manifests.
 *   3. Non-member — ExtensionService.listExtensions rejects with
 *      NotAMemberError (→ 403).
 */

import {
  identityLayer,
  memberRepoLayer,
  MembershipService,
  type Membership,
} from "@gtmgrid/cloud";
import {
  ExtensionRepo,
  extensionRepoLayer,
  ExtensionService,
  type Extension,
} from "@gtmgrid/services";
import { Cause, Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { GetExtensionsSchema } from "../_schemas";

/** A valid workspace id for tests. */
const WS = "ws-1";
/** Another workspace the test member does NOT belong to. */
const OTHER_WS = "ws-2";

const memberMemberships: readonly Membership[] = [
  { workspaceId: WS, userId: "alice", role: "member" },
];

const extensionsData: readonly Extension[] = [
  {
    id: "e1",
    workspaceId: WS,
    extensionId: "apollo",
    name: "Apollo",
    category: null,
    manifest: { connector: "apollo" },
  },
  {
    id: "e2",
    workspaceId: OTHER_WS,
    extensionId: "leadmagic",
    name: "LeadMagic",
    category: null,
    manifest: { connector: "leadmagic" },
  },
  {
    id: "e3",
    workspaceId: WS,
    extensionId: "snov",
    name: "Snov",
    category: null,
    manifest: { connector: "snov" },
  },
];

// ── The handler logic (duplicated from route.ts so the test doesn't depend on
// the POST wrapper — the Effect is the tested unit; runWorkerSecretOrMember
// is just the request-boundary glue already tested elsewhere). ────────────────

const handlerEffect = (workspaceId: string) =>
  Effect.gen(function* () {
    const membership = yield* MembershipService;

    const maybeUserId = yield* membership.requireUserId.pipe(
      Effect.catchTag("UnauthenticatedError", () => Effect.succeed(null)),
    );

    if (maybeUserId === null) {
      // Worker path (userId: null).
      const repo = yield* ExtensionRepo;
      const extensions = yield* repo.listByWorkspace(workspaceId);
      return extensions.map((e) => e.manifest);
    }

    // Member path.
    const svc = yield* ExtensionService;
    const extensions = yield* svc.listExtensions(workspaceId);
    return extensions.map((e) => e.manifest);
  });

// ── Harness
// Provides ExtensionRepo, MembershipService, ExtensionService — the three tags
// the handler Effect requires. ExtensionService.Default is built on top of the
// in-memory repo + membership layers.

function harness(opts: {
  currentUserId?: string | null;
  memberships?: readonly Membership[];
}) {
  const repo = extensionRepoLayer([...extensionsData]);
  const id = identityLayer(opts.currentUserId ?? null);
  const memberRepo = memberRepoLayer(opts.memberships ?? []);
  const membership = MembershipService.Default.pipe(
    Layer.provide(id),
    Layer.provide(memberRepo),
  );
  const extSvc = ExtensionService.Default.pipe(
    Layer.provide(repo),
    Layer.provide(membership),
  );

  const layer = Layer.mergeAll(repo, membership, extSvc);

  const run = <A, E>(
    program: Effect.Effect<
      A,
      E,
      ExtensionRepo | MembershipService | ExtensionService
    >,
  ) => Effect.runPromiseExit(program.pipe(Effect.provide(layer)));

  return { run };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("getExtensions handler — worker-secret path (userId: null)", () => {
  it("returns manifests for the requested workspace (any workspaceId)", async () => {
    const { run } = harness({ currentUserId: null });

    // Worker can list extensions for any workspace — no membership check.
    const exit1 = await run(handlerEffect(GetExtensionsSchema.parse({ workspaceId: WS }).workspaceId));
    expect(Exit.isSuccess(exit1)).toBe(true);
    if (Exit.isSuccess(exit1)) {
      expect(exit1.value).toEqual([
        { connector: "apollo" },
        { connector: "snov" },
      ]);
    }

    // Worker can ALSO list a workspace it has no member identity for.
    const exit2 = await run(
      handlerEffect(GetExtensionsSchema.parse({ workspaceId: OTHER_WS }).workspaceId),
    );
    expect(Exit.isSuccess(exit2)).toBe(true);
    if (Exit.isSuccess(exit2)) {
      expect(exit2.value).toEqual([{ connector: "leadmagic" }]);
    }
  });
});

describe("getExtensions handler — member path", () => {
  it("returns manifests for the member's own workspace", async () => {
    const { run } = harness({
      currentUserId: "alice",
      memberships: memberMemberships,
    });

    const exit = await run(
      handlerEffect(GetExtensionsSchema.parse({ workspaceId: WS }).workspaceId),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual([
        { connector: "apollo" },
        { connector: "snov" },
      ]);
    }
  });

  it("rejects with NotAMemberError when accessing another workspace", async () => {
    const { run } = harness({
      currentUserId: "alice",
      memberships: memberMemberships,
    });

    // Alice is a member of WS, not OTHER_WS.
    const exit = await run(
      handlerEffect(GetExtensionsSchema.parse({ workspaceId: OTHER_WS }).workspaceId),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const f = Cause.failureOption(exit.cause);
      expect(f._tag).toBe("Some");
      if (f._tag === "Some") {
        expect(f.value._tag).toBe("NotAMemberError");
      }
    }
  });

  it("rejects with NotAMemberError for a completely unknown user", async () => {
    const { run } = harness({
      currentUserId: "stranger",
      memberships: memberMemberships, // stranger is not a member of WS
    });

    const exit = await run(
      handlerEffect(GetExtensionsSchema.parse({ workspaceId: WS }).workspaceId),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const f = Cause.failureOption(exit.cause);
      expect(f._tag === "Some" && f.value._tag).toBe("NotAMemberError");
    }
  });
});

describe("GetExtensionsSchema — schema validation", () => {
  it("accepts a valid workspaceId", () => {
    expect(GetExtensionsSchema.safeParse({ workspaceId: "w1" }).success).toBe(
      true,
    );
  });

  it("rejects a missing workspaceId", () => {
    expect(GetExtensionsSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an empty workspaceId", () => {
    expect(GetExtensionsSchema.safeParse({ workspaceId: "" }).success).toBe(
      false,
    );
  });
});