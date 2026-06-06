import type {
  ConvexClientLike,
  ConvexFunctionRefs,
} from "@gtmgrid/engine";

/**
 * A {@link ConvexClientLike} (the structural client the engine's
 * `convexGridStoreShape` injects — see `packages/engine/src/store-convex.ts`
 * lines ~61-71) that talks to Convex through the SECRET-GATED `/webhook/*` HTTP
 * routes (`convex/http.ts`) instead of authenticated Convex function calls.
 *
 * The worker runs headless: it has no member identity / Convex Auth JWT, so it
 * cannot call `tables:getTable` / `cells:setCell` directly (those `requireMember`).
 * Instead the Convex backend exposes member-less analogues
 * (`getTableForWorker` / `setCellFromWorker` / ...) behind HTTP routes that
 * authenticate the worker with a shared `Bearer WEBHOOK_WORKER_SECRET`. This
 * client POSTs the function args as JSON to the matching route.
 *
 * The opaque "function refs" the engine passes around are, on this path, just
 * route-name strings (see {@link WORKER_REFS}); `query`/`mutation`/`action` all
 * resolve the same way — POST `${CONVEX_SITE_URL}<ref>` with the bearer header.
 */

/** Resolve the Convex HTTP actions origin (the `.convex.site` host). */
function convexSiteUrl(): string {
  const url = process.env.CONVEX_SITE_URL;
  if (url === undefined || url === "") {
    throw new Error("CONVEX_SITE_URL is not configured");
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
 * POST `args` to a `/webhook/*` route and return the parsed JSON body. A
 * non-2xx response throws (the engine maps it to a typed `GridStoreError`).
 */
async function call(route: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${convexSiteUrl()}${route}`, {
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
      `Convex worker route ${route} failed: ${res.status} ${res.statusText} ${text}`.trim(),
    );
  }
  // Routes return JSON; tolerate an empty body (returns null).
  const text = await res.text();
  return text === "" ? null : JSON.parse(text);
}

/** The route name a ref resolves to — refs ARE the route strings here. */
function routeOf(ref: unknown): string {
  if (typeof ref !== "string") {
    throw new Error(`Unsupported worker function ref: ${String(ref)}`);
  }
  return ref;
}

/**
 * The worker's {@link ConvexClientLike}. query/mutation/action are identical on
 * the HTTP boundary (a POST to the route); the distinction only matters to the
 * authenticated Convex client, which the worker does not use.
 */
export const convexWorkerClient: ConvexClientLike = {
  query: (ref, args) => call(routeOf(ref), args),
  mutation: (ref, args) => call(routeOf(ref), args),
  action: (ref, args) => call(routeOf(ref), args),
};

/**
 * Worker-specific function refs: each maps to a `/webhook/*` route name. These
 * stand in for the authenticated `CLOUD_REFS` in `packages/server/src/cloud-run.ts`
 * — the engine treats them as opaque, and {@link convexWorkerClient} interprets
 * each string as the route to POST to.
 *
 * Note: `getCredential` here points at `/webhook/getCredential`, which decrypts a
 * WORKSPACE-scope secret for the worker; the store calls it with
 * `{ workspaceId, extensionId, scope }` and the route forwards `workspaceId` +
 * `extensionId` to `credentials.getCredentialForWorker`.
 */
export const WORKER_REFS: ConvexFunctionRefs = {
  getTable: "/webhook/getTable",
  setCell: "/webhook/setCell",
  setCellStatus: "/webhook/setCellStatus",
  getCredential: "/webhook/getCredential",
};
