// In-memory state for the mock cloud + engine the E2E renderer talks to.
//
// The renderer's mutation hooks optimistically update AND invalidate (refetch),
// so the mock must PERSIST writes: a `grid.setCell` must be visible on the next
// `grid.getTablePage`. State is a single mutable object reset between tests via
// the `/__test/reset` control endpoint (see server.mjs).

const FIXED_NOW = 1750000000000; // stable timestamp so payloads are deterministic

/** A fresh, fully-seeded world: one workspace, one project, one table (Leads)
 *  with two manual columns (Company, Domain) and two rows of data. */
export function freshState() {
  return {
    // Auth: whether `GET /api/auth/get-session` reports a signed-in user.
    signedIn: true,
    // Whether the active workspace is on a paid plan. `plan.id === null` ⇒ the
    // renderer treats the workspace as Free (`cloudLocked`) and hides the grid.
    paid: true,
    // Trial end (epoch ms) surfaced on `plan.trialEndsAt`; null = not trialing.
    // A past value locks the cloud tier even while `paid` (the time-based
    // backstop). See mePayload for the state matrix.
    trialEndsAt: null,
    // Cloud-actions usage that drives the low-credits warning (limit null =
    // unmetered = no warning).
    cloudActionsUsed: 0,
    cloudActionsLimit: null,
    // Self-hosted backend (GTMGRID_SELF_HOST=1). When true the renderer never
    // locks the cloud UI regardless of paid/trial state. Default: hosted.
    selfHost: false,

    // Shared connector credentials + calls captured by hermetic provider
    // simulators. Tokens never leave this process and no live credits are used.
    credentials: [],
    zoomInfoCalls: [],
    surfeCalls: [],
    linearCalls: [],
    theirStackCalls: [],
    peopleDataLabsCalls: [],
    lemlistCalls: [],

    // ── CRM sync (Attio) ────────────────────────────────────────────────────
    // Whether the workspace has an Attio OAuth connection (crm.connectionStatus).
    crmConnected: false,
    // Same for HubSpot — the two providers connect independently.
    hubspotConnected: false,
    // Bindings + sync-run history, seedable per scenario (shallow overrides).
    crmBindings: [],
    crmRuns: [],

    user: {
      id: "user_1",
      _id: "user_1",
      name: "Morgan",
      email: "morgan@trigify.io",
      image: null,
      emailVerified: true,
      createdAt: new Date(FIXED_NOW).toISOString(),
      updatedAt: new Date(FIXED_NOW).toISOString(),
    },
    token: "e2e-token",

    workspaceId: "ws_1",
    workspaceName: "Acme",

    projects: [
      { id: "proj_1", workspaceId: "ws_1", name: "Default", createdAt: FIXED_NOW },
    ],
    folders: [],
    tables: [
      {
        id: "tbl_1",
        projectId: "proj_1",
        name: "Leads",
        position: 1,
        createdAt: FIXED_NOW,
        folderId: null,
        favorite: false,
        dedupe: null,
      },
    ],
    columns: [
      col("col_1", "tbl_1", "Company", "manual"),
      col("col_2", "tbl_1", "Domain", "manual"),
    ],
    rows: [
      { _id: "row_1", tableId: "tbl_1", position: 1, createdAt: FIXED_NOW },
      { _id: "row_2", tableId: "tbl_1", position: 2, createdAt: FIXED_NOW },
    ],
    // cells[rowId][columnId] = { value, status, error }
    cells: {
      row_1: {
        col_1: cell("Acme"),
        col_2: cell("acme.com"),
      },
      row_2: {
        col_1: cell("Globex"),
        col_2: cell("globex.com"),
      },
    },

    // Reusable pipelines (automation layer). Each carries its own draft +
    // deployed version inline; the mock pipeline procedures mutate these.
    pipelines: [],

    // monotonic id counters for created entities
    seq: { table: 1, column: 2, row: 2, project: 1, folder: 0, pipeline: 0, version: 0 },
    now: FIXED_NOW,
  };
}

export function col(id, tableId, name, kind = "manual", extra = {}) {
  return {
    _id: id,
    tableId,
    name,
    type: extra.type ?? "text",
    kind,
    provider: extra.provider ?? null,
    method: extra.method ?? null,
    code: extra.code ?? null,
    params: extra.params ?? null,
    condition: extra.condition ?? null,
    // CRM-synced columns carry { synced: true, ... } — read-only in the grid.
    config: extra.config ?? null,
  };
}

export function cell(value, status = "done", error = null) {
  return { value, status, error };
}

/** The `Me` payload (tRPC `workspaces.me`) — drives `useMe` + workspace/plan.
 *
 * Trial/credit overrides (shallow-merged via `/__test/reset`):
 *   - `trialEndsAt` (epoch ms) — surfaced on `plan.trialEndsAt`. Combine with
 *     `paid` to model each state: `{ paid:true, trialEndsAt:<future> }` = active
 *     trial; `{ paid:true, trialEndsAt:<past> }` = lapsed-by-date-but-not-synced
 *     (plan id still "team"); `{ paid:false, trialEndsAt:<past> }` = lapsed +
 *     synced (plan id null). The renderer locks on EITHER null id OR a past
 *     trialEndsAt, so all three drive the right UI.
 *   - `cloudActionsUsed` / `cloudActionsLimit` — drive the low-credits warning.
 *   - `selfHost` (boolean) — a self-hosted backend (`GTMGRID_SELF_HOST=1`).
 *     Surfaced on each workspace; the renderer then NEVER locks the cloud UI,
 *     regardless of `paid`/`trialEndsAt`. Mirrors the server bypass.
 */
export function mePayload(s) {
  const trialEndsAt = typeof s.trialEndsAt === "number" ? s.trialEndsAt : null;
  return {
    user: { _id: s.user.id, name: s.user.name, email: s.user.email, image: s.user.image },
    workspaces: [
      {
        _id: s.workspaceId,
        name: s.workspaceName,
        role: "owner",
        seatUsage: { used: 1, limit: null },
        plan: s.paid
          ? { id: "team", name: "Team", trialEndsAt }
          : { id: null, name: "Free", trialEndsAt },
        cloudActions: {
          used: typeof s.cloudActionsUsed === "number" ? s.cloudActionsUsed : 0,
          limit: typeof s.cloudActionsLimit === "number" ? s.cloudActionsLimit : null,
        },
        selfHost: s.selfHost === true,
      },
    ],
  };
}

/** The Better Auth `get-session` body (signed-in ⇒ object, signed-out ⇒ null). */
export function sessionPayload(s) {
  if (!s.signedIn) return null;
  return {
    session: {
      id: "sess_1",
      userId: s.user.id,
      token: s.token,
      expiresAt: new Date(s.now + 1000 * 60 * 60 * 24 * 365).toISOString(),
      createdAt: new Date(s.now).toISOString(),
      updatedAt: new Date(s.now).toISOString(),
    },
    user: s.user,
  };
}

/** A table's `getTablePage` payload (single page; we never paginate in tests). */
export function tablePagePayload(s, tableId) {
  const table = s.tables.find((t) => t.id === tableId);
  if (!table) return null;
  const columns = s.columns.filter((c) => c.tableId === tableId);
  const rows = s.rows
    .filter((r) => r.tableId === tableId)
    .sort((a, b) => a.position - b.position);
  const cells = [];
  for (const r of rows) {
    const rowCells = s.cells[r._id] ?? {};
    for (const c of columns) {
      const cl = rowCells[c._id];
      if (cl) cells.push({ rowId: r._id, columnId: c._id, value: cl.value, status: cl.status, error: cl.error });
    }
  }
  return {
    table: { _id: table.id, name: table.name, dedupe: table.dedupe ?? null },
    columns,
    rows: rows.map((r) => ({ _id: r._id })),
    cells,
    nextCursor: null,
  };
}

/** Table summary (tRPC `grid.listTables`) — table row + live row count. */
export function tableSummary(s, t) {
  return {
    id: t.id,
    projectId: t.projectId,
    name: t.name,
    position: t.position,
    createdAt: t.createdAt,
    folderId: t.folderId ?? null,
    favorite: !!t.favorite,
    rows: s.rows.filter((r) => r.tableId === t.id).length,
  };
}
