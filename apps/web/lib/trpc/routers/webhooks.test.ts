/**
 * `webhooks` router procedure tests via `createCaller`, OFFLINE against a
 * `TestLayer` context (no live DB). Verifies each procedure end-to-end: member
 * success, non-member FORBIDDEN, unauthenticated UNAUTHORIZED, the create/list/
 * config/mapping/toggle/rotate/delete flow, and KEYSET deliveries paging.
 */

import type {
  GridColumn,
  GridTable,
  Membership,
  Webhook,
  WebhookDelivery,
} from "@gtmgrid/services";
import { TestLayer, type TestLayerFixtures } from "@gtmgrid/services";
import { describe, expect, it } from "vitest";
import { createTestContext } from "../context";
import { appRouter } from "../root";
import { createCallerFactory } from "../trpc";

const createCaller = createCallerFactory(appRouter);

const WS = "ws-1";
const TABLE = "table-1";
const COL = "col-email";

const memberships: readonly Membership[] = [
  { workspaceId: WS, userId: "member", role: "member" },
];
const tables: GridTable[] = [
  {
    id: TABLE,
    workspaceId: WS,
    projectId: "p1",
    name: "T",
    position: 0,
    createdAt: 1,
  },
];
const columns: GridColumn[] = [{ id: COL, tableId: TABLE }];

const webhook: Webhook = {
  id: "wh-1",
  workspaceId: WS,
  tableId: TABLE,
  name: "Test",
  token: "tok",
  signingSecret: "whsec_x",
  mapping: [],
  enabled: true,
  autoRun: true,
  mode: "create",
  upsertKey: null,
  createdAt: 100,
  lastReceivedAt: null,
  receivedCount: 0,
};

// Default the workspace to a cloud-enabled plan ("team") so createWebhook's
// cloud-access gate passes; override `workspaces` to test a locked workspace.
const callerFor = (fixtures: TestLayerFixtures) =>
  createCaller(
    createTestContext({
      layer: TestLayer({
        workspaces: [
          { id: WS, name: "WS", ownerId: "member", currentPlanId: "team" },
        ],
        ...fixtures,
      }),
      userId: fixtures.currentUserId ?? null,
    }),
  );

describe("webhooks.listWebhooks", () => {
  it("returns the table's webhooks for a member", async () => {
    const caller = callerFor({
      memberships,
      tables,
      webhooks: [{ ...webhook }],
      currentUserId: "member",
    });
    const list = await caller.webhooks.listWebhooks({ tableId: TABLE });
    expect(list).toHaveLength(1);
  });

  it("rejects a non-member with FORBIDDEN", async () => {
    const caller = callerFor({
      memberships,
      tables,
      webhooks: [{ ...webhook }],
      currentUserId: "stranger",
    });
    await expect(
      caller.webhooks.listWebhooks({ tableId: TABLE }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
    const caller = callerFor({ memberships, tables, currentUserId: null });
    await expect(
      caller.webhooks.listWebhooks({ tableId: TABLE }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("webhooks.createWebhook + deleteWebhook", () => {
  it("creates then deletes a webhook", async () => {
    const webhooks: Webhook[] = [];
    const caller = callerFor({
      memberships,
      tables,
      columns,
      webhooks,
      currentUserId: "member",
    });
    const id = await caller.webhooks.createWebhook({
      tableId: TABLE,
      name: "New",
      mapping: [{ path: "email", columnId: COL }],
    });
    expect(webhooks).toHaveLength(1);
    await caller.webhooks.deleteWebhook({ webhookId: id });
    expect(webhooks).toHaveLength(0);
  });

  it("maps a foreign mapping column to BAD_REQUEST", async () => {
    const caller = callerFor({
      memberships,
      tables,
      columns,
      webhooks: [],
      currentUserId: "member",
    });
    await expect(
      caller.webhooks.createWebhook({
        tableId: TABLE,
        mapping: [{ path: "x", columnId: "col-foreign" }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("webhooks.updateWebhookConfig", () => {
  it("rejects upsert mode without a key as BAD_REQUEST", async () => {
    const caller = callerFor({
      memberships,
      tables,
      columns,
      webhooks: [{ ...webhook }],
      currentUserId: "member",
    });
    await expect(
      caller.webhooks.updateWebhookConfig({
        webhookId: "wh-1",
        mode: "upsert",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("webhooks.toggleEnabled + rotateSecret", () => {
  it("toggles enabled and rotates the secret", async () => {
    const webhooks: Webhook[] = [{ ...webhook }];
    const caller = callerFor({
      memberships,
      tables,
      webhooks,
      currentUserId: "member",
    });
    await caller.webhooks.toggleEnabled({ webhookId: "wh-1", enabled: false });
    expect(webhooks[0].enabled).toBe(false);
    const rotated = await caller.webhooks.rotateSecret({ webhookId: "wh-1" });
    expect(rotated.token).not.toBe("tok");
  });
});

describe("webhooks.listDeliveriesPaged (keyset)", () => {
  it("pages newest-first with a cursor", async () => {
    const deliveries: WebhookDelivery[] = Array.from(
      { length: 3 },
      (_, i) => ({
        id: `d${i}`,
        workspaceId: WS,
        webhookId: "wh-1",
        tableId: TABLE,
        status: 200,
        rowsAffected: 1,
        mode: "create" as const,
        recordId: null,
        error: null,
        receivedAt: i + 1,
      }),
    );
    const caller = callerFor({
      memberships,
      tables,
      webhooks: [{ ...webhook }],
      deliveries,
      currentUserId: "member",
    });
    const p1 = await caller.webhooks.listDeliveriesPaged({
      webhookId: "wh-1",
      limit: 2,
    });
    expect(p1.items.map((d) => d.id)).toEqual(["d2", "d1"]);
    expect(p1.nextCursor).not.toBe(null);
    const p2 = await caller.webhooks.listDeliveriesPaged({
      webhookId: "wh-1",
      limit: 2,
      cursor: p1.nextCursor,
    });
    expect(p2.items.map((d) => d.id)).toEqual(["d0"]);
    expect(p2.nextCursor).toBe(null);
  });
});
