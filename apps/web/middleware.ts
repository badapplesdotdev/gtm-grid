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

const DEV_ORIGINS =
  process.env.NODE_ENV !== "production" ? ["http://localhost:5173"] : [];
const ALLOWED_ORIGINS = new Set([
  "tauri://localhost", // macOS / iOS Tauri webview
  "http://tauri.localhost", // Windows / Linux / Android Tauri webview
  "https://tauri.localhost",
  ...DEV_ORIGINS,
]);

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization",
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
  matcher: ["/api/auth/:path*", "/api/trpc/:path*"],
};
