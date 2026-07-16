/**
 * Cross-table action paths on `WebhookService` (the table.push / table.lookup
 * worker surface) — OFFLINE against in-memory Test Layers. The load-bearing
 * behaviours:
 *   - SAME-PROJECT scoping: a target in another project resolves as not-found
 *     (schema → null, upsert → 404-tagged error) even when it exists.
 *   - target resolution by id AND by exact name, project-scoped.
 *   - upsertRowInTable: matched-update vs new-insert, metered ONCE per record,
 *     append (null key) always inserts, key column must belong to the target.
 *   - member-path authz: a non-member of the SOURCE's workspace is rejected;
 *     the headless (null-identity) worker path passes.
 *   - quota: an exhausted plan rejects with CloudActionsLimitError (402).
 *   - createColumnInTable: manual column at the next position, metered once.
 */

import {
  identityLayer as cloudIdentityLayer,
  memberRepoLayer as cloudMemberRepoLayer,
  type Membership,
  MembershipService,
  CellMerge,
} from "@gtmgrid/cloud";
import { Cause, Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { credentialCryptoTest } from "../credential-crypto-test.js";
import { columnRepoLayer } from "../repositories/column-repo.js";
import { makeGridStore, type StoreColumn } from "../repositories/grid-store.js";
import { webhookDeliveryRepoLayer } from "../repositories/webhook-delivery-repo.js";
import {
  type GridCell,
  type GridColumn,
  type GridRow,
  type GridTable,
  webhookRepoLayer,
  type WorkspaceQuota,
} from "../repositories/webhook-repo.js";
import { workspaceRepoLayer } from "../repositories/workspace-repo.js";
import { EntitlementService } from "./entitlement-service.js";
import {
  RealtimePublisher,
  recordingRealtimePublisherLayer,
  type RecordedGridEvent,
} from "./realtime-publisher.js";
import { WebhookService } from "./webhook-service.js";

const WS = "ws-1";
const PROJECT = "proj-1";
const OTHER_PROJECT = "proj-2";

const SOURCE = "table-source";
const TARGET = "table-target";
const FOREIGN = "table-foreign"; // same workspace, DIFFERENT project

const COL_DOMAIN = "col-domain";
const COL_OWNER = "col-owner";

const memberships: readonly Membership[] = [
  { workspaceId: WS, userId: "member", role: "member" },
];

const tables: GridTable[] = [
  { id: SOURCE, workspaceId: WS, projectId: PROJECT, name: "Leads", position: 0, createdAt: 1 },
  { id: TARGET, workspaceId: WS, projectId: PROJECT, name: "Accounts", position: 1, createdAt: 1 },
  { id: FOREIGN, workspaceId: WS, projectId: OTHER_PROJECT, name: "Elsewhere", position: 0, createdAt: 1 },
];

/** The webhook repo's narrow column projection (id set validation). */
const gridColumns: GridColumn[] = [
  { id: COL_DOMAIN, tableId: TARGET },
  { id: COL_OWNER, tableId: TARGET },
];

/** The ColumnRepo full projection (schema reads + column creation). */
const storeColumn = (over: Partial<StoreColumn> & { id: string; tableId: string; name: string }): StoreColumn => ({
  workspaceId: WS,
  type: "text",
  kind: "manual",
  provider: null,
  method: null,
  code: null,
  params: {},
  condition: null,
  position: 0,
  createdAt: 1,
  ...over,
});

function harness(opts: {
  rows?: GridRow[];
  cells?: GridCell[];
  quotas?: Map<string, WorkspaceQuota>;
  currentUserId?: string | null;
  fullColumns?: StoreColumn[];
  webhooks?: import("../repositories/webhook-repo.js").Webhook[];
  /** Extra narrow (webhook-repo) column projections beyond the target's. */
  extraGridColumns?: GridColumn[];
}) {
  const webhooks = opts.webhooks ?? [];
  const webhookRepo = webhookRepoLayer({
    webhooks,
    tables: [...tables],
    columns: [...gridColumns, ...(opts.extraGridColumns ?? [])],
    rows: opts.rows ?? [],
    cells: opts.cells ?? [],
    quotas: opts.quotas ?? new Map(),
    credentials: new Map(),
  });
  const membership = MembershipService.Default.pipe(
    Layer.provide(
      cloudIdentityLayer(
        opts.currentUserId === undefined ? "member" : opts.currentUserId,
      ),
    ),
    Layer.provide(cloudMemberRepoLayer(memberships)),
  );
  const entitlement = EntitlementService.Default.pipe(
    Layer.provide(
      workspaceRepoLayer([
        { id: WS, name: "WS", ownerId: "owner", currentPlanId: "team" },
      ]),
    ),
  );
  const fullColumns =
    opts.fullColumns ??
    [
      storeColumn({ id: COL_DOMAIN, tableId: TARGET, name: "Domain", position: 0 }),
      storeColumn({ id: COL_OWNER, tableId: TARGET, name: "Owner", position: 1 }),
    ];
  const columnRepo = columnRepoLayer(makeGridStore({ columns: fullColumns }));
  const published: RecordedGridEvent[] = [];
  const layer = WebhookService.Default.pipe(
    Layer.provide(webhookRepo),
    Layer.provide(webhookDeliveryRepoLayer([])),
    Layer.provide(membership),
    Layer.provide(CellMerge.Default),
    Layer.provide(credentialCryptoTest()),
    Layer.provide(entitlement),
    Layer.provide(columnRepo),
    Layer.provide(recordingRealtimePublisherLayer(published)),
  );
  const run = <A, E>(program: Effect.Effect<A, E, WebhookService>) =>
    Effect.runPromiseExit(program.pipe(Effect.provide(layer)));
  return { run, published, fullColumns, webhooks };
}

const svc = Effect.gen(function* () {
  return yield* WebhookService;
});

/** Extract the typed failure tag from an Exit for assertions. */
function failureTag(exit: Exit.Exit<unknown, unknown>): string | undefined {
  if (Exit.isSuccess(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "None") return undefined;
  const v = failure.value;
  return typeof v === "object" && v !== null && "_tag" in v ? String(v._tag) : undefined;
}

describe("WebhookService.listProjectTables", () => {
  it("lists ONLY the source project's tables (position order)", async () => {
    const { run } = harness({});
    const exit = await run(svc.pipe(Effect.flatMap((s) => s.listProjectTables(SOURCE))));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.tables).toEqual([
        { id: SOURCE, name: "Leads" },
        { id: TARGET, name: "Accounts" },
      ]);
    }
  });

  it("rejects a NON-member of the source's workspace", async () => {
    const { run } = harness({ currentUserId: "stranger" });
    const exit = await run(svc.pipe(Effect.flatMap((s) => s.listProjectTables(SOURCE))));
    expect(failureTag(exit)).toBe("NotAMemberError");
  });

  it("passes on the headless (null identity) worker path", async () => {
    const { run } = harness({ currentUserId: null });
    const exit = await run(svc.pipe(Effect.flatMap((s) => s.listProjectTables(SOURCE))));
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("WebhookService.getTableSchemaForActions", () => {
  it("resolves the target by id and by exact NAME, returning full columns", async () => {
    const { run } = harness({});
    for (const targetRef of [TARGET, "Accounts"]) {
      const exit = await run(
        svc.pipe(
          Effect.flatMap((s) =>
            s.getTableSchemaForActions({ sourceTableId: SOURCE, targetRef }),
          ),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value).toEqual({
          table: { id: TARGET, name: "Accounts" },
          columns: [
            { id: COL_DOMAIN, name: "Domain", type: "text", kind: "manual" },
            { id: COL_OWNER, name: "Owner", type: "text", kind: "manual" },
          ],
        });
      }
    }
  });

  it("a CROSS-PROJECT table resolves to null — indistinguishable from missing", async () => {
    const { run } = harness({});
    for (const targetRef of [FOREIGN, "Elsewhere", "Ghost"]) {
      const exit = await run(
        svc.pipe(
          Effect.flatMap((s) =>
            s.getTableSchemaForActions({ sourceTableId: SOURCE, targetRef }),
          ),
        ),
      );
      expect(Exit.isSuccess(exit) && exit.value).toBeNull();
    }
  });
});

describe("WebhookService.upsertRowInTable", () => {
  it("INSERTS a fresh row when no key matches, writes cells, meters ONCE", async () => {
    const rows: GridRow[] = [];
    const cells: GridCell[] = [];
    const quotas = new Map<string, WorkspaceQuota>([
      [WS, { workspaceId: WS, cloudActionsLimit: 10, cloudActionsUsed: 0 }],
    ]);
    const { run, published } = harness({ rows, cells, quotas });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.upsertRowInTable({
            sourceTableId: SOURCE,
            targetTableId: TARGET,
            keyColumnId: COL_DOMAIN,
            keyValue: "acme.com",
            cells: { [COL_DOMAIN]: "acme.com", [COL_OWNER]: "max" },
          }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.created).toBe(true);
      expect(exit.value.tableId).toBe(TARGET);
    }
    expect(rows).toHaveLength(1);
    expect(cells).toHaveLength(2);
    expect(quotas.get(WS)?.cloudActionsUsed).toBe(1);
    expect(published.map((e) => e.event.type)).toEqual(["row.insert"]);
  });

  it("UPDATES the matched row on a key hit (no new row) and meters once", async () => {
    const rows: GridRow[] = [{ id: "row-1", tableId: TARGET, position: 0 }];
    const cells: GridCell[] = [
      {
        id: "cell-1",
        rowId: "row-1",
        columnId: COL_DOMAIN,
        value: "acme.com",
        status: "done",
        error: null,
        updatedAt: 1,
      },
    ];
    const quotas = new Map<string, WorkspaceQuota>([
      [WS, { workspaceId: WS, cloudActionsLimit: 10, cloudActionsUsed: 0 }],
    ]);
    const { run, published } = harness({ rows, cells, quotas });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.upsertRowInTable({
            sourceTableId: SOURCE,
            targetTableId: TARGET,
            keyColumnId: COL_DOMAIN,
            keyValue: "acme.com",
            cells: { [COL_OWNER]: "max" },
          }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toMatchObject({ rowId: "row-1", created: false });
    }
    expect(rows).toHaveLength(1);
    expect(quotas.get(WS)?.cloudActionsUsed).toBe(1);
    expect(published.map((e) => e.event.type)).toEqual(["cell.upsert"]);
  });

  it("APPEND mode (null key) always inserts a new row", async () => {
    const rows: GridRow[] = [{ id: "row-1", tableId: TARGET, position: 0 }];
    const cells: GridCell[] = [];
    const { run } = harness({ rows, cells });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.upsertRowInTable({
            sourceTableId: SOURCE,
            targetTableId: TARGET,
            keyColumnId: null,
            keyValue: null,
            cells: { [COL_OWNER]: "max" },
          }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.created).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it("rejects a key column that does not belong to the target table", async () => {
    const { run } = harness({});
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.upsertRowInTable({
            sourceTableId: SOURCE,
            targetTableId: TARGET,
            keyColumnId: "col-not-there",
            keyValue: "x",
            cells: {},
          }),
        ),
      ),
    );
    expect(failureTag(exit)).toBe("InvalidMappingError");
  });

  it("rejects a CROSS-PROJECT target as not-found (no leak)", async () => {
    const { run } = harness({});
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.upsertRowInTable({
            sourceTableId: SOURCE,
            targetTableId: FOREIGN,
            keyColumnId: null,
            keyValue: null,
            cells: {},
          }),
        ),
      ),
    );
    expect(failureTag(exit)).toBe("WebhookNotFoundError");
  });

  it("rejects when the plan's cloud actions are exhausted (402 tag)", async () => {
    const quotas = new Map<string, WorkspaceQuota>([
      [WS, { workspaceId: WS, cloudActionsLimit: 5, cloudActionsUsed: 5 }],
    ]);
    const { run } = harness({ quotas });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.upsertRowInTable({
            sourceTableId: SOURCE,
            targetTableId: TARGET,
            keyColumnId: null,
            keyValue: null,
            cells: { [COL_OWNER]: "max" },
          }),
        ),
      ),
    );
    expect(failureTag(exit)).toBe("CloudActionsLimitError");
  });

  it("rejects a NON-member on the member path", async () => {
    const { run } = harness({ currentUserId: "stranger" });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.upsertRowInTable({
            sourceTableId: SOURCE,
            targetTableId: TARGET,
            keyColumnId: null,
            keyValue: null,
            cells: {},
          }),
        ),
      ),
    );
    expect(failureTag(exit)).toBe("NotAMemberError");
  });
});

describe("WebhookService.getTableRowsForActions", () => {
  it("returns the target grid in the gateway shape (columns/_id/name)", async () => {
    const rows: GridRow[] = [{ id: "row-1", tableId: TARGET, position: 0 }];
    const cells: GridCell[] = [
      {
        id: "cell-1",
        rowId: "row-1",
        columnId: COL_DOMAIN,
        value: "acme.com",
        status: "done",
        error: null,
        updatedAt: 1,
      },
    ];
    const { run } = harness({ rows, cells });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.getTableRowsForActions({ sourceTableId: SOURCE, targetTableId: TARGET }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.columns[0]).toEqual({
        _id: COL_DOMAIN,
        name: "Domain",
        type: "text",
        kind: "manual",
      });
      expect(exit.value.rows).toEqual([{ _id: "row-1" }]);
      expect(exit.value.cells).toEqual([
        { rowId: "row-1", columnId: COL_DOMAIN, value: "acme.com" },
      ]);
    }
  });
});

describe("WebhookService.createColumnInTable", () => {
  it("creates a MANUAL column at the next position and meters once", async () => {
    const quotas = new Map<string, WorkspaceQuota>([
      [WS, { workspaceId: WS, cloudActionsLimit: 10, cloudActionsUsed: 0 }],
    ]);
    const { run, fullColumns, published } = harness({ quotas });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.createColumnInTable({
            sourceTableId: SOURCE,
            targetTableId: TARGET,
            name: "Region",
          }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    const created = fullColumns.find((c) => c.name === "Region");
    expect(created).toMatchObject({ tableId: TARGET, kind: "manual", type: "text", position: 2 });
    expect(quotas.get(WS)?.cloudActionsUsed).toBe(1);
    expect(published.map((e) => e.event.type)).toContain("column.insert");
  });

  it("rejects a cross-project target as not-found", async () => {
    const { run } = harness({});
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.createColumnInTable({
            sourceTableId: SOURCE,
            targetTableId: FOREIGN,
            name: "Region",
          }),
        ),
      ),
    );
    expect(failureTag(exit)).toBe("WebhookNotFoundError");
  });
});

// ── Push v2: webhook-style push connections ─────────────────────────────────

const COL_SRC_EMAIL = "col-src-email";
const COL_SRC_NAME = "col-src-name";
const COL_PUSHED = "col-pushed-data";

/** Source-table columns (full projection) + the target's pre-seeded payload col. */
const pushColumns = (): StoreColumn[] => [
  storeColumn({ id: COL_DOMAIN, tableId: TARGET, name: "Domain", position: 0 }),
  storeColumn({ id: COL_OWNER, tableId: TARGET, name: "Owner", position: 1 }),
  storeColumn({ id: COL_PUSHED, tableId: TARGET, name: "Pushed data", type: "json", position: 2 }),
  storeColumn({ id: COL_SRC_EMAIL, tableId: SOURCE, name: "Email", position: 0 }),
  storeColumn({ id: COL_SRC_NAME, tableId: SOURCE, name: "Full Name", position: 1 }),
];

/** Narrow projections for the payload column (target) — the source's columns
 *  never receive writes, so only ids the TARGET validates need to be here. */
const pushGridColumns: GridColumn[] = [{ id: COL_PUSHED, tableId: TARGET }];

const srcRow: GridRow = { id: "src-row-1", tableId: SOURCE, position: 0 };
const srcCells = (): GridCell[] => [
  { id: "sc-1", rowId: "src-row-1", columnId: COL_SRC_EMAIL, value: "a@acme.com", status: "done", error: null, updatedAt: 1 },
  { id: "sc-2", rowId: "src-row-1", columnId: COL_SRC_NAME, value: "Ada Acme", status: "done", error: null, updatedAt: 1 },
];

describe("WebhookService.pushRecord", () => {
  it("first push CREATES the connection + lands the payload row (metered once)", async () => {
    const rows: GridRow[] = [srcRow];
    const cells: GridCell[] = srcCells();
    const quotas = new Map<string, WorkspaceQuota>([
      [WS, { workspaceId: WS, cloudActionsLimit: 10, cloudActionsUsed: 0 }],
    ]);
    const { run, webhooks } = harness({
      rows, cells, quotas,
      fullColumns: pushColumns(),
      extraGridColumns: pushGridColumns,
    });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.pushRecord({
            sourceTableId: SOURCE,
            sourceRowId: "src-row-1",
            targetTableId: TARGET,
            mode: "upsert",
            keyColumnName: "Domain",
            keyValue: "acme.com",
          }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.created).toBe(true);

    // The connection exists, marked as a push source with the default $ mapping.
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]).toMatchObject({
      source: "push",
      sourceTableId: SOURCE,
      tableId: TARGET,
      mode: "upsert",
      upsertKey: COL_DOMAIN,
      mapping: [{ path: "$", columnId: COL_PUSHED }],
    });

    // The target row carries the RAW payload (whole source row by column name)
    // plus the injected dedupe-key cell. Metered exactly once.
    const targetRow = rows.find((r) => r.tableId === TARGET);
    expect(targetRow).toBeDefined();
    const payloadCell = cells.find(
      (c) => c.rowId === targetRow!.id && c.columnId === COL_PUSHED,
    );
    expect(payloadCell?.value).toMatchObject({
      payload: { Email: "a@acme.com", "Full Name": "Ada Acme" },
    });
    const keyCell = cells.find(
      (c) => c.rowId === targetRow!.id && c.columnId === COL_DOMAIN,
    );
    expect(keyCell?.value).toBe("acme.com");
    expect(quotas.get(WS)?.cloudActionsUsed).toBe(1);
  });

  it("re-push with the same key UPDATES the matched row via the same connection", async () => {
    const rows: GridRow[] = [srcRow];
    const cells: GridCell[] = srcCells();
    const { run, webhooks } = harness({
      rows, cells,
      fullColumns: pushColumns(),
      extraGridColumns: pushGridColumns,
    });
    const push = svc.pipe(
      Effect.flatMap((s) =>
        s.pushRecord({
          sourceTableId: SOURCE,
          sourceRowId: "src-row-1",
          targetTableId: TARGET,
          mode: "upsert",
          keyColumnName: "Domain",
          keyValue: "acme.com",
        }),
      ),
    );
    const first = await run(push);
    const second = await run(push);
    expect(Exit.isSuccess(first) && first.value.created).toBe(true);
    expect(Exit.isSuccess(second) && !second.value.created).toBe(true);
    expect(webhooks).toHaveLength(1); // connection reused, not duplicated
    expect(rows.filter((r) => r.tableId === TARGET)).toHaveLength(1); // no dupe row
  });

  it("honours the connection's EDITED mapping (fields land in mapped columns)", async () => {
    const rows: GridRow[] = [srcRow];
    const cells: GridCell[] = srcCells();
    const { run } = harness({
      rows, cells,
      fullColumns: pushColumns(),
      extraGridColumns: pushGridColumns,
      // A pre-existing connection whose mapping ALSO routes payload.Email → Owner.
      webhooks: [{
        id: "conn-1", workspaceId: WS, tableId: TARGET, name: "Push from Leads",
        token: "tok-push", signingSecret: null,
        mapping: [
          { path: "$", columnId: COL_PUSHED },
          { path: "Email", columnId: COL_OWNER },
        ],
        enabled: true, autoRun: null, mode: "create", upsertKey: null,
        createdAt: 1, lastReceivedAt: null, receivedCount: 0,
        source: "push", sourceTableId: SOURCE,
      }],
    });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.pushRecord({
            sourceTableId: SOURCE,
            sourceRowId: "src-row-1",
            targetTableId: TARGET,
            mode: "append",
          }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    const targetRow = rows.find((r) => r.tableId === TARGET)!;
    const ownerCell = cells.find(
      (c) => c.rowId === targetRow.id && c.columnId === COL_OWNER,
    );
    expect(ownerCell?.value).toBe("a@acme.com");
  });

  it("rejects self-push and cross-project targets", async () => {
    const { run } = harness({
      rows: [srcRow], cells: srcCells(),
      fullColumns: pushColumns(), extraGridColumns: pushGridColumns,
    });
    const self = await run(
      svc.pipe(Effect.flatMap((s) => s.pushRecord({
        sourceTableId: SOURCE, sourceRowId: "src-row-1",
        targetTableId: SOURCE, mode: "append",
      }))),
    );
    expect(failureTag(self)).toBe("InvalidConfigError");
    const foreign = await run(
      svc.pipe(Effect.flatMap((s) => s.pushRecord({
        sourceTableId: SOURCE, sourceRowId: "src-row-1",
        targetTableId: FOREIGN, mode: "append",
      }))),
    );
    expect(failureTag(foreign)).toBe("WebhookNotFoundError");
  });

  it("a push connection's token can NEVER be resolved as a public webhook", async () => {
    const { run } = harness({
      webhooks: [{
        id: "conn-1", workspaceId: WS, tableId: TARGET, name: "Push from Leads",
        token: "tok-push-secret", signingSecret: null,
        mapping: [{ path: "$", columnId: COL_PUSHED }],
        enabled: true, autoRun: null, mode: "create", upsertKey: null,
        createdAt: 1, lastReceivedAt: null, receivedCount: 0,
        source: "push", sourceTableId: SOURCE,
      }],
      fullColumns: pushColumns(), extraGridColumns: pushGridColumns,
    });
    const exit = await run(
      svc.pipe(Effect.flatMap((s) => s.resolveToken("tok-push-secret"))),
    );
    expect(Exit.isSuccess(exit) && exit.value).toBeNull();
  });
});

describe("WebhookService.backfillPushMapping", () => {
  it("re-applies an added mapping to already-pushed rows WITHOUT metering", async () => {
    // A target row that was pushed BEFORE any field mapping existed: only the
    // raw payload cell is populated.
    const rows: GridRow[] = [{ id: "t-row-1", tableId: TARGET, position: 0 }];
    const cells: GridCell[] = [{
      id: "tc-1", rowId: "t-row-1", columnId: COL_PUSHED,
      value: { receivedAt: 111, payload: { Email: "a@acme.com", "Full Name": "Ada" } },
      status: "done", error: null, updatedAt: 1,
    }];
    const quotas = new Map<string, WorkspaceQuota>([
      [WS, { workspaceId: WS, cloudActionsLimit: 10, cloudActionsUsed: 3 }],
    ]);
    const { run } = harness({
      rows, cells, quotas,
      fullColumns: pushColumns(), extraGridColumns: pushGridColumns,
      webhooks: [{
        id: "conn-1", workspaceId: WS, tableId: TARGET, name: "Push from Leads",
        token: "tok-push", signingSecret: null,
        // Mapping EDITED after the push: Email now routes to Owner.
        mapping: [
          { path: "$", columnId: COL_PUSHED },
          { path: "Email", columnId: COL_OWNER },
        ],
        enabled: true, autoRun: null, mode: "create", upsertKey: null,
        createdAt: 1, lastReceivedAt: null, receivedCount: 0,
        source: "push", sourceTableId: SOURCE,
      }],
    });
    const exit = await run(
      svc.pipe(Effect.flatMap((s) => s.backfillPushMapping("conn-1"))),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toEqual({ rows: 1, updated: 1 });

    const ownerCell = cells.find(
      (c) => c.rowId === "t-row-1" && c.columnId === COL_OWNER,
    );
    expect(ownerCell?.value).toBe("a@acme.com");
    // Backfill is a re-projection — NOT a billable ingest.
    expect(quotas.get(WS)?.cloudActionsUsed).toBe(3);
  });

  it("no field mappings → nothing to backfill", async () => {
    const { run } = harness({
      fullColumns: pushColumns(), extraGridColumns: pushGridColumns,
      webhooks: [{
        id: "conn-1", workspaceId: WS, tableId: TARGET, name: null,
        token: "tok", signingSecret: null,
        mapping: [{ path: "$", columnId: COL_PUSHED }],
        enabled: true, autoRun: null, mode: "create", upsertKey: null,
        createdAt: 1, lastReceivedAt: null, receivedCount: 0,
        source: "push", sourceTableId: SOURCE,
      }],
    });
    const exit = await run(
      svc.pipe(Effect.flatMap((s) => s.backfillPushMapping("conn-1"))),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toEqual({ rows: 0, updated: 0 });
  });
});

describe("WebhookService.pushRecord — Pushed data column placement", () => {
  it("creates the 'Pushed data' column at the FRONT of the target (webhook-style)", async () => {
    // Target starts WITHOUT a payload column; Domain(0) and Owner(1) exist.
    const fullColumns = [
      storeColumn({ id: COL_DOMAIN, tableId: TARGET, name: "Domain", position: 0 }),
      storeColumn({ id: COL_OWNER, tableId: TARGET, name: "Owner", position: 1 }),
      storeColumn({ id: COL_SRC_EMAIL, tableId: SOURCE, name: "Email", position: 0 }),
    ];
    const rows: GridRow[] = [srcRow];
    const cells: GridCell[] = srcCells();
    const { run } = harness({ rows, cells, fullColumns });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.pushRecord({
            sourceTableId: SOURCE,
            sourceRowId: "src-row-1",
            targetTableId: TARGET,
            mode: "append",
          }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    const pushed = fullColumns.find((c) => c.name === "Pushed data");
    expect(pushed).toBeDefined();
    expect(pushed!.tableId).toBe(TARGET);
    // Front placement: strictly before every pre-existing target column.
    expect(pushed!.position).toBeLessThan(0);
  });
});

describe("WebhookService.pushRecord — mapping self-heal", () => {
  it("recreates a DELETED 'Pushed data' column and repoints the $ entry", async () => {
    // The connection's $ entry points at a column that no longer exists (the
    // user deleted "Pushed data") — the regression that produced empty rows.
    const fullColumns = [
      storeColumn({ id: COL_DOMAIN, tableId: TARGET, name: "Domain", position: 0 }),
      storeColumn({ id: COL_SRC_EMAIL, tableId: SOURCE, name: "Email", position: 0 }),
    ];
    const rows: GridRow[] = [srcRow];
    const cells: GridCell[] = srcCells();
    const { run, webhooks } = harness({
      rows, cells, fullColumns,
      webhooks: [{
        id: "conn-1", workspaceId: WS, tableId: TARGET, name: "Push from Leads",
        token: "tok-push", signingSecret: null,
        mapping: [{ path: "$", columnId: "col-deleted-payload" }],
        enabled: true, autoRun: null, mode: "create", upsertKey: null,
        createdAt: 1, lastReceivedAt: null, receivedCount: 0,
        source: "push", sourceTableId: SOURCE,
      }],
    });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.pushRecord({
            sourceTableId: SOURCE,
            sourceRowId: "src-row-1",
            targetTableId: TARGET,
            mode: "append",
          }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);

    // A fresh "Pushed data" column exists on the target (front-placed)…
    const healed = fullColumns.find(
      (c) => c.name === "Pushed data" && c.tableId === TARGET,
    );
    expect(healed).toBeDefined();
    // …and the connection's $ entry now points at it, not the dead id.
    expect(webhooks[0].mapping).toEqual([
      { path: "$", columnId: healed!.id },
    ]);
  });
});

describe("WebhookService.pushRecord — auto-map by name", () => {
  it("fills MANUAL target columns whose names match payload fields (case-insensitive), never function columns", async () => {
    // Target: "Email" (manual, case-differs from source's "Email"? exact here),
    // "full name" (manual, case-insensitive match for "Full Name"), and a
    // function column named "Score" that must never be written.
    const T_EMAIL = "col-t-email";
    const T_FULLNAME = "col-t-fullname";
    const T_SCORE = "col-t-score";
    const fullColumns = [
      storeColumn({ id: T_EMAIL, tableId: TARGET, name: "Email", position: 0 }),
      storeColumn({ id: T_FULLNAME, tableId: TARGET, name: "full name", position: 1 }),
      storeColumn({ id: T_SCORE, tableId: TARGET, name: "Score", kind: "function", provider: "formula", position: 2 }),
      storeColumn({ id: COL_PUSHED, tableId: TARGET, name: "Pushed data", type: "json", position: 3 }),
      storeColumn({ id: COL_SRC_EMAIL, tableId: SOURCE, name: "Email", position: 0 }),
      storeColumn({ id: COL_SRC_NAME, tableId: SOURCE, name: "Full Name", position: 1 }),
      storeColumn({ id: "col-src-score", tableId: SOURCE, name: "Score", position: 2 }),
    ];
    const rows: GridRow[] = [srcRow];
    const cells: GridCell[] = [
      ...srcCells(),
      { id: "sc-3", rowId: "src-row-1", columnId: "col-src-score", value: 99, status: "done", error: null, updatedAt: 1 },
    ];
    const { run } = harness({
      rows, cells, fullColumns,
      extraGridColumns: [
        { id: T_EMAIL, tableId: TARGET },
        { id: T_FULLNAME, tableId: TARGET },
        { id: T_SCORE, tableId: TARGET },
        { id: COL_PUSHED, tableId: TARGET },
      ],
    });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.pushRecord({
            sourceTableId: SOURCE,
            sourceRowId: "src-row-1",
            targetTableId: TARGET,
            mode: "append",
          }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    const targetRow = rows.find((r) => r.tableId === TARGET)!;
    const cellValue = (columnId: string) =>
      cells.find((c) => c.rowId === targetRow.id && c.columnId === columnId)?.value;
    expect(cellValue(T_EMAIL)).toBe("a@acme.com"); // exact name match
    expect(cellValue(T_FULLNAME)).toBe("Ada Acme"); // case-insensitive match
    expect(cellValue(T_SCORE)).toBeUndefined(); // function column: never written
    expect(cellValue(COL_PUSHED)).toMatchObject({ payload: { Email: "a@acme.com" } });
  });

  it("an explicit mapping entry WINS over the name match for the same column", async () => {
    const T_EMAIL = "col-t-email";
    const fullColumns = [
      storeColumn({ id: T_EMAIL, tableId: TARGET, name: "Email", position: 0 }),
      storeColumn({ id: COL_PUSHED, tableId: TARGET, name: "Pushed data", type: "json", position: 1 }),
      storeColumn({ id: COL_SRC_EMAIL, tableId: SOURCE, name: "Email", position: 0 }),
      storeColumn({ id: COL_SRC_NAME, tableId: SOURCE, name: "Full Name", position: 1 }),
    ];
    const rows: GridRow[] = [srcRow];
    const cells: GridCell[] = srcCells();
    const { run } = harness({
      rows, cells, fullColumns,
      extraGridColumns: [
        { id: T_EMAIL, tableId: TARGET },
        { id: COL_PUSHED, tableId: TARGET },
      ],
      webhooks: [{
        id: "conn-1", workspaceId: WS, tableId: TARGET, name: "Push from Leads",
        token: "tok-push", signingSecret: null,
        // The user mapped "Full Name" → Email explicitly; the Email-name match
        // must NOT overwrite it.
        mapping: [
          { path: "$", columnId: COL_PUSHED },
          { path: "Full Name", columnId: T_EMAIL },
        ],
        enabled: true, autoRun: null, mode: "create", upsertKey: null,
        createdAt: 1, lastReceivedAt: null, receivedCount: 0,
        source: "push", sourceTableId: SOURCE,
      }],
    });
    const exit = await run(
      svc.pipe(
        Effect.flatMap((s) =>
          s.pushRecord({
            sourceTableId: SOURCE,
            sourceRowId: "src-row-1",
            targetTableId: TARGET,
            mode: "append",
          }),
        ),
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    const targetRow = rows.find((r) => r.tableId === TARGET)!;
    const emailCell = cells.find(
      (c) => c.rowId === targetRow.id && c.columnId === T_EMAIL,
    );
    expect(emailCell?.value).toBe("Ada Acme"); // the explicit mapping won
  });
});
