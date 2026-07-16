// Mock tRPC procedure table. Each handler receives (input, state) and returns
// the procedure's `data` payload; the server wraps it in the tRPC envelope
// `{ result: { data } }`. Writes mutate `state` so subsequent queries reflect
// them (the renderer refetches after every mutation).

import { col, cell, mePayload, tablePagePayload, tableSummary } from "./state.mjs";

// ── pipeline helpers (automation layer) ──────────────────────────────────────
const clone = (x) => JSON.parse(JSON.stringify(x));

/** A starter draft graph: input → formula (a complete, deployable 2-node flow,
 *  chosen so the editor's legacy-migration effect does NOT auto-patch it). */
function starterGraph() {
  return {
    schemaVersion: 1,
    nodes: [
      { id: "input", type: "input", name: "Record", position: { x: 80, y: 180 }, config: { key: "record", required: true } },
      { id: "label", type: "formula", name: "Label", position: { x: 360, y: 180 }, config: { expression: "record" } },
    ],
    edges: [{ id: "e1", source: "input", target: "label" }],
  };
}

/** The server-derived plan snapshot the editor reads (capabilities + estimate). */
function compiledFor(graph) {
  const billable = graph.nodes.filter((n) => n.type !== "input" && n.type !== "output").map((n) => n.id);
  return {
    graphHash: "e2e-hash",
    topologicalNodeIds: graph.nodes.map((n) => n.id),
    capabilities: { local: true, cloud: true, reasons: [] },
    actionEstimate: { minimumPerRecord: billable.length, expectedPerRecord: billable.length, maximumPerRecord: billable.length, billableNodeIds: billable },
  };
}

const pipelinePublic = (p) => ({
  id: p.id, workspaceId: p.workspaceId, projectId: p.projectId, name: p.name,
  description: p.description, archived: p.archived, createdBy: p.createdBy,
  createdAt: p.createdAt, updatedAt: p.updatedAt,
});

/** Minimal graph-patch reducer mirroring `applyPipelineGraphPatches`. */
function applyPatches(graph, patches) {
  const next = clone(graph);
  for (const patch of patches ?? []) {
    if (patch.op === "add_node") next.nodes.push(clone(patch.node));
    else if (patch.op === "update_node") next.nodes = next.nodes.map((n) => (n.id === patch.nodeId ? { ...n, ...clone(patch.patch) } : n));
    else if (patch.op === "remove_node") { next.nodes = next.nodes.filter((n) => n.id !== patch.nodeId); next.edges = next.edges.filter((e) => e.source !== patch.nodeId && e.target !== patch.nodeId); }
    else if (patch.op === "add_edge") next.edges.push(clone(patch.edge));
    else if (patch.op === "remove_edge") next.edges = next.edges.filter((e) => e.id !== patch.edgeId);
    else if (patch.op === "replace_node_edges") next.edges = clone(patch.edges);
  }
  return next;
}

function makeDraft(s, pipelineId, graph, version) {
  return {
    id: `version_${++s.seq.version}`, pipelineId, workspaceId: s.workspaceId, version,
    status: "draft", graph, compiledPlan: compiledFor(graph), graphHash: "e2e-hash",
    createdBy: s.user.id, createdAt: Date.now(), deployedAt: null,
  };
}

/** Procedures the renderer calls. Unlisted procedures fall back to `null` (see
 *  server.mjs) so optional/panel-only calls degrade gracefully. */
export const procedures = {
  // ── identity / workspace ────────────────────────────────────────────────
  "workspaces.me": (_input, s) => (s.signedIn ? mePayload(s) : null),
  "invitations.myPending": () => [],
  "auth.enabledProviders": () => ({ github: false, google: false, emailAuth: true }),
  "billing.syncPlan": () => ({ ok: true }),

  // ── grid: reads ─────────────────────────────────────────────────────────
  "grid.listProjects": (input, s) =>
    s.projects.filter((p) => p.workspaceId === (input?.workspaceId ?? s.workspaceId)),
  "grid.listTables": (input, s) =>
    s.tables
      .filter((t) => t.projectId === input?.projectId)
      .sort((a, b) => a.position - b.position)
      .map((t) => tableSummary(s, t)),
  "grid.listFolders": (input, s) =>
    s.folders
      .filter((f) => f.projectId === input?.projectId)
      .sort((a, b) => a.position - b.position),
  "grid.getTable": (input, s) => tablePagePayload(s, input?.tableId),
  "grid.getTablePage": (input, s) => tablePagePayload(s, input?.tableId),

  // ── grid: writes ────────────────────────────────────────────────────────
  "grid.createProject": (input, s) => {
    const id = input?.id ?? `proj_${++s.seq.project}`;
    const p = { id, workspaceId: input?.workspaceId ?? s.workspaceId, name: input?.name ?? "Untitled", createdAt: s.now };
    s.projects.push(p);
    return p;
  },

  "grid.createTable": (input, s) => {
    const id = input?.id ?? `tbl_${++s.seq.table}`;
    const position = s.tables.length + 1;
    const t = {
      id,
      projectId: input?.projectId,
      name: input?.name ?? "",
      position,
      createdAt: s.now,
      folderId: input?.folderId ?? null,
      favorite: false,
      dedupe: null,
    };
    s.tables.push(t);
    return tableSummary(s, t);
  },

  "grid.renameTable": (input, s) => {
    const t = s.tables.find((x) => x.id === input?.tableId);
    if (t) t.name = input.name;
    return { ok: true };
  },

  "grid.deleteTable": (input, s) => {
    s.tables = s.tables.filter((t) => t.id !== input?.tableId);
    s.columns = s.columns.filter((c) => c.tableId !== input?.tableId);
    const removedRows = s.rows.filter((r) => r.tableId === input?.tableId);
    for (const r of removedRows) delete s.cells[r._id];
    s.rows = s.rows.filter((r) => r.tableId !== input?.tableId);
    return { ok: true };
  },

  "grid.setTableFavorite": (input, s) => {
    const t = s.tables.find((x) => x.id === input?.tableId);
    if (t) t.favorite = !!input.favorite;
    return { ok: true };
  },

  "grid.moveTable": (input, s) => {
    const t = s.tables.find((x) => x.id === input?.tableId);
    if (t) {
      t.folderId = input.folderId ?? null;
      if (typeof input.position === "number") t.position = input.position;
    }
    return { ok: true };
  },

  "grid.createFolder": (input, s) => {
    const id = input?.id ?? `fld_${++s.seq.folder}`;
    const f = { id, projectId: input?.projectId, name: input?.name ?? "Untitled", position: s.folders.length + 1, createdAt: s.now };
    s.folders.push(f);
    return f;
  },
  "grid.renameFolder": (input, s) => {
    const f = s.folders.find((x) => x.id === input?.folderId);
    if (f) f.name = input.name;
    return { ok: true };
  },
  "grid.deleteFolder": (input, s) => {
    s.folders = s.folders.filter((f) => f.id !== input?.folderId);
    for (const t of s.tables) if (t.folderId === input?.folderId) t.folderId = null;
    return { ok: true };
  },

  "grid.addColumn": (input, s) => {
    const id = input?.id ?? `col_${++s.seq.column}`;
    const c = col(id, input?.tableId, input?.name ?? "", input?.kind ?? "manual", {
      type: input?.type,
      provider: input?.provider,
      method: input?.method,
      code: input?.code,
      params: input?.params,
      condition: input?.condition,
    });
    s.columns.push(c);
    return c;
  },

  "grid.updateColumn": (input, s) => {
    const c = s.columns.find((x) => x._id === input?.columnId);
    if (c) {
      for (const k of ["name", "type", "kind", "provider", "method", "code", "params", "condition"]) {
        if (input[k] !== undefined) c[k] = input[k];
      }
    }
    return c ?? { ok: true };
  },

  "grid.deleteColumn": (input, s) => {
    s.columns = s.columns.filter((c) => c._id !== input?.columnId);
    for (const rowId of Object.keys(s.cells)) delete s.cells[rowId][input?.columnId];
    return { ok: true };
  },

  "grid.addRow": (input, s) => {
    const id = input?.id ?? `row_${++s.seq.row}`;
    const position = s.rows.filter((r) => r.tableId === input?.tableId).length + 1;
    const r = { _id: id, tableId: input?.tableId, position, createdAt: s.now };
    s.rows.push(r);
    s.cells[id] = {};
    return r;
  },

  "grid.addRowsWithCells": (input, s) => {
    const created = [];
    const rowsIn = input?.rows ?? [];
    const rowIds = input?.rowIds ?? [];
    rowsIn.forEach((cellsMap, i) => {
      const id = rowIds[i] ?? `row_${++s.seq.row}`;
      const position = s.rows.filter((r) => r.tableId === input?.tableId).length + 1;
      s.rows.push({ _id: id, tableId: input?.tableId, position, createdAt: s.now });
      s.cells[id] = {};
      for (const [columnId, value] of Object.entries(cellsMap)) {
        s.cells[id][columnId] = cell(value);
      }
      created.push({ _id: id });
    });
    return { rows: created };
  },

  "grid.deleteRow": (input, s) => {
    s.rows = s.rows.filter((r) => r._id !== input?.rowId);
    delete s.cells[input?.rowId];
    return { ok: true };
  },

  "grid.setCell": (input, s) => {
    const rowId = input?.rowId;
    const columnId = input?.columnId;
    if (!s.cells[rowId]) s.cells[rowId] = {};
    const existing = s.cells[rowId][columnId] ?? cell(null, "empty");
    const next = { ...existing };
    if ("value" in input) {
      next.value = input.value;
      next.status = input.status ?? "done";
    }
    if (input.status !== undefined) next.status = input.status;
    if (input.error !== undefined) next.error = input.error;
    s.cells[rowId][columnId] = next;
    return { rowId, columnId, value: next.value, status: next.status, error: next.error };
  },

  "grid.setCellStatus": (input, s) => {
    const rowId = input?.rowId;
    const columnId = input?.columnId;
    if (!s.cells[rowId]) s.cells[rowId] = {};
    const existing = s.cells[rowId][columnId] ?? cell(null, "empty");
    existing.status = input.status;
    if (input.error !== undefined) existing.error = input.error;
    s.cells[rowId][columnId] = existing;
    return { ok: true };
  },

  "grid.setDedupe": (input, s) => {
    const t = s.tables.find((x) => x.id === input?.tableId);
    if (t) t.dedupe = input.dedupe ?? null;
    return { ok: true };
  },
  "grid.dedupe": () => ({ removed: 0 }),

  // ── CRM sync (Attio + HubSpot) ────────────────────────────────────────────
  // The wizard + status strip surface. Mirrors the real `crm` router closely
  // enough for E2E: connectionStatus gates step 2, createBinding adds synced
  // (read-only) columns + a first-pull row, syncNow appends a history run.
  // Every handler reads the optional `provider` input (default attio) like
  // the real router.
  "crm.connectionStatus": (input, s) => {
    const provider = input?.provider ?? "attio";
    const connected = provider === "hubspot" ? s.hubspotConnected : s.crmConnected;
    const label = provider === "hubspot" ? "acme.hubspot.com" : "Acme Attio";
    return connected
      ? { configured: true, connected: true, provider, connectedByName: "Morgan", workspaceLabel: label, attioWorkspaceName: label }
      : { configured: true, connected: false, provider };
  },
  "crm.authorizeUrl": (input) =>
    (input?.provider ?? "attio") === "hubspot"
      ? { url: "https://app.hubspot.com/oauth/authorize?client_id=e2e&state=fake" }
      : { url: "https://app.attio.com/authorize?client_id=e2e&state=fake" },
  "crm.listSources": (input) =>
    (input?.provider ?? "attio") === "hubspot"
      ? [
          { kind: "object", id: "contacts", label: "Contacts", parentObject: null },
          { kind: "object", id: "companies", label: "Companies", parentObject: null },
          { kind: "list", id: "7", label: "Newsletter subscribers", parentObject: "contacts" },
        ]
      : [
          { kind: "object", id: "people", label: "People", parentObject: null },
          { kind: "object", id: "companies", label: "Companies", parentObject: null },
          { kind: "list", id: "list_mql", label: "MQLs — Q3", parentObject: "people" },
        ],
  "crm.describeSource": (input) =>
    (input?.provider ?? "attio") === "hubspot"
      ? {
          fields: [
            { slug: "firstname", title: "First name", type: "text", recommended: true, sample: "Sarah  ·  Marcus" },
            { slug: "email", title: "Email", type: "email-address", recommended: true, sample: "sarah.chen@vercel.com" },
            { slug: "lifecyclestage", title: "Lifecycle stage", type: "select", recommended: false, sample: "customer" },
          ],
          suggestedMatchKey: "email",
        }
      : {
          fields: [
            { slug: "name", title: "Name", type: "personal-name", recommended: true, sample: "Sarah Chen  ·  Marcus Webb" },
            { slug: "email_addresses", title: "Email addresses", type: "email-address", recommended: true, sample: "sarah.chen@vercel.com" },
            { slug: "phone_numbers", title: "Phone numbers", type: "phone-number", recommended: false, sample: "+1 415-555-0142" },
          ],
          suggestedMatchKey: "email_addresses",
        },
  "crm.estimate": () => ({ count: 124, isLowerBound: false }),
  "crm.createBinding": (input, s) => {
    const bindingId = `crmb_${s.crmBindings.length + 1}`;
    const tableId = input?.tableId;
    // Synced (read-only) columns for the mapped fields…
    const columns = (input?.fields ?? []).map((f, i) => {
      const c = col(`col_crm_${bindingId}_${i}`, tableId, f.title, "manual", {
        config: { synced: true, crmBindingId: bindingId, attrSlug: f.attrSlug, attrType: f.attrType },
      });
      s.columns.push(c);
      return { attrSlug: f.attrSlug, attrType: f.attrType, columnId: c._id, title: f.title };
    });
    // …and a page of already-pulled rows so the grid shows synced data
    // immediately (Sarah first — specs assert on her).
    const SEED = [
      ["Sarah Chen", "sarah.chen@vercel.com"],
      ["Marcus Webb", "m.webb@stripe.com"],
      ["Elena Rodriguez", "elena@linear.app"],
      ["David Okafor", "d.okafor@notion.so"],
      ["Priya Nair", "priya@figma.com"],
      ["Tom Bradley", "tom.bradley@ramp.com"],
    ];
    SEED.forEach(([name, email], r) => {
      const rowId = `row_crm_${bindingId}_${r}`;
      s.rows.push({ _id: rowId, tableId, position: r + 1 });
      s.cells[rowId] = Object.fromEntries(
        columns.map((c, i) => [c.columnId, cell(i === 0 ? name : email)]),
      );
    });
    s.crmBindings.push({
      id: bindingId,
      workspaceId: s.workspaceId,
      tableId,
      provider: input?.provider ?? "attio",
      sourceKind: input?.sourceKind ?? "object",
      sourceId: input?.sourceId ?? "people",
      sourceLabel: input?.sourceLabel ?? "People",
      columns,
      config: { filters: input?.filters ?? [], dedupeMode: input?.dedupeMode ?? "update", matchKeyAttr: input?.matchKeyAttr ?? null },
      schedule: "daily",
      enabled: true,
      pausedReason: null,
      lastSyncedAt: Date.now(),
      lastError: null,
      rowsSynced: 6,
      createdAt: s.now,
    });
    return { bindingId };
  },
  // Mirrors CrmSyncService.listByTable: each binding carries its newest run so
  // the strip can derive "syncing" server-side (background/cron runs included).
  "crm.listBindings": (input, s) =>
    s.crmBindings
      .filter((b) => b.tableId === input?.tableId)
      .map((b) => {
        const run = s.crmRuns.find((r) => r.bindingId === b.id) ?? null;
        return {
          ...b,
          lastRun: run
            ? {
                id: run.id,
                status: run.status,
                trigger: run.trigger,
                rowsCreated: run.rowsCreated ?? 0,
                rowsUpdated: run.rowsUpdated ?? 0,
                startedAt: run.startedAt,
              }
            : null,
        };
      }),
  // Add one more source field to an existing binding (the add-column popover's
  // "From {CRM}" section). Mirrors the real router: creates the synced column,
  // extends the binding mapping, and "backfills" the seeded rows immediately
  // (the real backfill rides the enqueued sync).
  "crm.addBindingField": (input, s) => {
    const b = s.crmBindings.find((x) => x.id === input?.bindingId);
    if (!b) return { columnId: "" };
    const f = input?.field ?? {};
    const existing = b.columns.find((c) => c.attrSlug === f.attrSlug);
    if (existing) return { columnId: existing.columnId };
    const c = col(`col_crm_${b.id}_${b.columns.length}`, b.tableId, f.title ?? "Field", "manual", {
      config: { synced: true, crmBindingId: b.id, attrSlug: f.attrSlug, attrType: f.attrType },
    });
    s.columns.push(c);
    b.columns = [...b.columns, { attrSlug: f.attrSlug, attrType: f.attrType, columnId: c._id, title: f.title }];
    for (const row of s.rows.filter((r) => r.tableId === b.tableId)) {
      s.cells[row._id] = { ...(s.cells[row._id] ?? {}), [c._id]: cell("backfilled") };
    }
    return { columnId: c._id };
  },

  "crm.history": (input, s) => s.crmRuns.filter((r) => r.bindingId === input?.bindingId),
  "crm.syncNow": (input, s) => {
    const b = s.crmBindings.find((x) => x.id === input?.bindingId);
    const runId = `crmrun_${s.crmRuns.length + 1}`;
    s.crmRuns.unshift({
      id: runId,
      workspaceId: s.workspaceId,
      bindingId: input?.bindingId,
      tableId: b?.tableId ?? "",
      status: "ok",
      trigger: "manual",
      rowsCreated: 2,
      rowsUpdated: 5,
      rowsSkipped: 0,
      rowsStaled: 0,
      fieldsDropped: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    });
    if (b) { b.lastSyncedAt = Date.now(); b.rowsSynced = (b.rowsSynced ?? 0) + 2; }
    return { enqueued: true };
  },
  "crm.disconnect": (input, s) => {
    const provider = input?.provider ?? "attio";
    const name = provider === "hubspot" ? "HubSpot" : "Attio";
    const paused = s.crmBindings.filter((b) => b.workspaceId === s.workspaceId && (b.provider ?? "attio") === provider);
    for (const b of paused) { b.pausedReason = "auth_revoked"; b.lastError = `${name} was disconnected. Reconnect ${name} to resume syncing.`; }
    if (provider === "hubspot") s.hubspotConnected = false;
    else s.crmConnected = false;
    return { removed: true, bindingsPaused: paused.length };
  },
  "crm.deleteBinding": (input, s) => {
    s.crmBindings = s.crmBindings.filter((b) => b.id !== input?.bindingId);
    return null;
  },

  // ── pipelines (automation layer) ─────────────────────────────────────────
  "pipelines.list": (input, s) =>
    s.pipelines
      .filter((p) => p.projectId === input?.projectId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((p) => ({ id: p.id, name: p.name, description: p.description, createdAt: p.createdAt, updatedAt: p.updatedAt })),
  "pipelines.get": (input, s) => {
    const p = s.pipelines.find((x) => x.id === input?.pipelineId);
    if (!p) return null;
    return { pipeline: pipelinePublic(p), draft: p.draft, deployed: p.deployed, bindings: p.bindings };
  },
  "pipelines.create": (input, s) => {
    const now = Date.now();
    const pid = `pipeline_${++s.seq.pipeline}`;
    const draft = makeDraft(s, pid, starterGraph(), 1);
    const p = {
      id: pid, workspaceId: s.workspaceId, projectId: input?.projectId,
      name: (input?.name ?? "Untitled pipeline").trim(), description: null, archived: false,
      createdBy: s.user.id, createdAt: now, updatedAt: now, draft, deployed: null, bindings: [],
    };
    s.pipelines.push(p);
    return { pipeline: pipelinePublic(p), version: draft };
  },
  "pipelines.patchDraft": (input, s) => {
    const p = s.pipelines.find((x) => x.id === input?.pipelineId);
    if (!p) return null;
    // Editing a deployed-only pipeline forks a fresh draft off the deployed graph.
    if (!p.draft) p.draft = makeDraft(s, p.id, p.deployed ? clone(p.deployed.graph) : starterGraph(), (p.deployed?.version ?? 0) + 1);
    p.draft.graph = applyPatches(p.draft.graph, input?.patches ?? []);
    p.draft.compiledPlan = compiledFor(p.draft.graph);
    p.updatedAt = Date.now();
    return { id: p.draft.id, version: p.draft.version };
  },
  "pipelines.deploy": (input, s) => {
    const p = s.pipelines.find((x) => x.id === input?.pipelineId);
    if (!p || !p.draft) return null;
    const version = (p.deployed?.version ?? 0) + 1;
    p.deployed = { ...p.draft, status: "deployed", version, deployedAt: Date.now() };
    p.draft = null; // promoting the draft clears it until the next edit
    p.updatedAt = Date.now();
    return { version };
  },
  "pipelines.remove": (input, s) => {
    s.pipelines = s.pipelines.filter((x) => x.id !== input?.pipelineId);
    return { id: input?.pipelineId };
  },
  "pipelines.listRuns": () => [],
  "pipelines.tableBindings": () => [],
  "pipelines.estimateRun": () => ({ minimumActions: 0, expectedActions: 0, maximumActions: 0, perRecord: { minimumPerRecord: 0, expectedPerRecord: 0, maximumPerRecord: 0, billableNodeIds: [] } }),
};
