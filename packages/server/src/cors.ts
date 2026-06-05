/**
 * CORS origin allowlisting for the sidecar (#22).
 *
 * The gtmgrid sidecar is a privileged local service: some routes spawn the
 * user's authenticated `claude` / `codex` CLIs (`/api/agent/chat`) or run
 * connectors with the user's credentials. It binds to loopback (127.0.0.1) so
 * only this machine can reach it, but a hostile web page open in any browser on
 * the same machine could still POST to `http://localhost:8787/...` and — if the
 * server reflected `access-control-allow-origin: *` — read the response. So
 * EVERY response (JSON routes, OPTIONS preflight, AND the agent SSE stream) must
 * carry CORS headers derived from a fixed ORIGIN ALLOWLIST, never `*`.
 *
 * The decision (allow vs reject) is pure logic, written as Effect with a typed
 * error per `docs/effect-conventions.md`. The HTTP seam (index.ts / agent.ts)
 * resolves it synchronously and applies the resulting headers.
 */

import { Data, Effect } from "effect";

/**
 * The trusted origins allowed to call the sidecar from a browser context:
 *   - the Vite dev server the desktop UI runs against (`http://localhost:5173`),
 *   - the Tauri production webview origins (macOS/Linux `tauri://localhost`,
 *     Windows `http://tauri.localhost`).
 * Additional origins can be supplied via `GTMGRID_ALLOWED_ORIGINS` (comma list)
 * without touching code (e.g. an alternate dev port).
 */
const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "tauri://localhost",
  "http://tauri.localhost",
];

/** Build the active allowlist: the defaults plus any from the env override. */
export function allowedOrigins(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const extra = (env.GTMGRID_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return [...DEFAULT_ALLOWED_ORIGINS, ...extra];
}

/** Raised when a request carries an `Origin` header that is not allowlisted. */
export class OriginNotAllowed extends Data.TaggedError("OriginNotAllowed")<{
  readonly origin: string;
}> {}

/** The CORS response headers to apply when an origin is permitted. */
export interface CorsHeaders {
  readonly "access-control-allow-origin": string;
  readonly "access-control-allow-methods": string;
  readonly "access-control-allow-headers": string;
  readonly vary: string;
}

const METHODS = "GET,POST,OPTIONS";
const HEADERS = "content-type";

/**
 * Decide the CORS headers for a request's `Origin` against an allowlist.
 *
 * - No `Origin` header (same-origin fetch, the Tauri webview's IPC fetch, curl,
 *   the desktop's native client): there is no cross-origin browser exposure to
 *   guard, and loopback binding already gates the network — succeed with NO
 *   `access-control-allow-origin` header (the browser only enforces CORS when an
 *   Origin is present).
 * - An ALLOWLISTED `Origin`: reflect exactly that origin (never `*`), with
 *   `Vary: Origin` so caches don't serve one origin's response to another.
 * - A DISALLOWED `Origin`: fail with {@link OriginNotAllowed}. The seam emits
 *   the response WITHOUT an `access-control-allow-origin` header, so the browser
 *   blocks the calling page from reading it — on every route, SSE included.
 */
export function resolveCors(
  origin: string | undefined,
  allow: readonly string[] = allowedOrigins(),
): Effect.Effect<CorsHeaders | null, OriginNotAllowed> {
  if (origin === undefined || origin === "") return Effect.succeed(null);
  if (!allow.includes(origin)) return Effect.fail(new OriginNotAllowed({ origin }));
  return Effect.succeed({
    "access-control-allow-origin": origin,
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    vary: "Origin",
  });
}

/**
 * Synchronous resolution for the HTTP seam: returns the CORS headers to apply,
 * or `null` to apply none. `null` covers both "no Origin header" and "Origin not
 * allowed" — in BOTH cases no `access-control-allow-origin` is emitted, so a
 * disallowed browser origin can never read the response. The boolean companion
 * {@link isOriginAllowed} lets privileged routes additionally REJECT (4xx)
 * before doing any work.
 */
export function corsHeadersFor(
  origin: string | undefined,
  allow: readonly string[] = allowedOrigins(),
): CorsHeaders | null {
  return Effect.runSync(
    resolveCors(origin, allow).pipe(
      Effect.catchTag("OriginNotAllowed", () => Effect.succeed(null)),
    ),
  );
}

/**
 * Whether a request's `Origin` is permitted to call a privileged route. A
 * missing `Origin` is permitted (non-browser / same-origin caller); a present
 * but non-allowlisted `Origin` is rejected — used to 403 the agent SSE route
 * before spawning any CLI.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allow: readonly string[] = allowedOrigins(),
): boolean {
  return Effect.runSync(
    resolveCors(origin, allow).pipe(
      Effect.match({ onFailure: () => false, onSuccess: () => true }),
    ),
  );
}
