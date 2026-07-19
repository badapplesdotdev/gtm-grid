import posthog from "posthog-js";
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
    debug: process.env.NODE_ENV === "development",
  });
}
