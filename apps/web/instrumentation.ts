/**
 * Next.js server instrumentation. `onRequestError` is the framework hook that
 * fires for every uncaught server error (RSC render, route handler, server
 * action) — we forward them to PostHog Error Tracking. Guarded to the Node.js
 * runtime since the capture client (`posthog-node`) needs Node APIs.
 */
export function register(): void {
  // Required for Next to load this module; the real work is in onRequestError.
}

export async function onRequestError(
  error: unknown,
  request: { path?: string; method?: string },
  context: { routeType?: string; routerKind?: string },
): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { captureServerException } = await import("./lib/posthog-server");
  captureServerException(error, {
    properties: {
      source: "next",
      path: request?.path,
      method: request?.method,
      route_type: context?.routeType,
      router_kind: context?.routerKind,
    },
  });
}
