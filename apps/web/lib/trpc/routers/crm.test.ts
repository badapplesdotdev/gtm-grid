/**
 * `crm` router procedure tests via `createCaller`, OFFLINE against a `TestLayer`
 * context (no live DB, no Attio HTTP). Verifies the gating contract the desktop
 * "From your CRM" flow depends on (member success, non-member FORBIDDEN,
 * unauthenticated UNAUTHORIZED, lapsed-trial FORBIDDEN) plus the two enqueue
 * seams: `createBinding` fires `crm/binding.created` best-effort, and `syncNow`
 * enqueues `crm/binding.sync-now`. All sync execution lives in the Inngest
 * worker — these procedures only build/validate + enqueue.
 */

import type { CrmBinding, GridTable, Membership } from "@gtmgrid/services";
import { TestLayer, type TestLayerFixtures } from "@gtmgrid/services";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inngest } from "../../inngest/client";
import { createTestContext } from "../context";
import { appRouter } from "../root";
import { createCallerFactory } from "../trpc";

const createCaller = createCallerFactory(appRouter);

const WS = "ws-1";
const TABLE = "table-1";

const memberships: readonly Membership[] = [
  { workspaceId: WS, userId: "member", role: "member" },
];
const tables: GridTable[] = [
  { id: TABLE, workspaceId: WS, projectId: "p1", name: "T", position: 0, createdAt: 1 },
];
const binding: CrmBinding = {
  id: "crm-1",
  workspaceId: WS,
  tableId: TABLE,
  provider: "attio",
  sourceKind: "object",
  sourceId: "companies",
  sourceLabel: "Companies",
  columns: [],
  config: { filters: [], dedupeMode: "update", matchKeyAttr: null },
  schedule: "daily",
  enabled: true,
  pausedReason: null,
  lastSyncedAt: null,
  lastError: null,
  rowsSynced: 0,
  createdAt: 1,
};

// Default the workspace to a cloud-enabled plan ("team"); override `workspaces`
// to exercise a locked / Free workspace.
const callerFor = (fixtures: TestLayerFixtures) =>
  createCaller(
    createTestContext({
      layer: TestLayer({
        workspaces: [{ id: WS, name: "WS", ownerId: "member", currentPlanId: "team" }],
        ...fixtures,
      }),
      userId: fixtures.currentUserId ?? null,
    }),
  );

describe("crm.listSources (member-gated)", () => {
  it("rejects a non-member with FORBIDDEN", async () => {
    const caller = callerFor({ memberships, currentUserId: "stranger" });
    await expect(caller.crm.listSources({ workspaceId: WS })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
    const caller = callerFor({ memberships, currentUserId: null });
    await expect(caller.crm.listSources({ workspaceId: WS })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

describe("crm.connectionStatus", () => {
  it("reports disconnected + unconfigured for a member with no connection", async () => {
    const caller = callerFor({ memberships, currentUserId: "member" });
    const status = await caller.crm.connectionStatus({ workspaceId: WS });
    expect(status).toEqual({ configured: false, connected: false });
  });

  it("rejects a non-member with FORBIDDEN", async () => {
    const caller = callerFor({ memberships, currentUserId: "stranger" });
    await expect(caller.crm.connectionStatus({ workspaceId: WS })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("crm.authorizeUrl", () => {
  it("builds the authorize entry URL for the workspace", async () => {
    const caller = callerFor({ memberships, currentUserId: "member" });
    const { url } = await caller.crm.authorizeUrl({ workspaceId: WS });
    expect(url).toContain("/api/crm/attio/authorize?workspace=ws-1");
  });
});

// createBinding builds the columns + binding, then enqueues `crm/binding.created`
// so the durable worker runs the first pull. The enqueue is BEST-EFFORT — a
// failed send must never fail the create.
describe("crm.createBinding — first-pull event", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A caller whose workspace has a decryptable Attio connection saved. */
  const callerWithConnection = async (crmBindings: CrmBinding[]) => {
    const caller = callerFor({ memberships, tables, crmBindings, currentUserId: "member" });
    // Seed the Attio token through the same runtime so the create's member
    // session round-trips against the in-memory credential repo.
    await caller.credentials.save({
      workspaceId: WS,
      extensionId: "attio",
      scope: "workspace",
      name: "Attio",
      secrets: { accessToken: "at_live" },
    });
    return caller;
  };

  it("creates the binding and emits crm/binding.created with bindingId + workspaceId", async () => {
    const send = vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] });
    const crmBindings: CrmBinding[] = [];
    const caller = await callerWithConnection(crmBindings);
    const out = await caller.crm.createBinding({
      workspaceId: WS,
      tableId: TABLE,
      sourceKind: "object",
      sourceId: "companies",
      sourceLabel: "Companies",
      fields: [
        { attrSlug: "name", attrType: "text", title: "Name" },
        { attrSlug: "domains", attrType: "domain", title: "Domain" },
      ],
      filters: [],
      dedupeMode: "update",
      matchKeyAttr: "domains",
    });
    expect(out.bindingId).toBeTruthy();
    expect(crmBindings).toHaveLength(1);
    expect(send).toHaveBeenCalledWith({
      name: "crm/binding.created",
      data: { bindingId: out.bindingId, workspaceId: WS },
    });
  });

  it("still succeeds when the first-pull enqueue fails (best-effort send)", async () => {
    vi.spyOn(inngest, "send").mockRejectedValue(new Error("inngest down"));
    const caller = await callerWithConnection([]);
    const out = await caller.crm.createBinding({
      workspaceId: WS,
      tableId: TABLE,
      sourceKind: "object",
      sourceId: "companies",
      sourceLabel: "Companies",
      fields: [{ attrSlug: "name", attrType: "text", title: "Name" }],
      filters: [],
      dedupeMode: "update",
      matchKeyAttr: null,
    });
    // The binding exists and the create returns normally — the cron's
    // always-due-while-empty predicate covers the missed first pull.
    expect(out.bindingId).toBeTruthy();
  });

  it("rejects createBinding without an Attio connection (PRECONDITION_FAILED, human copy)", async () => {
    const caller = callerFor({ memberships, tables, crmBindings: [], currentUserId: "member" });
    await expect(
      caller.crm.createBinding({
        workspaceId: WS,
        tableId: TABLE,
        sourceKind: "object",
        sourceId: "companies",
        sourceLabel: "Companies",
        fields: [{ attrSlug: "name", attrType: "text", title: "Name" }],
        filters: [],
        dedupeMode: "update",
        matchKeyAttr: null,
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Attio isn't connected for this workspace. Connect Attio to start syncing.",
    });
  });
});

describe("crm.syncNow (entitlement gated → enqueue)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("validates then enqueues crm/binding.sync-now for an entitled member", async () => {
    const send = vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] });
    const caller = callerFor({
      memberships,
      tables,
      crmBindings: [{ ...binding }],
      currentUserId: "member",
    });
    const out = await caller.crm.syncNow({ bindingId: "crm-1" });
    expect(out).toEqual({ enqueued: true });
    expect(send).toHaveBeenCalledWith({
      name: "crm/binding.sync-now",
      data: { bindingId: "crm-1", workspaceId: WS },
    });
  });

  it("blocks manual sync on a Free workspace with FORBIDDEN", async () => {
    const caller = callerFor({
      workspaces: [{ id: WS, name: "WS", ownerId: "member", currentPlanId: null }],
      memberships,
      tables,
      crmBindings: [{ ...binding }],
      currentUserId: "member",
    });
    await expect(caller.crm.syncNow({ bindingId: "crm-1" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("crm.listBindings / deleteBinding", () => {
  it("lists a table's bindings for a member", async () => {
    const caller = callerFor({
      memberships,
      tables,
      crmBindings: [{ ...binding }],
      currentUserId: "member",
    });
    const list = await caller.crm.listBindings({ tableId: TABLE, workspaceId: WS });
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("crm-1");
  });

  it("deletes a binding for a member", async () => {
    const crmBindings: CrmBinding[] = [{ ...binding }];
    const caller = callerFor({ memberships, tables, crmBindings, currentUserId: "member" });
    await caller.crm.deleteBinding({ bindingId: "crm-1" });
    expect(crmBindings).toHaveLength(0);
  });
});
