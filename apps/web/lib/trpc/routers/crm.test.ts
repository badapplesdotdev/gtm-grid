/**
 * `crm` router procedure tests via `createCaller`, OFFLINE against a `TestLayer`
 * context (no live DB, no Attio HTTP). Verifies the gating contract the desktop
 * "From your CRM" flow depends on (member success, non-member FORBIDDEN,
 * unauthenticated UNAUTHORIZED, lapsed-trial FORBIDDEN) plus the two enqueue
 * seams: `createBinding` fires `crm/binding.created` best-effort, and `syncNow`
 * enqueues `crm/binding.sync-now`. All sync execution lives in the Inngest
 * worker — these procedures only build/validate + enqueue.
 */

import type { CrmBinding, GridTable, Membership, StoreColumn } from "@gtmgrid/services";
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
    expect(status).toEqual({ configured: false, connected: false, provider: "attio" });
  });

  it("rejects a non-member with FORBIDDEN", async () => {
    const caller = callerFor({ memberships, currentUserId: "stranger" });
    await expect(caller.crm.connectionStatus({ workspaceId: WS })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("crm.authorizeUrl", () => {
  // Desktop auth is bearer-based, so the browser carries no session — the
  // procedure mints the signed state HERE (member-gated) and returns the full
  // Attio URL; the callback trusts the state alone.
  it("mints a member-bound state and returns the full Attio authorize URL", async () => {
    vi.stubEnv("ATTIO_CLIENT_ID", "client-123");
    vi.stubEnv("ATTIO_CLIENT_SECRET", "secret-456");
    vi.stubEnv("BETTER_AUTH_SECRET", "test-hmac-secret");
    try {
      const caller = callerFor({ memberships, currentUserId: "member" });
      const { url } = await caller.crm.authorizeUrl({ workspaceId: WS });
      const parsed = new URL(url);
      expect(parsed.origin).toBe("https://app.attio.com");
      expect(parsed.searchParams.get("client_id")).toBe("client-123");
      expect(parsed.searchParams.get("redirect_uri")).toContain("/api/crm/attio/callback");
      const state = parsed.searchParams.get("state") ?? "";
      expect(state).not.toBe("");
      // The state round-trips to the calling member + workspace.
      const { AttioAuth } = await import("@gtmgrid/services");
      const { Effect } = await import("effect");
      const claims = await Effect.runPromise(
        Effect.flatMap(AttioAuth, (a) => a.verifyState(state)).pipe(Effect.provide(AttioAuth.Default)),
      );
      expect(claims).toEqual({ workspaceId: WS, userId: "member" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects a non-member (state minting is member-gated)", async () => {
    vi.stubEnv("ATTIO_CLIENT_ID", "client-123");
    vi.stubEnv("ATTIO_CLIENT_SECRET", "secret-456");
    vi.stubEnv("BETTER_AUTH_SECRET", "test-hmac-secret");
    try {
      const caller = callerFor({ memberships, currentUserId: "stranger" });
      await expect(caller.crm.authorizeUrl({ workspaceId: WS })).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      vi.unstubAllEnvs();
    }
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
      extensionId: "attio-crm",
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

describe("billing.syncPlan resumes lapse-paused syncs", () => {
  it("clears plan_lapsed pauses when the reconciled plan is paid", async () => {
    const crmBindings: CrmBinding[] = [
      { ...binding, pausedReason: "plan_lapsed", lastError: "Your plan doesn't include CRM sync right now." },
    ];
    const caller = callerFor({
      memberships,
      tables,
      crmBindings,
      workspaces: [{ id: WS, name: "WS", ownerId: "member", currentPlanId: "team" }],
      // The fake Autumn reports an active PAID plan so the reconcile resolves it.
      autumn: { activePlanIds: ["team"] },
      currentUserId: "member",
    });
    const plan = await caller.billing.syncPlan({ workspaceId: WS });
    expect(plan.id).not.toBeNull();
    expect(crmBindings[0]?.pausedReason).toBeNull(); // resumed without the webhook
  });
});

describe("entitlement gating (lapsed plan)", () => {
  it("wizard reads are FORBIDDEN on a lapsed workspace", async () => {
    const caller = callerFor({
      memberships,
      tables,
      workspaces: [{ id: WS, name: "W", ownerId: "member", currentPlanId: null }],
      currentUserId: "member",
    });
    await expect(caller.crm.listSources({ workspaceId: WS })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.crm.describeSource({ workspaceId: WS, kind: "object", id: "people", label: "People" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.crm.estimate({ workspaceId: WS, kind: "object", id: "people", label: "People", filters: [] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("crm.disconnect", () => {
  it("pauses the workspace's bindings and reports the count", async () => {
    const crmBindings: CrmBinding[] = [{ ...binding }];
    const caller = callerFor({ memberships, tables, crmBindings, currentUserId: "member" });
    const res = await caller.crm.disconnect({ workspaceId: WS });
    expect(res.bindingsPaused).toBe(1);
    expect(crmBindings[0]?.pausedReason).toBe("auth_revoked");
  });

  it("rejects a non-member with FORBIDDEN", async () => {
    const caller = callerFor({ memberships, tables, crmBindings: [{ ...binding }], currentUserId: "stranger" });
    await expect(caller.crm.disconnect({ workspaceId: WS })).rejects.toMatchObject({ code: "FORBIDDEN" });
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
    const list = await caller.crm.listBindings({ tableId: TABLE });
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("crm-1");
  });

  it("CROSS-TENANT: a member of another workspace cannot read a table's bindings", async () => {
    // Attacker is a legitimate member of workspace B, probing workspace A's
    // table id. Membership must be checked against the TABLE's workspace —
    // never any client-supplied id (the original shape was an IDOR).
    const caller = callerFor({
      memberships: [
        ...memberships,
        { workspaceId: "ws-ATTACKER", userId: "attacker", role: "member" },
      ],
      tables,
      crmBindings: [{ ...binding }],
      currentUserId: "attacker",
    });
    await expect(caller.crm.listBindings({ tableId: TABLE })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("an unknown table id returns empty (no existence probing)", async () => {
    const caller = callerFor({ memberships, tables, crmBindings: [{ ...binding }], currentUserId: "member" });
    const list = await caller.crm.listBindings({ tableId: "00000000-0000-0000-0000-000000000000" });
    expect(list).toEqual([]);
  });

  it("deletes a binding for a member", async () => {
    const crmBindings: CrmBinding[] = [{ ...binding }];
    const caller = callerFor({ memberships, tables, crmBindings, currentUserId: "member" });
    await caller.crm.deleteBinding({ bindingId: "crm-1" });
    expect(crmBindings).toHaveLength(0);
  });
});

describe("crm provider routing (hubspot)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("authorizeUrl with provider hubspot mints a HubSpot URL with read-only scopes", async () => {
    vi.stubEnv("HUBSPOT_CLIENT_ID", "hs-client");
    vi.stubEnv("HUBSPOT_CLIENT_SECRET", "hs-secret");
    vi.stubEnv("BETTER_AUTH_SECRET", "test-hmac-secret");
    const caller = callerFor({ memberships, currentUserId: "member" });
    const { url } = await caller.crm.authorizeUrl({ workspaceId: WS, provider: "hubspot" });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://app.hubspot.com");
    expect(parsed.searchParams.get("redirect_uri")).toContain("/api/crm/hubspot/callback");
    expect(parsed.searchParams.get("scope")).toContain("crm.objects.contacts.read");
  });

  it("connectionStatus is per provider: a hubspot connection doesn't light up attio", async () => {
    const caller = callerFor({ memberships, currentUserId: "member" });
    // Seed a HubSpot connection through the same credential slot machinery the
    // OAuth callback writes to.
    await caller.credentials.save({
      workspaceId: WS,
      extensionId: "hubspot-crm",
      scope: "workspace",
      name: "HubSpot",
      secrets: {
        accessToken: "at_hs",
        connectedByName: "Morgan",
        crmWorkspaceId: "424242",
        crmWorkspaceName: "acme.hubspot.com",
      },
    });
    const hubspot = await caller.crm.connectionStatus({ workspaceId: WS, provider: "hubspot" });
    const attio = await caller.crm.connectionStatus({ workspaceId: WS });
    expect(hubspot).toMatchObject({
      connected: true,
      provider: "hubspot",
      workspaceLabel: "acme.hubspot.com",
      // The legacy alias mirrors the neutral label for old desktop builds.
      attioWorkspaceName: "acme.hubspot.com",
    });
    expect(attio).toMatchObject({ connected: false, provider: "attio" });
  });

  it("createBinding persists provider hubspot on the binding row", async () => {
    vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] });
    const crmBindings: CrmBinding[] = [];
    const caller = callerFor({ memberships, tables, crmBindings, currentUserId: "member" });
    await caller.credentials.save({
      workspaceId: WS,
      extensionId: "hubspot-crm",
      scope: "workspace",
      name: "HubSpot",
      secrets: { accessToken: "at_hs" },
    });
    const out = await caller.crm.createBinding({
      workspaceId: WS,
      provider: "hubspot",
      tableId: TABLE,
      sourceKind: "object",
      sourceId: "contacts",
      sourceLabel: "Contacts",
      fields: [{ attrSlug: "email", attrType: "email-address", title: "Email" }],
      filters: [],
      dedupeMode: "update",
      matchKeyAttr: "email",
    });
    expect(out.bindingId).toBeTruthy();
    expect(crmBindings[0]?.provider).toBe("hubspot");
    vi.restoreAllMocks();
  });
});

describe("crm.addBindingField — one more synced column", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps the field, enqueues the backfill sync, and rejects non-members", async () => {
    const send = vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] });
    const gridColumns: StoreColumn[] = [];
    const crmBindings: CrmBinding[] = [{ ...binding }];
    const caller = callerFor({ memberships, tables, crmBindings, gridColumns, currentUserId: "member" });
    const out = await caller.crm.addBindingField({
      bindingId: binding.id,
      field: { attrSlug: "job_title", attrType: "text", title: "Job title" },
    });
    expect(out.columnId).toBeTruthy();
    expect(gridColumns).toHaveLength(1);
    expect(gridColumns[0]?.name).toBe("Job title");
    expect(crmBindings[0]?.columns.map((c) => c.attrSlug)).toContain("job_title");
    expect(send).toHaveBeenCalledWith({
      name: "crm/binding.sync-now",
      data: { bindingId: binding.id, workspaceId: WS },
    });

    const stranger = callerFor({ memberships, tables, crmBindings, currentUserId: "stranger" });
    await expect(
      stranger.crm.addBindingField({ bindingId: binding.id, field: { attrSlug: "x", attrType: "text", title: "X" } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
