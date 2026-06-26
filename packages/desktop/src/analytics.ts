/**
 * Desktop analytics — a thin, typed wrapper over `posthog-js` configured for the
 * Tauri native webview.
 *
 * Tauri specifics that differ from the web app:
 *  - `api_host` MUST be the ABSOLUTE PostHog ingest URL. The web app proxies via a
 *    same-origin `/ingest` rewrite, which does not exist in the `tauri://` webview.
 *  - `persistence: "localStorage"` — the WKWebview blocks third-party cookies, so
 *    the default cookie persistence loses the distinct id between launches.
 *  - `capture_pageview: false` — a webview has no meaningful page URLs; we capture
 *    explicit product events instead.
 *
 * Every export no-ops when `VITE_POSTHOG_KEY` is unset, so a local-only / OSS build
 * with no analytics configured runs untouched.
 */
import { WORKSPACE_GROUP } from "@gtmgrid/analytics";
import type {
  AnalyticsEventName,
  AnalyticsEventProps,
  UserTraits,
  WorkspaceGroupProps,
} from "@gtmgrid/analytics";
import posthog from "posthog-js";

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const HOST =
  (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? "https://us.i.posthog.com";

export const analyticsEnabled = Boolean(KEY);

let started = false;

/** Initialize PostHog once, on app boot. No-op when unconfigured or already started. */
export function initAnalytics(): void {
  if (started || !KEY) return;
  started = true;
  posthog.init(KEY, {
    api_host: HOST,
    ui_host: "https://us.posthog.com",
    persistence: "localStorage",
    capture_pageview: false,
    // Autocapture browser exceptions (incl. window.onerror / unhandledrejection).
    // React error-boundary catches are reported explicitly from ErrorBoundary.
    capture_exceptions: true,
    defaults: "2026-01-30",
    // Session Replay. Whether recording actually runs is gated by the project's
    // "Record user sessions" toggle (PostHog remote config), so this stays off
    // for OSS/local builds with their own project. The Tauri webview has no CSP
    // (tauri.conf.json `security.csp: null`) and an absolute `api_host`, so the
    // recorder script loads and uploads without extra config.
    //
    // `maskAllInputs` (PostHog default, set explicitly here) masks values typed
    // into inputs/textareas. Displayed text — including prospect data shown in
    // the grid — IS captured, so replays stay maximally useful for debugging UX.
    // To hide a specific element from replay, add the `ph-no-capture` class.
    session_recording: {
      maskAllInputs: true,
    },
  });
  // Super-properties attached to EVERY desktop event. There is no built-in
  // discriminator between the desktop (Tauri) and web (`apps/web`) surfaces —
  // they share one PostHog project and one identified person — so register an
  // explicit `platform` + `app_version` to make desktop-only filtering, the
  // desktop health dashboard, and version-scoped regression alerts possible.
  posthog.register({
    platform: "desktop",
    app_version: (import.meta.env.VITE_APP_VERSION as string | undefined) ?? null,
  });
}

/** Typed product-event capture against the shared catalog. No-ops when disabled. */
export function capture<E extends AnalyticsEventName>(
  event: E,
  properties?: AnalyticsEventProps<E>,
): void {
  if (!analyticsEnabled) return;
  posthog.capture(event, properties);
}

/** Report an exception to PostHog Error Tracking. No-ops when disabled. */
export function captureException(error: unknown): void {
  if (!analyticsEnabled) return;
  const err =
    error instanceof Error
      ? error
      : new Error(typeof error === "string" ? error : JSON.stringify(error));
  posthog.captureException(err);
}

/** Identify the signed-in user. No-ops when disabled. */
export function identifyUser(distinctId: string, traits?: UserTraits): void {
  if (!analyticsEnabled) return;
  posthog.identify(distinctId, traits as Record<string, unknown> | undefined);
}

/** Associate subsequent events with a workspace (account-level group analytics). */
export function identifyWorkspace(workspaceId: string, props?: WorkspaceGroupProps): void {
  if (!analyticsEnabled) return;
  posthog.group(WORKSPACE_GROUP, workspaceId, props as Record<string, unknown> | undefined);
}

/** Clear identity on sign-out so the next user starts a fresh person/session. */
export function resetAnalytics(): void {
  if (!analyticsEnabled) return;
  posthog.reset();
}
