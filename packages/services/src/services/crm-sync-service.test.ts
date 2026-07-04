/**
 * CrmSyncService.runSync — the six locked scenarios, end to end through the
 * in-memory {@link TestLayer} (real AES crypto for the connection, in-memory
 * grid + identity map) with a scripted Attio fetch:
 *
 *   1. the three dedupe modes (update / skip / always-create) — counts + map state
 *   2. hash guard — an unchanged CRM does ZERO cell writes on re-sync
 *   3. stale marking — vanished records flag rows (user cells survive), return unflags
 *   4. schema drift — dropped column reported, everything else lands, status partial
 *   5. plan row cap — truncates creates, partial + human copy, stale pass skipped
 *   6. mid-pull failures — page 1 lands, NO false-stale, auth revocation pauses
 */

import { Effect, Exit } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestLayer, type TestLayerFixtures } from "../layers.js";
import type { CrmBinding, CrmSyncedRow, CrmSyncRun } from "../repositories/crm-repo.js";
import type { GridCell, GridRow } from "../repositories/webhook-repo.js";
import { CrmConnectionService } from "./crm-connection-service.js";
import { CrmSyncService, planRowCap, type CrmSyncOutcome } from "./crm-sync-service.js";

const WS = "11111111-1111-1111-1111-111111111111";
const TABLE = "22222222-2222-2222-2222-222222222222";
const PROJECT = "33333333-3333-3333-3333-333333333333";

// ── Attio response builders ───────────────────────────────────────────────────

const ATTRS = {
  data: [
    { api_slug: "name", title: "Name", type: "personal-name" },
    { api_slug: "email_addresses", title: "Email", type: "email-address" },
  ],
};

const rec = (id: string, name: string, email: string) => ({
  id: { record_id: id },
  values: {
    name: [{ full_name: name }],
    email_addresses: [{ email_address: email }],
  },
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Scripted = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** Fetch stub that consumes `steps` in order (repeats the last step). */
function scriptFetch(steps: Scripted[]): Array<{ url: string; body: string }> {
  const calls: Array<{ url: string; body: string }> = [];
  let i = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return step(String(url), init);
  });
  return calls;
}

/** One standard sync exchange: attributes then a single (non-full) record page. */
const syncScript = (records: unknown[]): Scripted[] => [
  () => json(ATTRS),
  () => json({ data: records }),
];

// ── Harness ───────────────────────────────────────────────────────────────────

interface World {
  readonly binding: CrmBinding;
  readonly rows: GridRow[];
  readonly cells: GridCell[];
  readonly syncedRows: CrmSyncedRow[];
  readonly runs: CrmSyncRun[];
  readonly fixtures: TestLayerFixtures;
}

function world(overrides?: {
  readonly dedupeMode?: "update" | "skip" | "create";
  readonly planId?: string | null;
  readonly syncedRows?: CrmSyncedRow[];
}): World {
  const binding: CrmBinding = {
    id: "44444444-4444-4444-4444-444444444444",
    workspaceId: WS,
    tableId: TABLE,
    provider: "attio",
    sourceKind: "object",
    sourceId: "people",
    sourceLabel: "People",
    columns: [
      { attrSlug: "name", attrType: "personal-name", columnId: "col_name", title: "Name" },
      { attrSlug: "email_addresses", attrType: "email-address", columnId: "col_email", title: "Email" },
    ],
    config: {
      filters: [],
      dedupeMode: overrides?.dedupeMode ?? "update",
      matchKeyAttr: "email_addresses",
    },
    schedule: "daily",
    enabled: true,
    pausedReason: null,
    lastSyncedAt: null,
    lastError: null,
    rowsSynced: 0,
    createdAt: 1,
  };
  const rows: GridRow[] = [];
  const cells: GridCell[] = [];
  const syncedRows: CrmSyncedRow[] = overrides?.syncedRows ?? [];
  const runs: CrmSyncRun[] = [];
  const fixtures: TestLayerFixtures = {
    workspaces: [
      {
        id: WS,
        name: "Test WS",
        ownerId: "user_owner",
        currentPlanId: overrides?.planId === undefined ? "team" : overrides.planId,
      },
    ],
    memberships: [{ workspaceId: WS, userId: "user_m", role: "member" }],
    currentUserId: "user_m",
    tables: [{ id: TABLE, workspaceId: WS, projectId: PROJECT, name: "People", position: 0, createdAt: 1 }],
    rows,
    cells,
    crmBindings: [binding],
    crmSyncedRows: syncedRows,
    crmSyncRuns: runs,
  };
  return { binding, rows, cells, syncedRows, runs, fixtures };
}

/** Store an Attio connection, then run one worker sync. */
const syncOnce = (w: World): Promise<CrmSyncOutcome> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const connections = yield* CrmConnectionService;
      yield* connections.saveConnection({
        workspaceId: WS,
        tokens: { accessToken: "at_test" },
        meta: {
          connectedByUserId: "user_m",
          connectedByName: "Morgan",
          attioWorkspaceId: "attio_ws",
          attioWorkspaceName: "Acme",
        },
      });
      const sync = yield* CrmSyncService;
      return yield* sync.syncForWorker(w.binding.id, "cron");
    }).pipe(Effect.provide(TestLayer(w.fixtures))) as Effect.Effect<CrmSyncOutcome, never, never>,
  );

const cellText = (w: World, rowId: string, columnId: string): string => {
  const cell = w.cells.find((c) => c.rowId === rowId && c.columnId === columnId);
  return cell === undefined ? "" : String(cell.value);
};

beforeEach(() => {
  vi.stubEnv("ATTIO_CLIENT_ID", "client-123");
  vi.stubEnv("ATTIO_CLIENT_SECRET", "secret-456");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ── 1. Dedupe modes ───────────────────────────────────────────────────────────

describe("dedupe modes", () => {
  it("update mode: first sync creates rows + cells + identity entries", async () => {
    const w = world();
    scriptFetch(syncScript([rec("rec_1", "Sarah Chen", "sarah@vercel.com"), rec("rec_2", "Marcus Webb", "m@stripe.com")]));
    const outcome = await syncOnce(w);

    expect(outcome.status).toBe("ok");
    expect(outcome.rowsCreated).toBe(2);
    expect(w.rows).toHaveLength(2);
    expect(cellText(w, w.rows[0].id, "col_name")).toBe("Sarah Chen");
    expect(cellText(w, w.rows[0].id, "col_email")).toBe("sarah@vercel.com");
    expect(w.syncedRows.map((e) => e.externalId).sort()).toEqual(["rec_1", "rec_2"]);
    // Match keys normalized for upsert lookups.
    expect(w.syncedRows.find((e) => e.externalId === "rec_1")?.matchKey).toBe("sarah@vercel.com");
    expect(w.runs[0]?.status).toBe("ok");
  });

  it("update mode: a NEW record id matching an existing match key updates that row (CRM merge)", async () => {
    const w = world();
    scriptFetch(syncScript([rec("rec_1", "Sarah Chen", "sarah@vercel.com")]));
    await syncOnce(w);
    const rowId = w.syncedRows[0].rowId;

    scriptFetch(syncScript([rec("rec_MERGED", "Sarah Chen-Lee", "sarah@vercel.com")]));
    const second = await syncOnce(w);

    expect(second.rowsCreated).toBe(0);
    expect(second.rowsUpdated).toBe(1);
    expect(w.rows).toHaveLength(1);
    expect(cellText(w, rowId, "col_name")).toBe("Sarah Chen-Lee");
    // The new external id now maps to the same grid row.
    expect(w.syncedRows.find((e) => e.externalId === "rec_MERGED")?.rowId).toBe(rowId);
  });

  it("skip mode: existing records are never touched, new ones append", async () => {
    const w = world({ dedupeMode: "skip" });
    scriptFetch(syncScript([rec("rec_1", "Sarah", "sarah@vercel.com")]));
    await syncOnce(w);

    // Same record with CHANGED values + one new record.
    scriptFetch(syncScript([rec("rec_1", "Sarah RENAMED", "sarah@vercel.com"), rec("rec_2", "Marcus", "m@stripe.com")]));
    const second = await syncOnce(w);

    expect(second.rowsCreated).toBe(1);
    expect(second.rowsSkipped).toBe(1);
    expect(second.rowsUpdated).toBe(0);
    expect(w.rows).toHaveLength(2);
    // Skip means the changed name did NOT overwrite the cell.
    expect(cellText(w, w.syncedRows.find((e) => e.externalId === "rec_1")!.rowId, "col_name")).toBe("Sarah");
  });

  it("always-create mode: every sync appends fresh rows, no identity map, no stale", async () => {
    const w = world({ dedupeMode: "create" });
    scriptFetch(syncScript([rec("rec_1", "Sarah", "sarah@vercel.com")]));
    const first = await syncOnce(w);
    scriptFetch(syncScript([rec("rec_1", "Sarah", "sarah@vercel.com")]));
    const second = await syncOnce(w);

    expect(first.rowsCreated).toBe(1);
    expect(second.rowsCreated).toBe(1);
    expect(second.rowsStaled).toBe(0);
    expect(w.rows).toHaveLength(2);
    expect(w.syncedRows).toHaveLength(0);
  });
});

// ── 2. Hash guard ─────────────────────────────────────────────────────────────

describe("hash guard", () => {
  it("an unchanged CRM re-sync performs zero cell writes", async () => {
    const w = world();
    scriptFetch(syncScript([rec("rec_1", "Sarah", "sarah@vercel.com")]));
    await syncOnce(w);
    const cellSnapshot = w.cells.map((c) => ({ ...c }));

    scriptFetch(syncScript([rec("rec_1", "Sarah", "sarah@vercel.com")]));
    const second = await syncOnce(w);

    expect(second.status).toBe("ok");
    expect(second.rowsCreated).toBe(0);
    expect(second.rowsUpdated).toBe(0);
    expect(w.cells).toEqual(cellSnapshot);
    // But the record still counted as seen — no false stale.
    expect(w.syncedRows[0].stale).toBe(false);
    expect(second.rowsStaled).toBe(0);
  });
});

// ── 3. Stale marking ──────────────────────────────────────────────────────────

describe("stale marking", () => {
  it("vanished records flag their rows stale; user cells + rows survive; return unflags", async () => {
    const w = world();
    scriptFetch(syncScript([rec("rec_1", "Sarah", "sarah@vercel.com"), rec("rec_2", "Marcus", "m@stripe.com")]));
    await syncOnce(w);
    const rec2Row = w.syncedRows.find((e) => e.externalId === "rec_2")!.rowId;
    // A user-added enrichment cell on rec_2's row (not a synced column).
    w.cells.push({ id: "cell_user", rowId: rec2Row, columnId: "col_user_ai", value: "enriched!", status: "done", error: null, updatedAt: 1 });

    // rec_2 vanishes upstream.
    scriptFetch(syncScript([rec("rec_1", "Sarah", "sarah@vercel.com")]));
    const second = await syncOnce(w);

    expect(second.rowsStaled).toBe(1);
    expect(w.syncedRows.find((e) => e.externalId === "rec_2")?.stale).toBe(true);
    expect(w.rows).toHaveLength(2); // row NOT deleted
    expect(cellText(w, rec2Row, "col_user_ai")).toBe("enriched!"); // enrichment intact

    // rec_2 returns → unflagged.
    scriptFetch(syncScript([rec("rec_1", "Sarah", "sarah@vercel.com"), rec("rec_2", "Marcus", "m@stripe.com")]));
    const third = await syncOnce(w);
    expect(third.rowsStaled).toBe(0);
    expect(w.syncedRows.find((e) => e.externalId === "rec_2")?.stale).toBe(false);
  });
});

// ── 4. Schema drift ───────────────────────────────────────────────────────────

describe("schema drift", () => {
  it("a deleted attribute drops that column, syncs the rest, reports partial with human copy", async () => {
    const w = world();
    scriptFetch([
      () => json({ data: [{ api_slug: "name", title: "Name", type: "personal-name" }] }), // email attr gone
      () => json({ data: [rec("rec_1", "Sarah", "sarah@vercel.com")] }),
    ]);
    const outcome = await syncOnce(w);

    expect(outcome.status).toBe("partial");
    expect(outcome.fieldsDropped).toEqual(["Email"]);
    expect(outcome.rowsCreated).toBe(1);
    expect(cellText(w, w.rows[0].id, "col_name")).toBe("Sarah");
    expect(cellText(w, w.rows[0].id, "col_email")).toBe(""); // dropped column untouched
    expect(w.runs[0]?.error).toContain("1 field could not be mapped and was skipped: Email");
    expect(w.runs[0]?.error).not.toMatch(/\b(4\d\d|5\d\d)\b|_tag/);
  });
});

// ── 5. Plan row cap ───────────────────────────────────────────────────────────

describe("plan row cap", () => {
  it("planRowCap tiers: team/free → 10k, higher plans → 50k", () => {
    expect(planRowCap("team")).toBe(10_000);
    expect(planRowCap(null)).toBe(10_000);
    expect(planRowCap("business")).toBe(50_000);
    expect(planRowCap("unlimited")).toBe(50_000);
  });

  it("creates stop exactly at the cap; partial with upgrade copy; stale pass skipped", async () => {
    // 9,999 pre-existing identity entries → budget of exactly 1.
    const preexisting: CrmSyncedRow[] = Array.from({ length: 9_999 }, (_x, i) => ({
      id: `pre_${i}`,
      bindingId: "44444444-4444-4444-4444-444444444444",
      rowId: `row_pre_${i}`,
      externalId: `pre_rec_${i}`,
      matchKey: null,
      valuesHash: null,
      lastSeenRunId: null,
      stale: false,
    }));
    const w = world({ syncedRows: preexisting });
    scriptFetch(
      syncScript([
        rec("rec_a", "A", "a@x.com"),
        rec("rec_b", "B", "b@x.com"),
        rec("rec_c", "C", "c@x.com"),
      ]),
    );
    const outcome = await syncOnce(w);

    expect(outcome.rowsCreated).toBe(1); // exactly the remaining budget
    expect(outcome.status).toBe("partial");
    expect(outcome.error).toContain("10,000");
    expect(outcome.error).toContain("your plan's limit");
    // A capped (incomplete) pull must not false-stale the 9,999 unseen entries.
    expect(outcome.rowsStaled).toBe(0);
    expect(w.syncedRows.filter((e) => e.stale)).toHaveLength(0);
  });
});

// ── 6. Mid-pull failures ──────────────────────────────────────────────────────

const fullPage = Array.from({ length: 500 }, (_x, i) => rec(`bulk_${i}`, `Person ${i}`, `p${i}@x.com`));

describe("mid-pull failures", () => {
  it("a hard failure on page 2 keeps page 1's rows, fails the run, and skips stale", async () => {
    const w = world();
    scriptFetch([
      () => json(ATTRS),
      () => json({ data: fullPage }), // page 1: full → keep paging
      () => new Response("bad request", { status: 400 }), // page 2: hard failure
    ]);
    const outcome = await syncOnce(w);

    expect(outcome.rowsCreated).toBe(500); // page 1 landed
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("filters"); // human copy, no status codes
    expect(outcome.rowsStaled).toBe(0);
    expect(w.syncedRows.filter((e) => e.stale)).toHaveLength(0);
    expect(w.runs[0]?.status).toBe("failed");
  });

  it("auth revocation mid-pull pauses the binding with reconnect copy", async () => {
    const w = world();
    scriptFetch([
      () => json(ATTRS),
      () => json({}, 401), // token rejected, no refresh token stored
    ]);
    const outcome = await syncOnce(w);

    expect(outcome.status).toBe("failed");
    expect(outcome.errorTag).toBe("AttioAuthRevoked");
    expect(outcome.error).toContain("Reconnect Attio");
    const binding = w.fixtures.crmBindings?.[0];
    expect(binding?.pausedReason).toBe("auth_revoked");
    expect(outcome.rowsStaled).toBe(0);
  });

  it("a paused binding refuses to sync until reconnected", async () => {
    const w = world();
    scriptFetch([() => json(ATTRS), () => json({}, 401)]);
    await syncOnce(w); // pauses
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const sync = yield* CrmSyncService;
        return yield* sync.syncForWorker(w.binding.id, "cron");
      }).pipe(Effect.provide(TestLayer(w.fixtures))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
