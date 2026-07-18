import type {
  CloudClientLike,
  CloudFunctionRefs,
} from "@gtmgrid/engine";
import { callWorker } from "../worker-call";

/**
 * A {@link CloudClientLike} (the structural cloud-store client the engine's
 * `cloudGridStoreShape` injects — see `packages/engine/src/store-cloud.ts`
 * lines ~61-71) that talks to the headless webhook WORKER endpoints
 * (`apps/web/app/api/worker/*`, TRI-3250) over their SECRET-GATED HTTP boundary,
 * instead of authenticated function calls.
 *
 * The worker runs headless: it has no member identity / session, so it cannot
 * call the member-gated tRPC grid procedures directly (those `requireMember`).
 * Instead the web app exposes member-less analogues under `/api/worker/*`
 * (getTable/setCell/setCellStatus/getCredential + insertRow/upsertRow) that
 * authenticate the worker with a shared `Bearer WEBHOOK_WORKER_SECRET`
 * (`@gtmgrid/services` `isAuthorizedWorker`). This client POSTs the function args
 * as JSON to the matching route.
 *
 * The opaque "function refs" the engine passes around are, on this path, just
 * route-path strings (see {@link WORKER_REFS}); `query`/`mutation`/`action` all
 * resolve the same way — POST `${SITE_URL}/api/worker/<name>` with the bearer
 * header.
 */

/** The route path a ref resolves to — refs ARE the route strings here. */
function routeOf(ref: unknown): string {
  if (typeof ref !== "string") {
    throw new Error(`Unsupported worker function ref: ${String(ref)}`);
  }
  return ref;
}

/**
 * The worker's {@link CloudClientLike}. query/mutation/action are identical on
 * the HTTP boundary (a POST to the route); the distinction only matters to the
 * authenticated client, which the worker does not use.
 */
export const workerClient: CloudClientLike = {
  query: (ref, args) => callWorker(routeOf(ref), args),
  mutation: (ref, args) => callWorker(routeOf(ref), args),
  action: (ref, args) => callWorker(routeOf(ref), args),
};

/**
 * Worker-specific function refs: each maps to an `/api/worker/*` route path.
 * These stand in for the authenticated `CLOUD_REFS` in
 * `packages/server/src/cloud-run.ts` — the engine treats them as opaque, and
 * {@link workerClient} interprets each string as the route to POST to.
 *
 * Note: `getCredential` here points at `/api/worker/getCredential`, which
 * decrypts a WORKSPACE-scope secret for the worker; the store calls it with
 * `{ workspaceId, extensionId, scope }` and the route forwards `workspaceId` +
 * `extensionId` to the credential decrypt.
 */
export const WORKER_REFS: CloudFunctionRefs = {
  getTable: "/api/worker/getTable",
  // Scoped + keyset reads so a cloud column run never loads a whole 50k-row
  // grid: a row-scoped run fetches only its rows, a full run streams pages.
  getTableForRows: "/api/worker/getTableForRows",
  getTablePage: "/api/worker/getTablePage",
  setCell: "/api/worker/setCell",
  setCellStatus: "/api/worker/setCellStatus",
  // Batched cell writes: the cloud store buffers terminal writes and flushes
  // them here in chunks (bounded in-flight + backpressure).
  setCells: "/api/worker/setCells",
  getCredential: "/api/worker/getCredential",
};
