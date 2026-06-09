/**
 * Cloud-context resolution + data-source selection for the gtmgrid MCP server
 * (TRI-3296).
 *
 * The MCP server is a process spawned by the desktop sidecar (see
 * packages/server/src/agent.ts `mcpConfig`). Historically it only received
 * `GTMGRID_PROJECT` and always opened a LOCAL SQLite project via `openProject`,
 * so an agent driving a CLOUD project still read/wrote local SQLite.
 *
 * This module threads the cloud context the sidecar forwards (mode + apiUrl +
 * bearer token + workspaceId + cloud projectId + active cloud tableId) and turns
 * it into an explicit data-source choice. The choice is made HERE, from explicit
 * inputs — never guessed inside a tool handler — so:
 *
 *   - `mode === "cloud"` (with a complete cloud context) → the cloud data source
 *     (Supabase-backed via the engine's `cloudGridStoreShape` + the sidecar's
 *     cloud run path), and
 *   - anything else (mode local, or a pure-local build with no `VITE_API_URL` and
 *     therefore no cloud context) → the LOCAL SQLite data source, byte-identical
 *     to the prior behaviour.
 *
 * The token is read from the environment and NEVER logged: the connected banner
 * the server prints reports only the mode + project, not the bearer.
 */

/** The agent's data environment, threaded from the sidecar as an env var. */
export type GridMode = "local" | "cloud";

/**
 * The complete cloud context an MCP cloud data source needs. Assembled from the
 * sidecar's env vars (see {@link cloudContextFromEnv}); every field is required
 * for a cloud source, so a partial/blank context falls back to local.
 */
export interface CloudContext {
  /** The apps/web API base URL (the desktop's `VITE_API_URL`). */
  readonly apiUrl: string;
  /** The signed-in member's Better Auth bearer token (localhost trust boundary). */
  readonly token: string;
  /** The Convex `workspaces._id` the cloud project/table belongs to. */
  readonly workspaceId: string;
  /** The active cloud `projects._id` the agent operates within. */
  readonly projectId: string;
  /**
   * The active cloud `tables._id` the agent operates on by default. The worker
   * boundary is table-scoped (getTable / setCell / run), so the cloud source is
   * built for ONE active table — the one the user is viewing.
   */
  readonly tableId: string;
}

/**
 * The resolved data environment for an MCP run: either LOCAL (open the SQLite
 * project named by `project`) or CLOUD (use `context`). A discriminated union so
 * a handler branches on `mode` with the right payload present — the selection is
 * explicit, not re-derived per tool call.
 */
export type GridEnv =
  | { readonly mode: "local"; readonly project: string }
  | { readonly mode: "cloud"; readonly context: CloudContext };

/** The MCP server's relevant environment variables (a subset of `process.env`). */
export interface McpEnv {
  readonly GTMGRID_PROJECT?: string;
  /** Explicit mode the sidecar sets ("cloud" | "local"). Absent ⇒ local. */
  readonly GTMGRID_MODE?: string;
  readonly GTMGRID_API_URL?: string;
  /** Bearer token — read here, never logged. */
  readonly GTMGRID_TOKEN?: string;
  readonly GTMGRID_WORKSPACE_ID?: string;
  readonly GTMGRID_CLOUD_PROJECT?: string;
  readonly GTMGRID_CLOUD_TABLE?: string;
}

/** Trim a possibly-undefined env value to a non-empty string, else undefined. */
function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Resolve the cloud context from the MCP env, or `undefined` when it is not a
 * COMPLETE cloud context. A cloud context requires the mode to be explicitly
 * `cloud` AND all of apiUrl/token/workspaceId/projectId/tableId to be present —
 * so a half-threaded or local environment never resolves to cloud (the local
 * SQLite path is the fallback). The mode is read from `GTMGRID_MODE`, NOT guessed
 * from the mere presence of an apiUrl.
 */
export function cloudContextFromEnv(env: McpEnv): CloudContext | undefined {
  if (nonEmpty(env.GTMGRID_MODE)?.toLowerCase() !== "cloud") return undefined;
  const apiUrl = nonEmpty(env.GTMGRID_API_URL);
  const token = nonEmpty(env.GTMGRID_TOKEN);
  const workspaceId = nonEmpty(env.GTMGRID_WORKSPACE_ID);
  const projectId = nonEmpty(env.GTMGRID_CLOUD_PROJECT);
  const tableId = nonEmpty(env.GTMGRID_CLOUD_TABLE);
  if (
    apiUrl === undefined ||
    token === undefined ||
    workspaceId === undefined ||
    projectId === undefined ||
    tableId === undefined
  ) {
    return undefined;
  }
  return { apiUrl, token, workspaceId, projectId, tableId };
}

/**
 * Select the MCP data environment from the process env. CLOUD only when
 * {@link cloudContextFromEnv} resolves a complete cloud context (explicit
 * `GTMGRID_MODE=cloud` + every cloud field); otherwise LOCAL, opening the SQLite
 * project named by `GTMGRID_PROJECT` (default `"default"`) exactly as before.
 *
 * This is the single place the cloud-vs-local decision is made; tool handlers
 * consume the resolved {@link GridEnv} and never re-guess the mode.
 */
export function selectGridEnv(env: McpEnv): GridEnv {
  const context = cloudContextFromEnv(env);
  if (context !== undefined) return { mode: "cloud", context };
  return { mode: "local", project: nonEmpty(env.GTMGRID_PROJECT) ?? "default" };
}

/**
 * A one-line, token-free description of the resolved environment for the
 * connected banner (printed to stderr). The bearer token is deliberately
 * excluded so it never lands in a log line.
 */
export function describeGridEnv(env: GridEnv): string {
  return env.mode === "cloud"
    ? `cloud project ${env.context.projectId} (table ${env.context.tableId})`
    : `local project ${env.project}`;
}
