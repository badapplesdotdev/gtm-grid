/**
 * CORS for the cross-origin API consumers — the Tauri desktop app's webview
 * (origin `tauri://localhost` on macOS, `http://tauri.localhost` on Windows/Linux,
 * `http://localhost:5173` in dev) calls `/api/auth/*` (Better Auth) and
 * `/api/trpc/*` from a DIFFERENT origin than the API host. Without these headers
 * the webview blocks the response and auth/data calls fail ("Couldn't create your
 * account"). The web app itself is same-origin and unaffected.
 *
 * Bearer-token auth (Better Auth `bearer` plugin) is what actually carries the
 * desktop session — WKWebView blocks third-party cookies — so we expose the
 * `set-auth-token` response header and allow the `authorization` request header.
 */
import { NextResponse, type NextRequest } from "next/server";

const ALLOWED_ORIGINS = new Set([
  "app://gtmgrid", // packaged Electron desktop (custom app:// renderer scheme)
  // Legacy Tauri webview origins — kept so already-installed Tauri builds keep
  // working through the Electron cut-over (remove once Tauri installs age out).
  "tauri://localhost", // macOS / iOS Tauri webview
  "http://tauri.localhost", // Windows / Linux / Android Tauri webview
  "https://tauri.localhost",
  "http://localhost:5173", // desktop dev (vite)
  // Extra DEV origins for parallel-worktree development (a second checkout's
  // vite on an alternate port, e.g. http://localhost:5183). Comma-separated;
  // unset in production, so the packaged allow-list above is unchanged there.
  ...(process.env.GTMGRID_DEV_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean) ?? []),
]);

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    // `x-gtmgrid-member` carries the member session token on the renderer's
    // direct worker-route calls (e.g. the table-actions editors' sibling-table
    // reads) — without it here the browser fails those requests at preflight.
    "Access-Control-Allow-Headers": "content-type, authorization, x-gtmgrid-member",
    "Access-Control-Expose-Headers": "set-auth-token, set-auth-jwt",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function middleware(req: NextRequest) {
  const origin = req.headers.get("origin");
  // Only act on allow-listed cross-origin (desktop) callers; same-origin web has
  // no Origin header (or matches SITE_URL) and passes through untouched.
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return NextResponse.next();

  if (req.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
  }
  const res = NextResponse.next();
  for (const [k, v] of Object.entries(corsHeaders(origin))) res.headers.set(k, v);
  return res;
}

export const config = {
  matcher: ["/api/auth/:path*", "/api/trpc/:path*", "/api/worker/:path*"],
};
