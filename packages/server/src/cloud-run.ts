/**
 * Cloud run path (T9) — running a column on a CLOUD project from the sidecar.
 *
 * A LOCAL project runs through `current.engine` over SQLite, unchanged. A CLOUD
 * project's data lives in Convex, so this module builds an {@link Engine} whose
 * GridStore is the Convex-backed {@link convexGridStoreShape} (T5): it reads the
 * table's columns/rows/cells from Convex and writes cell status/results back via
 * the T4 `cells.setCell` / `cells.setCellStatus` mutations. Status (`running` →
 * `done`/`error`) therefore streams live to every workspace member through Convex
 * reactivity — the same `Engine.runColumn` code, only the store changes.
 *
 * DECOUPLING: the engine package never imports `convex/_generated` (so its build
 * doesn't depend on codegen). We honour that here too: the T4 function refs are
 * built from their string names via `makeFunctionReference` (from "convex/server",
 * a normal dependency), not imported from the generated `api`. The real
 * `ConvexHttpClient` (from "convex/browser") structurally satisfies the store's
 * injected `ConvexClientLike`, and is authenticated as the signed-in user with
 * the JWT the desktop forwards — so all reads/writes run under that member's
 * Convex identity and the existing `requireMember` authz holds.
 */

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { Effect } from "effect";
import {
  CloudSchemaMapping,
  Engine,
  convexGridStoreShape,
  defaultRegistry,
  Registry,
  type ConvexClientLike,
  type ConvexFunctionRefs,
  type EngineConfig,
  type GridStoreShape,
} from "@gtmgrid/engine";

/** The T4 Convex functions the cloud store/engine address, as opaque refs. */
const CLOUD_REFS: ConvexFunctionRefs = {
  getTable: makeFunctionReference<"query">("tables:getTable"),
  setCell: makeFunctionReference<"mutation">("cells:setCell"),
  setCellStatus: makeFunctionReference<"mutation">("cells:setCellStatus"),
};

/** Inputs the desktop forwards to run a column on a cloud project. */
export interface CloudRunRequest {
  /** The Convex deployment URL (the desktop's `VITE_CONVEX_URL`). */
  readonly convexUrl: string;
  /** The signed-in member's Convex Auth JWT (localhost trust boundary). */
  readonly token: string;
  /** The Convex `tables._id` the column belongs to. */
  readonly tableId: string;
  /** The Convex `columns._id` to run. */
  readonly columnId: string;
  /** Re-run cells already marked `done`. */
  readonly force?: boolean;
  /** Restrict the run to these Convex `rows._id`s (defaults to all rows). */
  readonly rowIds?: string[];
  /** Bounded concurrency for the row fan-out (defaults to 5). */
  readonly concurrency?: number;
}

/** What the dependencies a cloud run is built from (injected for testing). */
export interface CloudRunDeps {
  /**
   * Build an authenticated Convex client for a deployment + token. The default
   * constructs a real {@link ConvexHttpClient}; tests inject a fake.
   */
  readonly makeClient: (convexUrl: string, token: string) => ConvexClientLike;
  /** The connector/AI registry the engine runs functions against. */
  readonly registry: Registry;
  /** AI config (keys/models) for AI columns — resolved by the caller. */
  readonly config: EngineConfig;
}

/** Default deps: a real authenticated {@link ConvexHttpClient} + the registry. */
export function defaultCloudRunDeps(
  registry: Registry = defaultRegistry(),
  config: EngineConfig = {},
): CloudRunDeps {
  return {
    makeClient: (convexUrl, token) => {
      const client = new ConvexHttpClient(convexUrl);
      client.setAuth(token);
      return client as unknown as ConvexClientLike;
    },
    registry,
    config,
  };
}

/**
 * Build the Convex-backed {@link GridStoreShape} for one cloud table. The store
 * needs {@link CloudSchemaMapping}; we provide its `.Default` Layer and resolve
 * the shape eagerly so the rest of the run is plain `Engine` code.
 */
export async function buildConvexStore(
  client: ConvexClientLike,
  tableId: string,
): Promise<GridStoreShape> {
  return Effect.runPromise(
    convexGridStoreShape({ client, refs: CLOUD_REFS, tableId }).pipe(
      Effect.provide(CloudSchemaMapping.Default),
    ),
  );
}

/**
 * Run a column on a cloud project. Builds an authed Convex client, a
 * Convex-backed GridStore for the table, and an {@link Engine} that uses that
 * store for BOTH project data and credentials (workspace-shared cloud
 * credentials resolve through the same store; until T7's read path is wired they
 * resolve to none, matching a project with no connected keys). Returns the
 * engine's `{ ran, errors }` summary.
 *
 * The engine constructor still takes a `Db` for its (unused-on-the-cloud-path)
 * `db`/`credsDb` fields; the caller passes the sidecar's existing global db so
 * no new SQLite file is created. The run path itself reads/writes only the
 * injected Convex store.
 */
export async function runCloudColumn(
  req: CloudRunRequest,
  deps: CloudRunDeps,
  db: ConstructorParameters<typeof Engine>[0],
): Promise<{ ran: number; errors: number }> {
  const client = deps.makeClient(req.convexUrl, req.token);
  const store = await buildConvexStore(client, req.tableId);
  const engine = new Engine(db, deps.config, deps.registry, undefined, {
    store,
    creds: store,
  });
  return engine.runColumn(req.columnId, {
    force: req.force,
    rowIds: req.rowIds,
    concurrency: req.concurrency,
  });
}
