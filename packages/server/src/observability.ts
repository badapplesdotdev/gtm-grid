/**
 * Sidecar observability — server-side error tracking + structured logging for the
 * local Node sidecar (which Tauri spawns as a child process).
 *
 * The sidecar has no signed-in user identity (that lives in the desktop renderer,
 * which captures product events with the real person), so this module's job is the
 * gap the client can't cover: surfacing server-side EXCEPTIONS (uncaught crashes,
 * run failures) and shipping structured logs to PostHog.
 *
 * Config: `GTMGRID_POSTHOG_KEY` (+ optional `GTMGRID_POSTHOG_HOST`). When unset,
 * everything no-ops and logging falls back to stderr only — a local/OSS build runs
 * untouched. The Tauri shell passes the key into the spawned sidecar's env.
 */
import { PostHog } from "posthog-node";

const KEY = process.env.GTMGRID_POSTHOG_KEY;
const HOST = process.env.GTMGRID_POSTHOG_HOST ?? "https://eu.i.posthog.com";

// All sidecar telemetry groups under one pseudo-person — there's no user identity
// in this process; the desktop renderer owns per-user analytics.
const DISTINCT_ID = "desktop-sidecar";

let client: PostHog | null = null;

function ph(): PostHog | null {
  if (!KEY) return null;
  if (!client) {
    // flushAt:1 / flushInterval:0 — the sidecar can be killed by Tauri at any time,
    // so never buffer (and we flush explicitly on shutdown below).
    client = new PostHog(KEY, { host: HOST, flushAt: 1, flushInterval: 0 });
  }
  return client;
}

/** Report a sidecar exception to PostHog Error Tracking. No-ops when unconfigured. */
export function captureException(error: unknown, properties?: Record<string, unknown>): void {
  const c = ph();
  if (!c) return;
  const err =
    error instanceof Error
      ? error
      : new Error(typeof error === "string" ? error : JSON.stringify(error));
  c.captureException(err, DISTINCT_ID, properties);
}

type LogMeta = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", message: string, meta?: LogMeta): void {
  // Structured single-line JSON to stderr — greppable and machine-parseable,
  // replacing the ad-hoc console.* the sidecar used.
  const line = JSON.stringify({ level, msg: message, ...meta });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.error(line); // info → stderr too (stdout is reserved for protocols)
}

/**
 * Structured logger for the sidecar. `error` also forwards to PostHog Error
 * Tracking so server-side failures are visible centrally, not just in local stderr.
 */
export const log = {
  info(message: string, meta?: LogMeta): void {
    emit("info", message, meta);
  },
  warn(message: string, meta?: LogMeta): void {
    emit("warn", message, meta);
  },
  error(message: string, error?: unknown, meta?: LogMeta): void {
    emit("error", message, { ...meta, error: error instanceof Error ? error.message : error });
    if (error !== undefined) captureException(error, { context: message, ...meta });
  },
};

/** Flush + close the PostHog client. Call before the sidecar exits. */
export async function flushObservability(): Promise<void> {
  if (client) {
    try {
      await client.shutdown();
    } catch {
      /* best-effort on exit */
    }
  }
}

let handlersInstalled = false;

/**
 * Install process-level last-gasp handlers: report uncaught exceptions and
 * unhandled rejections to PostHog, flush, then exit. Without these a crash in the
 * sidecar dies silently with no server-side trace.
 */
export function installProcessHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  process.on("uncaughtException", (error) => {
    log.error("uncaughtException", error);
    void flushObservability().finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    log.error("unhandledRejection", reason);
    // Don't exit on an unhandled rejection — report and keep serving.
  });
}
