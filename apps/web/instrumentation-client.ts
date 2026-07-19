import posthog from "posthog-js";
import { applyConsent, readConsent } from "./lib/consent";
import { clientEnv, posthogEnabled } from "./lib/env";

// Initialize PostHog only when a project token is configured — a missing token
// degrades to "analytics off" instead of crashing the client bundle (the previous
// non-null `!` assertion threw at module load when the var was unset).
if (posthogEnabled) {
  // `defaults: "2026-01-30"` turns on the Web Analytics signals (history-based
  // $pageview + $pageleave + web-vitals performance) and leaves Surveys + the
  // feedback/support widgets enabled — those render automatically once created in
  // the PostHog app (no extra client code). `capture_exceptions` feeds Error
  // Tracking.
  posthog.init(clientEnv.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
    api_host: "/ingest",
    ui_host: "https://us.posthog.com",
    defaults: "2026-01-30",
    capture_exceptions: true,
    // Session Replay hard-off, matching packages/desktop/src/analytics.ts. Left
    // unset, posthog-js starts recording as soon as the project's "Record user
    // sessions" toggle is flipped — no code change, no review. /privacy states
    // we do not record screens, so that must not be a dashboard-only decision.
    // Re-enabling needs the privacy review in docs/observability.md plus a
    // matching disclosure in §2 of apps/web/app/privacy/page.tsx.
    disable_session_recording: true,
    // PECR requires PRIOR consent for non-essential storage, so PostHog must not
    // write a cookie or localStorage entry on page load. Booting opted-out with
    // in-memory persistence means nothing is stored and nothing is sent until
    // the visitor accepts in the banner (app/CookieConsent.tsx), at which point
    // `applyConsent` switches persistence on. Do NOT remove these two lines
    // without also removing the analytics-cookie disclosure in §10 of /privacy.
    opt_out_capturing_by_default: true,
    persistence: "memory",
    debug: process.env.NODE_ENV === "development",
  });

  // Re-apply a previously stored choice. Absent or unreadable = stay opted out.
  // `silent` suppresses the `$opt_in` event: this is replaying an existing
  // choice on page load, not a fresh act of consent.
  const stored = readConsent();
  if (stored) applyConsent(stored, { silent: true });
}
