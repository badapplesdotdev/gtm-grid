/**
 * Shared server-side observability for GTM Grid's long-lived/short-lived Node
 * processes — the desktop sidecar (`@gtmgrid/server`) and the MCP server
 * (`@gtmgrid/mcp`). Neither has a signed-in
 * user identity (that lives in the desktop renderer / web app), so this module's
 * job is the gap the client can't cover: surfacing server-side EXCEPTIONS
 * (uncaught crashes, run failures) and shipping structured logs to PostHog.
 *
 * Config: `GTMGRID_POSTHOG_KEY` (+ optional `GTMGRID_POSTHOG_HOST`). When unset,
 * everything no-ops and logging falls back to stderr only — a local/OSS build runs
 * untouched. Each consumer calls {@link setObservabilitySource} once at boot so its
 * telemetry groups under a recognisable pseudo-person (e.g. "desktop-sidecar",
 * "mcp"); apps/web has its OWN posthog-node client (NEXT_PUBLIC token) and
 * does not use this module.
 */
import { PostHog } from "posthog-node";

const KEY = process.env.GTMGRID_POSTHOG_KEY;
const HOST = process.env.GTMGRID_POSTHOG_HOST ?? "https://us.i.posthog.com";

// All telemetry from one process groups under a single pseudo-person — there's no
// user identity here. Each consumer overrides this at boot via setObservabilitySource.
let distinctId = process.env.GTMGRID_OBSERVABILITY_SOURCE ?? "node-service";

/** Tag this process's telemetry (the PostHog distinct id). Call once at boot. */
export function setObservabilitySource(source: string): void {
  distinctId = source;
}

let client: PostHog | null = null;

function ph(): PostHog | null {
  if (!KEY) return null;
  if (!client) {
    // flushAt:1 / flushInterval:0 — these processes can be killed at any time
    // (Tauri kills the sidecar; the CLI is short-lived), so never buffer (and we
    // flush explicitly on shutdown below).
    client = new PostHog(KEY, { host: HOST, flushAt: 1, flushInterval: 0 });
  }
  return client;
}

/** Report an exception to PostHog Error Tracking. No-ops when unconfigured. */
export function captureException(error: unknown, properties?: Record<string, unknown>): void {
  const c = ph();
  if (!c) return;
  const err =
    error instanceof Error
      ? error
      : new Error(typeof error === "string" ? error : JSON.stringify(error));
  c.captureException(err, distinctId, properties);
}

type LogMeta = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", message: string, meta?: LogMeta): void {
  // Structured single-line JSON to stderr — greppable and machine-parseable,
  // replacing the ad-hoc console.* these processes used.
  const line = JSON.stringify({ level, msg: message, ...meta });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.error(line); // info → stderr too (stdout is reserved for protocols)
}

/**
 * Structured logger. `error` also forwards to PostHog Error Tracking so
 * server-side failures are visible centrally, not just in local stderr.
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

/** Flush + close the PostHog client. Call before the process exits. */
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
 * unhandled rejections to PostHog, flush, then exit. Without these a crash dies
 * silently with no server-side trace. Pass a `source` to tag this process.
 */
export function installProcessHandlers(source?: string): void {
  if (source) setObservabilitySource(source);
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
