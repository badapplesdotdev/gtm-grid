/**
 * Sidecar observability — re-exports the shared {@link @gtmgrid/observability}
 * module (PostHog Error Tracking + structured logging) and tags this process's
 * telemetry as the desktop sidecar. The implementation is shared with the MCP
 * server and CLI so the convention lives in one place; this file keeps the
 * existing `./observability.js` import path stable for the rest of the sidecar.
 */
import { setObservabilitySource } from "@gtmgrid/observability";

setObservabilitySource("desktop-sidecar");

export {
  captureException,
  captureServerEvent,
  flushObservability,
  installProcessHandlers,
  log,
  setObservabilitySource,
} from "@gtmgrid/observability";
