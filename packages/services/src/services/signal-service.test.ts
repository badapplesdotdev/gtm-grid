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
import type { GridCell, GridRow, GridTable } from "../repositories/webhook-repo.js";
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

// Trigify searches take ~10-30s to start returning results, so the create-time
// pull is almost always 0. Stamping `lastSyncedAt` on that empty pull deferred
// the next pull by the full schedule interval (a "daily" cloud binding sat empty
// for 24h). The rule: `lastSyncedAt` stays NULL until the binding has EVER
// pulled data (always-due → the hourly cron retries), then stamps normally.
describe("SignalService sync — lastSyncedAt stamping (empty-table warm-up)", () => {
  const fixtures = async (bindings: SignalBinding[]) => ({
    currentUserId: null,
    workspaces: [{ id: WS, name: "WS", ownerId: "owner", currentPlanId: "team" }],
    signalBindings: bindings,
    tables: [table(WS)],
    webhookCredentials: new Map([[`${WS}:trigify`, await encryptedKey(WS, "tk_live")]]),
  });

  it("keeps lastSyncedAt NULL on a 0-result pull before first data (binding stays due)", async () => {
    stubTrigify([]); // search still scraping — nothing back yet
    const bindings = [binding({ rowsPulled: 0, lastSyncedAt: null })];
    const exit = await run(await fixtures(bindings), (s) => s.syncForWorker("sig-1"));
    expect(Exit.isSuccess(exit) && exit.value).toBe(0);
    expect(bindings[0].lastSyncedAt).toBeNull();
    expect(bindings[0].lastError).toBeNull();
  });

  it("stamps lastSyncedAt once the pull delivers first data", async () => {
    stubTrigify([{ id: "r1" }]);
    const bindings = [binding({ rowsPulled: 0, lastSyncedAt: null })];
    const exit = await run(await fixtures(bindings), (s) => s.syncForWorker("sig-1"));
    expect(Exit.isSuccess(exit) && exit.value).toBe(1);
    expect(bindings[0].lastSyncedAt).not.toBeNull();
    expect(bindings[0].rowsPulled).toBe(1);
  });

  it("stamps lastSyncedAt on an empty pull AFTER first data (no hot-loop once seeded)", async () => {
    stubTrigify([]); // nothing new this round
    const bindings = [binding({ rowsPulled: 5, lastSyncedAt: 1000 })];
    const exit = await run(await fixtures(bindings), (s) => s.syncForWorker("sig-1"));
    expect(Exit.isSuccess(exit) && exit.value).toBe(0);
    // Re-stamped (not nulled): the binding has data, so schedule semantics hold.
    expect(bindings[0].lastSyncedAt).not.toBeNull();
    expect(bindings[0].lastSyncedAt).not.toBe(1000);
  });
});

describe("SignalService.syncForWorker (durable dedupe + bulk insert)", () => {
  it("dedupes a result already seen even when the binding has >1000 cumulative results (no SEEN_CAP truncation dup)", async () => {
    // Seed a large history: the OLD code truncated `seen` to the last 1000 keys,
    // so an early key ("hist-0") would no longer be recognised and would be
    // re-inserted. The durable seen-set keeps every key, so it dedupes.
    const history = Array.from({ length: 1500 }, (_, i) => `hist-${i}`);
    stubTrigify([{ id: "hist-0" }, { id: "hist-1499" }]); // both already seen
    const enc = await encryptedKey(WS, "tk_live");
    const exit = await run(
      {
        currentUserId: null,
        workspaces: [{ id: WS, name: "WS", ownerId: "owner", currentPlanId: "team" }],
        signalBindings: [binding({ seen: history })],
        tables: [table(WS)],
        webhookCredentials: new Map([[`${WS}:trigify`, enc]]),
      },
      (s) => s.syncForWorker("sig-1"),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toBe(0);
  });

  it("inserts rows + cells for fresh results and computes positions above the table's max", async () => {
    stubTrigify([{ id: "r1", url: "u1" }, { id: "r2", url: "u2" }]);
    const enc = await encryptedKey(WS, "tk_live");
    const rows: GridRow[] = [{ id: "existing-row", tableId: TABLE, position: 7 }];
    const cells: GridCell[] = [];
    const exit = await run(
      {
        currentUserId: null,
        workspaces: [{ id: WS, name: "WS", ownerId: "owner", currentPlanId: "team" }],
        signalBindings: [
          binding({ columns: [{ key: "url", columnId: "col-url" }] }),
        ],
        tables: [table(WS)],
        columns: [{ id: "col-url", tableId: TABLE }],
        rows,
        cells,
        webhookCredentials: new Map([[`${WS}:trigify`, enc]]),
      },
      (s) => s.syncForWorker("sig-1"),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toBe(2);
    // Two new rows appended above the existing max position (7).
    expect(rows.filter((r) => r.position > 7)).toHaveLength(2);
    expect(rows.map((r) => r.position).sort((a, b) => a - b)).toEqual([7, 8, 9]);
    // One cell per new row (the single mapped column).
    expect(cells).toHaveLength(2);
  });
});

describe("SignalService.listDuePage (SQL due filter + keyset)", () => {
  const due = (over: Partial<SignalBinding>): SignalBinding =>
    binding({ enabled: true, schedule: "hourly", lastSyncedAt: null, ...over });

  it("returns only enabled, non-manual, due-by-schedule bindings", async () => {
    const now = 10_000_000_000;
    const exit = await run(
      {
        currentUserId: null,
        signalBindings: [
          due({ id: "a", createdAt: 1 }), // never synced → due
          due({ id: "b", createdAt: 2, schedule: "manual" }), // manual → not due
          due({ id: "c", createdAt: 3, enabled: false }), // disabled → not due
          due({ id: "d", createdAt: 4, schedule: "hourly", lastSyncedAt: now - 30 * 60 * 1000 }), // 30m ago, hourly → not due
          due({ id: "e", createdAt: 5, schedule: "hourly", lastSyncedAt: now - 2 * 60 * 60 * 1000 }), // 2h ago → due
        ],
      },
      (s) => s.listDuePage({ now, limit: 100, cursor: null }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.items.map((i) => i.id).sort()).toEqual(["a", "e"]);
      expect(exit.value.nextCursor).toBeNull();
    }
  });

  it("paginates via the keyset cursor without dropping or repeating bindings", async () => {
    const now = 10_000_000_000;
    const bindings = Array.from({ length: 5 }, (_, i) => due({ id: `s${i}`, createdAt: i + 1 }));
    const page1 = await run(
      { currentUserId: null, signalBindings: bindings },
      (s) => s.listDuePage({ now, limit: 2, cursor: null }),
    );
    expect(Exit.isSuccess(page1)).toBe(true);
    if (!Exit.isSuccess(page1)) return;
    expect(page1.value.items.map((i) => i.id)).toEqual(["s0", "s1"]);
    expect(page1.value.nextCursor).not.toBeNull();

    const page2 = await run(
      { currentUserId: null, signalBindings: bindings },
      (s) => s.listDuePage({ now, limit: 2, cursor: page1.value.nextCursor }),
    );
    expect(Exit.isSuccess(page2)).toBe(true);
    if (!Exit.isSuccess(page2)) return;
    expect(page2.value.items.map((i) => i.id)).toEqual(["s2", "s3"]);

    const page3 = await run(
      { currentUserId: null, signalBindings: bindings },
      (s) => s.listDuePage({ now, limit: 2, cursor: page2.value.nextCursor }),
    );
    expect(Exit.isSuccess(page3) && page3.value.items.map((i) => i.id)).toEqual(["s4"]);
    if (Exit.isSuccess(page3)) expect(page3.value.nextCursor).toBeNull();
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
