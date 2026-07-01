/**
 * `WebhookService` unit tests — OFFLINE against in-memory Test Layers (no live
 * DB). Covers every service method and the AC-named behaviours:
 *   - worker UPSERT match (matched-update vs new-insert) via `findUpsertRowId`,
 *   - the 50-row delivery PRUNE in `recordDelivery`,
 *   - TERMINAL-ONLY metering on setCell/setCellStatus (never on `running`),
 *   - one-meter-per-record on insert/upsert,
 *   - resolveToken (enabled vs disabled), getCredential round-trip,
 *   - member-gated CRUD (create/list/config/mapping/toggle/rotate/delete).
 */

import {
  CellMerge,
  CredentialCryptoService,
  identityLayer as cloudIdentityLayer,
  memberRepoLayer as cloudMemberRepoLayer,
  type Membership,
  MembershipService,
} from "@gtmgrid/cloud";
import { Cause, Effect, Exit, Layer, Logger } from "effect";
import { describe, expect, it } from "vitest";
import { WebhookRepo } from "../repositories/webhook-repo.js";
import { credentialCryptoTest } from "../credential-crypto-test.js";
import type { WebhookDelivery } from "../repositories/webhook-delivery-repo.js";
import { webhookDeliveryRepoLayer } from "../repositories/webhook-delivery-repo.js";
import type {
  GridCell,
  GridColumn,
  GridRow,
  GridTable,
  Webhook,
  WorkspaceQuota,
} from "../repositories/webhook-repo.js";
import { webhookRepoLayer } from "../repositories/webhook-repo.js";
import { workspaceRepoLayer } from "../repositories/workspace-repo.js";
import { columnRepoLayer } from "../repositories/column-repo.js";
import { makeGridStore, type StoreColumn } from "../repositories/grid-store.js";
import {
  RealtimePublisher,
  RealtimePublisherError,
  recordingRealtimePublisherLayer,
  type RecordedGridEvent,
} from "./realtime-publisher.js";
import { EntitlementService } from "./entitlement-service.js";
import { FULL_GRID_ROW_WARN_CAP, WebhookService } from "./webhook-service.js";

const WS = "ws-1";
const TABLE = "table-1";
const COL_EMAIL = "col-email";
const COL_NAME = "col-name";

const memberships: readonly Membership[] = [
  { workspaceId: WS, userId: "member", role: "member" },
];

const baseTable: GridTable = {
  id: TABLE,
  workspaceId: WS,
  projectId: "proj-1",
  name: "Leads",
  position: 0,
  createdAt: 1,
};

const columns: GridColumn[] = [
  { id: COL_EMAIL, tableId: TABLE },
  { id: COL_NAME, tableId: TABLE },
];

const webhook: Webhook = {
  id: "wh-1",
  workspaceId: WS,
  tableId: TABLE,
  name: "Test",
  token: "tok-123",
  signingSecret: "whsec_x",
  mapping: [{ path: "email", columnId: COL_EMAIL }],
  enabled: true,
  autoRun: true,
  mode: "create",
  upsertKey: null,
  createdAt: 100,
  lastReceivedAt: null,
  receivedCount: 0,
};

/** Build a service runtime over mutable fixtures so tests can read them back. */
function harness(opts: {
  webhooks?: Webhook[];
  rows?: GridRow[];
  cells?: GridCell[];
  quotas?: Map<string, WorkspaceQuota>;
  credentials?: Map<string, string>;
  deliveries?: WebhookDelivery[];
  currentUserId?: string | null;
  crypto?: Layer.Layer<CredentialCryptoService>;
  /** The workspace's cached plan; `undefined` defaults to "team" (cloud on). */
  plan?: string | null;
  /** Columns visible to ColumnRepo (MUTATED by ensureWebhookColumn). */
  gridColumns?: StoreColumn[];
  /**
   * Override the realtime publisher layer. Defaults to the recording layer;
   * pass a failing layer to prove the worker's publish is best-effort.
   */
  realtime?: Layer.Layer<RealtimePublisher>;
}) {
  const webhookRepo = webhookRepoLayer({
    webhooks: opts.webhooks ?? [{ ...webhook }],
    tables: [baseTable],
    columns,
    rows: opts.rows ?? [],
    cells: opts.cells ?? [],
    quotas: opts.quotas ?? new Map(),
    credentials: opts.credentials ?? new Map(),
  });
  const deliveryRepo = webhookDeliveryRepoLayer(opts.deliveries ?? []);
  // `currentUserId: null` is an EXPLICIT headless caller (no identity → the
  // worker-secret path); only an absent option defaults to the member "member".
  const membership = MembershipService.Default.pipe(
    Layer.provide(
      cloudIdentityLayer(
        opts.currentUserId === undefined ? "member" : opts.currentUserId,
      ),
    ),
    Layer.provide(cloudMemberRepoLayer(memberships)),
  );
  // EntitlementService reads the workspace plan; default "team" (cloud on).
  // Pass `plan: null` to exercise a lapsed/Free workspace (cloud locked).
  const entitlement = EntitlementService.Default.pipe(
    Layer.provide(
      workspaceRepoLayer([
        {
          id: WS,
          name: "WS",
          ownerId: "owner",
          currentPlanId: opts.plan === undefined ? "team" : opts.plan,
        },
      ]),
    ),
  );
  // ColumnRepo backs ensureWebhookColumn (the Clay-style raw-payload column).
  const gridColumns = opts.gridColumns ?? [];
  const columnRepo = columnRepoLayer(makeGridStore({ columns: gridColumns }));
  // Recording publisher: tests read back the realtime events worker writes emit.
  const published: RecordedGridEvent[] = [];
  const layer = WebhookService.Default.pipe(
    Layer.provide(webhookRepo),
    Layer.provide(deliveryRepo),
    Layer.provide(membership),
    Layer.provide(CellMerge.Default),
    Layer.provide(opts.crypto ?? credentialCryptoTest()),
    Layer.provide(entitlement),
    Layer.provide(columnRepo),
    Layer.provide(opts.realtime ?? recordingRealtimePublisherLayer(published)),
  );
  const run = <A, E>(program: Effect.Effect<A, E, WebhookService>) =>
    Effect.runPromiseExit(program.pipe(Effect.provide(layer)));
  return { run, gridColumns, published };
}

const svc = Effect.gen(function* () {
  return yield* WebhookService;
});

describe("WebhookService.resolveToken", () => {
  it("returns config for an enabled token", async () => {
    const { run } = harness({});
    const exit = await run(
      svc.pipe(Effect.flatMap((s) => s.resolveToken("tok-123"))),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value?.webhookId).toBe("wh-1");
      expect(exit.value?.mode).toBe("create");
    }
  });

  it("returns null for a disabled token", async () => {
    const { run } = harness({
      webhooks: [{ ...webhook, enabled: false }],
    });
    const exit = await run(
      svc.pipe(Effect.flatMap((s) => s.resolveToken("tok-123"))),
    );
    expect(Exit.isSuccess(exit) && exit.value).toBe(null);
  });

  it("returns null for an unknown token", async () => {
    const { run } = harness({});
    const exit = await run(
      svc.pipe(Effect.flatMap((s) => s.resolveToken("nope"))),
    );
    expect(Exit.isSuccess(exit) && exit.value).toBe(null);
  });

  it("returns null when the workspace's cloud plan lapsed (inbound locked)", async () => {
    const { run } = harness({ plan: null });
    const exit = await run(
      svc.pipe(Effect.flatMap((s) => s.resolveToken("tok-123"))),
    );
    expect(Exit.isSuccess(exit) && exit.value).toBe(null);
  });
});

describe("WebhookService.insertRow", () => {
  it("inserts a row + cells and meters EXACTLY once", async () => {
    const rows: GridRow[] = [];
    const cells: GridCell[] = [];
    const quotas = new Map<string, WorkspaceQuota>();
    const { run } = harness({ rows, cells, quotas });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.insertRow({
            webhookId: "wh-1",
            cells: { [COL_EMAIL]: "a@b.com", [COL_NAME]: "Ann" },
          }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(cells).toHaveLength(2);
    expect(quotas.get(WS)?.cloudActionsUsed).toBe(1);
  });

  it("broadcasts row.insert (with the written cells) so open grids patch live", async () => {
    const rows: GridRow[] = [];
    const { run, published } = harness({ rows, cells: [] });
    await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.insertRow({
            webhookId: "wh-1",
            cells: { [COL_EMAIL]: "a@b.com", "col-foreign": "dropped", [COL_NAME]: "" },
          }),
        ),
      ),
    );
    expect(published).toHaveLength(1);
    expect(published[0].workspaceId).toBe(WS);
    expect(published[0].tableId).toBe(TABLE);
    expect(published[0].event).toEqual({
      type: "row.insert",
      row: { _id: rows[0].id },
      // Mirrors writeCells: blank + foreign cells are NOT in the event either.
      cells: [
        { rowId: rows[0].id, columnId: COL_EMAIL, value: "a@b.com", status: "done", error: null },
      ],
    });
  });

  it("skips empty/foreign cells", async () => {
    const cells: GridCell[] = [];
    const { run } = harness({ rows: [], cells });
    await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.insertRow({
            webhookId: "wh-1",
            cells: { [COL_EMAIL]: "", [COL_NAME]: "Ann", "col-foreign": "x" },
          }),
        ),
      ),
    );
    // only COL_NAME is written (email empty, foreign column ignored).
    expect(cells.map((c) => c.columnId)).toEqual([COL_NAME]);
  });

  it("rejects when the delivery would exceed the cloud-actions limit", async () => {
    const quotas = new Map<string, WorkspaceQuota>([
      [WS, { cloudActionsUsed: 10, cloudActionsLimit: 10 }],
    ]);
    const { run } = harness({ rows: [], cells: [], quotas });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.insertRow({ webhookId: "wh-1", cells: { [COL_EMAIL]: "a@b.com" } }),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const f = Cause.failureOption(exit.cause);
      expect(f._tag === "Some" && f.value._tag).toBe("CloudActionsLimitError");
    }
  });

  // Regression (error-tracking issue 019ed668): the process-webhook-record worker
  // 500'd on every record because the realtime party rejected the broadcast with
  // 401 and the RealtimePublisherError propagated out of insertRow. The row is
  // already written + metered by then, so a realtime failure must be swallowed —
  // otherwise Inngest retries re-commit the row (duplicate-row risk) and the
  // record never finishes processing.
  it("succeeds insertRow even when the realtime publish fails (best-effort)", async () => {
    const failingRealtime = Layer.succeed(RealtimePublisher, {
      publish: () =>
        Effect.fail(
          new RealtimePublisherError({
            message: "party publish failed: 401 Unauthorized",
          }),
        ),
    });
    const rows: GridRow[] = [];
    const cells: GridCell[] = [];
    const { run } = harness({ rows, cells, realtime: failingRealtime });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.insertRow({
            webhookId: "wh-1",
            cells: { [COL_EMAIL]: "a@b.com", [COL_NAME]: "Ann" },
          }),
        ),
      ),
    );
    // The write committed; the publish 401 did NOT surface as a worker 500.
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(cells).toHaveLength(2);
  });
});

describe("WebhookService.assertColumnRunQuota (TRI-3277)", () => {
  const rows: GridRow[] = [
    { id: "row-1", tableId: TABLE, position: 0 },
    { id: "row-2", tableId: TABLE, position: 1 },
    { id: "row-3", tableId: TABLE, position: 2 },
  ];
  const doneCell = (rowId: string): GridCell => ({
    id: `cell-${rowId}`,
    rowId,
    columnId: COL_NAME,
    value: "x",
    status: "done",
    error: null,
    updatedAt: 1,
  });

  it("passes a run that fits within the remaining cloud actions", async () => {
    const quotas = new Map<string, WorkspaceQuota>([
      [WS, { cloudActionsUsed: 7, cloudActionsLimit: 10 }],
    ]);
    const { run } = harness({ rows, cells: [], quotas });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.assertColumnRunQuota({ tableId: TABLE, columnId: COL_NAME }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    // 3 candidate rows, none done → 3 cells; 7 + 3 = 10 == limit, fits.
    if (Exit.isSuccess(exit)) expect(exit.value.cellsToRun).toBe(3);
  });

  it("rejects with 402-mapped CloudActionsLimitError when remaining < cells to run", async () => {
    const quotas = new Map<string, WorkspaceQuota>([
      [WS, { cloudActionsUsed: 9, cloudActionsLimit: 10 }],
    ]);
    const { run } = harness({ rows, cells: [], quotas });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.assertColumnRunQuota({ tableId: TABLE, columnId: COL_NAME }),
        ),
      ),
    );
    // 3 cells but only 1 remaining → reject.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const f = Cause.failureOption(exit.cause);
      expect(f._tag === "Some" && f.value._tag).toBe("CloudActionsLimitError");
    }
  });

  it("SELF-HOST: an over-limit run passes (cloud-actions quota bypassed)", async () => {
    // Same over-limit setup as the rejecting case above, but GTMGRID_SELF_HOST=1
    // skips the quota gate so a self-hoster is never capped.
    const prev = process.env.GTMGRID_SELF_HOST;
    process.env.GTMGRID_SELF_HOST = "1";
    try {
      const quotas = new Map<string, WorkspaceQuota>([
        [WS, { cloudActionsUsed: 9, cloudActionsLimit: 10 }],
      ]);
      const { run } = harness({ rows, cells: [], quotas });
      const exit = await run(
        svc.pipe(
          Effect.flatMap((s) =>
            s.assertColumnRunQuota({ tableId: TABLE, columnId: COL_NAME }),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      // 3 candidate cells still reported, just not capped.
      if (Exit.isSuccess(exit)) expect(exit.value.cellsToRun).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.GTMGRID_SELF_HOST;
      else process.env.GTMGRID_SELF_HOST = prev;
    }
  });

  it("subtracts already-done cells (idempotency skips) so a re-run within quota passes", async () => {
    const quotas = new Map<string, WorkspaceQuota>([
      [WS, { cloudActionsUsed: 9, cloudActionsLimit: 10 }],
    ]);
    // Two of three rows already done for the run column → only 1 cell would run.
    const { run } = harness({
      rows,
      cells: [doneCell("row-1"), doneCell("row-2")],
      quotas,
    });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.assertColumnRunQuota({ tableId: TABLE, columnId: COL_NAME }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.cellsToRun).toBe(1);
  });

  it("counts every candidate cell when force re-runs already-done cells", async () => {
    const quotas = new Map<string, WorkspaceQuota>([
      [WS, { cloudActionsUsed: 9, cloudActionsLimit: 10 }],
    ]);
    const { run } = harness({
      rows,
      cells: [doneCell("row-1"), doneCell("row-2")],
      quotas,
    });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.assertColumnRunQuota({
            tableId: TABLE,
            columnId: COL_NAME,
            force: true,
          }),
        ),
      ),
    );
    // force ignores done skips → 3 cells, only 1 remaining → reject.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const f = Cause.failureOption(exit.cause);
      expect(f._tag === "Some" && f.value._tag).toBe("CloudActionsLimitError");
    }
  });

  it("gates only the explicit rowIds subset", async () => {
    const quotas = new Map<string, WorkspaceQuota>([
      [WS, { cloudActionsUsed: 9, cloudActionsLimit: 10 }],
    ]);
    const { run } = harness({ rows, cells: [], quotas });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.assertColumnRunQuota({
            tableId: TABLE,
            columnId: COL_NAME,
            rowIds: ["row-1"],
          }),
        ),
      ),
    );
    // Only 1 candidate row → 1 cell, fits within the 1 remaining.
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.cellsToRun).toBe(1);
  });

  it("passes when the workspace has no quota row (unmetered)", async () => {
    const { run } = harness({ rows, cells: [], quotas: new Map() });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.assertColumnRunQuota({ tableId: TABLE, columnId: COL_NAME }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("WebhookService.upsertRow", () => {
  it("UPDATES the matched row when the upsert key matches", async () => {
    const rows: GridRow[] = [{ id: "row-1", tableId: TABLE, position: 0 }];
    const cells: GridCell[] = [
      {
        id: "cell-1",
        rowId: "row-1",
        columnId: COL_EMAIL,
        value: "a@b.com",
        status: "done",
        error: null,
        updatedAt: 1,
      },
    ];
    const { run } = harness({ rows, cells });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.upsertRow({
            webhookId: "wh-1",
            upsertKey: COL_EMAIL,
            cells: { [COL_EMAIL]: "a@b.com", [COL_NAME]: "Updated" },
          }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.rowId).toBe("row-1");
    // No new row; the name cell was inserted onto the matched row.
    expect(rows).toHaveLength(1);
    expect(cells.find((c) => c.columnId === COL_NAME)?.value).toBe("Updated");
  });

  it("broadcasts cell.upsert per written cell on a MATCHED upsert (no row.insert)", async () => {
    const rows: GridRow[] = [{ id: "row-1", tableId: TABLE, position: 0 }];
    const cells: GridCell[] = [
      { id: "cell-1", rowId: "row-1", columnId: COL_EMAIL, value: "a@b.com", status: "done", error: null, updatedAt: 1 },
    ];
    const { run, published } = harness({ rows, cells });
    await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.upsertRow({
            webhookId: "wh-1",
            upsertKey: COL_EMAIL,
            cells: { [COL_EMAIL]: "a@b.com", [COL_NAME]: "Updated" },
          }),
        ),
      ),
    );
    expect(published.map((p) => p.event.type)).toEqual(["cell.upsert", "cell.upsert"]);
    expect(published[1].event).toEqual({
      type: "cell.upsert",
      cell: { rowId: "row-1", columnId: COL_NAME, value: "Updated", status: "done", error: null },
    });
  });

  it("INSERTS a fresh row when no upsert key matches", async () => {
    const rows: GridRow[] = [{ id: "row-1", tableId: TABLE, position: 0 }];
    const cells: GridCell[] = [
      {
        id: "cell-1",
        rowId: "row-1",
        columnId: COL_EMAIL,
        value: "a@b.com",
        status: "done",
        error: null,
        updatedAt: 1,
      },
    ];
    const { run } = harness({ rows, cells });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.upsertRow({
            webhookId: "wh-1",
            upsertKey: COL_EMAIL,
            cells: { [COL_EMAIL]: "new@b.com" },
          }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.rowId).not.toBe("row-1");
    expect(rows).toHaveLength(2);
  });

  it("rejects an upsert key not in the table", async () => {
    const { run } = harness({ rows: [], cells: [] });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.upsertRow({
            webhookId: "wh-1",
            upsertKey: "col-foreign",
            cells: { [COL_EMAIL]: "x" },
          }),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const f = Cause.failureOption(exit.cause);
      expect(f._tag === "Some" && f.value._tag).toBe("InvalidMappingError");
    }
  });
});

describe("WebhookService.upsertRow — TRI-3270 indexed point lookup", () => {
  // Regression: the upsert match must resolve the row with a single INDEXED
  // lookup (repo.findRowByCellValue), NOT a full-table cell scan that loads
  // every cell and filters in JS. We prove it on a multi-thousand-row table by
  // poisoning `listCellsByTable` so any fallback to the old O(rows×cols) scan
  // hard-fails, then asserting the correct row is still found.
  const ROW_COUNT = 5000;
  const TARGET_INDEX = 4242;

  function bigGrid() {
    const rows: GridRow[] = Array.from({ length: ROW_COUNT }, (_, i) => ({
      id: `row-${i}`,
      tableId: TABLE,
      position: i,
    }));
    // One email cell per row; the target row holds the value we upsert on.
    const cells: GridCell[] = rows.map((r, i) => ({
      id: `cell-${i}`,
      rowId: r.id,
      columnId: COL_EMAIL,
      value: `user-${i}@b.com`,
      status: "done",
      error: null,
      updatedAt: 1,
    }));
    return { rows, cells };
  }

  /** Wrap the live fake repo so `listCellsByTable` is a tripwire. */
  function noScanHarness(rows: GridRow[], cells: GridCell[]) {
    const base = webhookRepoLayer({
      webhooks: [{ ...webhook, mode: "upsert", upsertKey: COL_EMAIL }],
      tables: [baseTable],
      columns,
      rows,
      cells,
      quotas: new Map(),
      credentials: new Map(),
    });
    const guarded = Layer.effect(
      WebhookRepo,
      Effect.map(WebhookRepo, (repo) => ({
        ...repo,
        listCellsByTable: () =>
          Effect.die(
            new Error(
              "TRI-3270 regression: upsertRow performed a full-table cell scan",
            ),
          ),
      })),
    ).pipe(Layer.provide(base));
    const membership = MembershipService.Default.pipe(
      Layer.provide(cloudIdentityLayer("member")),
      Layer.provide(cloudMemberRepoLayer(memberships)),
    );
    const entitlement = EntitlementService.Default.pipe(
      Layer.provide(
        workspaceRepoLayer([
          { id: WS, name: "WS", ownerId: "owner", currentPlanId: "team" },
        ]),
      ),
    );
    const layer = WebhookService.Default.pipe(
      Layer.provide(guarded),
      Layer.provide(webhookDeliveryRepoLayer([])),
      Layer.provide(membership),
      Layer.provide(CellMerge.Default),
      Layer.provide(credentialCryptoTest()),
      Layer.provide(entitlement),
      Layer.provide(columnRepoLayer(makeGridStore())),
      Layer.provide(recordingRealtimePublisherLayer()),
    );
    const run = <A, E>(program: Effect.Effect<A, E, WebhookService>) =>
      Effect.runPromiseExit(program.pipe(Effect.provide(layer)));
    return { run };
  }

  it("finds the correct row on a 5000-row table without loading all cells", async () => {
    const { rows, cells } = bigGrid();
    const { run } = noScanHarness(rows, cells);
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.upsertRow({
            webhookId: "wh-1",
            upsertKey: COL_EMAIL,
            cells: {
              [COL_EMAIL]: `user-${TARGET_INDEX}@b.com`,
              [COL_NAME]: "Patched",
            },
          }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      // Matched the existing target row (no new row inserted).
      expect(exit.value.rowId).toBe(`row-${TARGET_INDEX}`);
    }
    expect(rows).toHaveLength(ROW_COUNT);
    expect(cells.find((c) => c.columnId === COL_NAME)?.rowId).toBe(
      `row-${TARGET_INDEX}`,
    );
  });

  it("inserts a fresh row (no scan) when no indexed match exists", async () => {
    const { rows, cells } = bigGrid();
    const { run } = noScanHarness(rows, cells);
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.upsertRow({
            webhookId: "wh-1",
            upsertKey: COL_EMAIL,
            cells: { [COL_EMAIL]: "brand-new@b.com" },
          }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(rows).toHaveLength(ROW_COUNT + 1);
  });
});

describe("WebhookService delivery 50-row prune", () => {
  it("caps the delivery log at 50 after recording", async () => {
    // Seed 50 existing deliveries; one more record should prune back to 50.
    const deliveries: WebhookDelivery[] = Array.from({ length: 50 }, (_, i) => ({
      id: `seed-${i}`,
      workspaceId: WS,
      webhookId: "wh-1",
      tableId: TABLE,
      status: 200,
      rowsAffected: 1,
      mode: "create",
      recordId: null,
      error: null,
      receivedAt: i + 1,
    }));
    const { run } = harness({ rows: [], cells: [], deliveries });
    await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.insertRow({ webhookId: "wh-1", cells: { [COL_EMAIL]: "a@b.com" } }),
        ),
      ),
    );
    expect(deliveries).toHaveLength(50);
    // The oldest (receivedAt = 1) was pruned; the newest remains.
    expect(deliveries.some((d) => d.id === "seed-0")).toBe(false);
  });
});

describe("WebhookService.setCell metering", () => {
  const rows: GridRow[] = [{ id: "row-1", tableId: TABLE, position: 0 }];

  it("does NOT meter on a running status", async () => {
    const quotas = new Map<string, WorkspaceQuota>();
    const { run } = harness({ rows: [...rows], cells: [], quotas });
    await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.setCell({
            rowId: "row-1",
            columnId: COL_EMAIL,
            hasValue: true,
            value: "x",
            status: "running",
          }),
        ),
      ),
    );
    expect(quotas.get(WS)?.cloudActionsUsed ?? 0).toBe(0);
  });

  it("meters once on a terminal (done) status", async () => {
    const quotas = new Map<string, WorkspaceQuota>();
    const { run } = harness({ rows: [...rows], cells: [], quotas });
    await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.setCell({
            rowId: "row-1",
            columnId: COL_EMAIL,
            hasValue: true,
            value: "x",
            status: "done",
          }),
        ),
      ),
    );
    expect(quotas.get(WS)?.cloudActionsUsed).toBe(1);
  });

  it("broadcasts the POST-MERGE cell so engine column runs paint live", async () => {
    const { run, published } = harness({ rows: [...rows], cells: [] });
    await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.setCell({
            rowId: "row-1",
            columnId: COL_EMAIL,
            hasValue: true,
            value: "x",
            status: "done",
          }),
        ),
      ),
    );
    expect(published).toHaveLength(1);
    expect(published[0].event).toEqual({
      type: "cell.upsert",
      cell: { rowId: "row-1", columnId: COL_EMAIL, value: "x", status: "done", error: null },
    });
  });
});

describe("WebhookService.setCells (batched)", () => {
  const rows: GridRow[] = [
    { id: "row-1", tableId: TABLE, position: 0 },
    { id: "row-2", tableId: TABLE, position: 1 },
  ];

  it("writes every cell in the array and meters once per terminal cell", async () => {
    const quotas = new Map<string, WorkspaceQuota>();
    const cells: GridCell[] = [];
    const { run } = harness({ rows: [...rows], cells, quotas });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.setCells({
            cells: [
              {
                rowId: "row-1",
                columnId: COL_EMAIL,
                hasValue: true,
                value: "a",
                status: "done",
              },
              {
                rowId: "row-2",
                columnId: COL_EMAIL,
                hasValue: true,
                value: "b",
                status: "done",
              },
            ],
          }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.written).toBe(2);
    expect(cells).toHaveLength(2);
    expect(cells.map((c) => c.value).sort()).toEqual(["a", "b"]);
    // Two terminal writes => metered twice.
    expect(quotas.get(WS)?.cloudActionsUsed).toBe(2);
  });
});

describe("WebhookService.getCredential", () => {
  it("decrypts a shared credential round-trip", async () => {
    // Encrypt a secret map with the SAME test crypto layer, store the envelope.
    const crypto = credentialCryptoTest();
    const enc = await Effect.runPromise(
      Effect.gen(function* () {
        const c = yield* CredentialCryptoService;
        return yield* c.encrypt(WS, { apiKey: "sekret" });
      }).pipe(Effect.provide(crypto)),
    );
    const credentials = new Map<string, string>([[`${WS}:apollo`, enc]]);
    const { run } = harness({ rows: [], cells: [], credentials, crypto });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.getCredential({ workspaceId: WS, extensionId: "apollo" }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value?.secrets).toEqual({ apiKey: "sekret" });
    }
  });

  it("returns null when no shared credential exists", async () => {
    const { run } = harness({ rows: [], cells: [] });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.getCredential({ workspaceId: WS, extensionId: "none" }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit) && exit.value).toBe(null);
  });
});

// The desktop sidecar + spawned MCP reach getTable/getTableMeta/setCell/
// getCredential/assertColumnRunQuota via the dual-auth `runWorkerSecretOrMember`
// route wrapper. On its MEMBER path the service runs with the caller's identity
// and `assertMemberIfIdentified` rejects a non-member (→ 403); on the HEADLESS
// worker-secret path there is no identity, so the assertion is skipped (the
// inngest worker keeps working). `currentUserId: null` models the headless caller.
describe("WebhookService.getTable — the engine/MCP/Inngest grid payload", () => {
  it("ships FULL Convex-doc-shaped columns (_id + name/kind/code/params) and rows", async () => {
    // REGRESSION (cloud runs dead on the Postgres tier): the engine cloud
    // store finds the run column via `grid.columns.find(c => c._id === id)`,
    // the MCP resolves columns by `name`, and the Inngest enricher filters
    // `kind === "function"`. A {id}-only projection silently broke ALL three.
    const extractCol: StoreColumn = {
      id: "col-extract", workspaceId: WS, tableId: TABLE, name: "Author URL",
      type: "text", kind: "function", provider: null, method: null,
      code: "function(inputs){ return inputs.src; }",
      params: { src: "{{Webhook}}" }, position: 1, createdAt: 5,
    };
    const rows: GridRow[] = [{ id: "row-1", tableId: TABLE, position: 0, createdAt: 7 }];
    const { run } = harness({ rows, cells: [], gridColumns: [extractCol] });
    const exit = await run(svc.pipe(Effect.flatMap((s) => s.getTable(TABLE))));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.table).toEqual({ _id: TABLE, id: TABLE, workspaceId: WS });
      expect(exit.value.columns[0]).toMatchObject({
        _id: "col-extract",
        id: "col-extract",
        name: "Author URL",
        kind: "function",
        code: "function(inputs){ return inputs.src; }",
        params: { src: "{{Webhook}}" },
        position: 1,
        createdAt: 5,
      });
      expect(exit.value.rows[0]).toEqual({
        _id: "row-1", id: "row-1", tableId: TABLE, position: 0, createdAt: 7,
      });
    }
  });
});

describe("WebhookService worker paths — member-auth gate", () => {
  it("getTable rejects a non-member of the table's workspace", async () => {
    const { run } = harness({ rows: [], cells: [], currentUserId: "stranger" });
    const exit = await run(svc.pipe(Effect.flatMap((s) => s.getTable(TABLE))));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const f = Cause.failureOption(exit.cause);
      expect(f._tag === "Some" && f.value._tag).toBe("NotAMemberError");
    }
  });

  it("getTable allows the headless worker-secret path (no identity → skip)", async () => {
    const { run } = harness({ rows: [], cells: [], currentUserId: null });
    const exit = await run(svc.pipe(Effect.flatMap((s) => s.getTable(TABLE))));
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("getTableMeta rejects a non-member", async () => {
    const { run } = harness({ currentUserId: "stranger" });
    const exit = await run(
      svc.pipe(Effect.flatMap((s) => s.getTableMeta(TABLE))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const f = Cause.failureOption(exit.cause);
      expect(f._tag === "Some" && f.value._tag).toBe("NotAMemberError");
    }
  });

  it("getCredential rejects a non-member (no plaintext secret leak)", async () => {
    const crypto = credentialCryptoTest();
    const enc = await Effect.runPromise(
      Effect.gen(function* () {
        const c = yield* CredentialCryptoService;
        return yield* c.encrypt(WS, { apiKey: "sekret" });
      }).pipe(Effect.provide(crypto)),
    );
    const credentials = new Map<string, string>([[`${WS}:apollo`, enc]]);
    const { run } = harness({ credentials, crypto, currentUserId: "stranger" });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.getCredential({ workspaceId: WS, extensionId: "apollo" }),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const f = Cause.failureOption(exit.cause);
      expect(f._tag === "Some" && f.value._tag).toBe("NotAMemberError");
    }
  });

  it("getCredential allows the headless worker-secret path (no identity → skip)", async () => {
    const crypto = credentialCryptoTest();
    const enc = await Effect.runPromise(
      Effect.gen(function* () {
        const c = yield* CredentialCryptoService;
        return yield* c.encrypt(WS, { apiKey: "sekret" });
      }).pipe(Effect.provide(crypto)),
    );
    const credentials = new Map<string, string>([[`${WS}:apollo`, enc]]);
    const { run } = harness({ credentials, crypto, currentUserId: null });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.getCredential({ workspaceId: WS, extensionId: "apollo" }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value?.secrets).toEqual({ apiKey: "sekret" });
    }
  });
});

describe("WebhookService config CRUD (member-gated)", () => {
  it("rejects a non-member from listWebhooks", async () => {
    const { run } = harness({ currentUserId: "stranger" });
    const exit = await run(
      svc.pipe(Effect.flatMap((s) => s.listWebhooks(TABLE))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const f = Cause.failureOption(exit.cause);
      expect(f._tag === "Some" && f.value._tag).toBe("NotAMemberError");
    }
  });

  it("creates a webhook with a minted token and NO secret by default (auth is opt-in)", async () => {
    const webhooks: Webhook[] = [];
    const { run } = harness({ webhooks });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.createWebhook({
            tableId: TABLE,
            name: "New",
            mapping: [{ path: "email", columnId: COL_EMAIL }],
          }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0].token.length).toBeGreaterThan(20);
    expect(webhooks[0].signingSecret).toBeNull();
  });

  it("creates the Webhook raw-payload column and a leading `$` mapping entry", async () => {
    const webhooks: Webhook[] = [];
    const { run, gridColumns } = harness({ webhooks });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.createWebhook({
            tableId: TABLE,
            mapping: [{ path: "email", columnId: COL_EMAIL }],
          }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    // A "Webhook" json column was created on the table…
    const webhookCol = gridColumns.find((c) => c.name === "Webhook");
    expect(webhookCol?.type).toBe("json");
    expect(webhookCol?.kind).toBe("manual");
    // …and the mapping leads with the `$` whole-payload entry targeting it.
    expect(webhooks[0].mapping[0]).toEqual({ path: "$", columnId: webhookCol?.id });
    expect(webhooks[0].mapping[1]).toEqual({ path: "email", columnId: COL_EMAIL });
  });

  it("reuses an existing Webhook column instead of duplicating it", async () => {
    const webhooks: Webhook[] = [];
    const existing: StoreColumn = {
      id: "col-webhook", workspaceId: WS, tableId: TABLE, name: "Webhook",
      type: "json", kind: "manual", provider: null, method: null, code: null,
      params: {}, position: 0, createdAt: 1,
    };
    const { run, gridColumns } = harness({ webhooks, gridColumns: [existing] });
    const exit = await run(
      svc.pipe(Effect.flatMap((s) => s.createWebhook({ tableId: TABLE }))),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(gridColumns).toHaveLength(1);
    expect(webhooks[0].mapping[0]).toEqual({ path: "$", columnId: "col-webhook" });
  });

  it("creates a webhook WITH a minted secret when auth opts in", async () => {
    const webhooks: Webhook[] = [];
    const { run } = harness({ webhooks });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) => s.createWebhook({ tableId: TABLE, auth: true })),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(webhooks[0].signingSecret?.startsWith("whsec_")).toBe(true);
  });

  it("rejects createWebhook with a foreign mapping column", async () => {
    const { run } = harness({ webhooks: [] });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.createWebhook({
            tableId: TABLE,
            mapping: [{ path: "x", columnId: "col-foreign" }],
          }),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const f = Cause.failureOption(exit.cause);
      expect(f._tag === "Some" && f.value._tag).toBe("InvalidMappingError");
    }
  });

  it("updateWebhookConfig rejects upsert mode without a key", async () => {
    const { run } = harness({});
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.updateWebhookConfig({ webhookId: "wh-1", mode: "upsert" }),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const f = Cause.failureOption(exit.cause);
      expect(f._tag === "Some" && f.value._tag).toBe("InvalidConfigError");
    }
  });

  it("rotateSecret returns a fresh token + secret and patches the row", async () => {
    const webhooks: Webhook[] = [{ ...webhook }];
    const { run } = harness({ webhooks });
    const exit = await run(
      svc.pipe(Effect.flatMap((s) => s.rotateSecret("wh-1"))),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.token).not.toBe("tok-123");
      expect(webhooks[0].token).toBe(exit.value.token);
      // The seeded webhook HAS auth on (whsec_x) — rotation mints a fresh secret.
      expect(exit.value.signingSecret?.startsWith("whsec_")).toBe(true);
      expect(exit.value.signingSecret).not.toBe("whsec_x");
    }
  });

  it("rotateSecret preserves the opted-OUT state (no secret minted)", async () => {
    const webhooks: Webhook[] = [{ ...webhook, signingSecret: null }];
    const { run } = harness({ webhooks });
    const exit = await run(
      svc.pipe(Effect.flatMap((s) => s.rotateSecret("wh-1"))),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.signingSecret).toBeNull();
      expect(webhooks[0].signingSecret).toBeNull();
      expect(webhooks[0].token).toBe(exit.value.token);
    }
  });

  it("setAuth opts in (mints + returns a secret) and back out (clears it)", async () => {
    const webhooks: Webhook[] = [{ ...webhook, signingSecret: null }];
    const { run } = harness({ webhooks });

    const on = await run(
      svc.pipe(Effect.flatMap((s) => s.setAuth({ webhookId: "wh-1", enabled: true }))),
    );
    expect(Exit.isSuccess(on)).toBe(true);
    if (Exit.isSuccess(on)) {
      expect(on.value.signingSecret?.startsWith("whsec_")).toBe(true);
      expect(webhooks[0].signingSecret).toBe(on.value.signingSecret);
    }

    const off = await run(
      svc.pipe(Effect.flatMap((s) => s.setAuth({ webhookId: "wh-1", enabled: false }))),
    );
    expect(Exit.isSuccess(off)).toBe(true);
    if (Exit.isSuccess(off)) {
      expect(off.value.signingSecret).toBeNull();
      expect(webhooks[0].signingSecret).toBeNull();
    }
  });

  it("rejects a non-member from setAuth", async () => {
    const { run } = harness({ currentUserId: "stranger" });
    const exit = await run(
      svc.pipe(Effect.flatMap((s) => s.setAuth({ webhookId: "wh-1", enabled: true }))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const f = Cause.failureOption(exit.cause);
      expect(f._tag === "Some" && f.value._tag).toBe("NotAMemberError");
    }
  });

  it("toggleEnabled(true) HEALS a legacy webhook without a `$` mapping entry", async () => {
    const webhooks: Webhook[] = [{ ...webhook, enabled: false }];
    const { run, gridColumns } = harness({ webhooks });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) => s.toggleEnabled({ webhookId: "wh-1", enabled: true })),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    const webhookCol = gridColumns.find((c) => c.name === "Webhook");
    expect(webhookCol).toBeDefined();
    expect(webhooks[0].mapping[0]).toEqual({ path: "$", columnId: webhookCol?.id });
    expect(webhooks[0].mapping[1]).toEqual({ path: "email", columnId: COL_EMAIL });
    expect(webhooks[0].enabled).toBe(true);
  });

  it("updateWebhookMapping preserves the `$` raw-payload entry", async () => {
    const webhooks: Webhook[] = [
      {
        ...webhook,
        mapping: [
          { path: "$", columnId: "col-webhook" },
          { path: "email", columnId: COL_EMAIL },
        ],
      },
    ];
    const { run } = harness({ webhooks });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.updateWebhookMapping({
            webhookId: "wh-1",
            mapping: [{ path: "name", columnId: COL_NAME }],
          }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(webhooks[0].mapping).toEqual([
      { path: "$", columnId: "col-webhook" },
      { path: "name", columnId: COL_NAME },
    ]);
  });

  it("toggleEnabled + deleteWebhook mutate the store", async () => {
    const webhooks: Webhook[] = [{ ...webhook }];
    const { run } = harness({ webhooks });
    await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.toggleEnabled({ webhookId: "wh-1", enabled: false }),
        ),
      ),
    );
    expect(webhooks[0].enabled).toBe(false);
    await run(svc.pipe(Effect.flatMap((s) => s.deleteWebhook("wh-1"))));
    expect(webhooks).toHaveLength(0);
  });
});

describe("WebhookService bounded grid reads (scale)", () => {
  const storeColumns: StoreColumn[] = [
    {
      id: COL_EMAIL, workspaceId: WS, tableId: TABLE, name: "Email",
      type: "text", kind: "manual", provider: null, method: null, code: null,
      params: {}, condition: null, position: 0, createdAt: 1,
    },
    {
      id: COL_NAME, workspaceId: WS, tableId: TABLE, name: "Name",
      type: "text", kind: "manual", provider: null, method: null, code: null,
      params: {}, condition: null, position: 1, createdAt: 2,
    },
  ];
  const threeRows: GridRow[] = [
    { id: "r1", tableId: TABLE, position: 0, createdAt: 10 },
    { id: "r2", tableId: TABLE, position: 1, createdAt: 11 },
    { id: "r3", tableId: TABLE, position: 2, createdAt: 12 },
  ];
  const threeCells: GridCell[] = [
    { id: "c1", rowId: "r1", columnId: COL_EMAIL, value: "a@x.com", status: "done", error: null },
    { id: "c2", rowId: "r2", columnId: COL_EMAIL, value: "b@x.com", status: "done", error: null },
    { id: "c3", rowId: "r3", columnId: COL_EMAIL, value: "c@x.com", status: "done", error: null },
  ];

  it("getTableForRows: all columns + ONLY the requested rows and their cells", async () => {
    const { run } = harness({
      gridColumns: storeColumns, rows: threeRows, cells: threeCells, currentUserId: null,
    });
    const exit = await run(
      svc.pipe(Effect.flatMap((s) => s.getTableForRows(TABLE, ["r1", "r3"]))),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      const g = exit.value;
      expect(g.columns.map((c) => c._id).sort()).toEqual([COL_EMAIL, COL_NAME].sort());
      expect(g.rows.map((r) => r._id)).toEqual(["r1", "r3"]);
      expect(g.cells.map((c) => c.rowId).sort()).toEqual(["r1", "r3"]);
      // The unrequested row never appears in rows OR cells (bounded read).
      expect(g.rows.some((r) => r._id === "r2")).toBe(false);
      expect(g.cells.some((c) => c.rowId === "r2")).toBe(false);
    }
  });

  it("getTableForRows: empty rowIds → columns only, zero rows/cells", async () => {
    const { run } = harness({
      gridColumns: storeColumns, rows: threeRows, cells: threeCells, currentUserId: null,
    });
    const exit = await run(
      svc.pipe(Effect.flatMap((s) => s.getTableForRows(TABLE, []))),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.columns.length).toBe(2);
      expect(exit.value.rows).toEqual([]);
      expect(exit.value.cells).toEqual([]);
    }
  });

  it("getTablePage: walks keyset pages in position order with a nextCursor", async () => {
    const { run } = harness({
      gridColumns: storeColumns, rows: threeRows, cells: threeCells, currentUserId: null,
    });
    const p1 = await run(
      svc.pipe(Effect.flatMap((s) => s.getTablePage({ tableId: TABLE, cursor: null, limit: 2 }))),
    );
    expect(Exit.isSuccess(p1)).toBe(true);
    if (!Exit.isSuccess(p1)) return;
    expect(p1.value.rows.map((r) => r._id)).toEqual(["r1", "r2"]);
    expect(p1.value.cells.map((c) => c.rowId).sort()).toEqual(["r1", "r2"]);
    expect(p1.value.nextCursor).not.toBeNull();

    const p2 = await run(
      svc.pipe(Effect.flatMap((s) => s.getTablePage({ tableId: TABLE, cursor: p1.value.nextCursor, limit: 2 }))),
    );
    expect(Exit.isSuccess(p2)).toBe(true);
    if (!Exit.isSuccess(p2)) return;
    expect(p2.value.rows.map((r) => r._id)).toEqual(["r3"]);
    expect(p2.value.nextCursor).toBeNull(); // last page
  });

  it("getTable still SERVES but WARNS (telemetry) above the full-grid row cap", async () => {
    const many: GridRow[] = Array.from(
      { length: FULL_GRID_ROW_WARN_CAP + 1 },
      (_, i) => ({ id: `r${i}`, tableId: TABLE, position: i, createdAt: i }),
    );
    const logs: string[] = [];
    const testLogger = Logger.make(({ message }) => {
      logs.push(Array.isArray(message) ? message.join(" ") : String(message));
    });
    const { run } = harness({ gridColumns: storeColumns, rows: many, cells: [], currentUserId: null });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) => s.getTable(TABLE)),
        Effect.provide(Logger.replace(Logger.defaultLogger, testLogger)),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      // Still served every row (never breaks).
      expect(exit.value.rows.length).toBe(FULL_GRID_ROW_WARN_CAP + 1);
    }
    expect(logs.some((m) => m.includes("full-grid read above"))).toBe(true);
  });

  it("getTable is SILENT below the cap", async () => {
    const logs: string[] = [];
    const testLogger = Logger.make(({ message }) => {
      logs.push(Array.isArray(message) ? message.join(" ") : String(message));
    });
    const { run } = harness({ gridColumns: storeColumns, rows: threeRows, cells: threeCells, currentUserId: null });
    await run(
      svc.pipe(
        Effect.flatMap((s) => s.getTable(TABLE)),
        Effect.provide(Logger.replace(Logger.defaultLogger, testLogger)),
      ),
    );
    expect(logs.some((m) => m.includes("full-grid read above"))).toBe(false);
  });
});
