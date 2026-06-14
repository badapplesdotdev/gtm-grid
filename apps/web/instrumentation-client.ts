import posthog from "posthog-js";
import { clientEnv, posthogEnabled } from "./lib/env";

// Initialize PostHog only when a project token is configured — a missing token
// degrades to "analytics off" instead of crashing the client bundle (the previous
// non-null `!` assertion threw at module load when the var was unset).
if (posthogEnabled) {
  posthog.init(clientEnv.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
    api_host: "/ingest",
    ui_host: "https://eu.posthog.com",
    defaults: "2026-01-30",
    capture_exceptions: true,
    debug: process.env.NODE_ENV === "development",
  });
}
