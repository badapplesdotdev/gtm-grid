/**
 * `SignalService` unit tests — OFFLINE against the in-memory {@link TestLayer}
 * (no live DB, Trigify HTTP stubbed). Focus is the cloud-correctness surface:
 *
 *   - the WORKER path ({@link SignalService.syncForWorker}) resolves the
 *     workspace-SHARED Trigify key with NO member identity (`userId: null`) — the
 *     regression guard for the bug where it routed through the membership-gated
 *     credential read and silently no-op'd every scheduled poll;
 *   - entitlement gating: a lapsed-trial / Free workspace cannot run the paid
 *     feature via the worker, manual sync, remove, or listByTable;
 *   - membership gating on the member-facing methods.
 *
 * Outcome-focused per docs/effect-conventions.md: assert the returned value or
 * the typed error `_tag`.
 */

import { CredentialCryptoService } from "@gtmgrid/cloud";
import { Cause, Effect, Exit, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialCryptoTest } from "../credential-crypto-test.js";
import { TestLayer, type TestLayerFixtures } from "../layers.js";
import type { SignalBinding } from "../repositories/signal-repo.js";
import type { GridTable } from "../repositories/webhook-repo.js";
import { SignalService } from "./signal-service.js";

const WS = "ws-team";
const WS_FREE = "ws-free";
const TABLE = "tbl-1";
const MEMBER = "user-member";

const failureTag = <A, E>(exit: Exit.Exit<A, E>): string | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure)
    ? (failure.value as { _tag?: string })._tag
    : undefined;
};

const table = (workspaceId: string): GridTable => ({
  id: TABLE,
  workspaceId,
  projectId: "proj-1",
  name: "Signals",
  position: 0,
  createdAt: 1,
});

const binding = (over: Partial<SignalBinding> = {}): SignalBinding => ({
  id: "sig-1",
  workspaceId: WS,
  tableId: TABLE,
  sourceId: "linkedin-posts",
  label: "LinkedIn Posts",
  kind: "search",
  searchId: "srch-1",
  config: {},
  schedule: "hourly",
  columns: [],
  seen: [],
  lastSyncedAt: null,
  lastError: null,
  rowsPulled: 0,
  enabled: true,
  createdAt: 1,
  ...over,
});

/** Encrypt a Trigify key with the SAME test crypto the TestLayer uses, so the
 * worker's shared-credential decrypt round-trips. Bound to `workspaceId`. */
const encryptedKey = (workspaceId: string, apiKey: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const c = yield* CredentialCryptoService;
      return yield* c.encrypt(workspaceId, { apiKey });
    }).pipe(Effect.provide(credentialCryptoTest())),
  );

/** Stub global fetch to return a fixed Trigify results payload. */
const stubTrigify = (payload: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
  );

const run = <A, E>(
  fixtures: TestLayerFixtures,
  program: (svc: typeof SignalService.Service) => Effect.Effect<A, E>,
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const svc = yield* SignalService;
      return yield* program(svc);
    }).pipe(Effect.provide(TestLayer(fixtures))),
  );

afterEach(() => vi.unstubAllGlobals());

describe("SignalService.syncForWorker (membership-free credential path)", () => {
  it("resolves the workspace-shared Trigify key with userId:null and pulls fresh results", async () => {
    stubTrigify([{ id: "r1" }]);
    const enc = await encryptedKey(WS, "tk_live");
    const exit = await run(
      {
        currentUserId: null, // the cron runtime has no member identity
        workspaces: [{ id: WS, name: "WS", ownerId: "owner", currentPlanId: "team" }],
        signalBindings: [binding()],
        tables: [table(WS)],
        webhookCredentials: new Map([[`${WS}:trigify`, enc]]),
      },
      (s) => s.syncForWorker("sig-1"),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toBe(1);
  });

  it("fails closed (SignalError) when no shared Trigify credential exists", async () => {
    stubTrigify([{ id: "r1" }]);
    const exit = await run(
      {
        currentUserId: null,
        workspaces: [{ id: WS, name: "WS", ownerId: "owner", currentPlanId: "team" }],
        signalBindings: [binding()],
        tables: [table(WS)],
        webhookCredentials: new Map(),
      },
      (s) => s.syncForWorker("sig-1"),
    );
    expect(failureTag(exit)).toBe("SignalError");
  });

  it("skips a lapsed-trial (Free) workspace — entitlement gate, before any Trigify call", async () => {
    const fetchSpy = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const enc = await encryptedKey(WS_FREE, "tk_live");
    const exit = await run(
      {
        currentUserId: null,
        workspaces: [{ id: WS_FREE, name: "Free", ownerId: "owner", currentPlanId: null }],
        signalBindings: [binding({ workspaceId: WS_FREE })],
        tables: [table(WS_FREE)],
        webhookCredentials: new Map([[`${WS_FREE}:trigify`, enc]]),
      },
      (s) => s.syncForWorker("sig-1"),
    );
    expect(failureTag(exit)).toBe("PlanRequiredError");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("dedupes results already in the binding's seen set", async () => {
    stubTrigify([{ id: "r1" }]);
    const enc = await encryptedKey(WS, "tk_live");
    const exit = await run(
      {
        currentUserId: null,
        workspaces: [{ id: WS, name: "WS", ownerId: "owner", currentPlanId: "team" }],
        signalBindings: [binding({ seen: ["r1"] })],
        tables: [table(WS)],
        webhookCredentials: new Map([[`${WS}:trigify`, enc]]),
      },
      (s) => s.syncForWorker("sig-1"),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toBe(0);
  });

  it("returns 0 for an unknown binding id", async () => {
    const exit = await run(
      {
        currentUserId: null,
        workspaces: [{ id: WS, name: "WS", ownerId: "owner", currentPlanId: "team" }],
        signalBindings: [],
      },
      (s) => s.syncForWorker("missing"),
    );
    expect(Exit.isSuccess(exit) && exit.value).toBe(0);
  });
});

describe("SignalService.sync (member + entitlement gated)", () => {
  it("blocks a non-member", async () => {
    const exit = await run(
      {
        currentUserId: "stranger",
        memberships: [{ workspaceId: WS, userId: MEMBER, role: "member" }],
        workspaces: [{ id: WS, name: "WS", ownerId: "owner", currentPlanId: "team" }],
        signalBindings: [binding()],
        tables: [table(WS)],
      },
      (s) => s.sync("sig-1"),
    );
    expect(failureTag(exit)).toBe("NotAMemberError");
  });

  it("blocks a Free workspace even for a member (PlanRequiredError)", async () => {
    const exit = await run(
      {
        currentUserId: MEMBER,
        memberships: [{ workspaceId: WS_FREE, userId: MEMBER, role: "member" }],
        workspaces: [{ id: WS_FREE, name: "Free", ownerId: "owner", currentPlanId: null }],
        signalBindings: [binding({ workspaceId: WS_FREE })],
        tables: [table(WS_FREE)],
      },
      (s) => s.sync("sig-1"),
    );
    expect(failureTag(exit)).toBe("PlanRequiredError");
  });
});

describe("SignalService.remove / listByTable (entitlement gated)", () => {
  it("remove blocks a Free workspace", async () => {
    const exit = await run(
      {
        currentUserId: MEMBER,
        memberships: [{ workspaceId: WS_FREE, userId: MEMBER, role: "member" }],
        workspaces: [{ id: WS_FREE, name: "Free", ownerId: "owner", currentPlanId: null }],
        signalBindings: [binding({ workspaceId: WS_FREE })],
        tables: [table(WS_FREE)],
      },
      (s) => s.remove("sig-1"),
    );
    expect(failureTag(exit)).toBe("PlanRequiredError");
  });

  it("remove succeeds for an entitled member", async () => {
    const exit = await run(
      {
        currentUserId: MEMBER,
        memberships: [{ workspaceId: WS, userId: MEMBER, role: "member" }],
        workspaces: [{ id: WS, name: "WS", ownerId: "owner", currentPlanId: "team" }],
        signalBindings: [binding()],
        tables: [table(WS)],
      },
      (s) => s.remove("sig-1"),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("listByTable blocks a Free workspace", async () => {
    const exit = await run(
      {
        currentUserId: MEMBER,
        memberships: [{ workspaceId: WS_FREE, userId: MEMBER, role: "member" }],
        workspaces: [{ id: WS_FREE, name: "Free", ownerId: "owner", currentPlanId: null }],
        signalBindings: [binding({ workspaceId: WS_FREE })],
        tables: [table(WS_FREE)],
      },
      (s) => s.listByTable(TABLE),
    );
    expect(failureTag(exit)).toBe("PlanRequiredError");
  });
});
