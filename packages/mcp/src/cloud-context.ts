/**
 * Cloud-context resolution for the gtmgrid MCP server.
 *
 * The MCP server is a process spawned by the desktop sidecar (see
 * packages/server/src/agent.ts `mcpConfig`). The grid the agent operates on is
 * ALWAYS a CLOUD (Postgres) project — there is no local SQLite grid. The sidecar
 * threads the cloud context (mode + apiUrl + bearer token + workspaceId + cloud
 * projectId + active cloud tableId) and this module assembles it into an explicit
 * {@link CloudContext}.
 *
 * The token is read from the environment and NEVER logged: the connected banner
 * the server prints reports only the project, not the bearer.
 */

/**
 * The complete cloud context an MCP cloud data source needs. Assembled from the
 * sidecar's env vars (see {@link cloudContextFromEnv}); every field is required.
 */
export interface CloudContext {
  /** The apps/web API base URL (the desktop's `VITE_API_URL`). */
  readonly apiUrl: string;
  /** The signed-in member's Better Auth bearer token (localhost trust boundary). */
  readonly token: string;
  /** The `workspaces.id` the cloud project/table belongs to. */
  readonly workspaceId: string;
  /** The active cloud `projects.id` the agent operates within. */
  readonly projectId: string;
  /**
   * The active cloud `tables.id` the agent operates on BY DEFAULT — the one the
   * user is viewing. OPTIONAL: the agent works with no active table too (it can
   * `list_tables`, `create_table`, or operate on any table by id); when absent,
   * table-scoped tools require an explicit `table` argument.
   */
  readonly tableId?: string;
  /** The pipeline open on the canvas, used as the default target for pipeline tools. */
  readonly pipelineId?: string;
}

/** The resolved data environment for an MCP run — always CLOUD. */
export type GridEnv = { readonly mode: "cloud"; readonly context: CloudContext };

/** The MCP server's relevant environment variables (a subset of `process.env`). */
export interface McpEnv {
  /** Explicit mode the sidecar sets — must be "cloud". */
  readonly GTMGRID_MODE?: string;
  readonly GTMGRID_API_URL?: string;
  /** Bearer token — read here, never logged. */
  readonly GTMGRID_TOKEN?: string;
  readonly GTMGRID_WORKSPACE_ID?: string;
  readonly GTMGRID_CLOUD_PROJECT?: string;
  readonly GTMGRID_CLOUD_TABLE?: string;
  readonly GTMGRID_CLOUD_PIPELINE?: string;
}

/** Trim a possibly-undefined env value to a non-empty string, else undefined. */
function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Resolve the cloud context from the MCP env, or `undefined` when it is not a
 * cloud context. Requires the mode to be explicitly `cloud` AND apiUrl + token +
 * workspaceId + projectId — the agent must be signed in with a cloud project, but
 * an active `tableId` is OPTIONAL (the agent works with no table loaded). The mode
 * is read from `GTMGRID_MODE`, NOT guessed from the presence of an apiUrl.
 */
export function cloudContextFromEnv(env: McpEnv): CloudContext | undefined {
  if (nonEmpty(env.GTMGRID_MODE)?.toLowerCase() !== "cloud") return undefined;
  const apiUrl = nonEmpty(env.GTMGRID_API_URL);
  const token = nonEmpty(env.GTMGRID_TOKEN);
  const workspaceId = nonEmpty(env.GTMGRID_WORKSPACE_ID);
  const projectId = nonEmpty(env.GTMGRID_CLOUD_PROJECT);
  const tableId = nonEmpty(env.GTMGRID_CLOUD_TABLE); // optional — may be absent
  const pipelineId = nonEmpty(env.GTMGRID_CLOUD_PIPELINE); // optional — may be absent
  if (apiUrl === undefined || token === undefined || workspaceId === undefined || projectId === undefined) {
    return undefined;
  }
  return { apiUrl, token, workspaceId, projectId, tableId, pipelineId };
}

/**
 * Select the MCP data environment from the process env. The grid is always
 * cloud-backed, so a complete cloud context is REQUIRED; an incomplete/absent
 * context throws (the MCP cannot operate on a grid without one).
 */
export function selectGridEnv(env: McpEnv): GridEnv {
  const context = cloudContextFromEnv(env);
  if (context === undefined) {
    throw new Error(
      "gtmgrid MCP requires a cloud context (GTMGRID_MODE=cloud + apiUrl/token/workspace/project; table optional). The local grid paradigm has been removed.",
    );
  }
  return { mode: "cloud", context };
}

/**
 * A one-line, token-free description of the resolved environment for the
 * connected banner (printed to stderr). The bearer token is deliberately
 * excluded so it never lands in a log line.
 */
export function describeGridEnv(env: GridEnv): string {
  const t = env.context.tableId;
  const p = env.context.pipelineId;
  return `cloud project ${env.context.projectId}${t ? ` (table ${t})` : " (no active table)"}${p ? ` (pipeline ${p})` : ""}`;
}
