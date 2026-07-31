import posthog from "posthog-js";
import { readConsent } from "./lib/consent";
import { clientEnv, posthogEnabled } from "./lib/env";

// Initialize PostHog only when a project token is configured — a missing token
// degrades to "analytics off" instead of crashing the client bundle (the previous
// non-null `!` assertion threw at module load when the var was unset).
if (posthogEnabled) {
  // Read before init: persistence must be decided up front (see below).
  const storedConsent = readConsent();

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
    // write a cookie or localStorage entry until the visitor accepts in the
    // banner (app/CookieConsent.tsx). Do NOT remove these two lines without also
    // removing the analytics-cookie disclosure in §10 of /privacy.
    //
    // Persistence is chosen HERE rather than swapped after init. A returning
    // visitor who already consented must boot straight into persistent storage:
    // booting into memory and calling set_config afterwards makes posthog-js
    // copy the freshly-minted in-memory props over the stored ones
    // (PostHogPersistence.update_config), which mints a brand-new anonymous
    // person on every page load and destroys returning-visitor analysis.
    // set_config is correct only for a mid-session change, where carrying the
    // in-memory id forward is what we actually want.
    opt_out_capturing_by_default: true,
    persistence: storedConsent === "granted" ? "localStorage+cookie" : "memory",
    debug: process.env.NODE_ENV === "development",
  });

  // Replaying a stored grant is not a fresh act of consent, so suppress the
  // `$opt_in` event that `opt_in_capturing` emits by default — otherwise every
  // page load by every consented visitor bills an extra event.
  if (storedConsent === "granted") {
    posthog.opt_in_capturing({ captureEventName: false });
  }
}
