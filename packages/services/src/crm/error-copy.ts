/**
 * CRM error → what the USER sees (TRI: crm-sync). GTM Grid's market is
 * non-technical, so this is the single translation point between the typed
 * error hierarchy (crm/errors.ts) and the sync-log/status-strip copy. Rules:
 *
 * - Copy NEVER contains HTTP statuses, error tags, stack fragments, or jargon
 *   (a unit test enforces this over every tag).
 * - Every message says what happened AND what happens next — either "we'll
 *   handle it" or one concrete action the user can take.
 * - `binding` tells the caller whether to pause the binding (failures the user
 *   must resolve) so the cron stops burning attempts on a dead connection.
 */

import type { CrmError } from "./errors.js";

/** Run status recorded in `crm_sync_runs.status`. */
export type CrmRunStatus = "ok" | "partial" | "warn" | "failed";

export interface CrmErrorPresentation {
  /** Status the run row is finalized with when this error ends/degrades a run. */
  readonly status: Exclude<CrmRunStatus, "ok">;
  /** Plain-English sync-log copy. User-safe by construction. */
  readonly copy: string;
  /** When set, the binding is paused with this reason until the user acts. */
  readonly pause?: "auth_revoked" | "source_gone";
}

const oneOf = (labels: ReadonlyArray<string>): string =>
  labels.length <= 3 ? labels.join(", ") : `${labels.slice(0, 3).join(", ")} and ${labels.length - 3} more`;

/** Translate a CRM failure into its user-facing presentation. */
export function crmErrorCopy(e: CrmError): CrmErrorPresentation {
  switch (e._tag) {
    // Transient failures only reach here after retries were exhausted.
    case "AttioRateLimitError":
    case "AttioServerError":
    case "AttioNetworkError":
      return {
        status: "warn",
        copy: "Attio was temporarily unavailable. We'll try again at the next sync.",
      };
    case "AttioAuthRevoked":
      return {
        status: "failed",
        pause: "auth_revoked",
        copy: "Your Attio connection needs attention. Reconnect Attio to resume syncing.",
      };
    case "CrmConnectionMissing":
      return {
        status: "failed",
        pause: "auth_revoked",
        copy: "Attio isn't connected for this workspace. Connect Attio to start syncing.",
      };
    case "AttioSchemaDriftError":
      return {
        status: "partial",
        copy: `${e.missingAttrs.length} field${e.missingAttrs.length === 1 ? "" : "s"} could not be mapped and ${e.missingAttrs.length === 1 ? "was" : "were"} skipped: ${oneOf(e.missingAttrs)}. Everything else synced.`,
      };
    case "AttioSourceGoneError":
      return {
        status: "failed",
        pause: "source_gone",
        copy: `"${e.sourceLabel}" no longer exists in your Attio workspace. Pick a new source or remove this sync.`,
      };
    case "RowCapReached":
      return {
        status: "partial",
        copy: `Synced the first ${e.cap.toLocaleString("en-US")} records (your plan's limit). Add filters to narrow what's pulled, or upgrade to sync more.`,
      };
    case "AttioRequestError":
      if (e.status === 403) {
        return {
          status: "failed",
          copy: "Attio declined access to that data. In Attio, open the GTM Grid app's settings and enable read access for records, object & list configuration, and workspace members — then reconnect and try again.",
        };
      }
      return {
        status: "failed",
        copy: "Attio couldn't process that request. Adjust the source or filters and try again.",
      };
    case "CrmSyncError":
      return {
        status: "failed",
        copy: "Something went wrong during this sync. We've logged it and will try again at the next sync.",
      };
  }
}
