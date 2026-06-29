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

    // monotonic id counters for created entities
    seq: { table: 1, column: 2, row: 2, project: 1, folder: 0 },
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
  };
}

export function cell(value, status = "done", error = null) {
  return { value, status, error };
}

/** The `Me` payload (tRPC `workspaces.me`) — drives `useMe` + workspace/plan. */
export function mePayload(s) {
  return {
    user: { _id: s.user.id, name: s.user.name, email: s.user.email, image: s.user.image },
    workspaces: [
      {
        _id: s.workspaceId,
        name: s.workspaceName,
        role: "owner",
        seatUsage: { used: 1, limit: null },
        plan: s.paid
          ? { id: "team", name: "Team", trialEndsAt: null }
          : { id: null, name: "Free", trialEndsAt: null },
        cloudActions: { used: 0, limit: null },
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
