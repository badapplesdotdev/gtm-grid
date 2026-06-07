import type {
  CloudClientLike,
  CloudFunctionRefs,
} from "@gtmgrid/engine";

/**
 * A {@link CloudClientLike} (the structural cloud-store client the engine's
 * `cloudGridStoreShape` injects — see `packages/engine/src/store-convex.ts`
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

/**
 * Resolve the base URL of the apps/web deployment that serves the worker
 * endpoints. The Inngest worker and the `/api/worker/*` routes run in the SAME
 * Next.js deployment, so they share `SITE_URL`.
 */
function workerBaseUrl(): string {
  const url = process.env.SITE_URL;
  if (url === undefined || url === "") {
    throw new Error("SITE_URL is not configured");
  }
  return url.replace(/\/$/, "");
}

/** Resolve the shared worker bearer secret, failing closed when unset. */
function workerSecret(): string {
  const secret = process.env.WEBHOOK_WORKER_SECRET;
  if (secret === undefined || secret === "") {
    throw new Error("WEBHOOK_WORKER_SECRET is not configured");
  }
  return secret;
}

/**
 * POST `args` to an `/api/worker/*` route and return the parsed JSON body. A
 * non-2xx response throws (the engine maps it to a typed `GridStoreError`).
 */
async function call(route: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${workerBaseUrl()}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${workerSecret()}`,
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Worker route ${route} failed: ${res.status} ${res.statusText} ${text}`.trim(),
    );
  }
  // Routes return JSON; tolerate an empty body (returns null).
  const text = await res.text();
  return text === "" ? null : JSON.parse(text);
}

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
  query: (ref, args) => call(routeOf(ref), args),
  mutation: (ref, args) => call(routeOf(ref), args),
  action: (ref, args) => call(routeOf(ref), args),
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
  setCell: "/api/worker/setCell",
  setCellStatus: "/api/worker/setCellStatus",
  getCredential: "/api/worker/getCredential",
};
